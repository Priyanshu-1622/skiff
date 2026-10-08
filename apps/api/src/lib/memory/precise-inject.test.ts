import { test } from "node:test";
import assert from "node:assert/strict";
import { injectPrecise, type PreciseDeps } from "./precise-inject.js";
import { PRECISE_SNIPPETS } from "./precise.js";

type GateResult = "marker" | "timeout" | "overflow" | "gone";

function harness(over: { execOut?: string | null; lastOutputAt?: number; input?: boolean; markers?: boolean; gate?: GateResult; writeOk?: boolean } = {}) {
  const calls: string[] = [];
  const armed: { marker?: string; prefix?: string; timeoutMs?: number } = {};
  const state = { clock: 1000, lastOutputAt: over.lastOutputAt ?? 400, input: over.input ?? false, markers: over.markers ?? false };
  const deps: PreciseDeps = {
    exec: async (cmd) => { calls.push(`exec:${cmd}`); return "execOut" in over ? (over.execOut as string | null) : "/bin/bash\n"; },
    armGate: (marker, opts) => {
      calls.push("arm");
      armed.marker = marker.toString(); armed.prefix = opts.prefix.toString(); armed.timeoutMs = opts.timeoutMs;
      return Promise.resolve(over.gate ?? "marker");
    },
    writeSystem: (data) => { calls.push(`write:${data.toString()}`); return over.writeOk ?? true; },
    activity: { lastOutputAt: () => state.lastOutputAt, inputSeen: () => state.input, markersSeen: () => state.markers },
    now: () => state.clock,
    sleep: async (ms) => { state.clock += ms; },
  };
  return { deps, calls, state, armed };
}

test("a quiet bash at its prompt gets the snippet once, after the gate is armed", async () => {
  const h = harness();
  const result = await injectPrecise(h.deps);
  assert.deepEqual(result, { status: "injected", shell: "bash" });
  assert.deepEqual(h.calls, ['exec:printf %s "$SHELL"', "arm", `write:${PRECISE_SNIPPETS.bash}\n`], "the gate is armed BEFORE the write, and nothing else is written");
  assert.equal(h.armed.marker, "\x1b]133;A", "released by the first prompt-start marker");
  assert.equal(h.armed.prefix, "\r\x1b[2K", "the new prompt replaces the old line");
  assert.equal(h.armed.timeoutMs, 3000);
});

test("zsh and fish get their own snippets", async () => {
  for (const [path, shell] of [["/usr/bin/zsh", "zsh"], ["/usr/local/bin/fish", "fish"]] as const) {
    const h = harness({ execOut: path });
    assert.deepEqual(await injectPrecise(h.deps), { status: "injected", shell });
    assert.ok(h.calls.includes(`write:${PRECISE_SNIPPETS[shell]}\n`));
  }
});

test("no shell information, an unsupported shell, or no output at all means nothing is typed", async () => {
  for (const execOut of [null, "", "  \n"]) {
    const h = harness({ execOut });
    assert.deepEqual(await injectPrecise(h.deps), { status: "skipped", reason: "no-shell-info" });
    assert.ok(!h.calls.some((c) => c.startsWith("write:") || c === "arm"));
  }
  const dash = harness({ execOut: "/bin/dash" });
  assert.deepEqual(await injectPrecise(dash.deps), { status: "skipped", reason: "unknown-shell" });
  assert.ok(!dash.calls.some((c) => c.startsWith("write:") || c === "arm"));
  const silent = harness({ lastOutputAt: 0 });
  assert.deepEqual(await injectPrecise(silent.deps, { maxWaitMs: 500 }), { status: "skipped", reason: "no-output" });
  assert.ok(!silent.calls.some((c) => c.startsWith("write:")));
});

test("if the user has already typed, nothing is injected under their typing", async () => {
  const h = harness({ input: true });
  assert.deepEqual(await injectPrecise(h.deps), { status: "skipped", reason: "user-typing" });
  assert.ok(!h.calls.some((c) => c.startsWith("write:") || c === "arm"));
});

test("if the shell already emits prompt markers, nothing is injected", async () => {
  const h = harness({ markers: true });
  assert.deepEqual(await injectPrecise(h.deps), { status: "skipped", reason: "markers-already" });
  assert.ok(!h.calls.some((c) => c.startsWith("write:") || c === "arm"));
});

test("it waits for the shell to go quiet, and gives up if it never does", async () => {
  const busy = harness();
  let sleeps = 0;
  busy.deps.sleep = async (ms) => { busy.state.clock += ms; if (++sleeps <= 5) busy.state.lastOutputAt = busy.state.clock; };
  busy.state.lastOutputAt = busy.state.clock; // output right now
  const result = await injectPrecise(busy.deps, { quietMs: 400, maxWaitMs: 6000 });
  assert.equal(result.status, "injected");
  assert.ok(sleeps > 5, "it kept waiting while output was still arriving");

  const endless = harness();
  endless.deps.sleep = async (ms) => { endless.state.clock += ms; endless.state.lastOutputAt = endless.state.clock; };
  endless.state.lastOutputAt = endless.state.clock;
  assert.deepEqual(await injectPrecise(endless.deps, { quietMs: 400, maxWaitMs: 1000 }), { status: "skipped", reason: "not-idle" });
  assert.ok(!endless.calls.some((c) => c.startsWith("write:")));
});

test("a shell that never confirms is reported as failed with the gate's reason; a vanished session too", async () => {
  for (const gate of ["timeout", "overflow", "gone"] as const) {
    const h = harness({ gate });
    assert.deepEqual(await injectPrecise(h.deps), { status: "failed", reason: gate, shell: "bash" });
  }
  const dead = harness({ writeOk: false });
  assert.deepEqual(await injectPrecise(dead.deps), { status: "failed", reason: "gone", shell: "bash" });
});
