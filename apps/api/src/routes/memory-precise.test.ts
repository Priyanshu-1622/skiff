import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { buildApp } from "../app.js";
import { runColumnMigrations } from "../db/client.js";
import { generateEd25519 } from "../test-support/ssh-keys.js";

const require = createRequire(import.meta.url);
const { Server, utils } = require("ssh2");
const WebSocket = require("ws");
const here = dirname(fileURLToPath(import.meta.url));

const TEST_CONFIG = {
  dataDir: "/tmp/skiff-test-unused", port: 0, host: "127.0.0.1",
  nodeEnv: "test" as const, trustedOrigins: [], cookieSecret: "x".repeat(40), setupToken: null,
};
// Short timings so the integration tests don't wait for the real quiet period.
const FAST = { quietMs: 120, maxWaitMs: 3000, gateMs: 700 };

function memDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(join(here, "../db/schema.sql"), "utf-8"));
  runColumnMigrations(db);
  return { raw: db, close: () => db.close() };
}
function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  return (Array.isArray(raw) ? raw[0] : (raw as string)).split(";")[0];
}

const OSC = (s: string) => `\x1b]133;${s}\x07`;

/**
 * A pretend server whose shell behaves like bash: a plain "$ " prompt until it
 * is sent Skiff's setup line (a line starting with a space and containing
 * "__skiff"), after which — if `honour` — it speaks OSC 133 like a real
 * integrated shell. `sawSetupLine` records whether the line ever arrived.
 */
function fakeBashSshd(opts: { shellEnv: string; honour?: boolean; markersFromStart?: boolean }) {
  const state = { sawSetupLine: false, execCommands: [] as string[] };
  const server = new Server({ hostKeys: [generateEd25519(utils).private] }, (c: any) => {
    c.on("authentication", (ctx: any) => (ctx.method === "password" && ctx.password === "pw" ? ctx.accept() : ctx.reject()));
    c.on("ready", () => c.on("session", (acc: any) => {
      const s = acc();
      s.on("pty", (a: any) => a && a());
      s.on("exec", (accept: any, _reject: any, info: any) => {
        state.execCommands.push(info.command);
        const st = accept();
        if (info.command.includes("$SHELL")) st.write(opts.shellEnv);
        st.exit(0);
        st.end();
      });
      s.on("shell", (a: any) => {
        const st = a();
        let precise = !!opts.markersFromStart;
        let line = "";
        const prompt = (code: number) => st.write(precise ? `${OSC(`D;${code}`)}${OSC("A")}$ ${OSC("B")}` : "$ ");
        prompt(0);
        st.on("data", (d: Buffer) => {
          for (const ch of d.toString()) {
            if (ch !== "\r" && ch !== "\n") { line += ch; st.write(ch); continue; }
            const cmd = line;
            line = "";
            st.write("\r\n");
            if (cmd.startsWith(" ") && cmd.includes("__skiff")) {
              state.sawSetupLine = true;
              if (opts.honour) { precise = true; prompt(0); } else { st.write("bash: syntax error near unexpected token\r\n$ "); }
              continue;
            }
            if (precise) st.write(OSC("C"));
            const code = cmd === "false" ? 1 : 0;
            if (cmd === "whoami") st.write("fakeuser\r\n");
            prompt(code);
          }
        });
      });
    }));
    c.on("error", () => {});
  });
  return { server, state };
}

async function setup(shell: { shellEnv: string; honour?: boolean; markersFromStart?: boolean }) {
  const { server, state } = fakeBashSshd(shell);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db, preciseTimings: FAST });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  const setupRes = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
  const cookie = cookieFrom(setupRes);
  const host = (await app.inject({
    method: "POST", url: "/api/hosts", headers: { cookie },
    payload: { label: "t", hostname: "127.0.0.1", port: server.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
  })).json() as any;
  const hostId = host.data.id as string;
  return {
    app, base, cookie, hostId, state,
    setPrecise: (on: boolean) => app.inject({ method: "PUT", url: `/api/hosts/${hostId}/memory`, headers: { cookie }, payload: { preciseMode: on } }),
    close: async () => { await app.close(); server.close(); },
  };
}

async function openTerminal(hostId: string, base: string, cookie: string) {
  const ws = new WebSocket(`ws://${base}/api/terminal/${hostId}`, { headers: { cookie } });
  const msgs: any[] = [];
  let wake: Array<() => void> = [];
  ws.on("message", (raw: Buffer) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "fingerprint_new") ws.send(JSON.stringify({ type: "fingerprint_approve" }));
    msgs.push(m);
    const w = wake; wake = []; w.forEach((f) => f());
  });
  const waitFor = (pred: (m: any) => boolean, ms = 10_000) => new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for a message")), ms);
    const check = () => {
      const m = msgs.find(pred);
      if (m) { clearTimeout(t); resolve(m); return; }
      wake.push(check);
    };
    check();
  });
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  const type = async (s: string) => { send({ type: "input", data: Buffer.from(s).toString("base64") }); await new Promise((r) => setTimeout(r, 300)); };
  const end = async () => { send({ type: "end_session" }); await new Promise((r) => setTimeout(r, 300)); try { ws.close(); } catch { /* ignore */ } };
  const screenText = () => msgs.filter((m) => m.type === "data").map((m) => Buffer.from(m.data, "base64").toString()).join("");
  return { ws, msgs, waitFor, send, type, end, screenText };
}
const connected = (m: any) => m.type === "status" && (m.message === "Connected" || m.message === "Reattached");
const timelineOf = async (app: any, cookie: string, hostId: string) =>
  ((await app.inject({ method: "GET", url: `/api/memory/hosts/${hostId}/timeline`, headers: { cookie } })).json() as any).data.entries as any[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("precise mode on: the shell is switched to markers, the line never reaches the screen, and exit codes are captured", async () => {
  const s = await setup({ shellEnv: "/bin/bash\n", honour: true });
  try {
    assert.equal((await s.setPrecise(true)).statusCode, 200);
    const t = await openTerminal(s.hostId, s.base, s.cookie);
    await t.waitFor(connected);
    await sleep(1200); // quiet period, injection, marker
    await t.type("whoami\n");
    await t.type("false\n");
    await t.end();

    assert.equal(s.state.sawSetupLine, true, "the line was typed into the shell");
    assert.ok(s.state.execCommands.some((c) => c.includes("$SHELL")), "the shell was looked up on a separate channel");
    assert.ok(!t.screenText().includes("__skiff"), "the browser never saw the line or its echo");
    const entries = await timelineOf(s.app, s.cookie, s.hostId);
    assert.deepEqual(entries.map((e) => e.command), ["false", "whoami"]);
    assert.deepEqual(entries.map((e) => e.confidence), ["marker", "marker"]);
    assert.deepEqual(entries.map((e) => e.exitCode), [1, 0]);
    const failed = ((await s.app.inject({ method: "GET", url: "/api/memory/search?q=&browse=1&failed=1", headers: { cookie: s.cookie } })).json() as any).data.entries;
    assert.deepEqual(failed.map((e: any) => e.command), ["false"], "'Failed only' now works");
  } finally { await s.close(); }
});

test("precise mode off (the default): nothing is typed and capture stays in screen mode", async () => {
  const s = await setup({ shellEnv: "/bin/bash\n", honour: true });
  try {
    const t = await openTerminal(s.hostId, s.base, s.cookie);
    await t.waitFor(connected);
    await sleep(1000);
    await t.type("whoami\n");
    await t.end();
    assert.equal(s.state.sawSetupLine, false);
    assert.equal(s.state.execCommands.length, 0, "not even the shell lookup");
    const entries = await timelineOf(s.app, s.cookie, s.hostId);
    assert.deepEqual(entries.map((e) => e.confidence), ["screen"]);
  } finally { await s.close(); }
});

test("an unsupported shell is left alone, the user is told once, and commands are still remembered", async () => {
  const s = await setup({ shellEnv: "/bin/csh\n" });
  try {
    await s.setPrecise(true);
    const t = await openTerminal(s.hostId, s.base, s.cookie);
    await t.waitFor(connected);
    const note = await t.waitFor((m) => m.type === "memory_note");
    assert.match(note.message, /bash, zsh and fish/);
    await sleep(500);
    await t.type("whoami\n");
    await t.end();
    assert.equal(s.state.sawSetupLine, false);
    assert.equal(t.msgs.filter((m) => m.type === "memory_note").length, 1, "once");
    assert.deepEqual((await timelineOf(s.app, s.cookie, s.hostId)).map((e) => e.command), ["whoami"]);
  } finally { await s.close(); }
});

test("a shell that never confirms: the held output is released to the user, they are told, and the session works", async () => {
  const s = await setup({ shellEnv: "/bin/bash\n", honour: false });
  try {
    await s.setPrecise(true);
    const t = await openTerminal(s.hostId, s.base, s.cookie);
    await t.waitFor(connected);
    const note = await t.waitFor((m) => m.type === "memory_note", 8000);
    assert.match(note.message, /couldn't be set up/);
    assert.ok(t.screenText().includes("syntax error"), "what the shell said is shown, not swallowed");
    await t.type("whoami\n");
    await t.end();
    assert.deepEqual((await timelineOf(s.app, s.cookie, s.hostId)).map((e) => ({ c: e.command, k: e.confidence })), [{ c: "whoami", k: "screen" }]);
  } finally { await s.close(); }
});

test("if the user starts typing first, nothing is injected", async () => {
  const s = await setup({ shellEnv: "/bin/bash\n", honour: true });
  try {
    await s.setPrecise(true);
    const t = await openTerminal(s.hostId, s.base, s.cookie);
    await t.waitFor(connected);
    await t.type("whoami\n"); // straight away, before the quiet period is over
    await sleep(900);
    await t.end();
    assert.equal(s.state.sawSetupLine, false);
  } finally { await s.close(); }
});

test("a shell that already speaks prompt markers is left alone", async () => {
  const s = await setup({ shellEnv: "/bin/bash\n", honour: true, markersFromStart: true });
  try {
    await s.setPrecise(true);
    const t = await openTerminal(s.hostId, s.base, s.cookie);
    await t.waitFor(connected);
    await sleep(1000);
    await t.type("whoami\n");
    await t.end();
    assert.equal(s.state.sawSetupLine, false, "nothing typed: the shell already reports prompts itself");
    const entries = await timelineOf(s.app, s.cookie, s.hostId);
    assert.deepEqual(entries.map((e) => e.confidence), ["marker"]);
  } finally { await s.close(); }
});
