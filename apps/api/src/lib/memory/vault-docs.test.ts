import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runColumnMigrations } from "../../db/client.js";
import { newDataKey } from "../../crypto/data-keys.js";
import {
  MAX_NOTE_CHARS, appendToNote, createSnippet, deleteSnippet, formatPin, getNote, getSnippet, listSnippets, putNote, rewrapDocs, updateSnippet,
} from "./vault-docs.js";

const here = dirname(fileURLToPath(import.meta.url));

function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(readFileSync(join(here, "../../db/schema.sql"), "utf-8"));
  runColumnMigrations(d);
  d.prepare("INSERT INTO hosts (id,label,hostname,port,username,auth_method,created_at) VALUES ('h1','prod','10.0.0.1',22,'deploy','password','then')").run();
  d.prepare("INSERT INTO hosts (id,label,hostname,port,username,auth_method,created_at) VALUES ('h2','stage','10.0.0.2',22,'deploy','password','then')").run();
  return d;
}

test("a host with no note has an empty one at version 0", () => {
  const d = freshDb();
  const n = getNote(d, newDataKey(), "h1")!;
  assert.equal(n.text, "");
  assert.equal(n.version, 0);
});

test("saving creates version 1, each save bumps the version, and the last editor is kept", () => {
  const d = freshDb();
  const k = newDataKey();
  const a = putNote(d, k, "h1", "restart with systemctl", 0, "alice");
  assert.ok(a.ok);
  assert.equal(a.note.version, 1);
  const b = putNote(d, k, "h1", "restart with systemctl\nthen check logs", 1, "bob");
  assert.ok(b.ok);
  assert.equal(b.note.version, 2);
  const read = getNote(d, k, "h1")!;
  assert.equal(read.text, "restart with systemctl\nthen check logs");
  assert.equal(read.updatedBy, "bob");
  assert.equal(getNote(d, k, "h2")!.text, "", "another host's note is separate");
});

test("a stale save is a conflict that carries the current note and changes nothing", () => {
  const d = freshDb();
  const k = newDataKey();
  putNote(d, k, "h1", "v1", 0, "alice");
  putNote(d, k, "h1", "v2", 1, "bob");
  const stale = putNote(d, k, "h1", "alice's edit of v1", 1, "alice");
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.reason, "conflict");
    assert.equal(stale.current?.text, "v2");
    assert.equal(stale.current?.version, 2);
  }
  assert.equal(getNote(d, k, "h1")!.text, "v2");
  // Creating over an existing note with baseVersion 0 is also a conflict.
  const again = putNote(d, k, "h1", "fresh", 0, "carol");
  assert.equal(again.ok, false);
});

test("a note over the size cap is refused", () => {
  const d = freshDb();
  const r = putNote(d, newDataKey(), "h1", "x".repeat(MAX_NOTE_CHARS + 1), 0, "alice");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "too-long");
  assert.ok(putNote(d, newDataKey(), "h2", "x".repeat(MAX_NOTE_CHARS), 0, "alice").ok, "exactly at the cap is fine");
});

test("the note is sealed: nothing readable in the table, a wrong key reads as unreadable, and it goes with its host", () => {
  const d = freshDb();
  const k = newDataKey();
  putNote(d, k, "h1", "the prod db password rotates on friday", 0, "alice");
  const row = d.prepare("SELECT * FROM host_notes").get() as any;
  const raw = Object.values(row).map((v) => (Buffer.isBuffer(v) ? v.toString("latin1") : String(v))).join("|");
  assert.ok(!raw.includes("password") && !raw.includes("alice"));
  assert.equal(getNote(d, newDataKey(), "h1"), null);
  d.prepare("DELETE FROM hosts WHERE id = 'h1'").run();
  assert.equal((d.prepare("SELECT COUNT(*) n FROM host_notes").get() as any).n, 0);
});

test("appendToNote starts a note or adds to one with a blank line between, and respects the cap", () => {
  const d = freshDb();
  const k = newDataKey();
  const a = appendToNote(d, k, "h1", "$ uptime", "alice");
  assert.ok(a.ok);
  assert.equal(a.note.text, "$ uptime");
  const b = appendToNote(d, k, "h1", "$ df -h", "bob");
  assert.ok(b.ok);
  assert.equal(b.note.text, "$ uptime\n\n$ df -h");
  assert.equal(b.note.version, 2);
  assert.equal(b.note.updatedBy, "bob");
  putNote(d, k, "h2", "x".repeat(MAX_NOTE_CHARS - 5), 0, "alice");
  const full = appendToNote(d, k, "h2", "this will not fit", "alice");
  assert.equal(full.ok, false);
  if (!full.ok) assert.equal(full.reason, "too-long");
});

test("a pinned command is the command, when, exit status and folder, and never its output", () => {
  const text = formatPin({ kind: "command", command: "sudo systemctl restart nginx", startedAt: "2026-10-08T14:03:09.000Z", exitCode: 0, cwd: "/etc/nginx" });
  assert.equal(text, "$ sudo systemctl restart nginx\n  2026-10-08 14:03 UTC · exit 0 · in /etc/nginx");
  assert.equal(formatPin({ kind: "command", command: "false", startedAt: "2026-10-08T14:03:09.000Z", exitCode: 1, cwd: null }), "$ false\n  2026-10-08 14:03 UTC · exit 1");
  assert.equal(formatPin({ kind: "command", command: "ls", startedAt: "2026-10-08T14:03:09.000Z", exitCode: null, cwd: null }), "$ ls\n  2026-10-08 14:03 UTC");
});

test("a pinned file change names the file, the counts and an indented diff capped at 60 lines", () => {
  const diff = ["@@ -1,2 +1,2 @@", " keep", "-port = 80", "+port = 8080"].join("\n") + "\n";
  const text = formatPin({
    kind: "file", command: "/etc/app.conf", startedAt: "2026-10-08T14:03:09.000Z", exitCode: null, cwd: null,
    file: { change: "modified", added: 1, removed: 1, note: null, by: "vim /etc/app.conf" }, diff,
  });
  assert.equal(text, "✎ /etc/app.conf (modified, +1 −1)\n  2026-10-08 14:03 UTC\n    @@ -1,2 +1,2 @@\n     keep\n    -port = 80\n    +port = 8080");
  const long = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join("\n") + "\n";
  const capped = formatPin({ kind: "file", command: "/x", startedAt: "2026-10-08T14:03:09.000Z", exitCode: null, cwd: null, file: { change: "created", added: 100, removed: 0, note: null, by: "" }, diff: long });
  assert.equal(capped.split("\n").filter((l) => l.startsWith("    +line")).length, 60);
  assert.match(capped, /40 more lines not shown/);
  const note = formatPin({ kind: "file", command: "/etc/shadow", startedAt: "2026-10-08T14:03:09.000Z", exitCode: null, cwd: null, file: { change: "modified", added: 0, removed: 0, note: "sensitive file — not tracked", by: "" }, diff: "" });
  assert.equal(note, "✎ /etc/shadow (sensitive file — not tracked)\n  2026-10-08 14:03 UTC");
});

test("snippets: create, list newest first, update only what is given, delete", () => {
  const d = freshDb();
  const k = newDataKey();
  const a = createSnippet(d, k, { name: "restart nginx", command: "sudo systemctl restart nginx", userId: "u1", username: "alice" });
  const b = createSnippet(d, k, { name: "disk", command: "df -h", userId: "u2", username: "bob" });
  assert.match(a.id, /^snip_/);
  assert.deepEqual(listSnippets(d, k).map((s) => s.name), ["disk", "restart nginx"]);
  const u = updateSnippet(d, k, a.id, { name: "bounce nginx" })!;
  assert.equal(u.name, "bounce nginx");
  assert.equal(u.command, "sudo systemctl restart nginx");
  const u2 = updateSnippet(d, k, a.id, { command: "sudo systemctl reload nginx" })!;
  assert.equal(u2.name, "bounce nginx");
  assert.equal(u2.command, "sudo systemctl reload nginx");
  assert.equal(updateSnippet(d, k, "snip_nope", { name: "x" }), null);
  assert.equal(getSnippet(d, k, b.id)?.username, "bob");
  assert.equal(deleteSnippet(d, b.id), true);
  assert.equal(deleteSnippet(d, b.id), false);
  assert.deepEqual(listSnippets(d, k).map((s) => s.id), [a.id]);
});

test("snippets are sealed and a wrong key lists nothing", () => {
  const d = freshDb();
  const k = newDataKey();
  createSnippet(d, k, { name: "secret thing", command: "mysql -u root -pS3CR3T", userId: null, username: null });
  const row = d.prepare("SELECT * FROM snippets").get() as any;
  const raw = Object.values(row).map((v) => (Buffer.isBuffer(v) ? v.toString("latin1") : String(v))).join("|");
  assert.ok(!raw.includes("S3CR3T") && !raw.includes("secret thing"));
  assert.deepEqual(listSnippets(d, newDataKey()), []);
});

test("rewrapDocs moves notes and snippets to a new key (a password change)", () => {
  const d = freshDb();
  const oldKey = newDataKey(), newKey = newDataKey();
  putNote(d, oldKey, "h1", "keep me", 0, "alice");
  const s = createSnippet(d, oldKey, { name: "n", command: "c", userId: null, username: null });
  rewrapDocs(d, oldKey, newKey);
  assert.equal(getNote(d, newKey, "h1")!.text, "keep me");
  assert.equal(getNote(d, newKey, "h1")!.version, 1, "the version does not change");
  assert.equal(getSnippet(d, newKey, s.id)?.command, "c");
  assert.equal(getNote(d, oldKey, "h1"), null);
  assert.deepEqual(listSnippets(d, oldKey), []);
});

test("a note sealed for one host cannot be passed off as another host's", () => {
  const d = freshDb();
  const k = newDataKey();
  putNote(d, k, "h1", "prod only", 0, "alice");
  const row = d.prepare("SELECT nonce, data FROM host_notes WHERE host_id = 'h1'").get() as { nonce: Buffer; data: Buffer };
  d.prepare("INSERT INTO host_notes (host_id, nonce, data, version, updated_at) VALUES ('h2', ?, ?, 1, 'now')").run(row.nonce, row.data);
  assert.equal(getNote(d, k, "h2"), null);
});
