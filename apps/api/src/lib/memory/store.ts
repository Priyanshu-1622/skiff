import type Database from "better-sqlite3";
import { generateId } from "../id.js";
import { sealEntry, openEntry } from "../../crypto/data-keys.js";
import type { CommandEvent } from "../capture/engine.js";

export function beginMemorySession(
  db: Database.Database,
  opts: { serverId: string | null; hostId: string; userId: string | null; username: string | null; keyId: string; recordingId: string | null },
): string {
  const id = generateId("msess");
  db.prepare(
    `INSERT INTO memory_sessions (id, server_id, host_id, user_id, username, key_id, recording_id, started_at, stats_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  ).run(id, opts.serverId, opts.hostId, opts.userId, opts.username, opts.keyId, opts.recordingId, new Date().toISOString());
  return id;
}

export function endMemorySession(db: Database.Database, memorySessionId: string): void {
  const { c } = db.prepare("SELECT COUNT(*) c FROM memory_entries WHERE memory_session_id = ?").get(memorySessionId) as { c: number };
  db.prepare("UPDATE memory_sessions SET ended_at = ?, stats_json = ? WHERE id = ?")
    .run(new Date().toISOString(), JSON.stringify({ commands: c }), memorySessionId);
}

interface EntryPayload {
  command: string;
  output: string;
  cwd: string | null;
}

export function saveCommandEntry(
  db: Database.Database,
  dataKey: Buffer,
  opts: { memorySessionId: string; serverId: string | null; userId: string | null; event: CommandEvent },
): void {
  const id = generateId("mentry");
  const { event } = opts;
  const payload: EntryPayload = { command: event.command, output: event.output, cwd: event.cwd };
  const { nonce, data } = sealEntry(dataKey, `memory-entry:${id}`, Buffer.from(JSON.stringify(payload), "utf8"));
  const startedAt = new Date(event.startedAt).toISOString();
  const finishedAt = event.ended === "exited" ? new Date().toISOString() : null;
  db.prepare(
    `INSERT INTO memory_entries
       (id, memory_session_id, server_id, user_id, kind, started_at, finished_at, exit_code, confidence, flags, output_bytes, output_pruned, nonce, data)
     VALUES (?, ?, ?, ?, 'command', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, opts.memorySessionId, opts.serverId, opts.userId,
    startedAt, finishedAt, event.exitCode, event.confidence, JSON.stringify(event.flags),
    event.outputBytes, event.outputPruned ? 1 : 0, nonce, data,
  );
}

export function beginPauseEntry(
  db: Database.Database,
  dataKey: Buffer,
  opts: { memorySessionId: string; serverId: string | null; userId: string | null; username: string | null },
): string {
  const id = generateId("mentry");
  const { nonce, data } = sealEntry(dataKey, `memory-entry:${id}`, Buffer.from(JSON.stringify({ by: opts.username }), "utf8"));
  db.prepare(
    `INSERT INTO memory_entries
       (id, memory_session_id, server_id, user_id, kind, started_at, finished_at, exit_code, confidence, flags, output_bytes, output_pruned, nonce, data)
     VALUES (?, ?, ?, ?, 'pause', ?, NULL, NULL, NULL, '[]', 0, 0, ?, ?)`,
  ).run(id, opts.memorySessionId, opts.serverId, opts.userId, new Date().toISOString(), nonce, data);
  return id;
}

export function endPauseEntry(db: Database.Database, entryId: string): void {
  db.prepare("UPDATE memory_entries SET finished_at = ? WHERE id = ? AND kind = 'pause' AND finished_at IS NULL").run(new Date().toISOString(), entryId);
}

export function loadCommandEntry(db: Database.Database, dataKey: Buffer, entryId: string): EntryPayload {
  const row = db.prepare("SELECT nonce, data FROM memory_entries WHERE id = ?").get(entryId) as
    | { nonce: Buffer; data: Buffer } | undefined;
  if (!row) throw new Error("no such memory entry");
  const plain = openEntry(dataKey, `memory-entry:${entryId}`, row.nonce, row.data);
  return JSON.parse(plain.toString("utf8")) as EntryPayload;
}

/**
 * Clears the `output` field on entries older than `olderThanDays`, leaving
 * command text, exit code, and every plaintext column untouched. Requires
 * decrypting each entry (to strip output before re-sealing) and re-sealing
 * it — `getDataKey(keyId, sessionRow)` returns `null` when that session's
 * key can't currently be unwrapped (vault locked, or the session predates
 * data keys entirely); such rows are left alone, not corrupted, and don't
 * stop the sweep from covering everything else. Grouped by session so each
 * session's key is unwrapped once, not once per entry.
 */
export function pruneOldOutput(
  db: Database.Database,
  getDataKey: (keyId: string, sessionRow: { id: string }) => Buffer | null,
  olderThanDays: number,
): number {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const sessions = db.prepare(
    `SELECT DISTINCT ms.id, ms.key_id
       FROM memory_sessions ms
       JOIN memory_entries me ON me.memory_session_id = ms.id
      WHERE me.started_at < ? AND me.output_bytes > 0`,
  ).all(cutoff) as Array<{ id: string; key_id: string }>;

  let trimmed = 0;
  for (const session of sessions) {
    const key = getDataKey(session.key_id, { id: session.id });
    if (!key) continue;
    const entries = db.prepare(
      "SELECT id, nonce, data FROM memory_entries WHERE memory_session_id = ? AND started_at < ? AND output_bytes > 0",
    ).all(session.id, cutoff) as Array<{ id: string; nonce: Buffer; data: Buffer }>;
    for (const entry of entries) {
      try {
        const plain = openEntry(key, `memory-entry:${entry.id}`, entry.nonce, entry.data);
        const payload = JSON.parse(plain.toString("utf8")) as EntryPayload;
        const stripped: EntryPayload = { ...payload, output: "" };
        const sealed = sealEntry(key, `memory-entry:${entry.id}`, Buffer.from(JSON.stringify(stripped), "utf8"));
        db.prepare("UPDATE memory_entries SET nonce = ?, data = ?, output_bytes = 0, output_pruned = 1 WHERE id = ?")
          .run(sealed.nonce, sealed.data, entry.id);
        trimmed++;
      } catch {
        // A single corrupted/undecryptable row must not stop the sweep
        // from covering every other entry, this tick or any future one.
      }
    }
  }
  return trimmed;
}
