/**
 * Team-mode integration tests.
 *
 * Boots the real Fastify app against an in-memory SQLite database and
 * exercises the full team lifecycle over HTTP via app.inject():
 *   setup (team) -> admin session -> create user -> second user login
 *   -> shared credential visibility -> reset password -> disable -> audit.
 *
 * These require the native argon2 and better-sqlite3 modules, so they run
 * in a normal dev environment (not in restricted sandboxes without the
 * compiled bindings).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildApp } from "../app.js";
import type { SkiffDb } from "../db/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_CONFIG = {
  dataDir: "/tmp/skiff-test-unused",
  port: 0,
  host: "127.0.0.1",
  nodeEnv: "test" as const,
  trustedOrigins: [],
  cookieSecret: "test-cookie-secret-at-least-32-chars-long-xxxxxxxxxx",
};

/** In-memory SQLite with schema + the runtime column migration applied. */
function memDb(): SkiffDb {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(join(__dirname, "../db/schema.sql"), "utf-8");
  db.exec(schema);
  // Mirror the additive migration runColumnMigrations() performs at boot.
  const hasMode = db.prepare("PRAGMA table_info(vault_meta)").all().some((c: any) => c.name === "mode");
  if (!hasMode) db.exec("ALTER TABLE vault_meta ADD COLUMN mode TEXT NOT NULL DEFAULT 'personal'");
  return { raw: db, close: () => db.close() };
}

/** Pull the session cookie out of a set-cookie header. */
function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : (raw as string);
  return header.split(";")[0];
}

test("team setup creates an admin and an unlocked session", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as any;
    assert.equal(body.ok, true);
    assert.equal(body.data.mode, "team");
    assert.equal(body.data.user.username, "admin");
    assert.equal(body.data.user.isAdmin, true);
    assert.ok(cookieFrom(res).startsWith("skiff_session="));

    // status should report team mode + the signed-in user
    const status = await app.inject({ method: "GET", url: "/api/vault/status", headers: { cookie: cookieFrom(res) } });
    const sBody = status.json() as any;
    assert.equal(sBody.data.mode, "team");
    assert.equal(sBody.data.unlocked, true);
  } finally {
    await app.close();
  }
});

test("admin can create a user who can then log in and see shared hosts", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    // setup
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const adminCookie = cookieFrom(setup);

    // admin creates a host (encrypted with the shared key)
    const host = await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie: adminCookie },
      payload: {
        label: "prod-web", hostname: "10.0.0.5", port: 22, username: "deploy",
        authMethod: "password", tags: [], starred: false,
        credential: { kind: "password", value: "super-secret" },
      },
    });
    assert.equal(host.statusCode, 200);

    // admin creates a second user
    const create = await app.inject({
      method: "POST", url: "/api/team/users", headers: { cookie: adminCookie },
      payload: { username: "bob", tempPassword: "bob-temp-password", isAdmin: false },
    });
    assert.equal(create.statusCode, 200);

    // bob logs in
    const login = await app.inject({
      method: "POST", url: "/api/team/login",
      payload: { username: "bob", password: "bob-temp-password" },
    });
    assert.equal(login.statusCode, 200);
    const bobCookie = cookieFrom(login);

    // bob sees the shared host
    const hosts = await app.inject({ method: "GET", url: "/api/hosts", headers: { cookie: bobCookie } });
    assert.equal(hosts.statusCode, 200);
    const list = (hosts.json() as any).data;
    assert.equal(list.length, 1);
    assert.equal(list[0].label, "prod-web");
  } finally {
    await app.close();
  }
});

test("wrong password is rejected", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const bad = await app.inject({
      method: "POST", url: "/api/team/login",
      payload: { username: "admin", password: "wrong-password" },
    });
    assert.equal(bad.statusCode, 401);
    assert.equal((bad.json() as any).error.code, "INVALID_PASSWORD");
  } finally {
    await app.close();
  }
});

test("non-admin cannot access admin routes", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const adminCookie = cookieFrom(setup);
    await app.inject({
      method: "POST", url: "/api/team/users", headers: { cookie: adminCookie },
      payload: { username: "bob", tempPassword: "bob-temp-password", isAdmin: false },
    });
    const login = await app.inject({
      method: "POST", url: "/api/team/login",
      payload: { username: "bob", password: "bob-temp-password" },
    });
    const bobCookie = cookieFrom(login);

    const users = await app.inject({ method: "GET", url: "/api/team/users", headers: { cookie: bobCookie } });
    assert.equal(users.statusCode, 403);
    assert.equal((users.json() as any).error.code, "FORBIDDEN");
  } finally {
    await app.close();
  }
});

test("password reset lets a user log in with the new password", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const adminCookie = cookieFrom(setup);
    const create = await app.inject({
      method: "POST", url: "/api/team/users", headers: { cookie: adminCookie },
      payload: { username: "bob", tempPassword: "bob-temp-password", isAdmin: false },
    });
    const bobId = (create.json() as any).data.id;

    // admin resets bob's password
    const reset = await app.inject({
      method: "POST", url: "/api/team/users/reprovision", headers: { cookie: adminCookie },
      payload: { userId: bobId, tempPassword: "bob-new-password" },
    });
    assert.equal(reset.statusCode, 200);

    // old password fails
    const oldLogin = await app.inject({
      method: "POST", url: "/api/team/login",
      payload: { username: "bob", password: "bob-temp-password" },
    });
    assert.equal(oldLogin.statusCode, 401);

    // new password works
    const newLogin = await app.inject({
      method: "POST", url: "/api/team/login",
      payload: { username: "bob", password: "bob-new-password" },
    });
    assert.equal(newLogin.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("cannot disable the last admin", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const adminCookie = cookieFrom(setup);
    const me = await app.inject({ method: "GET", url: "/api/team/me", headers: { cookie: adminCookie } });
    const adminId = (me.json() as any).data.user.id;

    const disable = await app.inject({
      method: "POST", url: `/api/team/users/${adminId}/disabled`, headers: { cookie: adminCookie },
      payload: { disabled: true },
    });
    assert.equal(disable.statusCode, 409);
    assert.equal((disable.json() as any).error.code, "CONFLICT");
  } finally {
    await app.close();
  }
});

test("audit log records logins and user creation", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const adminCookie = cookieFrom(setup);
    await app.inject({
      method: "POST", url: "/api/team/users", headers: { cookie: adminCookie },
      payload: { username: "bob", tempPassword: "bob-temp-password", isAdmin: false },
    });

    const audit = await app.inject({ method: "GET", url: "/api/team/audit", headers: { cookie: adminCookie } });
    assert.equal(audit.statusCode, 200);
    const events = (audit.json() as any).data as Array<{ action: string }>;
    const actions = events.map((e) => e.action);
    assert.ok(actions.includes("vault.setup"));
    assert.ok(actions.includes("user.create"));
  } finally {
    await app.close();
  }
});

test("personal unlock route is rejected on a team vault", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    // Even with the correct first-admin password, the personal unlock path
    // must refuse team vaults (it would create a session with no user).
    const res = await app.inject({
      method: "POST", url: "/api/vault/unlock",
      payload: { password: "admin-password-1" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as any).error.code, "WRONG_MODE");
  } finally {
    await app.close();
  }
});

test("personal password-change route is rejected on a team vault", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const adminCookie = cookieFrom(setup);
    const res = await app.inject({
      method: "PUT", url: "/api/settings/password", headers: { cookie: adminCookie },
      payload: { currentPassword: "admin-password-1", newPassword: "new-password-2" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as any).error.code, "WRONG_MODE");
  } finally {
    await app.close();
  }
});

test("personal mode still works and rejects team login", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "my-master-password" },
    });
    assert.equal(setup.statusCode, 200);
    assert.equal((setup.json() as any).data.mode, "personal");

    // team login should not work on a personal vault
    const teamLogin = await app.inject({
      method: "POST", url: "/api/team/login",
      payload: { username: "whoever", password: "whatever" },
    });
    assert.equal(teamLogin.statusCode, 400);
    assert.equal((teamLogin.json() as any).error.code, "WRONG_MODE");
  } finally {
    await app.close();
  }
});

test("personal -> team upgrade preserves hosts and creates admin", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    // personal setup
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "my-master-password" },
    });
    let cookie = cookieFrom(setup);

    // add a host in personal mode
    await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: {
        label: "my-server", hostname: "1.2.3.4", port: 22, username: "root",
        authMethod: "password", tags: [], starred: false,
        credential: { kind: "password", value: "secret" },
      },
    });

    // upgrade to team
    const upgrade = await app.inject({
      method: "POST", url: "/api/settings/upgrade-team", headers: { cookie },
      payload: { currentPassword: "my-master-password", adminUsername: "owner" },
    });
    assert.equal(upgrade.statusCode, 200);
    assert.equal((upgrade.json() as any).data.mode, "team");
    cookie = cookieFrom(upgrade);

    // host survived the upgrade
    const hosts = await app.inject({ method: "GET", url: "/api/hosts", headers: { cookie } });
    const list = (hosts.json() as any).data;
    assert.equal(list.length, 1);
    assert.equal(list[0].label, "my-server");

    // can log in as the new admin with the same password
    const login = await app.inject({
      method: "POST", url: "/api/team/login",
      payload: { username: "owner", password: "my-master-password" },
    });
    assert.equal(login.statusCode, 200);
  } finally {
    await app.close();
  }
});
