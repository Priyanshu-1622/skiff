/**
 * Backup → restore round-trip tests.
 *
 * A restore that "succeeds" but leaves credentials undecryptable is the worst
 * kind of failure, so these go all the way: back up a vault with a stored SSH
 * password, restore it into a fresh instance, sign in the way a real user
 * would, then decrypt the credential with the restored key material and check
 * the plaintext comes back.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildApp } from "../app.js";
import type { SkiffDb } from "../db/client.js";
import { runColumnMigrations } from "../db/client.js";
import { decrypt, deriveVaultKey } from "../crypto/vault.js";
import { unlockSharedKey } from "../crypto/team-vault.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_CONFIG = {
  dataDir: "/tmp/skiff-test-unused",
  port: 0,
  host: "127.0.0.1",
  nodeEnv: "test" as const,
  trustedOrigins: [],
  cookieSecret: "test-cookie-secret-at-least-32-chars-long-xxxxxxxxxx",
  setupToken: null, // setup-token gate has its own tests
};

function memDb(): SkiffDb {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(join(__dirname, "../db/schema.sql"), "utf-8"));
  runColumnMigrations(db);
  return { raw: db, close: () => db.close() };
}

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : (raw as string);
  return header.split(";")[0];
}

const SSH_SECRET = "the-ssh-password-we-must-get-back";

async function addHostWithPassword(app: any, cookie: string) {
  const res = await app.inject({
    method: "POST", url: "/api/hosts", headers: { cookie },
    payload: {
      label: "prod", hostname: "10.0.0.5", username: "deploy",
      authMethod: "password", credential: { kind: "password", value: SSH_SECRET },
    },
  });
  assert.equal(res.statusCode, 200);
}

function onlyCredential(db: SkiffDb) {
  return db.raw.prepare("SELECT * FROM credentials").get() as any;
}

test("personal backup restores and the credential decrypts with the original password", async () => {
  const source = await buildApp({ config: TEST_CONFIG, db: memDb() });
  let backup: any;
  try {
    const setup = await source.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    await addHostWithPassword(source, cookieFrom(setup));
    const res = await source.inject({ method: "GET", url: "/api/settings/backup", headers: { cookie: cookieFrom(setup) } });
    backup = (res.json() as any).data;
    assert.equal(backup.version, 2);
  } finally { await source.close(); }

  const targetDb = memDb();
  const target = await buildApp({ config: TEST_CONFIG, db: targetDb });
  try {
    const restore = await target.inject({ method: "POST", url: "/api/settings/restore", payload: backup });
    assert.equal(restore.statusCode, 200);
    assert.equal((restore.json() as any).data.mode, "personal");

    const unlock = await target.inject({ method: "POST", url: "/api/vault/unlock", payload: { password: "master-pass-1" } });
    assert.equal(unlock.statusCode, 200);

    const meta = targetDb.raw.prepare("SELECT * FROM vault_meta").get() as any;
    const key = await deriveVaultKey("master-pass-1", {
      algorithm: "argon2id", salt: meta.kdf_salt, iterations: meta.kdf_iterations,
      memoryKib: meta.kdf_memory_kib, parallelism: meta.kdf_parallelism,
    });
    const cred = onlyCredential(targetDb);
    assert.equal(decrypt(cred.encrypted_blob, cred.nonce, key), SSH_SECRET);
  } finally { await target.close(); }
});

test("team backup restores as a team: every member signs in and credentials decrypt", async () => {
  const source = await buildApp({ config: TEST_CONFIG, db: memDb() });
  let backup: any;
  try {
    const setup = await source.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const adminCookie = cookieFrom(setup);
    await addHostWithPassword(source, adminCookie);
    await source.inject({
      method: "POST", url: "/api/team/users", headers: { cookie: adminCookie },
      payload: { username: "bob", tempPassword: "bob-temp-password", isAdmin: false },
    });
    const res = await source.inject({ method: "GET", url: "/api/settings/backup", headers: { cookie: adminCookie } });
    backup = (res.json() as any).data;
    assert.equal(backup.users.length, 2);
  } finally { await source.close(); }

  const targetDb = memDb();
  const target = await buildApp({ config: TEST_CONFIG, db: targetDb });
  try {
    const restore = await target.inject({ method: "POST", url: "/api/settings/restore", payload: backup });
    assert.equal(restore.statusCode, 200);
    assert.equal((restore.json() as any).data.mode, "team");

    const status = await target.inject({ method: "GET", url: "/api/vault/status" });
    assert.equal((status.json() as any).data.mode, "team");
    assert.equal((status.json() as any).data.recordingEnabled, true);

    for (const [username, password] of [["admin", "admin-password-1"], ["bob", "bob-temp-password"]]) {
      const login = await target.inject({ method: "POST", url: "/api/team/login", payload: { username, password } });
      assert.equal(login.statusCode, 200, `${username} should be able to sign in after restore`);

      const hosts = await target.inject({ method: "GET", url: "/api/hosts", headers: { cookie: cookieFrom(login) } });
      assert.equal((hosts.json() as any).data.length, 1);

      // The real proof: this member's password unseals a key that decrypts the credential.
      const u = targetDb.raw.prepare("SELECT * FROM users WHERE username = ?").get(username) as any;
      const sharedKey = await unlockSharedKey(
        password,
        { algorithm: "argon2id", salt: u.kdf_salt, iterations: u.kdf_iterations, memoryKib: u.kdf_memory_kib, parallelism: u.kdf_parallelism },
        u.verifier, u.shared_key_blob, u.shared_key_nonce,
      );
      assert.ok(sharedKey);
      const cred = onlyCredential(targetDb);
      assert.equal(decrypt(cred.encrypted_blob, cred.nonce, sharedKey!), SSH_SECRET);
    }
  } finally { await target.close(); }
});

test("an old (v1) team backup without members restores as personal, with a warning", async () => {
  const source = await buildApp({ config: TEST_CONFIG, db: memDb() });
  let backup: any;
  try {
    const setup = await source.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const res = await source.inject({ method: "GET", url: "/api/settings/backup", headers: { cookie: cookieFrom(setup) } });
    backup = (res.json() as any).data;
  } finally { await source.close(); }

  // What older Skiff versions produced: no users, version 1.
  delete backup.users;
  backup.version = 1;

  const target = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const restore = await target.inject({ method: "POST", url: "/api/settings/restore", payload: backup });
    assert.equal(restore.statusCode, 200);
    const data = (restore.json() as any).data;
    assert.equal(data.mode, "personal");
    assert.match(data.message, /older Skiff/);
  } finally { await target.close(); }
});

test("a team backup with no active admin is refused", async () => {
  const source = await buildApp({ config: TEST_CONFIG, db: memDb() });
  let backup: any;
  try {
    const setup = await source.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const res = await source.inject({ method: "GET", url: "/api/settings/backup", headers: { cookie: cookieFrom(setup) } });
    backup = (res.json() as any).data;
  } finally { await source.close(); }

  for (const u of backup.users) u.disabled = 1;

  const targetDb = memDb();
  const target = await buildApp({ config: TEST_CONFIG, db: targetDb });
  try {
    const restore = await target.inject({ method: "POST", url: "/api/settings/restore", payload: backup });
    assert.equal(restore.statusCode, 400);
    // Nothing half-written.
    assert.equal(targetDb.raw.prepare("SELECT COUNT(*) AS c FROM vault_meta").get()!.c as number, 0);
  } finally { await target.close(); }
});

test("restore refuses to overwrite an existing vault", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const res = await app.inject({ method: "GET", url: "/api/settings/backup", headers: { cookie: cookieFrom(setup) } });
    const again = await app.inject({ method: "POST", url: "/api/settings/restore", payload: (res.json() as any).data });
    assert.equal(again.statusCode, 409);
  } finally { await app.close(); }
});

// ── Setup token: an unclaimed instance only accepts setup/restore from its operator ──

test("setup and restore require the setup token when one is set", async () => {
  const token = "operator-token-0123456789";
  const app = await buildApp({ config: { ...TEST_CONFIG, setupToken: token }, db: memDb() });
  try {
    const status = await app.inject({ method: "GET", url: "/api/vault/status" });
    assert.equal((status.json() as any).data.setupTokenRequired, true);

    for (const headers of [{}, { "x-skiff-setup-token": "wrong-token-0123456789" }]) {
      const setup = await app.inject({ method: "POST", url: "/api/vault/setup", headers, payload: { password: "master-pass-1" } });
      assert.equal(setup.statusCode, 403);
      const restore = await app.inject({ method: "POST", url: "/api/settings/restore", headers, payload: { version: 2 } });
      assert.equal(restore.statusCode, 403);
    }

    const ok = await app.inject({
      method: "POST", url: "/api/vault/setup",
      headers: { "x-skiff-setup-token": token }, payload: { password: "master-pass-1" },
    });
    assert.equal(ok.statusCode, 200);

    // Once initialized, the token no longer matters and status stops asking for it.
    const after = await app.inject({ method: "GET", url: "/api/vault/status" });
    assert.equal((after.json() as any).data.setupTokenRequired, false);
  } finally { await app.close(); }
});

test("Memory settings (per-host off, vault-wide off, output retention days) survive a backup/restore round trip", async () => {
  const sourceDb = memDb();
  const source = await buildApp({ config: TEST_CONFIG, db: sourceDb });
  let backup: any;
  let hostId: string;
  try {
    const setup = await source.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const cookie = cookieFrom(setup);
    await addHostWithPassword(source, cookie);
    hostId = (sourceDb.raw.prepare("SELECT id FROM hosts").get() as any).id;
    // Deliberately opted out — this is exactly the setting a restore must
    // not silently reset, since that would turn capture back on for a
    // host/vault the owner explicitly turned off.
    sourceDb.raw.prepare("UPDATE hosts SET memory_mode = 'off' WHERE id = ?").run(hostId);
    sourceDb.raw.prepare("UPDATE vault_meta SET memory_enabled = 0, memory_output_days = 30 WHERE id = 1").run();

    const res = await source.inject({ method: "GET", url: "/api/settings/backup", headers: { cookie } });
    backup = (res.json() as any).data;
    assert.equal(backup.vaultMeta.memory_enabled, 0, "export carries the opted-out vault setting");
    const exportedHost = backup.hosts.find((h: any) => h.id === hostId);
    assert.equal(exportedHost.memory_mode, "off", "export carries the opted-out host setting");
  } finally { await source.close(); }

  const targetDb = memDb();
  const target = await buildApp({ config: TEST_CONFIG, db: targetDb });
  try {
    const restore = await target.inject({ method: "POST", url: "/api/settings/restore", payload: backup });
    assert.equal(restore.statusCode, 200);

    const vault = targetDb.raw.prepare("SELECT memory_enabled, memory_output_days FROM vault_meta WHERE id = 1").get() as any;
    assert.equal(vault.memory_enabled, 0, "restore must not silently turn memory back on vault-wide");
    assert.equal(vault.memory_output_days, 30, "restore must not silently reset the retention window to the default");
    const host = targetDb.raw.prepare("SELECT memory_mode FROM hosts WHERE id = ?").get(hostId!) as any;
    assert.equal(host.memory_mode, "off", "restore must not silently turn memory back on for a host that had it off");
  } finally { await target.close(); }
});
