/**
 * Hosts, folders, fingerprints and self-service passwords — the everyday
 * paths where a mistake used to be accepted and only surface later.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { buildApp } from "../app.js";
import type { SkiffDb } from "../db/client.js";
import { runColumnMigrations } from "../db/client.js";

const require = createRequire(import.meta.url);
const { utils } = require("ssh2");
const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_CONFIG = {
  dataDir: "/tmp/skiff-test-unused",
  port: 0,
  host: "127.0.0.1",
  nodeEnv: "test" as const,
  trustedOrigins: [],
  cookieSecret: "test-cookie-secret-at-least-32-chars-long-xxxxxxxxxx",
  setupToken: null,
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

async function personal() {
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
  return { app, db, cookie: cookieFrom(setup) };
}

const hostBody = (credential?: object, extra: object = {}) => ({
  label: "box", hostname: "10.0.0.9", username: "me", authMethod: "key", ...extra,
  ...(credential ? { credential } : {}),
});

// ── B-17: private keys are checked when saved ──

test("an encrypted private key needs its passphrase, and the right one", async () => {
  const { app, cookie } = await personal();
  try {
    const key = utils.generateKeyPairSync("ed25519", { passphrase: "open-sesame", cipher: "aes256-cbc" }).private;
    const post = (credential: object) => app.inject({ method: "POST", url: "/api/hosts", headers: { cookie }, payload: hostBody(credential) });

    const noPass = await post({ kind: "key", value: key });
    assert.equal(noPass.statusCode, 400);
    assert.match((noPass.json() as any).error.message, /encrypted.*passphrase/i);

    const wrong = await post({ kind: "key", value: key, passphrase: "nope" });
    assert.equal(wrong.statusCode, 400);
    assert.match((wrong.json() as any).error.message, /doesn't unlock/);

    const right = await post({ kind: "key", value: key, passphrase: "open-sesame" });
    assert.equal(right.statusCode, 200);
    assert.equal((right.json() as any).data.auth_method, "key+passphrase", "kind follows what the key is");
  } finally { await app.close(); }
});

test("public keys and garbage are rejected with a useful message; plain keys work", async () => {
  const { app, cookie } = await personal();
  try {
    const pair = utils.generateKeyPairSync("ed25519");
    const post = (credential: object) => app.inject({ method: "POST", url: "/api/hosts", headers: { cookie }, payload: hostBody(credential) });

    const pub = await post({ kind: "key", value: pair.public });
    assert.equal(pub.statusCode, 400);
    assert.match((pub.json() as any).error.message, /public key/);

    const junk = await post({ kind: "key", value: "hello" });
    assert.equal(junk.statusCode, 400);
    assert.match((junk.json() as any).error.message, /doesn't look like a private key/);

    const ok = await post({ kind: "key", value: pair.private });
    assert.equal(ok.statusCode, 200);
    assert.equal((ok.json() as any).data.auth_method, "key");
  } finally { await app.close(); }
});

test("editing without a new credential keeps the stored auth method", async () => {
  const { app, cookie } = await personal();
  try {
    const created = await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: hostBody({ kind: "password", value: "pw" }, { authMethod: "password" }),
    });
    const id = (created.json() as any).data.id;
    // The form's tab says "key" but no key was pasted.
    const edited = await app.inject({
      method: "PUT", url: `/api/hosts/${id}`, headers: { cookie },
      payload: hostBody(undefined, { authMethod: "key", label: "renamed" }),
    });
    assert.equal(edited.statusCode, 200);
    assert.equal((edited.json() as any).data.auth_method, "password");
    assert.equal((edited.json() as any).data.label, "renamed");
  } finally { await app.close(); }
});

// ── B-27: folders ──

test("folders can't be moved inside themselves and hosts can't use a missing folder", async () => {
  const { app, cookie } = await personal();
  try {
    const mk = async (name: string, parentId: string | null) =>
      (await app.inject({ method: "POST", url: "/api/folders", headers: { cookie }, payload: { name, parentId } })).json() as any;
    const a = (await mk("a", null)).data;
    const b = (await mk("b", a.id)).data;

    const self = await app.inject({ method: "PUT", url: `/api/folders/${a.id}`, headers: { cookie }, payload: { name: "a", parentId: a.id } });
    assert.equal(self.statusCode, 400);
    const loop = await app.inject({ method: "PUT", url: `/api/folders/${a.id}`, headers: { cookie }, payload: { name: "a", parentId: b.id } });
    assert.equal(loop.statusCode, 400);
    const fine = await app.inject({ method: "PUT", url: `/api/folders/${b.id}`, headers: { cookie }, payload: { name: "b", parentId: null } });
    assert.equal(fine.statusCode, 200);

    const ghost = await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: hostBody(undefined, { authMethod: "password", folderId: "fld_missing" }),
    });
    assert.equal(ghost.statusCode, 400, "was a 500 from the foreign key");
  } finally { await app.close(); }
});

// ── B-19: resetting a pinned fingerprint ──

test("only the owner/admin can forget a pinned host key, and it is audited", async () => {
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const admin = cookieFrom(setup);
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie: admin },
      payload: hostBody({ kind: "password", value: "pw" }, { authMethod: "password" }),
    })).json() as any;
    db.raw.prepare("INSERT INTO known_hosts (hostname, port, fingerprint, algorithm, first_seen_at) VALUES (?, 22, ?, 'ssh-ed25519', ?)")
      .run("10.0.0.9", "SHA256:old", new Date().toISOString());

    await app.inject({
      method: "POST", url: "/api/team/users", headers: { cookie: admin },
      payload: { username: "bob", tempPassword: "bob-temp-password" },
    });
    const bob = cookieFrom(await app.inject({ method: "POST", url: "/api/team/login", payload: { username: "bob", password: "bob-temp-password" } }));

    const byBob = await app.inject({ method: "DELETE", url: `/api/hosts/${host.data.id}/known-host`, headers: { cookie: bob } });
    assert.equal(byBob.statusCode, 403);

    const byAdmin = await app.inject({ method: "DELETE", url: `/api/hosts/${host.data.id}/known-host`, headers: { cookie: admin } });
    assert.equal(byAdmin.statusCode, 200);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS c FROM known_hosts").get()!.c as number, 0);

    const audit = await app.inject({ method: "GET", url: "/api/team/audit", headers: { cookie: admin } });
    const entry = ((audit.json() as any).data as any[]).find((e) => e.action === "host.fingerprint_reset");
    assert.equal(entry?.detail?.forgotten, "SHA256:old");
  } finally { await app.close(); }
});

// ── B-16: members change their own password ──

test("a member replaces their temporary password; other browsers are signed out", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const admin = cookieFrom(await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    }));
    await app.inject({
      method: "POST", url: "/api/team/users", headers: { cookie: admin },
      payload: { username: "bob", tempPassword: "bob-temp-password" },
    });
    const login = (password: string) => app.inject({ method: "POST", url: "/api/team/login", payload: { username: "bob", password } });

    const first = await login("bob-temp-password");
    assert.equal((first.json() as any).data.user.mustChangePassword, true);
    const laptop = cookieFrom(first);
    const phone = cookieFrom(await login("bob-temp-password"));

    const status = await app.inject({ method: "GET", url: "/api/vault/status", headers: { cookie: laptop } });
    assert.equal((status.json() as any).data.user.mustChangePassword, true);

    const wrong = await app.inject({
      method: "POST", url: "/api/team/me/password", headers: { cookie: laptop },
      payload: { currentPassword: "nope", newPassword: "bobs-own-password" },
    });
    assert.equal(wrong.statusCode, 401);

    const changed = await app.inject({
      method: "POST", url: "/api/team/me/password", headers: { cookie: laptop },
      payload: { currentPassword: "bob-temp-password", newPassword: "bobs-own-password" },
    });
    assert.equal(changed.statusCode, 200);

    assert.equal((await login("bob-temp-password")).statusCode, 401, "old password no longer works");
    const again = await login("bobs-own-password");
    assert.equal(again.statusCode, 200);
    assert.equal((again.json() as any).data.user.mustChangePassword, false);

    const laptopStatus = await app.inject({ method: "GET", url: "/api/vault/status", headers: { cookie: laptop } });
    assert.equal((laptopStatus.json() as any).data.unlocked, true, "the browser that changed it stays signed in");
    const phoneStatus = await app.inject({ method: "GET", url: "/api/vault/status", headers: { cookie: phone } });
    assert.equal((phoneStatus.json() as any).data.unlocked, false, "other browsers are signed out");

    // The member can still see and use the shared hosts afterwards (key re-sealed correctly).
    const hosts = await app.inject({ method: "GET", url: "/api/hosts", headers: { cookie: cookieFrom(again) } });
    assert.equal(hosts.statusCode, 200);

    // An admin reset issues a temporary password again.
    const users = (await app.inject({ method: "GET", url: "/api/team/users", headers: { cookie: admin } })).json() as any;
    const bobId = users.data.find((u: any) => u.username === "bob").id;
    await app.inject({
      method: "POST", url: "/api/team/users/reprovision", headers: { cookie: admin },
      payload: { userId: bobId, tempPassword: "another-temp-pass" },
    });
    assert.equal(((await login("another-temp-pass")).json() as any).data.user.mustChangePassword, true);
  } finally { await app.close(); }
});

// ── B-26: upgrading to team signs out anonymous personal logins ──

test("upgrading to team signs out other personal-mode browsers", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const first = cookieFrom(await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } }));
    const other = cookieFrom(await app.inject({ method: "POST", url: "/api/vault/unlock", payload: { password: "master-pass-1" } }));

    const up = await app.inject({
      method: "POST", url: "/api/settings/upgrade-team", headers: { cookie: first },
      payload: { currentPassword: "master-pass-1", adminUsername: "owner" },
    });
    assert.equal(up.statusCode, 200);
    const admin = cookieFrom(up);

    const otherStatus = await app.inject({ method: "GET", url: "/api/vault/status", headers: { cookie: other } });
    assert.equal((otherStatus.json() as any).data.unlocked, false);
    const adminStatus = await app.inject({ method: "GET", url: "/api/vault/status", headers: { cookie: admin } });
    assert.equal((adminStatus.json() as any).data.user.username, "owner");
  } finally { await app.close(); }
});
