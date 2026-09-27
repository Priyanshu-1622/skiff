/**
 * SessionRecorder format tests.
 *
 * Verifies the on-disk file is valid asciicast v2: a JSON header line
 * followed by [time, "o", data] event lines, and that finalize reports
 * sane duration/bytes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRecorder } from "./recorder.js";
import { openChunks, newDataKey } from "../crypto/data-keys.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "skiff-rec-"));
}

test("writes a valid asciicast v2 header", async () => {
  const dir = tmp();
  try {
    const rec = await SessionRecorder.create({ dir, id: "rec_abc", cols: 100, rows: 30, title: "test" });
    rec.finalize();
    await rec.closed;

    const lines = readFileSync(join(dir, "rec_abc.cast"), "utf8").trim().split("\n");
    const header = JSON.parse(lines[0]!);
    assert.equal(header.version, 2);
    assert.equal(header.width, 100);
    assert.equal(header.height, 30);
    assert.equal(header.title, "test");
    assert.ok(typeof header.timestamp === "number");
  } finally {
    await new Promise((r) => setTimeout(r, 30));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("records output events in [time, 'o', data] form", async () => {
  const dir = tmp();
  try {
    const rec = await SessionRecorder.create({ dir, id: "rec_evt", cols: 80, rows: 24 });
    rec.writeOutput(Buffer.from("hello"));
    await new Promise((r) => setTimeout(r, 10));
    rec.writeOutput(Buffer.from("world"));
    rec.finalize();
    await rec.closed;

    const lines = readFileSync(join(dir, "rec_evt.cast"), "utf8").trim().split("\n");
    assert.equal(lines.length, 3); // header + 2 events

    const e1 = JSON.parse(lines[1]!);
    const e2 = JSON.parse(lines[2]!);
    assert.equal(e1[1], "o");
    assert.equal(e1[2], "hello");
    assert.equal(e2[2], "world");
    assert.ok(typeof e1[0] === "number");
    assert.ok(e2[0] >= e1[0]); // time is monotonic
  } finally {
    await new Promise((r) => setTimeout(r, 30));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("finalize reports duration and byte count", async () => {
  const dir = tmp();
  try {
    const rec = await SessionRecorder.create({ dir, id: "rec_fin", cols: 80, rows: 24 });
    rec.writeOutput(Buffer.from("12345"));
    await new Promise((r) => setTimeout(r, 15));
    const { durationMs, bytes } = rec.finalize();
    assert.equal(bytes, 5);
    assert.ok(durationMs >= 10);
  } finally {
    await new Promise((r) => setTimeout(r, 30));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("writeOutput after finalize is a no-op (no throw)", async () => {
  const dir = tmp();
  try {
    const rec = await SessionRecorder.create({ dir, id: "rec_no", cols: 80, rows: 24 });
    rec.finalize();
    assert.doesNotThrow(() => rec.writeOutput(Buffer.from("late")));
    await new Promise((r) => setTimeout(r, 30)); // let the write stream flush to disk

    const lines = readFileSync(join(dir, "rec_no.cast"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1); // header only; the late write was dropped
  } finally {
    await new Promise((r) => setTimeout(r, 30));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("a UTF-8 character split across two chunks is recorded intact", async () => {
  const dir = tmp();
  try {
    const rec = SessionRecorder.create({ dir, id: "rec_utf8", cols: 80, rows: 24 });
    const bytes = Buffer.from("héllo ✓ 日本", "utf8");
    // Split inside "✓" (3 bytes) and inside "日" (3 bytes).
    const cut1 = bytes.indexOf(Buffer.from("✓")) + 1;
    const cut2 = bytes.indexOf(Buffer.from("日")) + 2;
    rec.writeOutput(bytes.subarray(0, cut1));
    rec.writeOutput(bytes.subarray(cut1, cut2));
    rec.writeOutput(bytes.subarray(cut2));
    rec.finalize();
    await rec.closed;

    const events = readFileSync(join(dir, "rec_utf8.cast"), "utf8").trim().split("\n").slice(1).map((l) => JSON.parse(l));
    const text = events.filter((e) => e[1] === "o").map((e) => e[2]).join("");
    assert.equal(text, "héllo ✓ 日本");
    assert.ok(!text.includes("�"));
  } finally {
    await new Promise((r) => setTimeout(r, 30));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("resizes are recorded as asciicast 'r' events", async () => {
  const dir = tmp();
  try {
    const rec = SessionRecorder.create({ dir, id: "rec_rs", cols: 120, rows: 40 });
    rec.writeResize(100, 30);
    rec.finalize();
    await rec.closed;
    const lines = readFileSync(join(dir, "rec_rs.cast"), "utf8").trim().split("\n");
    assert.equal(JSON.parse(lines[0]!).width, 120);
    const ev = JSON.parse(lines[1]!);
    assert.equal(ev[1], "r");
    assert.equal(ev[2], "100x30");
  } finally {
    await new Promise((r) => setTimeout(r, 30));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("with a key, the recording on disk is encrypted and decrypts to valid asciicast", async () => {
  const dir = tmp();
  try {
    const key = newDataKey();
    const rec = SessionRecorder.create({ dir, id: "rec_enc", cols: 90, rows: 30, key });
    rec.writeOutput(Buffer.from("SECRET-OUTPUT-42"));
    rec.finalize();
    await rec.closed;
    const raw = readFileSync(join(dir, "rec_enc.cast.enc"));
    assert.ok(!raw.includes(Buffer.from("SECRET-OUTPUT")));
    const { plain, truncated } = openChunks(key, "rec_enc", raw);
    assert.equal(truncated, false);
    const lines = plain.toString().trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].width, 90);
    assert.equal(lines[1][2], "SECRET-OUTPUT-42");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("encrypted recording keeps writing after the vault key is gone (uses its own key)", async () => {
  const dir = tmp();
  try {
    const key = newDataKey();
    const copy = Buffer.from(key);
    const rec = SessionRecorder.create({ dir, id: "rec_lock", cols: 80, rows: 24, key });
    rec.writeOutput(Buffer.from("before lock "));
    key.fill(0); // the caller's buffer being wiped must not matter: the recorder keeps its own copy
    rec.writeOutput(Buffer.from("after lock"));
    rec.finalize();
    await rec.closed;
    const text = openChunks(copy, "rec_lock", readFileSync(join(dir, "rec_lock.cast.enc"))).plain.toString();
    assert.ok(text.includes("before lock") && text.includes("after lock"));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("a long encrypted recording is written in several chunks, all readable", async () => {
  const dir = tmp();
  try {
    const key = newDataKey();
    const rec = SessionRecorder.create({ dir, id: "rec_big", cols: 80, rows: 24, key });
    for (let i = 0; i < 3000; i++) rec.writeOutput(Buffer.from(`line ${i} ${"x".repeat(40)}\r\n`));
    rec.finalize();
    await rec.closed;
    const raw = readFileSync(join(dir, "rec_big.cast.enc"));
    const { plain, truncated } = openChunks(key, "rec_big", raw);
    assert.equal(truncated, false);
    const text = plain.toString();
    assert.ok(text.includes("line 0 ") && text.includes("line 2999 "));
    assert.ok(raw.length > 3 * 32 * 1024, "more than one 32 KB chunk was written");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
