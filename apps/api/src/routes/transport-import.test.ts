/**
 * Plain-HTTP sign-in guard (production cookies are HTTPS-only) and the
 * import route's handling of repeats and bad folders.
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

const BASE_CONFIG = {
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

const prod = (extra: object = {}) => ({ ...BASE_CONFIG, nodeEnv: "production" as const, ...extra });

test("production over plain HTTP from another machine: sign-in refuses with an explanation", async () => {
  const app = await buildApp({ config: prod(), db: memDb() });
  try {
    const lan = { host: "192.168.1.5:8080" };
    const status = await app.inject({ method: "GET", url: "/api/vault/status", headers: lan });
    assert.equal((status.json() as any).data.insecureTransport, true);

    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", headers: lan, payload: { password: "master-pass-1" } });
    assert.equal(setup.statusCode, 400);
    assert.equal((setup.json() as any).error.code, "INSECURE_TRANSPORT");
    assert.match((setup.json() as any).error.message, /HTTPS/);
  } finally { await app.close(); }
});

test("production on localhost works (browsers treat it as secure), cookie stays Secure", async () => {
  const app = await buildApp({ config: prod(), db: memDb() });
  try {
    const local = { host: "localhost:8080" };
    const status = await app.inject({ method: "GET", url: "/api/vault/status", headers: local });
    assert.equal((status.json() as any).data.insecureTransport, false);
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", headers: local, payload: { password: "master-pass-1" } });
    assert.equal(setup.statusCode, 200);
    assert.match(String(setup.headers["set-cookie"]), /Secure/);
  } finally { await app.close(); }
});

test("behind a trusted TLS proxy the original https counts", async () => {
  const app = await buildApp({ config: prod({ trustProxy: "127.0.0.1" }), db: memDb() });
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup", remoteAddress: "127.0.0.1",
      headers: { host: "skiff.example.com", "x-forwarded-proto": "https" },
      payload: { password: "master-pass-1" },
    });
    assert.equal(setup.statusCode, 200);
  } finally { await app.close(); }
});

test("SKIFF_INSECURE_HTTP opts in: sign-in works over LAN HTTP with a non-Secure cookie", async () => {
  const app = await buildApp({ config: prod({ allowInsecureHttp: true }), db: memDb() });
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup",
      headers: { host: "192.168.1.5:8080" }, payload: { password: "master-pass-1" },
    });
    assert.equal(setup.statusCode, 200);
    assert.doesNotMatch(String(setup.headers["set-cookie"]), /Secure/);
  } finally { await app.close(); }
});

// ── import ──

test("re-importing the same config skips hosts that already exist", async () => {
  const app = await buildApp({ config: BASE_CONFIG, db: memDb() });
  try {
    const cookie = cookieFrom(await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } }));
    const configText = "Host a\n  HostName 10.0.0.1\n  User me\nHost b c\n  HostName 10.0.0.2\n";
    const first = await app.inject({ method: "POST", url: "/api/import/apply", headers: { cookie }, payload: { configText } });
    assert.equal((first.json() as any).data.imported, 3);
    const second = await app.inject({ method: "POST", url: "/api/import/apply", headers: { cookie }, payload: { configText } });
    assert.equal((second.json() as any).data.imported, 0);
    assert.deepEqual((second.json() as any).data.skipped, ["a", "b", "c"]);
    const hosts = await app.inject({ method: "GET", url: "/api/hosts", headers: { cookie } });
    assert.equal((hosts.json() as any).data.length, 3);

    const badFolder = await app.inject({
      method: "POST", url: "/api/import/apply", headers: { cookie },
      payload: { configText: "Host z\n", folderId: "fld_nope" },
    });
    assert.equal(badFolder.statusCode, 400);
  } finally { await app.close(); }
});
