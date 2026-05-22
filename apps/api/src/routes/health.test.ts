/**
 * Health route smoke test.
 *
 * Boots the Fastify app against an in-memory SQLite database so the
 * test is hermetic and fast. Verifies the response envelope shape
 * matches what the client expects.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildApp } from "../app.js";
import { SCHEMA_VERSION, type SkiffDb } from "../db/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Open an in-memory SQLite with the schema applied. */
function memDb(): SkiffDb {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const schemaPath = join(__dirname, "../db/schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);
  return { raw: db, close: () => db.close() };
}

test("GET /api/health returns ok envelope with db connectivity", async () => {
  const app = await buildApp({
    config: {
      dataDir: "/tmp/skiff-test-unused",
      port: 0,
      host: "127.0.0.1",
      nodeEnv: "test",
      trustedOrigins: [],
      cookieSecret: "test-cookie-secret-at-least-32-chars-long-xxxxxxxxxx",
    },
    db: memDb(),
  });

  try {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(res.statusCode, 200);

    const body = res.json() as {
      ok: boolean;
      data: {
        status: string;
        version: string;
        schemaVersion: number;
        uptimeSeconds: number;
        db: string;
      };
    };

    assert.equal(body.ok, true);
    assert.equal(body.data.status, "ok");
    assert.equal(body.data.schemaVersion, SCHEMA_VERSION);
    assert.equal(body.data.db, "connected");
    assert.ok(typeof body.data.uptimeSeconds === "number");
    assert.ok(body.data.uptimeSeconds >= 0);
  } finally {
    await app.close();
  }
});

test("unknown route returns NOT_FOUND envelope", async () => {
  const app = await buildApp({
    config: {
      dataDir: "/tmp/skiff-test-unused",
      port: 0,
      host: "127.0.0.1",
      nodeEnv: "test",
      trustedOrigins: [],
      cookieSecret: "test-cookie-secret-at-least-32-chars-long-xxxxxxxxxx",
    },
    db: memDb(),
  });

  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/does-not-exist",
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { ok: boolean; error: { code: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "NOT_FOUND");
  } finally {
    await app.close();
  }
});
