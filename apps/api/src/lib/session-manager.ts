import type { Client as SSH2Client } from "ssh2";
import type { SessionUser } from "../crypto/session-store.js";

/**
 * Server-side terminal session manager.
 *
 * The key idea behind persistent sessions: the SSH connection and its PTY
 * stream live HERE, in the server's memory, not inside a WebSocket handler.
 * A browser WebSocket attaches to a session to see its output and send input,
 * and detaches when the tab closes — but the underlying SSH session keeps
 * running on the server. Reopening the terminal reattaches to the same live
 * session and replays the recent scrollback so the user picks up exactly
 * where they left off.
 *
 * Sessions belong to an OWNER — the person, not the browser login that
 * opened them (see ownerKeyFor). That is what lets a session outlive the
 * vault's idle lock, a re-login, or a switch to another device: whoever
 * signs back in as the same owner finds it again.
 *
 * A session is reaped only when:
 *   - the remote shell closes (logout / connection dropped), or
 *   - it has had no attached client for `idleGraceMs` (default 30 min), or
 *   - it is explicitly killed (user ends it, admin disables the owner).
 */

export interface ManagedSession {
  id: string;
  hostId: string;
  /** Who may reattach. See ownerKeyFor(). */
  owner: string;
  /** Identity that opened the session (team mode); undefined in personal mode. */
  user?: SessionUser;
  ssh: SSH2Client;
  /** The PTY stream from ssh.shell(). Typed loosely — ssh2's types are partial. */
  stream: any;
  /** Ring buffer of recent raw output bytes, replayed to a client on attach. */
  scrollback: Buffer[];
  scrollbackBytes: number;
  /** The single currently-attached client, if any. One viewer per session. */
  attached: AttachedClient | null;
  /** Timer that reaps the session after the idle grace period with no client. */
  reapTimer: NodeJS.Timeout | null;
  createdAt: number;
  /** Optional recorder; receives every output chunk if recording is on. */
  onOutput: ((chunk: Buffer) => void) | null;
  /** Receives every PTY resize (recording keeps playback the right size). */
  onResize: ((rows: number, cols: number) => void) | null;
  /** Called once when the session ends, for cleanup (e.g. finalize recording). */
  onEnd: (() => void) | null;
  closed: boolean;
}

export interface AttachedClient {
  /** Send a raw output chunk to the browser. */
  send: (chunk: Buffer) => void;
  /** Tell the browser the session has ended (or that it is being detached). */
  end: (reason: string) => void;
  /** The browser login this client came through, so a lock can detach it. */
  loginSessionId?: string;
}

const MAX_SCROLLBACK_BYTES = 256 * 1024; // 256 KB of replayable history per session
const DEFAULT_IDLE_GRACE_MS = 30 * 60 * 1000; // reap detached sessions after 30 min

/**
 * The owner of a session: the team member in team mode, or the vault itself in
 * personal mode (there is exactly one person who can unlock a personal vault).
 */
export function ownerKeyFor(user?: SessionUser): string {
  return user ? `user:${user.id}` : "vault";
}

export function managedIdFor(owner: string, hostId: string): string {
  return `${owner}:${hostId}`;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private idleGraceMs: number;

  constructor(opts: { idleGraceMs?: number } = {}) {
    this.idleGraceMs = opts.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  /** How many live sessions an owner has open. */
  countByOwner(owner: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.owner === owner && !s.closed) n++;
    return n;
  }

  /** All live sessions, newest first — used by the "active sessions" view. */
  list(): ManagedSession[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Register a freshly-connected SSH session + PTY stream. Wires the stream's
   * output into the scrollback buffer, the attached client (if any), and the
   * optional recorder. Returns the managed session.
   *
   * Callers must check get(id) first: a live session under the same id is a
   * programming error (two connects raced), so this refuses rather than
   * silently orphaning the older connection.
   */
  register(opts: {
    id: string;
    hostId: string;
    owner?: string;
    user?: SessionUser;
    ssh: SSH2Client;
    stream: any;
  }): ManagedSession {
    const existing = this.sessions.get(opts.id);
    if (existing && !existing.closed) {
      throw new Error(`Session ${opts.id} is already live`);
    }

    const session: ManagedSession = {
      id: opts.id,
      hostId: opts.hostId,
      owner: opts.owner ?? "",
      user: opts.user,
      ssh: opts.ssh,
      stream: opts.stream,
      scrollback: [],
      scrollbackBytes: 0,
      attached: null,
      reapTimer: null,
      createdAt: Date.now(),
      onOutput: null,
      onResize: null,
      onEnd: null,
      closed: false,
    };
    this.sessions.set(opts.id, session);

    const handleOutput = (data: Buffer) => {
      // Feed the recorder first so nothing is lost if a send throws.
      if (session.onOutput) {
        try { session.onOutput(data); } catch { /* recording must never break the session */ }
      }
      this.pushScrollback(session, data);
      if (session.attached) {
        try { session.attached.send(data); } catch { /* client vanished; detach happens on its own */ }
      }
    };

    opts.stream.on("data", handleOutput);
    if (opts.stream.stderr) opts.stream.stderr.on("data", handleOutput);

    // Bound to this session object, not its id: a handler from one connection
    // must never end a different session that later took the same id.
    opts.stream.on("close", () => this.endSession(session, "Session ended"));
    opts.ssh.on("error", () => this.endSession(session, "Connection error"));

    // Safety net: if no client ever attaches (e.g. the browser vanished mid
    // connect), reap the session after the idle grace period rather than
    // leaking it. A normal attach() cancels this timer immediately.
    this.startReap(session);

    return session;
  }

  /** Append output to the ring buffer, trimming from the front past the cap. */
  private pushScrollback(session: ManagedSession, data: Buffer): void {
    session.scrollback.push(data);
    session.scrollbackBytes += data.length;
    while (session.scrollbackBytes > MAX_SCROLLBACK_BYTES && session.scrollback.length > 1) {
      const dropped = session.scrollback.shift()!;
      session.scrollbackBytes -= dropped.length;
    }
  }

  private startReap(session: ManagedSession): void {
    if (session.reapTimer) clearTimeout(session.reapTimer);
    session.reapTimer = setTimeout(() => {
      if (!session.attached) this.endSession(session, "Session timed out");
    }, this.idleGraceMs);
    // Don't keep the process alive just for the reap timer.
    if (typeof session.reapTimer.unref === "function") session.reapTimer.unref();
  }

  /**
   * Attach a browser client to a live session. Cancels any pending reap,
   * replaces any previous client (last attach wins), and returns the current
   * scrollback so the caller can replay it to the newly-attached browser.
   */
  attach(id: string, client: AttachedClient): Buffer | null {
    const session = this.sessions.get(id);
    if (!session || session.closed) return null;

    // Only one viewer at a time — boot the previous one cleanly.
    if (session.attached && session.attached !== client) {
      try { session.attached.end("Session opened in another window"); } catch { /* ignore */ }
    }
    session.attached = client;

    if (session.reapTimer) {
      clearTimeout(session.reapTimer);
      session.reapTimer = null;
    }

    return session.scrollback.length ? Buffer.concat(session.scrollback) : Buffer.alloc(0);
  }

  /**
   * Detach the given client. The SSH session keeps running; an idle-grace
   * reap timer starts so abandoned sessions don't live forever.
   */
  detach(id: string, client: AttachedClient): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.attached !== client) return; // a newer client already took over
    session.attached = null;
    this.startReap(session);
  }

  /**
   * Detach every client that came in through a given browser login — used when
   * that login is locked or expires. The sessions keep running for their owner.
   */
  detachByLogin(loginSessionId: string, reason: string): void {
    for (const session of this.sessions.values()) {
      const client = session.attached;
      if (!client || client.loginSessionId !== loginSessionId) continue;
      session.attached = null;
      try { client.end(reason); } catch { /* ignore */ }
      this.startReap(session);
    }
  }

  /** End every session belonging to an owner — used when an admin disables or resets them. */
  endByOwner(owner: string, reason: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.owner === owner) this.endSession(session, reason);
    }
  }

  /**
   * Hand every session of one owner to another. Used when a personal vault is
   * upgraded to team mode, so the owner's running sessions follow them to
   * their new admin identity instead of becoming unreachable.
   */
  transferOwner(from: string, to: string, user?: SessionUser): void {
    for (const session of [...this.sessions.values()]) {
      if (session.owner !== from) continue;
      const newId = managedIdFor(to, session.hostId);
      if (this.sessions.has(newId)) continue; // the new owner already has one for this host
      this.sessions.delete(session.id);
      session.id = newId;
      session.owner = to;
      session.user = user;
      this.sessions.set(newId, session);
    }
  }

  /**
   * Write input from the browser to the PTY. When `from` is given, only the
   * currently attached client may type — a client that was booted by a newer
   * window must not keep injecting keystrokes.
   */
  write(id: string, data: Buffer, from?: AttachedClient): void {
    const session = this.sessions.get(id);
    if (!session || session.closed || !session.stream) return;
    if (from && session.attached !== from) return;
    try { session.stream.write(data); } catch { /* stream may have just closed */ }
  }

  /** Resize the PTY. */
  resize(id: string, rows: number, cols: number, from?: AttachedClient): void {
    const session = this.sessions.get(id);
    if (!session || session.closed || !session.stream) return;
    if (from && session.attached !== from) return;
    try { session.stream.setWindow(rows, cols, 0, 0); } catch { /* ignore */ }
    if (session.onResize) {
      try { session.onResize(rows, cols); } catch { /* recording must never break the session */ }
    }
  }

  /**
   * End a session: close the SSH connection, notify any attached client,
   * run the end hook (finalizes recording), and remove it from the registry.
   * Idempotent.
   */
  end(id: string, reason: string): void {
    const session = this.sessions.get(id);
    if (session) this.endSession(session, reason);
  }

  private endSession(session: ManagedSession, reason: string): void {
    if (session.closed) return;
    session.closed = true;

    if (session.reapTimer) {
      clearTimeout(session.reapTimer);
      session.reapTimer = null;
    }
    if (session.onEnd) {
      try { session.onEnd(); } catch { /* recording finalize failure must not throw here */ }
    }
    if (session.attached) {
      try { session.attached.end(reason); } catch { /* ignore */ }
      session.attached = null;
    }
    try { session.ssh.end(); } catch { /* already closed */ }

    // Only remove the registry entry if it is still this session.
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
  }

  /** Kill every session — used on server shutdown. */
  shutdown(): void {
    for (const session of [...this.sessions.values()]) {
      this.endSession(session, "Server shutting down");
    }
  }
}
