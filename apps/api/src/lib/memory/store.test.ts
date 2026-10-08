import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runColumnMigrations } from "../../db/client.js";
import { newDataKey, openEntry } from "../../crypto/data-keys.js";
import { beginMemorySession, endMemorySession, saveCommandEntry, loadCommandEntry, pruneOldOutput, beginPauseEntry, endPauseEntry } from "./store.js";
import type { CommandEvent } from "../capture/engine.js";

const here = dirname(fileURLToPath(import.meta.url));

function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(readFileSync(join(here, "../../db/schema.sql"), "utf-8"));
  runColumnMigrations(d);
  d.prepare(
    "INSERT INTO hosts (id,label,hostname,port,username,auth_method,created_at) VALUES ('h1','prod','10.0.0.1',22,'deploy','password','then')"
  ).run();
  d.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES ('key1', x'00', x'00', 'then')").run();
  return d;
}

function fakeEvent(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return {
    command: "whoami",
    exitCode: 0,
    cwd: "/home/deploy",
    confidence: "screen",
    flags: [],
    output: "piyup\n",
    outputBytes: 6,
    outputPruned: false,
    ended: "exited",
    startedAt: Date.now(),
    ...overrides,
  };
}

test("beginMemorySession creates a row; endMemorySession stamps ended_at and a command count", () => {
  const d = freshDb();
  const id = beginMemorySession(d, { serverId: null, hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  const key = newDataKey();
  saveCommandEntry(d, key, { memorySessionId: id, serverId: null, userId: null, event: fakeEvent() });
  endMemorySession(d, id);
  const row = d.prepare("SELECT ended_at, stats_json FROM memory_sessions WHERE id = ?").get(id) as any;
  assert.ok(row.ended_at);
  assert.deepEqual(JSON.parse(row.stats_json), { commands: 1 });
});

test("saveCommandEntry stores exit_code/confidence/flags/output_bytes in the clear, and the command/output/cwd encrypted", () => {
  const d = freshDb();
  const id = beginMemorySession(d, { serverId: null, hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  const key = newDataKey();
  saveCommandEntry(d, key, { memorySessionId: id, serverId: null, userId: null, event: fakeEvent({ command: "findable-command-text" }) });
  const row = d.prepare("SELECT * FROM memory_entries WHERE memory_session_id = ?").get(id) as any;
  assert.equal(row.exit_code, 0);
  assert.equal(row.confidence, "screen");
  assert.deepEqual(JSON.parse(row.flags), []);
  assert.equal(row.output_bytes, 6);
  assert.equal(row.kind, "command");
  assert.equal((row.data as Buffer).includes("findable-command-text"), false, "command text is not stored in the clear");

  const decrypted = loadCommandEntry(d, key, row.id);
  assert.equal(decrypted.command, "findable-command-text");
  assert.equal(decrypted.output, "piyup\n");
  assert.equal(decrypted.cwd, "/home/deploy");
});

test("loadCommandEntry rejects the wrong data key", () => {
  const d = freshDb();
  const id = beginMemorySession(d, { serverId: null, hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  const key = newDataKey();
  saveCommandEntry(d, key, { memorySessionId: id, serverId: null, userId: null, event: fakeEvent() });
  const row = d.prepare("SELECT id FROM memory_entries WHERE memory_session_id = ?").get(id) as any;
  assert.throws(() => loadCommandEntry(d, newDataKey(), row.id));
});

test("pruneOldOutput clears output on entries past the retention window, leaving command/exit-code/timestamps intact", () => {
  const d = freshDb();
  const id = beginMemorySession(d, { serverId: null, hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  const key = newDataKey();
  saveCommandEntry(d, key, { memorySessionId: id, serverId: null, userId: null, event: fakeEvent({ command: "old one" }) });
  const row = d.prepare("SELECT id FROM memory_entries WHERE memory_session_id = ?").get(id) as any;
  const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  d.prepare("UPDATE memory_entries SET started_at = ? WHERE id = ?").run(oldDate, row.id);

  const trimmed = pruneOldOutput(d, () => key, 90);
  assert.equal(trimmed, 1);
  const after = loadCommandEntry(d, key, row.id);
  assert.equal(after.command, "old one", "command text survives retention trimming");
  assert.equal(after.output, "", "output is cleared");
  const dbRow = d.prepare("SELECT output_bytes FROM memory_entries WHERE id = ?").get(row.id) as any;
  assert.equal(dbRow.output_bytes, 0);
});

test("pruneOldOutput skips a session it can't get a data key for, without throwing, and still processes the rest", () => {
  const d = freshDb();
  const id = beginMemorySession(d, { serverId: null, hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  const key = newDataKey();
  saveCommandEntry(d, key, { memorySessionId: id, serverId: null, userId: null, event: fakeEvent() });
  const row = d.prepare("SELECT id FROM memory_entries WHERE memory_session_id = ?").get(id) as any;
  const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  d.prepare("UPDATE memory_entries SET started_at = ? WHERE id = ?").run(oldDate, row.id);

  const trimmed = pruneOldOutput(d, () => null, 90); // simulates "vault locked, can't unwrap this session's key"
  assert.equal(trimmed, 0);
  const dbRow = d.prepare("SELECT output_bytes FROM memory_entries WHERE id = ?").get(row.id) as any;
  assert.equal(dbRow.output_bytes, 6, "left untouched, not corrupted, when the key isn't available");
});

test("pruneOldOutput leaves recent entries' output alone", () => {
  const d = freshDb();
  const id = beginMemorySession(d, { serverId: null, hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  const key = newDataKey();
  saveCommandEntry(d, key, { memorySessionId: id, serverId: null, userId: null, event: fakeEvent() });
  const trimmed = pruneOldOutput(d, () => key, 90);
  assert.equal(trimmed, 0);
  const row = d.prepare("SELECT id FROM memory_entries WHERE memory_session_id = ?").get(id) as any;
  const after = loadCommandEntry(d, key, row.id);
  assert.equal(after.output, "piyup\n");
});

test("a still-running event (session ended mid-command) is stored with a null finished_at and exit_code, not dropped", () => {
  const d = freshDb();
  const id = beginMemorySession(d, { serverId: null, hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  const key = newDataKey();
  saveCommandEntry(d, key, { memorySessionId: id, serverId: null, userId: null, event: fakeEvent({ ended: "running", exitCode: null }) });
  const row = d.prepare("SELECT finished_at, exit_code FROM memory_entries WHERE memory_session_id = ?").get(id) as any;
  assert.equal(row.finished_at, null);
  assert.equal(row.exit_code, null);
});

test("pruneOldOutput skips a single corrupted entry (fails to decrypt) without aborting the rest of the sweep", () => {
  const d = freshDb();
  const id = beginMemorySession(d, { serverId: null, hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  const key = newDataKey();
  saveCommandEntry(d, key, { memorySessionId: id, serverId: null, userId: null, event: fakeEvent({ command: "good one" }) });
  saveCommandEntry(d, key, { memorySessionId: id, serverId: null, userId: null, event: fakeEvent({ command: "corrupted one" }) });
  saveCommandEntry(d, key, { memorySessionId: id, serverId: null, userId: null, event: fakeEvent({ command: "good two" }) });
  const rows = d.prepare("SELECT id FROM memory_entries WHERE memory_session_id = ? ORDER BY rowid").all(id) as any[];
  const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  for (const r of rows) d.prepare("UPDATE memory_entries SET started_at = ? WHERE id = ?").run(oldDate, r.id);
  // Corrupt the middle row's ciphertext so it fails to authenticate.
  const middle = d.prepare("SELECT data FROM memory_entries WHERE id = ?").get(rows[1].id) as any;
  const corrupted = Buffer.from(middle.data);
  corrupted[corrupted.length - 1] ^= 1;
  d.prepare("UPDATE memory_entries SET data = ? WHERE id = ?").run(corrupted, rows[1].id);

  const trimmed = pruneOldOutput(d, () => key, 90);
  assert.equal(trimmed, 2, "the two good entries are still trimmed despite the corrupted one between them");
  assert.equal(loadCommandEntry(d, key, rows[0].id).output, "", "entry before the corrupted one was trimmed");
  assert.equal(loadCommandEntry(d, key, rows[2].id).output, "", "entry after the corrupted one was trimmed");
  const untouchedRow = d.prepare("SELECT output_bytes FROM memory_entries WHERE id = ?").get(rows[1].id) as any;
  assert.equal(untouchedRow.output_bytes, 6, "the corrupted row itself is left alone, not further damaged");
});

test("beginPauseEntry stores an encrypted pause row that is still open, naming who paused", () => {
  const d = freshDb();
  const key = newDataKey();
  const sid = beginMemorySession(d, { serverId: null, hostId: "h1", userId: "u1", username: "bob", keyId: "key1", recordingId: null });
  const id = beginPauseEntry(d, key, { memorySessionId: sid, serverId: null, userId: "u1", username: "bob" });
  const row = d.prepare("SELECT kind, started_at, finished_at, user_id, nonce, data FROM memory_entries WHERE id = ?").get(id) as any;
  assert.equal(row.kind, "pause");
  assert.equal(row.user_id, "u1");
  assert.ok(row.started_at);
  assert.equal(row.finished_at, null);
  assert.deepEqual(JSON.parse(openEntry(key, `memory-entry:${id}`, row.nonce, row.data).toString("utf8")), { by: "bob" });
  assert.ok(!Buffer.from(row.data).includes("bob"), "the name is not stored in the clear");

  const anon = beginPauseEntry(d, key, { memorySessionId: sid, serverId: null, userId: null, username: null });
  const anonRow = d.prepare("SELECT nonce, data FROM memory_entries WHERE id = ?").get(anon) as any;
  assert.deepEqual(JSON.parse(openEntry(key, `memory-entry:${anon}`, anonRow.nonce, anonRow.data).toString("utf8")), { by: null });
});

test("endPauseEntry closes a pause once, never overwrites it, and ignores unknown or non-pause ids", () => {
  const d = freshDb();
  const key = newDataKey();
  const sid = beginMemorySession(d, { serverId: null, hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  const id = beginPauseEntry(d, key, { memorySessionId: sid, serverId: null, userId: null, username: null });
  endPauseEntry(d, id);
  const first = (d.prepare("SELECT finished_at FROM memory_entries WHERE id = ?").get(id) as any).finished_at;
  assert.ok(first);
  d.prepare("UPDATE memory_entries SET finished_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  endPauseEntry(d, id);
  assert.equal((d.prepare("SELECT finished_at FROM memory_entries WHERE id = ?").get(id) as any).finished_at, "2000-01-01T00:00:00.000Z", "a second call changes nothing");
  assert.doesNotThrow(() => endPauseEntry(d, "nope"));

  saveCommandEntry(d, key, { memorySessionId: sid, serverId: null, userId: null, event: fakeEvent({ ended: "running" }) });
  const cmd = d.prepare("SELECT id FROM memory_entries WHERE kind = 'command'").get() as any;
  endPauseEntry(d, cmd.id);
  assert.equal((d.prepare("SELECT finished_at FROM memory_entries WHERE id = ?").get(cmd.id) as any).finished_at, null, "a command entry is never touched");
});
