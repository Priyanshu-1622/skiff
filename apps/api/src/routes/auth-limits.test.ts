/**
 * Password-guessing protection and client-IP handling.
 *
 * The property that matters: someone guessing wrong passwords slows down only
 * themselves. The owner, signing in from their own machine, is never locked out.
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

test("concurrent first-run setup initializes once and rejects the losing request cleanly", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const results = await Promise.all(["personal", "team"].map((mode) => app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "master-pass-1", mode, username: "admin" },
    })));
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
    const status = (await app.inject({ method: "GET", url: "/api/vault/status" })).json().data;
    assert.equal(status.initialized, true);
  } finally { await app.close(); }
});

test("failed team administrator insertion rolls back setup so it can be retried", async () => {
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  try {
    db.raw.exec("CREATE TRIGGER fail_admin BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END");
    const failed = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { mode: "team", username: "admin", password: "master-pass-1" } });
    assert.equal(failed.statusCode, 500);
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM vault_meta").get() as any).n, 0);
    db.raw.exec("DROP TRIGGER fail_admin");
    const retry = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { mode: "team", username: "admin", password: "master-pass-1" } });
    assert.equal(retry.statusCode, 200, retry.body);
  } finally { await app.close(); }
});

test("personal: an attacker's wrong passwords never lock the owner out", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });

    const attacker = "198.51.100.7";
    let last: any;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({
        method: "POST", url: "/api/vault/unlock", remoteAddress: attacker,
        payload: { password: "wrong-guess" },
      });
    }
    assert.equal(last.statusCode, 429, "the attacker gets slowed down");

    const owner = await app.inject({
      method: "POST", url: "/api/vault/unlock", remoteAddress: "192.0.2.10",
      payload: { password: "master-pass-1" },
    });
    assert.equal(owner.statusCode, 200, "the owner from another address unlocks normally");
  } finally { await app.close(); }
});

test("team: backoff is per client and says how long to wait; failures are audited", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const adminCookie = cookieFrom(setup);

    const attacker = "198.51.100.8";
    const codes: number[] = [];
    let blocked: any;
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({
        method: "POST", url: "/api/team/login", remoteAddress: attacker,
        payload: { username: "admin", password: "wrong-guess" },
      });
      codes.push(r.statusCode);
      blocked = r;
    }
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
    assert.match((blocked.json() as any).error.message, /wrong passwords/);
    assert.ok(Number(blocked.headers["retry-after"]) >= 1);

    // The admin is not locked out of their own account by someone else's guesses.
    const admin = await app.inject({
      method: "POST", url: "/api/team/login", remoteAddress: "192.0.2.20",
      payload: { username: "admin", password: "admin-password-1" },
    });
    assert.equal(admin.statusCode, 200);

    // Unknown usernames are rejected exactly like wrong passwords.
    const ghost = await app.inject({
      method: "POST", url: "/api/team/login", remoteAddress: "192.0.2.30",
      payload: { username: "nobody", password: "whatever" },
    });
    assert.equal(ghost.statusCode, 401);
    assert.equal((ghost.json() as any).error.message, "Invalid credentials");

    const audit = await app.inject({ method: "GET", url: "/api/team/audit", headers: { cookie: adminCookie } });
    const failed = ((audit.json() as any).data as any[]).filter((e) => e.action === "login.failed");
    assert.equal(failed.length, 6, "5 wrong passwords + 1 unknown user (the blocked attempt never got to check)");
    assert.ok(failed.some((e) => e.ip === attacker && e.detail?.username === "admin"));
  } finally { await app.close(); }
});

test("a successful sign-in clears that client's failures", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const me = "192.0.2.40";
    const login = (password: string) => app.inject({
      method: "POST", url: "/api/team/login", remoteAddress: me,
      payload: { username: "admin", password },
    });
    // 3 typos, a success, then 4 typos: 7 failures in all, which would trip the
    // backoff (5 free) if the success hadn't cleared the first three. Kept to
    // 8 requests so the separate 8-per-minute route cap doesn't interfere.
    for (let i = 0; i < 3; i++) assert.equal((await login("typo")).statusCode, 401);
    assert.equal((await login("admin-password-1")).statusCode, 200);
    for (let i = 0; i < 4; i++) assert.equal((await login("typo")).statusCode, 401);
  } finally { await app.close(); }
});

test("logout is audited in team mode", async () => {
  const app = await buildApp({ config: TEST_CONFIG, db: memDb() });
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    await app.inject({ method: "POST", url: "/api/vault/lock", headers: { cookie: cookieFrom(setup) } });
    const login = await app.inject({
      method: "POST", url: "/api/team/login",
      payload: { username: "admin", password: "admin-password-1" },
    });
    const audit = await app.inject({ method: "GET", url: "/api/team/audit", headers: { cookie: cookieFrom(login) } });
    assert.ok(((audit.json() as any).data as any[]).some((e) => e.action === "logout" && e.username === "admin"));
  } finally { await app.close(); }
});

test("behind a trusted proxy the real client IP is used; untrusted headers are ignored", async () => {
  const run = async (trustProxy: string | undefined) => {
    const app = await buildApp({ config: { ...TEST_CONFIG, trustProxy }, db: memDb() });
    try {
      const setup = await app.inject({
        method: "POST", url: "/api/vault/setup",
        payload: { password: "admin-password-1", mode: "team", username: "admin" },
      });
      await app.inject({
        method: "POST", url: "/api/team/login", remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.9" },
        payload: { username: "admin", password: "wrong" },
      });
      const audit = await app.inject({ method: "GET", url: "/api/team/audit", headers: { cookie: cookieFrom(setup) } });
      return ((audit.json() as any).data as any[]).find((e) => e.action === "login.failed")?.ip;
    } finally { await app.close(); }
  };
  assert.equal(await run("127.0.0.1"), "203.0.113.9", "trusted proxy → real client IP");
  assert.equal(await run(undefined), "127.0.0.1", "no trust → the header is ignored");
});
