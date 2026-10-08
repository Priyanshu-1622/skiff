import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptureEngine, truncateHeadTail } from "./engine.js";
import { TermMirror } from "../term-mirror.js";
import { BASH_MARKER } from "./corpus/bash-marker.js";
import { BASH_PLAIN } from "./corpus/bash-plain.js";

function typeAndEnter(engine: CaptureEngine, command: string) {
  for (const ch of command) engine.onInput(ch);
  engine.onInput("\n");
}

test("marker mode: captures command text, exit code and cwd from real OSC 133/7 bytes, ignoring the probe's own spurious duplicate C markers", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);

  await engine.onOutput(BASH_MARKER.preamble);
  for (const seg of BASH_MARKER.segments) {
    typeAndEnter(engine, seg.command);
    await engine.onOutput(seg.echoAndOutput);
  }

  assert.equal(engine.events.length, 3, "the probe's spurious extra C markers must not create phantom events");
  assert.deepEqual(
    engine.events.map((e) => ({ command: e.command, exitCode: e.exitCode, confidence: e.confidence, cwd: e.cwd })),
    [
      { command: "whoami", exitCode: 0, confidence: "marker", cwd: "/d/Skiff/skiff webapp updates" },
      { command: "false", exitCode: 1, confidence: "marker", cwd: "/d/Skiff/skiff webapp updates" },
      { command: "echo done", exitCode: 0, confidence: "marker", cwd: "/d/Skiff/skiff webapp updates" },
    ],
  );
  mirror.dispose();
});

test("a spurious command_executed marker with nothing typed yet is a no-op, not a phantom event", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("\x1b]133;C\x07\x1b]133;D;0\x07"); // matches the real probe's startup quirk
  assert.equal(engine.events.length, 0);
  mirror.dispose();
});

test("screen mode: no markers at all, captures via the real bash corpus", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);

  await engine.onOutput(BASH_PLAIN.preamble);
  for (const seg of BASH_PLAIN.segments) {
    typeAndEnter(engine, seg.command);
    await engine.onOutput(seg.echoAndOutput);
  }
  await engine.end(); // the corpus's final auto-"exit" (triggered by EOF, not typed) is not modeled as input

  assert.equal(engine.events.length, 3);
  assert.deepEqual(
    engine.events.map((e) => ({ command: e.command, confidence: e.confidence })),
    [
      { command: "whoami", confidence: "screen" },
      { command: "false", confidence: "screen" },
      { command: "echo done", confidence: "screen" },
    ],
  );
  mirror.dispose();
});

test("screen mode flags a fullscreen program's launching command and never captures alt-screen content as output", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("deploy@web-1:~$ ");
  typeAndEnter(engine, "vim file.txt");
  await engine.onOutput("vim file.txt\r\n"); // echo + newline, still on the normal screen
  await engine.onOutput("\x1b[?1049h"); // now enters alt screen, in its own chunk
  await engine.onOutput("~ file contents ~"); // rendered inside vim; must not be captured
  await engine.onOutput("\x1b[?1049l\r\ndeploy@web-1:~$ "); // leaving alt screen, prompt returns
  await engine.end();

  assert.equal(engine.events.length, 1);
  assert.equal(engine.events[0].command, "vim file.txt");
  assert.ok(engine.events[0].flags.includes("fullscreen"));
  assert.equal(engine.events[0].output, "", "alt-screen content is never captured as output");
  mirror.dispose();
});

test("truncateHeadTail keeps short text untouched", () => {
  const r = truncateHeadTail("short output", 32_000);
  assert.equal(r.text, "short output");
  assert.equal(r.pruned, false);
});

test("truncateHeadTail keeps head+tail and reports the true total byte count", () => {
  const big = "A".repeat(100_000);
  const r = truncateHeadTail(big, 100);
  assert.equal(r.pruned, true);
  assert.equal(r.totalBytes, 100_000);
  assert.ok(r.text.length < big.length);
  assert.ok(r.text.startsWith("A".repeat(100)));
  assert.ok(r.text.endsWith("A".repeat(100)));
});

test("truncateHeadTail never splits a multi-byte character at the cut boundary", () => {
  const big = "x".repeat(99) + "\u{1F600}" + "y".repeat(99) + "z".repeat(50_000) + "\u{1F600}".repeat(50);
  const r = truncateHeadTail(big, 100);
  assert.ok(!r.text.includes("�"));
  assert.equal([...r.text].every((ch) => ch.codePointAt(0)! <= 0x10ffff), true);
});

test("a command's output larger than the cap is pruned on the emitted event", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24, scrollback: 100 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("deploy@web-1:~$ ");
  typeAndEnter(engine, "yes");
  await engine.onOutput("yes\r\n"); // the echo, establishing the running command as "yes"
  const flood = "y\r\n".repeat(25_000); // 75,000 bytes ("y\r\n" is 3 bytes), over the 65,536-byte (32KB+32KB) cap, fed separately
  await engine.onOutput(flood);
  await engine.onOutput("deploy@web-1:~$ "); // e.g. Ctrl-C stopped `yes`; the shell redraws its prompt
  await engine.onInput("q"); // next command starts, ending the previous one (screen mode)
  const [event] = engine.events;
  assert.equal(event.command, "yes");
  assert.equal(event.outputPruned, true);
  assert.ok(event.outputBytes > 64_000);
  mirror.dispose();
});

test("session end while a command is still running is captured with ended: 'running'", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("deploy@web-1:~$ ");
  typeAndEnter(engine, "sleep 100");
  await engine.onOutput("sleep 100\r\n");
  await engine.end();

  assert.equal(engine.events.length, 1);
  assert.equal(engine.events[0].ended, "running");
  assert.equal(engine.events[0].exitCode, null);
  mirror.dispose();
});

// --- Fixes from the fresh reviewer's whole-branch review (2026-09-27) ---

test("output does not grow without bound while a command is still running (bounded memory)", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24, scrollback: 100 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("deploy@web-1:~$ ");
  typeAndEnter(engine, "tail -f log");
  await engine.onOutput("tail -f log\r\n");
  const chunk = "x".repeat(30_000) + "\r\n"; // ~30KB per chunk
  for (let i = 0; i < 12; i++) {
    await engine.onOutput(chunk); // ~360KB total, well over the trim threshold — reproduces a long `tail -f`/`docker logs -f`
  }
  const retained = (engine as unknown as { phase: { output: string } }).phase.output.length;
  // The retained proxy oscillates between roughly 4x and 8x MAX_HEAD_TAIL_BYTES
  // as chunks arrive and periodic trims fire — bounded by a small constant,
  // never by how much total output has actually arrived (360KB here; for a
  // real long-running `tail -f` it could otherwise grow to gigabytes).
  assert.ok(retained < 270_000, `retained output should stay bounded well under the total written, was ${retained} chars`);
  await engine.onOutput("deploy@web-1:~$ "); // e.g. Ctrl-C stopped it; the shell redraws its prompt
  await engine.onInput("q");
  const [event] = engine.events;
  assert.equal(event.outputPruned, true);
  assert.ok(event.outputBytes > 300_000, `outputBytes should reflect the true total, was ${event.outputBytes}`);
  mirror.dispose();
});

test("a command that wraps across terminal rows is captured in full (screen mode)", async () => {
  const mirror = new TermMirror({ cols: 10, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("$ ");
  const longCmd = "0123456789ABCDEFGHIJ"; // 21 chars, wraps multiple times in a 10-col terminal
  typeAndEnter(engine, longCmd);
  await engine.onOutput(`${longCmd}\r\nOUTPUT\r\n$ `);
  await engine.end();
  assert.equal(engine.events[0].command, longCmd);
  mirror.dispose();
});

test("a password prompt's hidden input is not captured as a command, and does not leak into output (screen mode)", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("deploy@web-1:~$ ");
  typeAndEnter(engine, "sudo ls");
  await engine.onOutput("sudo ls\r\n[sudo] password: ");
  // The password never echoes (hidden input), but the engine still sees
  // the raw input bytes arrive — they must never become a "command".
  for (const ch of "hunter2") engine.onInput(ch);
  engine.onInput("\n");
  await engine.onOutput("\r\nfile.txt\r\ndeploy@web-1:~$ "); // real ls output, then the real prompt returns
  await engine.end();

  assert.equal(engine.events.length, 1, "no phantom event from the password prompt");
  assert.equal(engine.events[0].command, "sudo ls");
  assert.ok(!engine.events[0].output.includes("hunter2"), "the typed password must never appear anywhere");
  mirror.dispose();
});

test("Ctrl-C does not corrupt the next command's prompt column (screen mode)", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("deploy@web-1:~$ ");
  typeAndEnter(engine, "ping example.com");
  await engine.onOutput("ping example.com\r\n64 bytes from 1.2.3.4\r\n");
  engine.onInput("\x03"); // Ctrl-C
  await engine.onOutput("^C\r\ndeploy@web-1:~$ "); // shell redraws its prompt after the interrupt
  typeAndEnter(engine, "ls");
  await engine.onOutput("ls\r\nfile.txt\r\ndeploy@web-1:~$ ");
  await engine.end();

  assert.deepEqual(engine.events.map((e) => e.command), ["ping example.com", "ls"]);
});

test("screen mode: typing then backspacing to nothing, then Enter, does not create a phantom empty-command event", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("deploy@web-1:~$ ");
  engine.onInput("x");
  await engine.onOutput("x");
  engine.onInput("\x7f"); // backspace
  await engine.onOutput("\x08 \x08"); // typical backspace-erase echo
  engine.onInput("\n");
  await engine.onOutput("\r\ndeploy@web-1:~$ "); // shell just redraws the prompt; nothing ran
  typeAndEnter(engine, "ls");
  await engine.onOutput("ls\r\nfile.txt\r\ndeploy@web-1:~$ ");
  await engine.end();

  assert.deepEqual(engine.events.map((e) => e.command), ["ls"]);
  mirror.dispose();
});

test("marker mode: an empty command (typed then backspaced away) produces no event", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("\x1b]133;A\x07\x1b]133;B\x07deploy@web-1:~$ ");
  engine.onInput("x");
  await engine.onOutput("x");
  engine.onInput("\x7f");
  await engine.onOutput("\x08 \x08");
  engine.onInput("\n");
  await engine.onOutput("\x1b]133;C\x07\x1b]133;D;0\x07\x1b]133;A\x07\x1b]133;B\x07deploy@web-1:~$ ");
  assert.equal(engine.events.length, 0);
  mirror.dispose();
});

test("alt-screen entered and left within a single chunk still gets flagged, and its content is never captured (screen mode)", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("deploy@web-1:~$ ");
  typeAndEnter(engine, "vim .env");
  await engine.onOutput("vim .env\r\n");
  // enter alt-screen, show secret content, and leave alt-screen — all in one chunk
  await engine.onOutput("\x1b[?1049hDB_PASS=s3cr3t\x1b[?1049l");
  await engine.onOutput("\r\ndeploy@web-1:~$ ");
  await engine.end();

  assert.equal(engine.events.length, 1);
  assert.equal(engine.events[0].command, "vim .env");
  assert.ok(engine.events[0].flags.includes("fullscreen"));
  assert.ok(!engine.events[0].output.includes("DB_PASS"), "alt-screen content within an atomic chunk must never leak into output");
  mirror.dispose();
});

test("a multi-byte UTF-8 character split across two Buffer chunks is not corrupted", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("deploy@web-1:~$ ");
  typeAndEnter(engine, "echo cafe");
  const full = Buffer.from("echo cafe\r\ncafé\r\ndeploy@web-1:~$ ", "utf8");
  const eBytes = Buffer.from("é", "utf8");
  const splitPoint = full.indexOf(eBytes) + 1; // split inside the 2-byte 'é'
  await engine.onOutput(full.subarray(0, splitPoint));
  await engine.onOutput(full.subarray(splitPoint));
  await engine.end();

  assert.ok(engine.events[0].output.includes("café"), "the split character must not be corrupted");
  mirror.dispose();
});

// --- Storage-wiring hardening (2026-09-27 storage plan, Task 1) ---

test("CommandEvent carries a startedAt timestamp captured when the command began running", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("deploy@web-1:~$ ");
  const before = Date.now();
  typeAndEnter(engine, "ls");
  await engine.onOutput("ls\r\nfile.txt\r\ndeploy@web-1:~$ ");
  const after = Date.now();
  await engine.onInput("q"); // no-op here, "ls" already finished via marker-less screen mode newline
  const [event] = engine.events;
  assert.ok(event.startedAt >= before && event.startedAt <= after);
  mirror.dispose();
});

test("onCommand fires with the same event pushed to events, as each command completes", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const seen: string[] = [];
  const engine = new CaptureEngine(mirror, { onCommand: (e) => seen.push(e.command) });
  await engine.onOutput("deploy@web-1:~$ ");
  typeAndEnter(engine, "whoami");
  await engine.onOutput("whoami\r\npiyup\r\ndeploy@web-1:~$ ");
  typeAndEnter(engine, "pwd");
  await engine.onOutput("pwd\r\n/home\r\ndeploy@web-1:~$ ");
  await engine.end();
  assert.deepEqual(seen, ["whoami", "pwd"]);
  assert.deepEqual(engine.events.map((e) => e.command), seen);
  mirror.dispose();
});

test("concurrent, un-awaited onOutput calls still apply to the mirror in the order they were called, never reordered", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  // Fire three chunks back-to-back with NO await between them — exactly
  // what a synchronous stream 'data' handler that can't await per chunk
  // will do once this engine is wired into SessionManager (Task 5).
  const p1 = engine.onOutput("AAA");
  const p2 = engine.onOutput("BBB");
  const p3 = engine.onOutput("CCC");
  await Promise.all([p1, p2, p3]);
  assert.equal(mirror.cursorLine(), "AAABBBCCC", "chunks landed in call order, not completion order");
  mirror.dispose();
});

// --- Fixes from the fresh reviewer's whole-branch review (2026-09-28) ---

test("input arriving while an earlier output write is still queued reads the mirror only after that write is applied, not before", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  const p1 = engine.onOutput("deploy@web-1:~$ "); // NOT awaited: still queued when input arrives
  typeAndEnter(engine, "whoami"); // fired synchronously, before p1 has necessarily resolved
  const p2 = engine.onOutput("whoami\r\npiyup\r\ndeploy@web-1:~$ ");
  await Promise.all([p1, p2]);
  await engine.end();

  assert.equal(engine.events.length, 1);
  assert.equal(engine.events[0].command, "whoami", "must read the prompt column only once the prior queued write has actually been applied");
  mirror.dispose();
});

test("end() drains the queue first, so a command whose completing output was still queued when the session ended is still captured", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("deploy@web-1:~$ ");
  typeAndEnter(engine, "whoami");
  const p = engine.onOutput("whoami\r\npiyup\r\ndeploy@web-1:~$ "); // not awaited: simulates output still in flight when the session ends
  await engine.end();
  await p;

  assert.equal(engine.events.length, 1, "the command must not be silently dropped");
  assert.equal(engine.events[0].command, "whoami");
  mirror.dispose();
});

test("output queued far beyond a reasonable backlog degrades capture for the rest of the session instead of growing memory without bound", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  const bigChunk = "x".repeat(1_000_000); // 1MB
  const promises: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) promises.push(engine.onOutput(bigChunk)); // 20MB fired, well past a small cap
  await Promise.all(promises);
  assert.equal(engine.failed, true, "capture degrades rather than queueing an unbounded backlog");
  mirror.dispose();
});

test("screen mode: a command is captured as soon as its prompt returns, without waiting for the next keystroke or end()", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);

  await engine.onOutput(BASH_PLAIN.preamble);
  const seg = BASH_PLAIN.segments[0];
  typeAndEnter(engine, seg.command);
  await engine.onOutput(seg.echoAndOutput);

  assert.equal(engine.events.length, 1, "prompt is back on screen: the command is finished");
  assert.equal(engine.events[0].command, seg.command);
  assert.equal(engine.events[0].ended, "exited");
  mirror.dispose();
});

test("screen mode: the captured output does not end with the returned prompt line", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);

  await engine.onOutput("$ ");
  typeAndEnter(engine, "whoami");
  await engine.onOutput("whoami\r\nfakeuser\r\n$ ");

  assert.equal(engine.events.length, 1);
  assert.ok(engine.events[0].output.includes("fakeuser"));
  assert.ok(!/\$\s*$/.test(engine.events[0].output), `output must not end with the prompt, got ${JSON.stringify(engine.events[0].output)}`);
  mirror.dispose();
});

async function runCmd(engine: CaptureEngine, cmd: string, out = "") {
  typeAndEnter(engine, cmd);
  await engine.onOutput(`${cmd}\r\n${out}$ `);
}

test("pause: commands run while paused are not captured, and capture resumes afterwards", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("$ ");
  await runCmd(engine, "whoami", "fakeuser\r\n");
  engine.pause();
  await runCmd(engine, "secret-cmd", "secret-output\r\n");
  await engine.resume();
  await runCmd(engine, "pwd", "/home/u\r\n");
  assert.deepEqual(engine.events.map((e) => e.command), ["whoami", "pwd"]);
  assert.ok(engine.events.every((e) => !e.output.includes("secret")), "nothing from the pause leaks into later entries");
  mirror.dispose();
});

test("pause: a command already running when the pause starts is dropped even if it finishes after resume", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("$ ");
  typeAndEnter(engine, "make");
  await engine.onOutput("make\r\n"); // running, prompt not back yet
  engine.pause();
  await engine.onOutput("password: hunter2\r\n");
  await engine.resume();
  await engine.onOutput("done\r\n$ "); // prompt returns after resume
  assert.deepEqual(engine.events, []);
  mirror.dispose();
});

test("pause: resume is ordered after output still queued, so a paused command is not remembered", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("$ ");
  engine.pause();
  typeAndEnter(engine, "early");
  const pending = engine.onOutput("early\r\nsecret\r\n$ "); // not awaited: still queued
  const resumed = engine.resume(); // called while that output is still queued
  await pending;
  await resumed;
  assert.deepEqual(engine.events, []);
  assert.equal(engine.isPaused, false);
  mirror.dispose();
});

test("pause: ending the session while paused emits nothing for the running command", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  await engine.onOutput("$ ");
  typeAndEnter(engine, "tail -f log");
  await engine.onOutput("tail -f log\r\n");
  engine.pause();
  await engine.end();
  assert.deepEqual(engine.events, []);
  mirror.dispose();
});

test("pause and resume are idempotent and isPaused reflects the state", async () => {
  const mirror = new TermMirror({ cols: 80, rows: 24 });
  const engine = new CaptureEngine(mirror);
  assert.equal(engine.isPaused, false);
  engine.pause();
  engine.pause();
  assert.equal(engine.isPaused, true);
  await engine.resume();
  await engine.resume();
  assert.equal(engine.isPaused, false);
  mirror.dispose();
});
