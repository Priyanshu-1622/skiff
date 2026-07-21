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

function tmp() {
  return mkdtempSync(join(tmpdir(), "skiff-rec-"));
}

test("writes a valid asciicast v2 header", async () => {
  const dir = tmp();
  try {
    const rec = await SessionRecorder.create({ dir, id: "rec_abc", cols: 100, rows: 30, title: "test" });
    rec.finalize();
    await new Promise((r) => setTimeout(r, 30)); // let the write stream flush to disk

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
    await new Promise((r) => setTimeout(r, 30)); // let the write stream flush

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
