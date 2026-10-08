import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runColumnMigrations } from "../../db/client.js";
import { newDataKey } from "../../crypto/data-keys.js";
import { beginMemorySession, loadCommandEntry, pruneOldOutput, saveFileEntry } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));

function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(readFileSync(join(here, "../../db/schema.sql"), "utf-8"));
  runColumnMigrations(d);
  d.prepare("INSERT INTO hosts (id,label,hostname,port,username,auth_method,created_at) VALUES ('h1','prod','10.0.0.1',22,'deploy','password','then')").run();
  d.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES ('key1', x'00', x'00', 'then')").run();
  d.prepare("INSERT INTO servers (id, fingerprint, algorithm, first_seen_at, file_key_wrapped, file_key_nonce) VALUES ('srv1', 'fp', 'ssh-ed25519', 'then', x'00', x'00')").run();
  return d;
}

test("a file entry round-trips through the store and its diff is trimmed by retention like command output", () => {
  const d = freshDb();
  const key = newDataKey();
  const sid = beginMemorySession(d, { serverId: "srv1", hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  const id = saveFileEntry(d, key, {
    memorySessionId: sid, serverId: "srv1", userId: null, path: "/etc/app.conf", diff: "@@ -1 +1 @@\n-a\n+b\n",
    meta: { change: "modified", added: 1, removed: 1, note: null, by: "vim /etc/app.conf" },
    flags: ["assumed-home"], oldContentId: "old1", newContentId: "new1", startedAt: Date.now() - 100 * 24 * 3600 * 1000,
  });
  const row = d.prepare("SELECT kind, flags, content_old_id, content_new_id, output_bytes FROM memory_entries WHERE id = ?").get(id) as any;
  assert.equal(row.kind, "file");
  assert.equal(row.flags, '["assumed-home"]');
  assert.equal(row.content_old_id, "old1");
  assert.ok(row.output_bytes > 0);
  const loaded = loadCommandEntry(d, key, id);
  assert.equal(loaded.command, "/etc/app.conf");
  assert.match(loaded.output, /\+b/);
  assert.equal(loaded.file?.added, 1);

  assert.equal(pruneOldOutput(d, (k) => (k === "key1" ? key : null), 90), 1);
  const after = loadCommandEntry(d, key, id);
  assert.equal(after.output, "", "the diff is gone after the retention window");
  assert.equal(after.command, "/etc/app.conf", "the path and summary stay");
  assert.equal(after.file?.change, "modified");
});

test("nothing in a file entry row shows the path or the diff in the clear", () => {
  const d = freshDb();
  const key = newDataKey();
  const sid = beginMemorySession(d, { serverId: "srv1", hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  saveFileEntry(d, key, {
    memorySessionId: sid, serverId: "srv1", userId: null, path: "/etc/very-secret/app.conf", diff: "+db_host = internal.example\n",
    meta: { change: "created", added: 1, removed: 0, note: null, by: "vim x" }, flags: [], oldContentId: null, newContentId: "n", startedAt: Date.now(),
  });
  const r = d.prepare("SELECT * FROM memory_entries WHERE kind = 'file'").get() as any;
  const raw = Object.values(r).map((v) => (Buffer.isBuffer(v) ? v.toString("latin1") : String(v))).join("|");
  assert.ok(!raw.includes("very-secret") && !raw.includes("internal.example"));
});
