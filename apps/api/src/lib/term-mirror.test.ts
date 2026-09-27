import { test } from "node:test";
import assert from "node:assert/strict";
import { TermMirror } from "./term-mirror.js";

test("renders output and reports the cursor line", async () => {
  const m = new TermMirror({ cols: 80, rows: 24 });
  m.write("hello\r\ndeploy@web-1:~$ ls");
  await m.flush();
  assert.equal(m.cursorLine(), "deploy@web-1:~$ ls");
  assert.equal(m.cursorX(), 18);
  m.dispose();
});

test("applies terminal edits (backspace, cursor moves)", async () => {
  const m = new TermMirror({ cols: 80, rows: 24 });
  m.write("$ cat /etc/hsots\b \b\b \b\b \b\b \bosts");
  await m.flush();
  assert.equal(m.cursorLine(), "$ cat /etc/hosts");
  m.dispose();
});

test("detects the alternate screen (vim, less, htop)", async () => {
  const m = new TermMirror({ cols: 80, rows: 24 });
  m.write("\x1b[?1049h");
  await m.flush();
  assert.equal(m.isAltScreen(), true);
  m.write("\x1b[?1049l");
  await m.flush();
  assert.equal(m.isAltScreen(), false);
  m.dispose();
});

test("snapshot replays into a fresh terminal as the same screen", async () => {
  const a = new TermMirror({ cols: 40, rows: 5 });
  a.write("one\r\n\x1b[31mtwo\x1b[0m\r\n$ ");
  const snap = await a.snapshot();
  assert.ok(snap.includes("\x1b[31m"), "colours are preserved");
  const b = new TermMirror({ cols: 40, rows: 5 });
  b.write(snap);
  await b.flush();
  assert.equal(b.cursorLine(), "$");
  a.dispose(); b.dispose();
});

test("an output flood stays bounded by scrollback and remains responsive", async () => {
  const m = new TermMirror({ cols: 80, rows: 24, scrollback: 1000 });
  const line = "x".repeat(79) + "\r\n";
  const start = Date.now();
  for (let i = 0; i < 20000; i++) m.write(line); // ~1.6 MB
  m.write("END");
  await m.flush();
  assert.ok(Date.now() - start < 5000, "20k lines processed in under 5s");
  assert.equal(m.cursorLine(), "END");
  const snap = await m.snapshot();
  assert.ok(snap.length < 200_000, "snapshot limited by scrollback, not total output");
  m.dispose();
});

test("a snapshot reports exactly which writes it contains", async () => {
  const m = new TermMirror({ cols: 40, rows: 5 });
  const a = m.write("one\r\n");
  const pending = m.snapshotWithSeq();
  const b = m.write("two\r\n");          // written after the snapshot was requested
  const { screen, seq } = await pending;
  assert.ok(a <= seq, "earlier write is included");
  // Whatever xterm batched, the reported seq and the screen agree:
  assert.equal(screen.includes("two"), b <= seq);
  m.dispose();
});

test("write() sheds (does not queue) once the pending backlog is at the cap", () => {
  // The cap must be enforced by TermMirror itself, checked before a write is
  // ever handed to xterm — not discovered by hitting xterm's own internal
  // limit. Proven purely through the public API: a shed write's sequence
  // number does not advance, because nothing was actually queued for it.
  const m = new TermMirror({ cols: 80, rows: 24, maxPendingBytes: 4000 });
  const chunk = Buffer.alloc(2001, 0x78); // never resolved in this test — pendingBytes only grows
  const seq1 = m.write(chunk); // backlog 0 -> accepted; pending 2001
  const seq2 = m.write(chunk); // backlog 2001 (under 4000) -> accepted; pending 4002
  const seq3 = m.write(chunk); // backlog 4002 (at/over 4000) -> shed
  assert.equal(seq2, seq1 + 1, "second write is accepted");
  assert.equal(seq3, seq2, "third write is shed: no new sequence number was issued");
  assert.equal(m.failed, false, "shedding is not a failure");
  m.dispose();
});

test("a flood large enough to hit xterm's own internal backlog limit does not fail the mirror", async () => {
  // Independently confirmed against the installed @xterm/headless: its own
  // WriteBuffer throws once unparsed backlog passes 50,000,000 bytes exactly
  // ("write data discarded, use flow control to avoid losing data"), almost
  // immediately once that many bytes have been queued without the async
  // parser getting a turn to drain any of it. Before this fix, that exception
  // set `_failed = true` forever: every later reattach of that session would
  // show an empty screen for the rest of its life, from one fast burst of
  // output (e.g. `cat` on a large file). This must not happen with the
  // mirror's PRODUCTION default cap — no test-only override here.
  const m = new TermMirror({ cols: 80, rows: 24 });
  const chunk = Buffer.alloc(200_000, 0x78); // 200 KB per call, no callback awaited
  for (let i = 0; i < 400; i++) m.write(chunk); // 80 MB fired synchronously, well past the 50 MB throw point
  assert.equal(m.failed, false, "the default cap must keep the mirror well under xterm's internal limit");

  // The mirror must also still be fully usable afterwards, not merely alive.
  await m.flush();
  assert.equal(m.failed, false);
  m.write("RECOVERED");
  await m.flush();
  assert.equal(m.cursorLine(), "RECOVERED", "the mirror keeps working after the flood, not just survives it");
  m.dispose();
});

test("resize clamps nonsense sizes and never throws", async () => {
  const m = new TermMirror({ cols: 80, rows: 24 });
  m.resize(0, -5);
  m.resize(100000, 3);
  m.write("ok");
  await m.flush();
  assert.equal(m.cursorLine(), "ok");
  m.dispose();
});
