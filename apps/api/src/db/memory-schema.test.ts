import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runColumnMigrations } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));

function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(readFileSync(join(here, "schema.sql"), "utf-8"));
  runColumnMigrations(d);
  return d;
}

test("hosts default to memory on; vault_meta defaults to memory enabled, 90-day output retention", () => {
  const d = freshDb();
  d.prepare(
    "INSERT INTO hosts (id,label,hostname,port,username,auth_method,created_at) VALUES ('h1','prod','10.0.0.1',22,'deploy','password','then')"
  ).run();
  d.prepare(
    `INSERT INTO vault_meta (id, schema_version, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, created_at)
     VALUES (1, 6, x'00', 3, 65536, 4, x'00', 'then')`
  ).run();
  const host = d.prepare("SELECT memory_mode FROM hosts WHERE id='h1'").get() as any;
  assert.equal(host.memory_mode, "on");
  const vault = d.prepare("SELECT memory_enabled, memory_output_days FROM vault_meta WHERE id=1").get() as any;
  assert.equal(vault.memory_enabled, 1);
  assert.equal(vault.memory_output_days, 90);
});

test("a memory_session and its memory_entries round-trip", () => {
  const d = freshDb();
  d.prepare(
    "INSERT INTO servers (id,fingerprint,algorithm,first_seen_at,file_key_wrapped,file_key_nonce) VALUES ('s1','fp','ssh-ed25519','then',x'00',x'00')"
  ).run();
  d.prepare(
    "INSERT INTO hosts (id,label,hostname,port,username,auth_method,created_at) VALUES ('h1','prod','10.0.0.1',22,'deploy','password','then')"
  ).run();
  d.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES ('key1', x'00', x'00', 'then')").run();
  d.prepare(
    `INSERT INTO memory_sessions (id, server_id, host_id, user_id, username, key_id, recording_id, started_at, stats_json)
     VALUES ('ms1', 's1', 'h1', NULL, NULL, 'key1', NULL, 'then', '{}')`
  ).run();
  d.prepare(
    `INSERT INTO memory_entries
       (id, memory_session_id, server_id, user_id, kind, started_at, finished_at, exit_code, confidence, flags, output_bytes, output_pruned, nonce, data)
     VALUES ('me1', 'ms1', 's1', NULL, 'command', 'then', 'then2', 0, 'screen', '[]', 5, 0, x'00', x'00')`
  ).run();
  const entry = d.prepare("SELECT memory_session_id, kind, exit_code FROM memory_entries WHERE id='me1'").get() as any;
  assert.equal(entry.memory_session_id, "ms1");
  assert.equal(entry.kind, "command");
  assert.equal(entry.exit_code, 0);
  assert.throws(
    () => d.prepare(
      `INSERT INTO memory_entries (id, memory_session_id, server_id, kind, started_at, nonce, data) VALUES ('bad', 'ms1', 's1', 'not-a-kind', 'then', x'00', x'00')`
    ).run(),
    "kind is constrained to the spec's known set",
  );
});

test("upgrading a v5 database (servers/session_keys, no memory tables) adds the v6 columns and tables without disturbing existing rows", () => {
  const full = readFileSync(join(here, "schema.sql"), "utf-8");
  const old = full.slice(0, full.indexOf("-- ─── memory_sessions (v6)"));
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(old);
  d.prepare(
    "INSERT INTO hosts (id,label,hostname,port,username,auth_method,created_at) VALUES ('h1','prod','10.0.0.1',22,'deploy','password','then')"
  ).run();
  d.prepare(
    `INSERT INTO vault_meta (id, schema_version, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, created_at)
     VALUES (1, 5, x'00', 3, 65536, 4, x'00', 'then')`
  ).run();

  d.exec(full);
  runColumnMigrations(d);

  const host = d.prepare("SELECT label, memory_mode FROM hosts WHERE id='h1'").get() as any;
  assert.equal(host.label, "prod", "existing hosts survive");
  assert.equal(host.memory_mode, "on", "upgraded hosts default to memory on");
  const vault = d.prepare("SELECT memory_enabled FROM vault_meta WHERE id=1").get() as any;
  assert.equal(vault.memory_enabled, 1, "an EXISTING vault_meta row (a real prior installation) also gets the new column with its default");
  // The new tables exist and are usable.
  d.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES ('k1', x'00', x'00', 'then')").run();
  d.prepare(
    `INSERT INTO memory_sessions (id, server_id, host_id, key_id, started_at, stats_json) VALUES ('ms1', NULL, 'h1', 'k1', 'then', '{}')`
  ).run();
});
