import { randomBytes } from "node:crypto";

export interface SessionUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface SessionEntry {
  vaultKey: Buffer;
  createdAt: number;
  lastSeenAt: number;
  /** Present in team mode; undefined in personal mode. */
  user?: SessionUser;
}

export class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  private idleTimeoutMs: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private destroyListeners = new Set<(sessionId: string) => void>();

  constructor(idleTimeoutMinutes: number = 15) {
    this.idleTimeoutMs = idleTimeoutMinutes * 60 * 1000;
    this.startCleanup();
  }

  /**
   * Create a new session. In personal mode `user` is omitted; in team
   * mode it carries the authenticated user's identity so routes can
   * attribute actions in the audit log.
   */
  create(vaultKey: Buffer, user?: SessionUser): string {
    const id = randomBytes(32).toString("hex");
    const now = Date.now();
    this.sessions.set(id, {
      vaultKey: Buffer.from(vaultKey),
      createdAt: now,
      lastSeenAt: now,
      user,
    });
    return id;
  }

  /**
   * Get the vault key for a session, updating its lastSeenAt.
   * Returns null if expired or not found.
   */
  get(sessionId: string): Buffer | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;

    if (Date.now() - entry.lastSeenAt > this.idleTimeoutMs) {
      this.destroy(sessionId);
      return null;
    }

    entry.lastSeenAt = Date.now();
    return entry.vaultKey;
  }

  /**
   * Get the full session entry (key + user identity), updating lastSeenAt.
   * Returns null if expired or not found.
   */
  getEntry(sessionId: string): SessionEntry | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    if (Date.now() - entry.lastSeenAt > this.idleTimeoutMs) {
      this.destroy(sessionId);
      return null;
    }
    entry.lastSeenAt = Date.now();
    return entry;
  }

  /**
   * Destroy every session belonging to a given user (e.g. on disable), or all
   * but one of them (`exceptSessionId`) when they change their own password.
   */
  destroyUserSessions(userId: string, exceptSessionId?: string): void {
    for (const [id, entry] of this.sessions) {
      if (entry.user?.id === userId && id !== exceptSessionId) {
        this.destroy(id);
      }
    }
  }

  /** Destroy sessions that carry no user identity (personal-mode logins). */
  destroyAnonymous(): void {
    for (const [id, entry] of this.sessions) {
      if (!entry.user) this.destroy(id);
    }
  }

  /**
   * Destroy a session, zeroing the key in memory.
   */
  destroy(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.vaultKey.fill(0);
      this.sessions.delete(sessionId);
      for (const listener of this.destroyListeners) {
        try { listener(sessionId); } catch { /* a listener must not block destroy */ }
      }
    }
  }

  /**
   * Be told whenever a session ends — lock, idle expiry, disable, password
   * change. The terminal route uses this to detach any browser still attached
   * under that login, so a locked vault never leaves a live shell on screen.
   */
  onDestroy(listener: (sessionId: string) => void): () => void {
    this.destroyListeners.add(listener);
    return () => this.destroyListeners.delete(listener);
  }

  /**
   * Lock all sessions (e.g. manual lock button).
   */
  destroyAll(): void {
    for (const [id] of this.sessions) {
      this.destroy(id);
    }
  }

  /**
   * Update the idle timeout (e.g. from settings change).
   */
  setIdleTimeout(minutes: number): void {
    this.idleTimeoutMs = minutes * 60 * 1000;
    // Apply the new (possibly shorter) timeout right away rather than
    // waiting for the next sweep, so a tightened setting takes effect now.
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastSeenAt > this.idleTimeoutMs) {
        this.destroy(id);
      }
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  private startCleanup(): void {
    // Sweep every 60 seconds for expired sessions
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.sessions) {
        if (now - entry.lastSeenAt > this.idleTimeoutMs) {
          this.destroy(id);
        }
      }
    }, 60_000);

    // Allow the process to exit even if the interval is still running
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.destroyAll();
    this.destroyListeners.clear();
  }
}
