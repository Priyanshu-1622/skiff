/**
 * Slows down password guessing without letting anyone lock the owner out.
 *
 * Every failed attempt is recorded against a key (e.g. the client's IP).
 * The first few failures are free — people mistype. After that each further
 * attempt from the same key must wait, and the wait doubles with every
 * failure, up to a cap. A correct password clears the key.
 *
 * Because keys are per client, an attacker hammering the login only slows
 * themselves down; the owner signing in from their own machine is untouched.
 * (Keying on the client IP only works when the server sees the real IP — see
 * SKIFF_TRUST_PROXY.)
 *
 * State is in memory: a restart forgets it, which is fine — an attacker can't
 * restart the server, and argon2 already makes each guess expensive.
 */

export interface AttemptLimiterOptions {
  /** Failures allowed before any waiting is required. */
  freeAttempts?: number;
  /** Wait after the first failure beyond the free ones. Doubles from there. */
  baseDelayMs?: number;
  /** Upper bound on the wait. */
  maxDelayMs?: number;
  /** Forget a key this long after its last failure. */
  forgetAfterMs?: number;
  now?: () => number;
}

interface Entry {
  failures: number;
  lastFailureAt: number;
}

export class AttemptLimiter {
  private entries = new Map<string, Entry>();
  private readonly freeAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly forgetAfterMs: number;
  private readonly now: () => number;

  constructor(opts: AttemptLimiterOptions = {}) {
    this.freeAttempts = opts.freeAttempts ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 1_000;
    this.maxDelayMs = opts.maxDelayMs ?? 15 * 60_000;
    this.forgetAfterMs = opts.forgetAfterMs ?? 24 * 60 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** How long this key must still wait before its next attempt (0 = go ahead). */
  retryAfterMs(key: string): number {
    const entry = this.live(key);
    if (!entry || entry.failures < this.freeAttempts) return 0;
    const over = entry.failures - this.freeAttempts; // 0 on the first penalised attempt
    const delay = Math.min(this.baseDelayMs * 2 ** Math.min(over, 30), this.maxDelayMs);
    return Math.max(0, entry.lastFailureAt + delay - this.now());
  }

  recordFailure(key: string): void {
    const entry = this.live(key);
    const now = this.now();
    if (entry) {
      entry.failures++;
      entry.lastFailureAt = now;
    } else {
      this.entries.set(key, { failures: 1, lastFailureAt: now });
    }
    this.prune();
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.lastFailureAt > this.forgetAfterMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Keep memory bounded even under a flood of distinct keys. */
  private prune(): void {
    if (this.entries.size <= 10_000) return;
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastFailureAt > this.forgetAfterMs) this.entries.delete(key);
    }
    // Still too many (a flood within the window): drop the oldest.
    if (this.entries.size > 10_000) {
      const oldest = [...this.entries.entries()]
        .sort((a, b) => a[1].lastFailureAt - b[1].lastFailureAt)
        .slice(0, this.entries.size - 10_000);
      for (const [key] of oldest) this.entries.delete(key);
    }
  }
}
