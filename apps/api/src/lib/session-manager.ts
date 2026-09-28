import type { Client as SSH2Client } from "ssh2";
import type { SessionUser } from "../crypto/session-store.js";
import { TermMirror } from "./term-mirror.js";

/**
 * Server-side terminal session manager.
 *
 * The key idea behind persistent sessions: the SSH connection and its PTY
 * stream live HERE, in the server's memory, not inside a WebSocket handler.
 * A browser WebSocket attaches to a session to see its output and send input,
 * and detaches when the tab closes — but the underlying SSH session keeps
 * running on the server. Reopening the terminal reattaches to the same live
 * session and replays its screen — the rendered result, colours and edits
 * applied, not a stream of raw bytes — so the user picks up exactly where
 * they left off.
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
  /** Headless copy of the screen; replayed on attach (and read by capture). */
  mirror: TermMirror;
  /**
   * This session's own data key (plaintext, in memory only) and the id of its
   * wrapped copy in `session_keys`. Encrypts the session's recording (and,
   * later, its memory) even after the vault locks. Zeroed when the session ends.
   */
  dataKey: Buffer | null;
  keyId: string | null;
  /** The single currently-attached client, if any. One viewer per session. */
  attached: AttachedClient | null;
  /**
   * A client being attached: output produced meanwhile waits here, in order,
   * tagged with its mirror sequence number so the snapshot boundary is exact.
   */
  pending: { client: AttachedClient; queue: Array<{ seq: number; data: Buffer }> } | null;
  /** Timer that reaps the session after the idle grace period with no client. */
  reapTimer: NodeJS.Timeout | null;
  createdAt: number;
  /** Optional recorder; receives every output chunk if recording is on. */
  onOutput: ((chunk: Buffer) => void) | null;
  /** Receives every input chunk from the browser, before it reaches the stream (e.g. Memory capture). */
  onInput: ((chunk: Buffer) => void) | null;
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
   * output into the screen mirror, the attached client (if any), and the
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
    /** Initial PTY size, so the mirror matches the real terminal from the start. */
    cols?: number;
    rows?: number;
    dataKey?: Buffer | null;
    keyId?: string | null;
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
      mirror: new TermMirror({ cols: opts.cols ?? 80, rows: opts.rows ?? 24 }),
      dataKey: opts.dataKey ?? null,
      keyId: opts.keyId ?? null,
      attached: null,
      pending: null,
      reapTimer: null,
      createdAt: Date.now(),
      onOutput: null,
      onInput: null,
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
      const seq = session.mirror.write(data);
      this.deliver(session, data, seq);
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

  /** Send output to the attached client, or hold it while one is being attached. */
  private deliver(session: ManagedSession, data: Buffer, seq: number): void {
    if (session.pending) {
      session.pending.queue.push({ seq, data });
      return;
    }
    if (session.attached) {
      try { session.attached.send(data); } catch { /* client vanished; detach happens on its own */ }
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
   * replaces any previous client (last attach wins), and resolves with a
   * snapshot of the screen for the caller to replay.
   *
   * Ordering: everything the mirror had before this call is in the snapshot;
   * output produced while the snapshot is taken is held and sent afterwards.
   * Pass `onSnapshot` to deliver the snapshot yourself: it is called
   * synchronously before the held output is flushed, which is the only way to
   * guarantee the browser sees the screen first. Awaiting the returned promise
   * and then sending would be too late, because the flush has already run.
   * Resolves null if the session ended or another window took over.
   */
  async attach(
    id: string,
    client: AttachedClient,
    onSnapshot?: (snapshot: Buffer) => void,
  ): Promise<Buffer | null> {
    const session = this.sessions.get(id);
    if (!session || session.closed) return null;

    // Only one viewer at a time — boot the previous one cleanly.
    if (session.attached && session.attached !== client) {
      try { session.attached.end("Session opened in another window"); } catch { /* ignore */ }
    }
    if (session.pending && session.pending.client !== client) {
      try { session.pending.client.end("Session opened in another window"); } catch { /* ignore */ }
    }
    session.attached = null;

    if (session.reapTimer) {
      clearTimeout(session.reapTimer);
      session.reapTimer = null;
    }

    const hand = { client, queue: [] as Array<{ seq: number; data: Buffer }> };
    session.pending = hand;
    const snap = await session.mirror.snapshotWithSeq();
    const snapshot = Buffer.from(snap.screen, "utf8");
    // Ended, detached, or superseded while the snapshot was being taken.
    if (session.closed || session.pending !== hand) return null;

    if (onSnapshot) {
      try { onSnapshot(snapshot); } catch { /* client vanished */ }
    }
    session.pending = null;
    session.attached = client;
    // Only what the snapshot doesn't already show — xterm may have applied
    // some queued chunks before the snapshot was taken.
    for (const item of hand.queue) {
      if (item.seq <= snap.seq) continue;
      try { client.send(item.data); } catch { /* vanished */ }
    }
    return snapshot;
  }

  /**
   * Detach the given client. The SSH session keeps running; an idle-grace
   * reap timer starts so abandoned sessions don't live forever.
   */
  detach(id: string, client: AttachedClient): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.pending?.client === client) {
      // Went away before its snapshot was ready.
      session.pending = null;
      if (!session.attached) this.startReap(session);
      return;
    }
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
      if (session.pending?.client.loginSessionId === loginSessionId) {
        const waiting = session.pending.client;
        session.pending = null;
        try { waiting.end(reason); } catch { /* ignore */ }
        if (!session.attached) this.startReap(session);
      }
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
    if (session.onInput) {
      try { session.onInput(data); } catch { /* capture must never break the session */ }
    }
    try { session.stream.write(data); } catch { /* stream may have just closed */ }
  }

  /** Resize the PTY. */
  resize(id: string, rows: number, cols: number, from?: AttachedClient): void {
    const session = this.sessions.get(id);
    if (!session || session.closed || !session.stream) return;
    if (from && session.attached !== from) return;
    try { session.stream.setWindow(rows, cols, 0, 0); } catch { /* ignore */ }
    session.mirror.resize(cols, rows);
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
    if (session.pending) {
      try { session.pending.client.end(reason); } catch { /* ignore */ }
      session.pending = null;
    }
    session.mirror.dispose();
    // After onEnd (the recorder has flushed with it): the key is no longer needed.
    session.dataKey?.fill(0);
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
