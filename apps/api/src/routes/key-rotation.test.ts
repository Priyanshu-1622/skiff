import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildApp } from "../app.js";
import { runColumnMigrations } from "../db/client.js";
import { deriveVaultKey } from "../crypto/vault.js";
import { newDataKey, wrapDataKey, unwrapDataKey } from "../crypto/data-keys.js";
import { linkServer, serverFileKey } from "../lib/servers.js";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = { dataDir: "/tmp/skiff-test-unused", port: 0, host: "127.0.0.1", nodeEnv: "test" as const, trustedOrigins: [], cookieSecret: "x".repeat(40), setupToken: null };

function memDb() {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  raw.exec(readFileSync(join(here, "../db/schema.sql"), "utf-8"));
  runColumnMigrations(raw);
  return { raw, close: () => raw.close() };
}
async function vaultKeyFor(raw: Database.Database, password: string) {
  const m = raw.prepare("SELECT * FROM vault_meta").get() as any;
  return deriveVaultKey(password, { algorithm: "argon2id", salt: m.kdf_salt, iterations: m.kdf_iterations, memoryKib: m.kdf_memory_kib, parallelism: m.kdf_parallelism });
}
function seedKeys(raw: Database.Database, vaultKey: Buffer) {
  raw.prepare("INSERT INTO hosts (id,label,hostname,port,username,auth_method,created_at) VALUES ('h1','a','10.0.0.1',22,'u','password','now')").run();
  const server = linkServer(raw, { hostId: "h1", fingerprint: "SHA256:x", algorithm: "ssh-ed25519", vaultKey });
  const dk = newDataKey();
  const { nonce, wrapped } = wrapDataKey(dk, vaultKey);
  raw.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES ('k1', ?, ?, 'now')").run(wrapped, nonce);
  return { serverId: server.id, dk };
}
const sessionKey = (raw: Database.Database, vk: Buffer) => {
  const r = raw.prepare("SELECT wrapped_key w, nonce n FROM session_keys WHERE id='k1'").get() as any;
  return unwrapDataKey(r.w, r.n, vk);
};

test("changing the master password re-wraps session and server keys", async () => {
  const db = memDb();
  const app = await buildApp({ config: CONFIG, db });
  try {
    const cookie = String((await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "old-password-1" } })).headers["set-cookie"]).split(";")[0];
    const oldKey = await vaultKeyFor(db.raw, "old-password-1");
    const { serverId, dk } = seedKeys(db.raw, oldKey);
    const res = await app.inject({ method: "PUT", url: "/api/settings/password", headers: { cookie }, payload: { currentPassword: "old-password-1", newPassword: "new-password-2" } });
    assert.equal(res.statusCode, 200);
    const newKey = await vaultKeyFor(db.raw, "new-password-2");
    assert.ok(sessionKey(db.raw, newKey).equals(dk));
    assert.throws(() => sessionKey(db.raw, oldKey));
    assert.equal(serverFileKey(db.raw, serverId, newKey).length, 32);
    assert.throws(() => serverFileKey(db.raw, serverId, oldKey));
  } finally { await app.close(); }
});

test("backup and restore keep session and server keys usable", async () => {
  const src = memDb();
  const a = await buildApp({ config: CONFIG, db: src });
  let backup: any;
  let dk: Buffer;
  try {
    const cookie = String((await a.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } })).headers["set-cookie"]).split(";")[0];
    ({ dk } = seedKeys(src.raw, await vaultKeyFor(src.raw, "master-pass-1")));
    backup = (await a.inject({ method: "GET", url: "/api/settings/backup", headers: { cookie } })).json().data;
    assert.equal(backup.sessionKeys.length, 1);
    assert.equal(backup.servers.length, 1);
  } finally { await a.close(); }

  const dst = memDb();
  const b = await buildApp({ config: CONFIG, db: dst });
  try {
    const res = await b.inject({ method: "POST", url: "/api/settings/restore", payload: backup });
    assert.equal(res.statusCode, 200);
    const vk = await vaultKeyFor(dst.raw, "master-pass-1");
    assert.ok(sessionKey(dst.raw, vk).equals(dk!));
    const host = dst.raw.prepare("SELECT server_id FROM hosts WHERE id='h1'").get() as any;
    assert.ok(host.server_id, "host keeps its server link");
  } finally { await b.close(); }
});

test("in team mode, a member changing their own password does not disturb session/server keys (the shared key is unchanged)", async () => {
  const db = memDb();
  const app = await buildApp({ config: CONFIG, db });
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "admin-password-1", mode: "team", username: "admin" } });
    const adminCookie = String(setup.headers["set-cookie"]).split(";")[0];
    await app.inject({
      method: "POST", url: "/api/team/users", headers: { cookie: adminCookie },
      payload: { username: "bob", tempPassword: "bob-temp-password" },
    });
    const login = await app.inject({ method: "POST", url: "/api/team/login", payload: { username: "bob", password: "bob-temp-password" } });
    const bobCookie = String(login.headers["set-cookie"]).split(";")[0];

    // The shared key IS the vault key in team mode; derive it via the admin's
    // row (bob's login response doesn't hand back raw key material).
    const usersRow = db.raw.prepare("SELECT * FROM users WHERE username = 'admin'").get() as any;
    const { unlockSharedKey } = await import("../crypto/team-vault.js");
    const shared = await unlockSharedKey(
      "admin-password-1",
      { algorithm: "argon2id", salt: usersRow.kdf_salt, iterations: usersRow.kdf_iterations, memoryKib: usersRow.kdf_memory_kib, parallelism: usersRow.kdf_parallelism },
      usersRow.verifier, usersRow.shared_key_blob, usersRow.shared_key_nonce,
    );
    const { serverId, dk } = seedKeys(db.raw, shared!);

    const changeRes = await app.inject({
      method: "POST", url: "/api/team/me/password", headers: { cookie: bobCookie },
      payload: { currentPassword: "bob-temp-password", newPassword: "bobs-own-password" },
    });
    assert.equal(changeRes.statusCode, 200);

    // The shared key is still the same value — session/server keys wrapped
    // under it must still open, without any rotation route touching them.
    assert.ok(sessionKey(db.raw, shared!).equals(dk));
    assert.equal(serverFileKey(db.raw, serverId, shared!).length, 32);
  } finally { await app.close(); }
});
