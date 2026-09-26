import { test } from "node:test";
import assert from "node:assert/strict";
import { AttemptLimiter } from "./attempt-limiter.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("the first few failures are free", () => {
  const c = clock();
  const lim = new AttemptLimiter({ freeAttempts: 3, now: c.now });
  for (let i = 0; i < 3; i++) {
    assert.equal(lim.retryAfterMs("ip-a"), 0);
    lim.recordFailure("ip-a");
  }
  assert.ok(lim.retryAfterMs("ip-a") > 0);
});

test("the wait doubles with each further failure and is capped", () => {
  const c = clock();
  const lim = new AttemptLimiter({ freeAttempts: 1, baseDelayMs: 1000, maxDelayMs: 5000, now: c.now });
  lim.recordFailure("k"); // free one used
  assert.equal(lim.retryAfterMs("k"), 1000);
  lim.recordFailure("k");
  assert.equal(lim.retryAfterMs("k"), 2000);
  lim.recordFailure("k");
  assert.equal(lim.retryAfterMs("k"), 4000);
  lim.recordFailure("k");
  assert.equal(lim.retryAfterMs("k"), 5000); // capped
});

test("waiting out the delay allows the next attempt", () => {
  const c = clock();
  const lim = new AttemptLimiter({ freeAttempts: 1, baseDelayMs: 1000, now: c.now });
  lim.recordFailure("k");
  c.advance(999);
  assert.equal(lim.retryAfterMs("k"), 1);
  c.advance(1);
  assert.equal(lim.retryAfterMs("k"), 0);
});

test("one client's failures never slow down another client", () => {
  const c = clock();
  const lim = new AttemptLimiter({ freeAttempts: 2, now: c.now });
  for (let i = 0; i < 20; i++) lim.recordFailure("attacker");
  assert.ok(lim.retryAfterMs("attacker") > 0);
  assert.equal(lim.retryAfterMs("owner"), 0);
});

test("success clears the record", () => {
  const c = clock();
  const lim = new AttemptLimiter({ freeAttempts: 1, now: c.now });
  lim.recordFailure("k");
  lim.recordFailure("k");
  lim.recordSuccess("k");
  assert.equal(lim.retryAfterMs("k"), 0);
});

test("old failures are forgotten", () => {
  const c = clock();
  const lim = new AttemptLimiter({ freeAttempts: 1, forgetAfterMs: 60_000, now: c.now });
  lim.recordFailure("k");
  lim.recordFailure("k");
  c.advance(60_001);
  assert.equal(lim.retryAfterMs("k"), 0);
});
