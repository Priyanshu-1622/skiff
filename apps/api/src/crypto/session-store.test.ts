import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SessionStore } from "./session-store.js";

test("anyVaultKey returns null with nothing unlocked, and a live key once one session exists", () => {
  const store = new SessionStore();
  assert.equal(store.anyVaultKey(), null);
  const key = randomBytes(32);
  store.create(key);
  assert.deepEqual(store.anyVaultKey(), key);
  store.close();
});
