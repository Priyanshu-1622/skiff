import { test } from "node:test";
import assert from "node:assert/strict";
import { Osc133Parser } from "./osc133.js";

test("tokenizes prompt/command/executed markers with no surrounding text (BEL terminator)", () => {
  const p = new Osc133Parser();
  assert.deepEqual(p.feed("\x1b]133;A\x07"), [{ marker: { type: "prompt_start" } }]);
  assert.deepEqual(p.feed("\x1b]133;B\x07"), [{ marker: { type: "command_start" } }]);
  assert.deepEqual(p.feed("\x1b]133;C\x07"), [{ marker: { type: "command_executed" } }]);
});

test("tokenizes command_finished with and without an exit code (ST terminator)", () => {
  const p = new Osc133Parser();
  assert.deepEqual(p.feed("\x1b]133;D;0\x1b\\"), [{ marker: { type: "command_finished", exitCode: 0 } }]);
  assert.deepEqual(p.feed("\x1b]133;D;127\x1b\\"), [{ marker: { type: "command_finished", exitCode: 127 } }]);
  assert.deepEqual(p.feed("\x1b]133;D\x07"), [{ marker: { type: "command_finished", exitCode: null } }]);
});

test("tokenizes OSC 7 cwd reports", () => {
  const p = new Osc133Parser();
  assert.deepEqual(p.feed("\x1b]7;file://web-1/home/deploy/app\x07"), [
    { marker: { type: "cwd", path: "/home/deploy/app" } },
  ]);
});

test("consumes an unrelated OSC sequence (e.g. window title) without emitting a marker or crashing", () => {
  const p = new Osc133Parser();
  assert.deepEqual(p.feed("\x1b]0;deploy@web-1: ~\x07"), []);
});

test("consumes an unrecognized 133 letter instead of throwing", () => {
  const p = new Osc133Parser();
  assert.deepEqual(p.feed("\x1b]133;Z\x07"), []);
});

test("plain text with no escape sequences at all is passed through as a single write token", () => {
  const p = new Osc133Parser();
  assert.deepEqual(p.feed("\x1b[31mred text\x1b[0m"), [{ write: "\x1b[31mred text\x1b[0m" }]);
  // CSI colour codes are not OSC — untouched, passed straight through so
  // the mirror renders them exactly as sent.
});

test("interleaves write and marker tokens in the order they occurred", () => {
  const p = new Osc133Parser();
  const tokens = p.feed("some output\x1b]133;C\x07more output\r\n");
  assert.deepEqual(tokens, [
    { write: "some output" },
    { marker: { type: "command_executed" } },
    { write: "more output\r\n" },
  ]);
});

test("multiple markers and text runs in one chunk are all reported in order", () => {
  const p = new Osc133Parser();
  const tokens = p.feed("\x1b]133;A\x07prompt$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07");
  assert.deepEqual(tokens, [
    { marker: { type: "prompt_start" } },
    { write: "prompt$ " },
    { marker: { type: "command_start" } },
    { write: "ls\r\n" },
    { marker: { type: "command_executed" } },
  ]);
});

test("reassembles a sequence split across chunks, anywhere in the middle", () => {
  const p = new Osc133Parser();
  assert.deepEqual(p.feed("\x1b]13"), []);
  assert.deepEqual(p.feed("3;B\x07"), [{ marker: { type: "command_start" } }]);
});

test("reassembles a sequence split exactly between ESC and ']'", () => {
  const p = new Osc133Parser();
  assert.deepEqual(p.feed("\x1b"), []);
  assert.deepEqual(p.feed("]133;A\x07"), [{ marker: { type: "prompt_start" } }]);
});

test("text before a sequence split across chunks is emitted immediately, not held back", () => {
  const p = new Osc133Parser();
  assert.deepEqual(p.feed("hello \x1b]13"), [{ write: "hello " }]);
  assert.deepEqual(p.feed("3;B\x07 world"), [{ marker: { type: "command_start" } }, { write: " world" }]);
});

test("an unterminated sequence does not grow the pending buffer without bound, and text before it still gets through", () => {
  const p = new Osc133Parser();
  const junk = "x".repeat(10_000);
  assert.deepEqual(p.feed(`before\x1b]133;${junk}`), [{ write: "before" }]);
  // the parser recovered rather than holding 10KB forever; a real marker right
  // after still gets found once the bogus one is discarded
  assert.deepEqual(p.feed("\x1b]133;A\x07"), [{ marker: { type: "prompt_start" } }]);
});

test("an OSC aborted by another escape sequence (no BEL/ST) does not swallow that sequence's visible text", () => {
  // Real terminals end an OSC string at BEL/ST OR at any other ESC that
  // isn't the start of ST — the aborting ESC is NOT consumed, so it can
  // start its own sequence right after. Before this fix, the parser only
  // looked for BEL/ST and would treat "\x1b[31mVISIBLE\x1b[0m" as if it
  // were still inside the OSC body, discarding visible text a real
  // terminal would have rendered.
  const p = new Osc133Parser();
  const tokens = p.feed("bin\x1b]garbage\x1b[31mVISIBLE TEXT\x07tail");
  assert.deepEqual(tokens, [
    { write: "bin" },
    // the aborted OSC ("garbage") produced no marker
    { write: "\x1b[31mVISIBLE TEXT\x07tail" },
  ]);
});

test("an unterminated OSC title followed by a real marker does not swallow the marker", () => {
  const p = new Osc133Parser();
  const tokens = p.feed("\x1b]0;untermina");
  assert.deepEqual(tokens, [], "still waiting for a terminator, nothing to report yet");
  const tokens2 = p.feed("ted title\x1b[Hmore\x1b]133;A\x07");
  assert.deepEqual(tokens2, [
    { write: "\x1b[Hmore" },
    { marker: { type: "prompt_start" } },
  ]);
});

test("CAN and SUB abort an in-progress OSC and are themselves discarded", () => {
  const p = new Osc133Parser();
  const tokens = p.feed("bin\x1b]garbage\x18tail");
  assert.deepEqual(tokens, [{ write: "bin" }, { write: "tail" }]);
});
