import { test } from "node:test";
import assert from "node:assert/strict";
import { OutputGate } from "./output-gate.js";

const MARKER = Buffer.from("\x1b]133;A");
const PREFIX = Buffer.from("\r\x1b[2K");

function gate(maxHeld = 1024) {
  const results: string[] = [];
  const g = new OutputGate(MARKER, PREFIX, maxHeld, (r) => results.push(r));
  return { g, results };
}
const text = (b: Buffer) => b.toString();

test("it holds everything until the marker, then passes on the prefix plus everything from the marker", () => {
  const { g, results } = gate();
  assert.equal(text(g.push(Buffer.from(" __skiff_x\r\n"))), "", "the echo is held");
  assert.equal(g.active, true);
  const out = g.push(Buffer.from("\x1b]133;D;0\x07\x1b]133;A\x07$ "));
  assert.equal(text(out), "\r\x1b[2K\x1b]133;A\x07$ ", "the echo and the D marker before A are dropped");
  assert.equal(g.active, false);
  assert.deepEqual(results, ["marker"]);
});

test("a marker split across two chunks is still found", () => {
  const { g, results } = gate();
  assert.equal(text(g.push(Buffer.from("echo\r\n\x1b]13"))), "");
  assert.equal(text(g.push(Buffer.from("3;A\x07$ "))), "\r\x1b[2K\x1b]133;A\x07$ ");
  assert.deepEqual(results, ["marker"]);
});

test("after it resolves the gate is transparent", () => {
  const { g } = gate();
  g.push(Buffer.from("\x1b]133;A\x07"));
  assert.equal(text(g.push(Buffer.from("ls\r\n"))), "ls\r\n");
});

test("timeout() releases everything held, in order, and resolves once", () => {
  const { g, results } = gate();
  g.push(Buffer.from("bash: "));
  g.push(Buffer.from("syntax error\r\n"));
  assert.equal(text(g.timeout()), "bash: syntax error\r\n");
  assert.equal(g.active, false);
  assert.deepEqual(results, ["timeout"]);
  assert.equal(text(g.push(Buffer.from("\x1b]133;A\x07"))), "\x1b]133;A\x07", "late marker passes straight through");
  assert.deepEqual(results, ["timeout"], "resolved exactly once");
});

test("holding more than the limit releases everything (fails open)", () => {
  const { g, results } = gate(10);
  const out = g.push(Buffer.from("0123456789ABCDEF"));
  assert.equal(text(out), "0123456789ABCDEF");
  assert.deepEqual(results, ["overflow"]);
  assert.equal(g.active, false);
});

test("abort() drops what was held and resolves 'gone'", () => {
  const { g, results } = gate();
  g.push(Buffer.from("held"));
  g.abort();
  assert.deepEqual(results, ["gone"]);
  assert.equal(g.active, false);
  assert.equal(text(g.push(Buffer.from("x"))), "x");
});
