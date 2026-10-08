import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runColumnMigrations } from "../../db/client.js";
import { newDataKey } from "../../crypto/data-keys.js";
import { beginMemorySession } from "./store.js";
import { contentIdFor, getContent, lastContentId, pathHash, putContent, releaseContents, rememberFile, watchedPaths } from "./file-store.js";

const here = dirname(fileURLToPath(import.meta.url));

function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(readFileSync(join(here, "../../db/schema.sql"), "utf-8"));
  runColumnMigrations(d);
  d.prepare("INSERT INTO hosts (id,label,hostname,port,username,auth_method,created_at) VALUES ('h1','prod','10.0.0.1',22,'deploy','password','then')").run();
  d.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES ('key1', x'00', x'00', 'then')").run();
  for (const id of ["srv1", "srv2"]) {
    d.prepare("INSERT INTO servers (id, fingerprint, algorithm, first_seen_at, file_key_wrapped, file_key_nonce) VALUES (?, ?, 'ssh-ed25519', 'then', x'00', x'00')").run(id, `fp-${id}`);
  }
  return d;
}

/** A file entry row that references stored versions the way the tracker will. */
function fileEntry(d: Database.Database, id: string, oldId: string | null, newId: string | null) {
  const sid = (d.prepare("SELECT id FROM memory_sessions LIMIT 1").get() as { id: string } | undefined)?.id
    ?? beginMemorySession(d, { serverId: "srv1", hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  d.prepare(
    `INSERT INTO memory_entries (id, memory_session_id, server_id, user_id, kind, started_at, finished_at, flags, nonce, data, content_old_id, content_new_id)
     VALUES (?, ?, 'srv1', NULL, 'file', 'then', 'then', '[]', x'00', x'00', ?, ?)`,
  ).run(id, sid, oldId, newId);
}

test("the schema has the file tables and the entry reference columns", () => {
  const d = freshDb();
  const cols = (t: string) => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols("server_files").sort(), ["last_content_id", "path_data", "path_hash", "path_nonce", "server_id", "updated_at"]);
  assert.deepEqual(cols("file_contents").sort(), ["data", "id", "nonce", "server_id"]);
  assert.ok(cols("memory_entries").includes("content_old_id") && cols("memory_entries").includes("content_new_id"));
});

test("content ids are deterministic per key and text, and differ across keys and texts", () => {
  const k1 = newDataKey(), k2 = newDataKey();
  assert.equal(contentIdFor(k1, "hello"), contentIdFor(k1, "hello"));
  assert.notEqual(contentIdFor(k1, "hello"), contentIdFor(k1, "hello!"));
  assert.notEqual(contentIdFor(k1, "hello"), contentIdFor(k2, "hello"));
  assert.match(contentIdFor(k1, "hello"), /^[0-9a-f]{64}$/);
});

test("putContent is idempotent and getContent round-trips; a wrong key, a tampered row or a missing id read as null", () => {
  const d = freshDb();
  const key = newDataKey();
  const id = putContent(d, key, "srv1", "line one\nline two\n");
  assert.equal(putContent(d, key, "srv1", "line one\nline two\n"), id);
  assert.equal((d.prepare("SELECT COUNT(*) n FROM file_contents").get() as any).n, 1);
  assert.equal(getContent(d, key, id), "line one\nline two\n");
  assert.equal(getContent(d, newDataKey(), id), null);
  assert.equal(getContent(d, key, "nope"), null);
  const row = d.prepare("SELECT data FROM file_contents WHERE id = ?").get(id) as { data: Buffer };
  d.prepare("UPDATE file_contents SET data = ? WHERE id = ?").run(Buffer.alloc(row.data.length, 5), id);
  assert.equal(getContent(d, key, id), null);
  assert.equal(putContent(d, key, "srv1", ""), contentIdFor(key, ""), "an empty file is a valid version");
  assert.equal(getContent(d, key, contentIdFor(key, "")), "");
});

test("path hashes are stable per key and differ across keys and paths", () => {
  const k1 = newDataKey(), k2 = newDataKey();
  assert.equal(pathHash(k1, "/etc/hosts"), pathHash(k1, "/etc/hosts"));
  assert.notEqual(pathHash(k1, "/etc/hosts"), pathHash(k1, "/etc/hostname"));
  assert.notEqual(pathHash(k1, "/etc/hosts"), pathHash(k2, "/etc/hosts"));
});

test("rememberFile / lastContentId / watchedPaths round-trip; updating replaces in place; never-seen differs from missing", () => {
  const d = freshDb();
  const key = newDataKey();
  assert.equal(lastContentId(d, key, "srv1", "/etc/app.conf"), undefined, "never seen");
  const v1 = putContent(d, key, "srv1", "a\n");
  rememberFile(d, key, "srv1", "/etc/app.conf", v1);
  assert.equal(lastContentId(d, key, "srv1", "/etc/app.conf"), v1);
  const v2 = putContent(d, key, "srv1", "b\n");
  rememberFile(d, key, "srv1", "/etc/app.conf", v2);
  assert.equal(lastContentId(d, key, "srv1", "/etc/app.conf"), v2);
  assert.equal((d.prepare("SELECT COUNT(*) n FROM server_files").get() as any).n, 1, "updated in place");
  rememberFile(d, key, "srv1", "/etc/gone.conf", null);
  assert.equal(lastContentId(d, key, "srv1", "/etc/gone.conf"), null, "last seen missing");
  rememberFile(d, key, "srv2", "/other", null);
  assert.deepEqual(watchedPaths(d, key, "srv1").sort(), ["/etc/app.conf", "/etc/gone.conf"]);
  assert.deepEqual(watchedPaths(d, key, "srv2"), ["/other"]);
  assert.equal(lastContentId(d, key, "srv2", "/etc/app.conf"), undefined, "other servers don't see it");
});

test("releaseContents deletes unreferenced versions and keeps ones another entry or a watched path still uses", () => {
  const d = freshDb();
  const key = newDataKey();
  const a = putContent(d, key, "srv1", "version a\n");
  const b = putContent(d, key, "srv1", "version b\n");
  const c = putContent(d, key, "srv1", "version c\n");
  const e = putContent(d, key, "srv1", "version e\n");
  fileEntry(d, "e1", a, b);          // references a and b
  fileEntry(d, "e2", b, c);          // references b and c
  rememberFile(d, key, "srv1", "/etc/app.conf", e); // e is the watched file's latest
  // Forget e1: a is used only by e1, b is still used by e2.
  d.prepare("DELETE FROM memory_entries WHERE id = 'e1'").run();
  releaseContents(d, "srv1", [a, b]);
  assert.equal(getContent(d, key, a), null, "a was only referenced by the forgotten entry");
  assert.equal(getContent(d, key, b), "version b\n", "b is still referenced by e2");
  // Forget e2 too, but e stays because a watched path points at it.
  d.prepare("DELETE FROM memory_entries WHERE id = 'e2'").run();
  releaseContents(d, "srv1", [b, c, e]);
  assert.equal(getContent(d, key, b), null);
  assert.equal(getContent(d, key, c), null);
  assert.equal(getContent(d, key, e), "version e\n", "a watched path still points at it");
  const otherServer = putContent(d, key, "srv2", "another server's version\n");
  releaseContents(d, "srv1", [otherServer]);
  assert.equal(getContent(d, key, otherServer), "another server's version\n", "releasing for one server never touches another's versions");
  releaseContents(d, "srv1", []);
  releaseContents(d, "srv1", ["does-not-exist"]);
});

test("nothing in the file tables contains a path or file text in the clear", () => {
  const d = freshDb();
  const key = newDataKey();
  const id = putContent(d, key, "srv1", "db_password = SUPERSECRETVALUE\n");
  rememberFile(d, key, "srv1", "/etc/very-secret-app/app.conf", id);
  const raw = [
    ...(d.prepare("SELECT * FROM file_contents").all() as any[]),
    ...(d.prepare("SELECT * FROM server_files").all() as any[]),
  ].map((r) => Object.values(r).map((v) => (Buffer.isBuffer(v) ? v.toString("latin1") : String(v))).join("|")).join("\n");
  assert.ok(!raw.includes("SUPERSECRETVALUE"));
  assert.ok(!raw.includes("very-secret-app"));
  assert.ok(!raw.includes("app.conf"));
});
