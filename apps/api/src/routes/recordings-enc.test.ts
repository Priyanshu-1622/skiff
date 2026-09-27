/**
 * Encrypted recordings play back decrypted while the vault is unlocked, old
 * plaintext recordings still play, and a recording cut off by a crash plays
 * up to the last complete chunk.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildApp } from "../app.js";
import { runColumnMigrations } from "../db/client.js";
import { deriveVaultKey } from "../crypto/vault.js";
import { newDataKey, wrapDataKey } from "../crypto/data-keys.js";
import { SessionRecorder } from "../lib/recorder.js";

const here = dirname(fileURLToPath(import.meta.url));

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "skiff-recenc-"));
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  raw.exec(readFileSync(join(here, "../db/schema.sql"), "utf-8"));
  runColumnMigrations(raw);
  const app = await buildApp({
    config: { dataDir, port: 0, host: "127.0.0.1", nodeEnv: "test", trustedOrigins: [], cookieSecret: "x".repeat(40), setupToken: null },
    db: { raw, close: () => raw.close() },
  });
  const res = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
  const cookie = String(res.headers["set-cookie"]).split(";")[0];
  const meta = raw.prepare("SELECT * FROM vault_meta").get() as any;
  const vaultKey = await deriveVaultKey("master-pass-1", {
    algorithm: "argon2id", salt: meta.kdf_salt, iterations: meta.kdf_iterations,
    memoryKib: meta.kdf_memory_kib, parallelism: meta.kdf_parallelism,
  });
  mkdirSync(join(dataDir, "recordings"), { recursive: true });
  return { app, raw, cookie, vaultKey, dataDir };
}

async function writeEncrypted(raw: Database.Database, dataDir: string, vaultKey: Buffer, id: string, text: string) {
  const key = newDataKey();
  const { nonce, wrapped } = wrapDataKey(key, vaultKey);
  raw.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES (?, ?, ?, 'now')").run(`key_${id}`, wrapped, nonce);
  const rec = SessionRecorder.create({ dir: join(dataDir, "recordings"), id, cols: 80, rows: 24, key });
  rec.writeOutput(Buffer.from(text));
  rec.finalize();
  await rec.closed;
  raw.prepare("INSERT INTO session_recordings (id, started_at, status, format, key_id) VALUES (?, 'now', 'complete', 'enc', ?)").run(id, `key_${id}`);
}

test("encrypted recordings play back decrypted while unlocked, and not after lock", async () => {
  const { app, raw, cookie, vaultKey, dataDir } = await setup();
  try {
    await writeEncrypted(raw, dataDir, vaultKey, "rec_a", "hello from the past");
    const ok = await app.inject({ method: "GET", url: "/api/recordings/rec_a/cast", headers: { cookie } });
    assert.equal(ok.statusCode, 200);
    const lines = ok.body.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].version, 2);
    assert.ok(ok.body.includes("hello from the past"));

    await app.inject({ method: "POST", url: "/api/vault/lock", headers: { cookie } });
    const locked = await app.inject({ method: "GET", url: "/api/recordings/rec_a/cast", headers: { cookie } });
    assert.equal(locked.statusCode, 401);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("recordings made before encryption still play", async () => {
  const { app, raw, cookie, dataDir } = await setup();
  try {
    writeFileSync(join(dataDir, "recordings", "rec_old.cast"), '{"version":2,"width":80,"height":24}\n[0.1,"o","legacy"]\n');
    raw.prepare("INSERT INTO session_recordings (id, started_at, status) VALUES ('rec_old', 'now', 'complete')").run();
    const res = await app.inject({ method: "GET", url: "/api/recordings/rec_old/cast", headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes("legacy"));
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a recording cut off mid-chunk plays up to the last complete chunk", async () => {
  const { app, raw, cookie, vaultKey, dataDir } = await setup();
  try {
    await writeEncrypted(raw, dataDir, vaultKey, "rec_cut", "survives");
    const file = join(dataDir, "recordings", "rec_cut.cast.enc");
    // Append a partial frame, as a crash mid-write would leave.
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from([0, 0, 1, 0, 9, 9, 9])]));
    const res = await app.inject({ method: "GET", url: "/api/recordings/rec_cut/cast", headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes("survives"));
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("deleting an encrypted recording removes its file", async () => {
  const { app, raw, cookie, vaultKey, dataDir } = await setup();
  try {
    await writeEncrypted(raw, dataDir, vaultKey, "rec_del", "gone soon");
    const res = await app.inject({ method: "DELETE", url: "/api/recordings/rec_del", headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.throws(() => readFileSync(join(dataDir, "recordings", "rec_del.cast.enc")), "file deleted");
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
