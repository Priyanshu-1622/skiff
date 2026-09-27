import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { runColumnMigrations } from "../db/client.js";
import { linkServer, serverFileKey } from "./servers.js";

const here = dirname(fileURLToPath(import.meta.url));
function db() {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(readFileSync(join(here, "../db/schema.sql"), "utf-8"));
  runColumnMigrations(d);
  d.prepare("INSERT INTO hosts (id,label,hostname,port,username,auth_method,created_at) VALUES ('h1','a','10.0.0.1',22,'u','password','now'),('h2','b','box.lan',22,'u','password','now')").run();
  return d;
}

test("two host entries for the same machine share one server", () => {
  const d = db(); const vk = randomBytes(32);
  const a = linkServer(d, { hostId: "h1", fingerprint: "SHA256:aaa", algorithm: "ssh-ed25519", vaultKey: vk });
  const b = linkServer(d, { hostId: "h2", fingerprint: "SHA256:aaa", algorithm: "ssh-ed25519", vaultKey: vk });
  assert.equal(a.id, b.id);
  assert.equal((d.prepare("SELECT COUNT(*) c FROM servers").get() as { c: number }).c, 1);
  assert.equal((d.prepare("SELECT server_id FROM hosts WHERE id='h2'").get() as any).server_id, a.id);
});

test("a rebuilt machine (new key) is a new server linked to the previous one", () => {
  const d = db(); const vk = randomBytes(32);
  const old = linkServer(d, { hostId: "h1", fingerprint: "SHA256:old", algorithm: "ssh-ed25519", vaultKey: vk });
  const fresh = linkServer(d, { hostId: "h1", fingerprint: "SHA256:new", algorithm: "ssh-ed25519", vaultKey: vk });
  assert.notEqual(old.id, fresh.id);
  assert.equal((d.prepare("SELECT previous_server_id p FROM servers WHERE id=?").get(fresh.id) as any).p, old.id);
});

test("the server file key is stable and needs the vault key", () => {
  const d = db(); const vk = randomBytes(32);
  const s = linkServer(d, { hostId: "h1", fingerprint: "SHA256:k", algorithm: "ssh-ed25519", vaultKey: vk });
  assert.ok(serverFileKey(d, s.id, vk).equals(serverFileKey(d, s.id, vk)));
  assert.throws(() => serverFileKey(d, s.id, randomBytes(32)));
});

test("migrations are idempotent on an existing database", () => {
  const d = db();
  runColumnMigrations(d);
  runColumnMigrations(d);
});

test("upgrading a v0.3.2 database keeps its data and adds the v5 columns", () => {
  // Build the database exactly as v0.3.2 left it: the schema before the v5
  // block, plus the columns v2–v4 migrations had added.
  const full = readFileSync(join(here, "../db/schema.sql"), "utf-8");
  const old = full.slice(0, full.indexOf("-- ─── servers (v5)"));
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(old);
  d.exec("ALTER TABLE vault_meta ADD COLUMN mode TEXT NOT NULL DEFAULT 'personal'");
  d.exec("ALTER TABLE vault_meta ADD COLUMN recording_enabled INTEGER NOT NULL DEFAULT 0");
  d.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
  d.prepare("INSERT INTO hosts (id,label,hostname,port,username,auth_method,created_at) VALUES ('h1','prod','10.0.0.1',22,'deploy','password','then')").run();
  d.prepare("INSERT INTO session_recordings (id, started_at, status) VALUES ('rec_old', 'then', 'complete')").run();

  // What the server does on boot.
  d.exec(full);
  runColumnMigrations(d);

  const host = d.prepare("SELECT label, server_id FROM hosts WHERE id='h1'").get() as any;
  assert.equal(host.label, "prod", "existing hosts survive");
  assert.equal(host.server_id, null, "linked on first connection, not during the upgrade");
  const rec = d.prepare("SELECT format, key_id FROM session_recordings WHERE id='rec_old'").get() as any;
  assert.equal(rec.format, "plain", "old recordings are marked plaintext so they still play");
  assert.equal(rec.key_id, null);
  // And linking works on the upgraded database.
  const s = linkServer(d, { hostId: "h1", fingerprint: "SHA256:u", algorithm: "ssh-ed25519", vaultKey: randomBytes(32) });
  assert.equal((d.prepare("SELECT server_id FROM hosts WHERE id='h1'").get() as any).server_id, s.id);
});
