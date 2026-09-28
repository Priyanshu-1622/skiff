import type Database from "better-sqlite3";
import { unwrapDataKey } from "../../crypto/data-keys.js";
import { pruneOldOutput } from "./store.js";

export interface RetentionSweep {
  /** Runs one sweep immediately — exposed for tests; production code only relies on the interval. */
  tick: () => Promise<void>;
  stop: () => void;
}

const RUN_AT_MOST_EVERY_MS = 24 * 60 * 60 * 1000;
// Checked far more often than once a day, so a vault that's only briefly
// unlocked (typical idle timeouts are 15-30 minutes) still gets many
// chances to coincide with the 24h-since-last-run window — a fixed 24h
// timer only ever gets exactly one chance per day, and every restart
// (a routine Docker update) resets its clock to zero.
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Periodically trims output on memory_entries older than vault_meta's
 * memory_output_days (default 90). Requires the vault to currently be
 * unlocked to unwrap each session's data key — a locked vault means this
 * tick simply does nothing (not an error; the next tick tries again).
 * Real work only happens once RUN_AT_MOST_EVERY_MS has passed since the
 * last successful run (tracked in vault_meta.memory_last_retention_at) —
 * checking every tick is cheap, so this is checked far more often than it
 * actually runs, maximizing the chance of catching the vault unlocked.
 */
export function startRetentionSweep(
  db: Database.Database,
  getUnlockedVaultKey: () => Buffer | null,
  intervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
): RetentionSweep {
  const result: RetentionSweep = {
    tick: async (): Promise<void> => {
      const vaultKey = getUnlockedVaultKey();
      if (!vaultKey) return;
      const meta = db.prepare("SELECT memory_output_days, memory_last_retention_at FROM vault_meta WHERE id = 1").get() as
        | { memory_output_days: number; memory_last_retention_at: string | null } | undefined;
      if (meta?.memory_last_retention_at) {
        const elapsed = Date.now() - new Date(meta.memory_last_retention_at).getTime();
        if (elapsed < RUN_AT_MOST_EVERY_MS) return;
      }
      const days = meta?.memory_output_days ?? 90;
      pruneOldOutput(
        db,
        (keyId) => {
          const row = db.prepare("SELECT wrapped_key, nonce FROM session_keys WHERE id = ?").get(keyId) as
            | { wrapped_key: Buffer; nonce: Buffer } | undefined;
          if (!row) return null;
          try { return unwrapDataKey(row.wrapped_key, row.nonce, vaultKey); } catch { return null; }
        },
        days,
      );
      db.prepare("UPDATE vault_meta SET memory_last_retention_at = ? WHERE id = 1").run(new Date().toISOString());
    },
    stop: () => clearInterval(timer),
  };

  // Dispatched through `result.tick` (not a closed-over local) so a test
  // wrapping `sweep.tick` after construction still observes future ticks.
  const timer = setInterval(() => { result.tick().catch(() => {}); }, intervalMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  return result;
}
