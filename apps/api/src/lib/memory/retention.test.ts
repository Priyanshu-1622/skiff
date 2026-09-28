import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runColumnMigrations } from "../../db/client.js";
import { newDataKey, wrapDataKey } from "../../crypto/data-keys.js";
import { beginMemorySession, saveCommandEntry, loadCommandEntry } from "./store.js";
import { startRetentionSweep } from "./retention.js";
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
  // schema.sql does not seed a vault_meta row (it's created by the real
  // setup flow) — insert one here so the UPDATE ... WHERE id = 1 calls
  // below actually affect a row instead of silently no-op-ing.
  d.prepare(
    `INSERT INTO vault_meta (id, schema_version, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, created_at)
     VALUES (1, 6, x'00', 3, 65536, 4, x'00', 'then')`
  ).run();
  return d;
}

function fakeEvent(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return {
    command: "whoami", exitCode: 0, cwd: null, confidence: "screen", flags: [],
    output: "piyup\n", outputBytes: 6, outputPruned: false, ended: "exited", startedAt: Date.now(),
    ...overrides,
  };
}

test("a sweep tick trims output on entries past vault_meta.memory_output_days using the currently unlocked vault key", async () => {
  const d = freshDb();
  const vaultKey = newDataKey(); // stand-in vault key for this test
  const dataKey = newDataKey();
  const { nonce, wrapped } = wrapDataKey(dataKey, vaultKey);
  d.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES ('key1', ?, ?, 'then')").run(wrapped, nonce);
  const id = beginMemorySession(d, { serverId: null, hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  saveCommandEntry(d, dataKey, { memorySessionId: id, serverId: null, userId: null, event: fakeEvent() });
  const row = d.prepare("SELECT id FROM memory_entries WHERE memory_session_id = ?").get(id) as any;
  const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  d.prepare("UPDATE memory_entries SET started_at = ? WHERE id = ?").run(oldDate, row.id);
  d.prepare("UPDATE vault_meta SET memory_output_days = 90 WHERE id = 1").run();

  const sweep = startRetentionSweep(d, () => vaultKey, 24 * 60 * 60 * 1000);
  await sweep.tick(); // run one sweep synchronously for the test, without waiting a real day
  sweep.stop();

  const after = loadCommandEntry(d, dataKey, row.id);
  assert.equal(after.output, "");
});

test("a sweep tick while locked (no vault key available) does nothing and does not throw", async () => {
  const d = freshDb();
  const sweep = startRetentionSweep(d, () => null, 24 * 60 * 60 * 1000);
  await sweep.tick();
  sweep.stop();
});

test("a sweep tick does nothing if the last successful run was recent, even with old entries and an unlocked vault", async () => {
  const d = freshDb();
  const vaultKey = newDataKey();
  const dataKey = newDataKey();
  const { nonce, wrapped } = wrapDataKey(dataKey, vaultKey);
  d.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES ('key1', ?, ?, 'then')").run(wrapped, nonce);
  const id = beginMemorySession(d, { serverId: null, hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  saveCommandEntry(d, dataKey, { memorySessionId: id, serverId: null, userId: null, event: fakeEvent() });
  const row = d.prepare("SELECT id FROM memory_entries WHERE memory_session_id = ?").get(id) as any;
  const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  d.prepare("UPDATE memory_entries SET started_at = ? WHERE id = ?").run(oldDate, row.id);
  d.prepare("UPDATE vault_meta SET memory_output_days = 90, memory_last_retention_at = ? WHERE id = 1")
    .run(new Date().toISOString()); // "just ran successfully"

  const sweep = startRetentionSweep(d, () => vaultKey, 1000);
  await sweep.tick();
  sweep.stop();

  const after = loadCommandEntry(d, dataKey, row.id);
  assert.equal(after.output, "piyup\n", "too soon since the last successful run; nothing trimmed yet");
});

test("a sweep tick runs real work once 24h have passed since the last successful run, and records the new run time", async () => {
  const d = freshDb();
  const vaultKey = newDataKey();
  const dataKey = newDataKey();
  const { nonce, wrapped } = wrapDataKey(dataKey, vaultKey);
  d.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES ('key1', ?, ?, 'then')").run(wrapped, nonce);
  const id = beginMemorySession(d, { serverId: null, hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  saveCommandEntry(d, dataKey, { memorySessionId: id, serverId: null, userId: null, event: fakeEvent() });
  const row = d.prepare("SELECT id FROM memory_entries WHERE memory_session_id = ?").get(id) as any;
  const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  d.prepare("UPDATE memory_entries SET started_at = ? WHERE id = ?").run(oldDate, row.id);
  const staleRunDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
  d.prepare("UPDATE vault_meta SET memory_output_days = 90, memory_last_retention_at = ? WHERE id = 1").run(staleRunDate);

  const sweep = startRetentionSweep(d, () => vaultKey, 1000);
  await sweep.tick();
  sweep.stop();

  const after = loadCommandEntry(d, dataKey, row.id);
  assert.equal(after.output, "", "24h+ since the last run, and the vault happens to be unlocked right now: the sweep must actually run");
  const meta = d.prepare("SELECT memory_last_retention_at FROM vault_meta WHERE id = 1").get() as any;
  assert.notEqual(meta.memory_last_retention_at, staleRunDate, "the last-run marker is updated after a real sweep");
});

test("stop() prevents any further scheduled tick from running", async () => {
  const d = freshDb();
  let ticks = 0;
  const sweep = startRetentionSweep(d, () => null, 10); // 10ms interval, short for the test
  const orig = sweep.tick;
  sweep.tick = async () => { ticks++; return orig(); };
  await new Promise((r) => setTimeout(r, 35));
  sweep.stop();
  const countAtStop = ticks;
  assert.ok(countAtStop > 0, "the interval must actually dispatch through the (possibly wrapped) tick, not a closed-over original");
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(ticks, countAtStop, "no tick ran after stop()");
});
