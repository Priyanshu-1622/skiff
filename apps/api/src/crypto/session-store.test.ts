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

test("background key lookup expires old sessions without extending live sessions", (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const store = new SessionStore(1);
  try {
    const old = store.create(randomBytes(32));
    const oldKey = store.get(old)!;
    now += 30_000;
    const live = store.create(randomBytes(32));
    const liveKey = store.get(live)!;
    now += 30_001;
    assert.equal(store.anyVaultKey(), liveKey);
    assert.ok(oldKey.every((byte) => byte === 0));
    assert.equal(store.size, 1);
    now += 30_000;
    assert.equal(store.anyVaultKey(), null, "background jobs do not renew idle time");
    assert.ok(liveKey.every((byte) => byte === 0));
  } finally { store.close(); }
});
