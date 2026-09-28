import { test } from "node:test";
import assert from "node:assert/strict";
import { newDataKey, wrapDataKey, unwrapDataKey, sealChunk, openChunks, sealEntry, openEntry } from "./data-keys.js";
import { randomBytes } from "node:crypto";

test("a data key round-trips through wrapping; wrong vault key is rejected", () => {
  const vault = randomBytes(32);
  const dk = newDataKey();
  const { nonce, wrapped } = wrapDataKey(dk, vault);
  assert.ok(unwrapDataKey(wrapped, nonce, vault).equals(dk));
  assert.throws(() => unwrapDataKey(wrapped, nonce, randomBytes(32)));
});

test("chunks decrypt in order to the original bytes", () => {
  const k = newDataKey();
  const file = Buffer.concat([
    sealChunk(k, 0, "rec_1", Buffer.from("hello ")),
    sealChunk(k, 1, "rec_1", Buffer.from("world")),
  ]);
  const { plain, truncated } = openChunks(k, "rec_1", file);
  assert.equal(plain.toString(), "hello world");
  assert.equal(truncated, false);
});

test("the file never contains the plaintext", () => {
  const k = newDataKey();
  const file = sealChunk(k, 0, "rec_1", Buffer.from("SECRET-MARKER-123"));
  assert.ok(!file.includes(Buffer.from("SECRET-MARKER")));
});

test("a partial final chunk (crash mid-write) is dropped, earlier data survives", () => {
  const k = newDataKey();
  const a = sealChunk(k, 0, "rec_1", Buffer.from("complete "));
  const b = sealChunk(k, 1, "rec_1", Buffer.from("cut off"));
  const { plain, truncated } = openChunks(k, "rec_1", Buffer.concat([a, b.subarray(0, b.length - 5)]));
  assert.equal(plain.toString(), "complete ");
  assert.equal(truncated, true);
});

test("reordered, swapped or tampered chunks are rejected", () => {
  const k = newDataKey();
  const a = sealChunk(k, 0, "rec_1", Buffer.from("A"));
  const b = sealChunk(k, 1, "rec_1", Buffer.from("B"));
  assert.throws(() => openChunks(k, "rec_1", Buffer.concat([b, a])), "order is authenticated");
  assert.throws(() => openChunks(k, "rec_2", a), "chunks are bound to their recording");
  const bad = Buffer.from(a); bad[bad.length - 1] ^= 1;
  assert.throws(() => openChunks(k, "rec_1", bad));
});

test("sealEntry/openEntry round-trip; wrong key or wrong AAD is rejected", () => {
  const key = newDataKey();
  const plain = Buffer.from(JSON.stringify({ command: "whoami", output: "piyup\n", cwd: "/home" }));
  const { nonce, data } = sealEntry(key, "memory-entry:e1", plain);
  assert.deepEqual(openEntry(key, "memory-entry:e1", nonce, data), plain);
  assert.throws(() => openEntry(newDataKey(), "memory-entry:e1", nonce, data));
  assert.throws(() => openEntry(key, "memory-entry:e2", nonce, data), "AAD binds the entry to its own id");
});

test("sealEntry never puts the plaintext in the ciphertext", () => {
  const key = newDataKey();
  const plain = Buffer.from("a very findable marker string");
  const { data } = sealEntry(key, "memory-entry:e1", plain);
  assert.equal(data.includes(plain), false);
});
