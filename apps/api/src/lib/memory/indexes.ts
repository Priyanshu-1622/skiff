import type Database from "better-sqlite3";
import type { SessionStore } from "../../crypto/session-store.js";
import { openEntry } from "../../crypto/data-keys.js";
import { MemoryIndex } from "./index.js";
import type { FileMeta } from "./store.js";
import { makeKeyCache } from "./keys.js";

const BATCH_ROWS = 200;

interface Slot {
  index: MemoryIndex;
  chain: Promise<void>;
  retentionAt?: string | null;
}

/**
 * One in-memory index per login session. Built lazily on first use and caught
 * up on every later use by indexing only rows past the watermark, so capture
 * never has to know the index exists. Dropped the moment the login session is
 * destroyed (lock, idle expiry, logout): the plaintext index lives exactly as
 * long as the vault key that could decrypt the same data.
 */
export class MemoryIndexes {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly db: Database.Database, sessionStore: SessionStore) {
    sessionStore.onDestroy((loginId) => this.drop(loginId));
  }

  has(loginId: string): boolean {
    return this.slots.has(loginId);
  }

  /** Catches the login's index up with the database, then returns it. visibleUserId null = no per-user filter. */
  async forLogin(loginId: string, vaultKey: Buffer, visibleUserId: string | null): Promise<MemoryIndex> {
    let slot = this.slots.get(loginId);
    if (!slot) {
      slot = { index: new MemoryIndex(), chain: Promise.resolve() };
      this.slots.set(loginId, slot);
    }
    const s = slot;
    // Serialize catch-ups per login so two requests can't index the same rows twice.
    const run = s.chain.then(async () => {
      await this.catchUp(s.index, vaultKey, visibleUserId);
      const meta = this.db.prepare("SELECT memory_last_retention_at FROM vault_meta WHERE id = 1").get() as
        { memory_last_retention_at: string | null } | undefined;
      const retentionAt = meta?.memory_last_retention_at ?? null;
      if (retentionAt && retentionAt !== s.retentionAt) {
        const pruned = this.db.prepare("SELECT id FROM memory_entries WHERE output_bytes = 0 AND output_pruned = 1").all() as { id: string }[];
        for (const row of pruned) s.index.clearOutput(row.id);
      }
      s.retentionAt = retentionAt;
    });
    s.chain = run.catch(() => {});
    await run;
    return s.index;
  }

  private async catchUp(index: MemoryIndex, vaultKey: Buffer, visibleUserId: string | null): Promise<void> {
    const keys = makeKeyCache(this.db, vaultKey);
    try {
      for (;;) {
        const rows = this.db.prepare(
          `SELECT me.rowid AS rid, me.id, me.user_id AS uid, ms.username, ms.host_id, me.started_at, me.finished_at, me.exit_code, me.confidence, me.flags,
                  me.kind, me.nonce, me.data, ms.key_id
             FROM memory_entries me
             JOIN memory_sessions ms ON ms.id = me.memory_session_id
            WHERE me.rowid > ?${visibleUserId !== null ? " AND me.user_id = ?" : ""}
            ORDER BY me.rowid
            LIMIT ${BATCH_ROWS}`,
        ).all(...(visibleUserId !== null ? [index.watermark, visibleUserId] : [index.watermark])) as any[];
        if (rows.length === 0) return;
        const before = index.watermark;
        for (const row of rows) {
          if (row.kind !== "command" && row.kind !== "file") { index.skip(row.rid); continue; } // pause rows etc. are not searchable
          const key = keys.get(row.key_id);
          if (!key) { index.skip(row.rid); continue; }
          let payload: { command: string; output: string; cwd: string | null; file?: FileMeta };
          try {
            payload = JSON.parse(openEntry(key, `memory-entry:${row.id}`, row.nonce, row.data).toString("utf8"));
          } catch {
            index.skip(row.rid);
            continue;
          }
          index.add({
            rowid: row.rid, id: row.id, hostId: row.host_id, startedAt: row.started_at, finishedAt: row.finished_at,
            exitCode: row.exit_code, confidence: row.confidence, flags: JSON.parse(row.flags),
            ended: row.finished_at ? "exited" : "running",
            command: payload.command, cwd: payload.cwd ?? "", output: payload.output ?? "",
            userId: row.uid ?? null, username: row.username ?? null,
            kind: row.kind, file: payload.file ?? null,
          });
        }
        // Every row advances the watermark (added or skipped); if none did, re-selecting would loop forever.
        if (index.watermark === before) return;
        await new Promise<void>((r) => setImmediate(r));
      }
    } finally {
      keys.dispose();
    }
  }

  /** Removes an entry (already deleted from the database) from every live login's index, after any catch-up still running. */
  async forget(entryId: string): Promise<void> {
    await Promise.all([...this.slots.values()].map((slot) => {
      const run = slot.chain.then(() => { slot.index.remove(entryId); });
      slot.chain = run.catch(() => {});
      return run;
    }));
  }

  private drop(loginId: string): void {
    const slot = this.slots.get(loginId);
    if (!slot) return;
    this.slots.delete(loginId);
    // Wait for any in-flight catch-up before closing, so it can't write into a closed database.
    slot.chain.then(() => slot.index.close(), () => slot.index.close());
  }

  closeAll(): void {
    for (const id of [...this.slots.keys()]) this.drop(id);
  }
}
