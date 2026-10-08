import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runColumnMigrations } from "../../db/client.js";
import { newDataKey, wrapDataKey } from "../../crypto/data-keys.js";
import { SessionStore } from "../../crypto/session-store.js";
import { beginMemorySession, saveCommandEntry, beginPauseEntry } from "./store.js";
import { MemoryIndexes } from "./indexes.js";
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
  return d;
}

function ev(command: string, over: Partial<CommandEvent> = {}): CommandEvent {
  return {
    command, exitCode: 0, cwd: "/srv", confidence: "screen", flags: [], output: `out of ${command}\n`,
    outputBytes: 10, outputPruned: false, ended: "exited", startedAt: Date.now(), ...over,
  };
}

/** One memory session (own session key, wrapped under vaultKey) with the given commands saved for userId. */
function seed(d: Database.Database, vaultKey: Buffer, keyId: string, userId: string | null, commands: string[]) {
  const dataKey = newDataKey();
  const { nonce, wrapped } = wrapDataKey(dataKey, vaultKey);
  d.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES (?, ?, ?, 'then')").run(keyId, wrapped, nonce);
  const id = beginMemorySession(d, { serverId: null, hostId: "h1", userId, username: null, keyId, recordingId: null });
  for (const c of commands) saveCommandEntry(d, dataKey, { memorySessionId: id, serverId: null, userId, event: ev(c) });
  return { memorySessionId: id, dataKey };
}

function setup() {
  const db = freshDb();
  const store = new SessionStore(15);
  const vaultKey = newDataKey();
  const indexes = new MemoryIndexes(db, store);
  return { db, store, vaultKey, indexes, done: () => { indexes.closeAll(); store.close(); } };
}

test("forLogin indexes every visible entry and search finds them", async () => {
  const { db, vaultKey, indexes, done } = setup();
  seed(db, vaultKey, "k1", null, ["whoami", "pwd", "uptime"]);
  const ix = await indexes.forLogin("login1", vaultKey, null);
  assert.equal(ix.size(), 3);
  assert.deepEqual(ix.search("whoami").map((h) => h.command), ["whoami"]);
  done();
});

test("catch-up is incremental: later calls index only new rows, never duplicating earlier ones", async () => {
  const { db, vaultKey, indexes, done } = setup();
  const s = seed(db, vaultKey, "k1", null, ["whoami", "pwd", "uptime"]);
  const first = await indexes.forLogin("login1", vaultKey, null);
  saveCommandEntry(db, s.dataKey, { memorySessionId: s.memorySessionId, serverId: null, userId: null, event: ev("df -h") });
  const second = await indexes.forLogin("login1", vaultKey, null);
  assert.equal(second, first, "same index object for the same login");
  assert.equal(second.size(), 4);
  assert.equal(second.search("whoami").length, 1);
  assert.equal(second.search("df").length, 1);
  done();
});

test("a corrupted LAST entry is skipped and the watermark still moves past it, so it is not retried forever", { timeout: 5000 }, async () => {
  const { db, vaultKey, indexes, done } = setup();
  seed(db, vaultKey, "k1", null, ["whoami", "pwd", "uptime"]);
  const victim = db.prepare("SELECT id, data FROM memory_entries ORDER BY rowid DESC LIMIT 1").get() as { id: string; data: Buffer };
  db.prepare("UPDATE memory_entries SET data = ? WHERE id = ?").run(Buffer.alloc(victim.data.length, 3), victim.id);
  const ix = await indexes.forLogin("login1", vaultKey, null);
  assert.equal(ix.size(), 2);
  assert.deepEqual(ix.search("uptime"), []);
  assert.equal(ix.search("whoami").length, 1);
  assert.equal(ix.watermark, 3, "watermark covers the skipped last row; no later row exists to advance it");
  done();
});

test("an unreadable session key (on the newest session) makes its entries unsearchable, keeps the rest, and still advances the watermark", { timeout: 5000 }, async () => {
  const { db, vaultKey, indexes, done } = setup();
  seed(db, vaultKey, "k1", null, ["whoami"]);
  seed(db, vaultKey, "k2", null, ["pwd"]);
  db.prepare("UPDATE session_keys SET wrapped_key = zeroblob(length(wrapped_key)) WHERE id = 'k2'").run();
  const ix = await indexes.forLogin("login1", vaultKey, null);
  assert.equal(ix.search("whoami").length, 1);
  assert.deepEqual(ix.search("pwd"), []);
  assert.equal(ix.watermark, 2);
  done();
});

test("visibleUserId limits the index to that user's entries", async () => {
  const { db, vaultKey, indexes, done } = setup();
  seed(db, vaultKey, "k1", "u1", ["whoami"]);
  seed(db, vaultKey, "k2", "u2", ["pwd"]);
  const ix = await indexes.forLogin("login-u1", vaultKey, "u1");
  assert.equal(ix.size(), 1);
  assert.equal(ix.search("whoami").length, 1);
  assert.deepEqual(ix.search("pwd"), []);
  done();
});

test("destroying the login session drops its index; a later call rebuilds from the database", async () => {
  const { db, store, vaultKey, indexes, done } = setup();
  seed(db, vaultKey, "k1", null, ["whoami"]);
  const loginId = store.create(vaultKey);
  const first = await indexes.forLogin(loginId, vaultKey, null);
  assert.equal(indexes.has(loginId), true);
  store.destroy(loginId);
  assert.equal(indexes.has(loginId), false);
  const second = await indexes.forLogin(loginId, vaultKey, null);
  assert.notEqual(second, first);
  assert.equal(second.search("whoami").length, 1);
  done();
});

test("a large catch-up yields to the event loop instead of blocking it", async () => {
  const { db, vaultKey, indexes, done } = setup();
  const cmds = Array.from({ length: 450 }, (_, i) => `cmd${i}`);
  seed(db, vaultKey, "k1", null, cmds);
  let yielded = false;
  setImmediate(() => { yielded = true; });
  let yieldedBeforeDone = false;
  const p = indexes.forLogin("login1", vaultKey, null).then(() => { yieldedBeforeDone = yielded; });
  await p;
  assert.equal(yieldedBeforeDone, true, "a callback scheduled before the build ran before it finished");
  done();
});

test("concurrent calls for one login do not double-index", async () => {
  const { db, vaultKey, indexes, done } = setup();
  seed(db, vaultKey, "k1", null, ["whoami", "pwd", "uptime"]);
  const [a, b] = await Promise.all([indexes.forLogin("login1", vaultKey, null), indexes.forLogin("login1", vaultKey, null)]);
  assert.equal(a, b);
  assert.equal(a.size(), 3);
  done();
});

test("destroying the login while a catch-up is still running waits for it instead of closing the index under it", { timeout: 5000 }, async () => {
  const { db, store, vaultKey, indexes, done } = setup();
  seed(db, vaultKey, "k1", null, Array.from({ length: 450 }, (_, i) => `cmd${i}`));
  const loginId = store.create(vaultKey);
  const inflight = indexes.forLogin(loginId, vaultKey, null);
  store.destroy(loginId);
  await assert.doesNotReject(inflight, "the in-flight build must finish cleanly");
  assert.equal(indexes.has(loginId), false);
  done();
});

test("forget removes the entry from every live login's index", async () => {
  const { db, vaultKey, indexes, done } = setup();
  seed(db, vaultKey, "k1", null, ["whoami", "pwd"]);
  const a = await indexes.forLogin("loginA", vaultKey, null);
  const b = await indexes.forLogin("loginB", vaultKey, null);
  const id = a.search("whoami")[0].id;
  db.prepare("DELETE FROM memory_entries WHERE id = ?").run(id);
  await indexes.forget(id);
  assert.deepEqual(a.search("whoami"), []);
  assert.deepEqual(b.search("whoami"), []);
  assert.equal(a.search("pwd").length, 1);
  done();
});

test("after forgetting the newest entry, a new entry that reuses its rowid is still indexed", async () => {
  const { db, vaultKey, indexes, done } = setup();
  const s = seed(db, vaultKey, "k1", null, ["whoami", "pwd", "uptime"]);
  const ix = await indexes.forLogin("login1", vaultKey, null);
  const newest = ix.search("uptime")[0].id;
  db.prepare("DELETE FROM memory_entries WHERE id = ?").run(newest);
  await indexes.forget(newest);
  saveCommandEntry(db, s.dataKey, { memorySessionId: s.memorySessionId, serverId: null, userId: null, event: ev("df -h") });
  const reused = (db.prepare("SELECT rowid AS r FROM memory_entries WHERE rowid = 3").get() as { r: number } | undefined)?.r;
  assert.equal(reused, 3, "the precondition: SQLite did reuse rowid 3");
  await indexes.forLogin("login1", vaultKey, null);
  assert.equal(ix.search("df").length, 1, "the command that reused the rowid is searchable");
  assert.equal(ix.size(), 3);
  done();
});

test("forget with no live indexes is a no-op", async () => {
  const { indexes, done } = setup();
  await assert.doesNotReject(indexes.forget("anything"));
  done();
});

test("pause entries are not indexed, and do not stall the watermark", async () => {
  const { db, vaultKey, indexes, done } = setup();
  const s = seed(db, vaultKey, "k1", null, ["whoami"]);
  beginPauseEntry(db, s.dataKey, { memorySessionId: s.memorySessionId, serverId: null, userId: null, username: "bob" });
  saveCommandEntry(db, s.dataKey, { memorySessionId: s.memorySessionId, serverId: null, userId: null, event: ev("uptime") });
  const ix = await indexes.forLogin("login1", vaultKey, null);
  assert.equal(ix.size(), 2, "the two commands only");
  assert.equal(ix.search("uptime").length, 1);
  assert.equal(ix.watermark, 3, "the pause row advanced the watermark");
  done();
});
