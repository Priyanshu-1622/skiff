import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runColumnMigrations } from "../../db/client.js";
import { newDataKey, wrapDataKey } from "../../crypto/data-keys.js";
import { makeKeyCache } from "./keys.js";

const here = dirname(fileURLToPath(import.meta.url));

function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(readFileSync(join(here, "../../db/schema.sql"), "utf-8"));
  runColumnMigrations(d);
  return d;
}

function seedKey(d: Database.Database, id: string, vaultKey: Buffer): Buffer {
  const dataKey = newDataKey();
  const { nonce, wrapped } = wrapDataKey(dataKey, vaultKey);
  d.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES (?, ?, ?, 'then')").run(id, wrapped, nonce);
  return dataKey;
}

test("get unwraps a session key, caches it, and returns null for a missing key id", () => {
  const d = freshDb();
  const vaultKey = newDataKey();
  const dataKey = seedKey(d, "key1", vaultKey);
  const cache = makeKeyCache(d, vaultKey);
  const first = cache.get("key1");
  assert.ok(first && first.equals(dataKey));
  assert.equal(cache.get("key1"), first, "second lookup returns the cached buffer");
  assert.equal(cache.get("missing"), null);
  cache.dispose();
});

test("dispose zero-fills every key the cache handed out", () => {
  const d = freshDb();
  const vaultKey = newDataKey();
  seedKey(d, "key1", vaultKey);
  seedKey(d, "key2", vaultKey);
  const cache = makeKeyCache(d, vaultKey);
  const a = cache.get("key1")!;
  const b = cache.get("key2")!;
  assert.ok(a.some((x) => x !== 0));
  cache.dispose();
  assert.ok(a.every((x) => x === 0), "key1 zeroed");
  assert.ok(b.every((x) => x === 0), "key2 zeroed");
});

test("a key wrapped under a different vault key yields null instead of throwing", () => {
  const d = freshDb();
  seedKey(d, "key1", newDataKey());
  const cache = makeKeyCache(d, newDataKey());
  assert.equal(cache.get("key1"), null);
  cache.dispose();
});
