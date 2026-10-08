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
async function personalApp() {
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
  return { app, db, cookie: cookieFrom(setup) };
}

async function teamApp() {
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  const setup = await app.inject({
    method: "POST", url: "/api/vault/setup",
    payload: { password: "admin-password-1", mode: "team", username: "admin" },
  });
  const adminCookie = cookieFrom(setup);
  const login = async (username: string) => {
    await app.inject({
      method: "POST", url: "/api/team/users", headers: { cookie: adminCookie },
      payload: { username, tempPassword: `${username}-temp-password`, isAdmin: false },
    });
    return cookieFrom(await app.inject({ method: "POST", url: "/api/team/login", payload: { username, password: `${username}-temp-password` } }));
  };
  return { app, db, adminCookie, login };
}

// Same fake shell as terminal-memory.test.ts: echoes input, answers "whoami"
// with a distinct output line, redraws the prompt.
function fakeSshdWithShell() {
  return new Server({ hostKeys: [generateEd25519(utils).private] }, (c: any) => {
    c.on("authentication", (ctx: any) => (ctx.method === "password" && ctx.password === "pw" ? ctx.accept() : ctx.reject()));
    c.on("ready", () => c.on("session", (acc: any) => {
      const s = acc();
      s.on("pty", (a: any) => a && a());
      s.on("shell", (a: any) => {
        const st = a();
        st.write("$ ");
        st.on("data", (d: Buffer) => {
          st.write(d);
          const cmd = d.toString().replace(/\r?\n$/, "");
          st.write(cmd === "whoami" ? "\r\nfakeuser\r\n$ " : "\r\n$ ");
        });
      });
    }));
    c.on("error", () => {});
  });
}

const newHost = async (app: any, cookie: string, port = 22, hostname = "10.0.0.1") =>
  ((await app.inject({
    method: "POST", url: "/api/hosts", headers: { cookie },
    payload: { label: "t", hostname, port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
  })).json() as any).data.id as string;


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
  const lastMemoryState = () => [...msgs].reverse().find((m) => m.type === "memory")?.state;
  return { ws, msgs, waitFor, send, type, end, lastMemoryState };
}
const connected = (m: any) => m.type === "status" && (m.message === "Connected" || m.message === "Reattached");
const memState = (s: string) => (m: any) => m.type === "memory" && m.state === s;
const timelineOf = async (app: any, cookie: string, hostId: string) =>
  ((await app.inject({ method: "GET", url: `/api/memory/hosts/${hostId}/timeline`, headers: { cookie } })).json() as any).data.entries;
const shape = (entries: any[]) => entries.map((e) => (e.kind === "pause" ? "pause" : e.command));

async function personalWithHost() {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
  const cookie = cookieFrom(setup);
  const hostId = await newHost(app, cookie, sshd.address().port, "127.0.0.1");
  return { app, db, sshd, base, cookie, hostId, close: async () => { await app.close(); sshd.close(); } };
}

// whoami (remembered), pause, pwd (not remembered), resume, uptime (remembered)
async function pauseScenario(t: Awaited<ReturnType<typeof openTerminal>>) {
  await t.waitFor(connected);
  await t.waitFor(memState("remembering"));
  await t.type("whoami\n");
  t.send({ type: "memory_pause", paused: true });
  await t.waitFor(memState("paused"));
  await t.type("pwd\n");
  t.send({ type: "memory_pause", paused: false });
  await t.waitFor((m) => m.type === "memory" && m.state === "remembering" && t.msgs.filter(memState("remembering")).length >= 2 ? true : false);
  await t.type("uptime\n");
}

test("a connected session reports that it is remembering", async () => {
  const s = await personalWithHost();
  try {
    const t = await openTerminal(s.hostId, s.base, s.cookie);
    await t.waitFor(connected);
    await t.waitFor(memState("remembering"));
    await t.end();
  } finally { await s.close(); }
});

test("when Memory is off for the host the state is off and pausing does nothing", async () => {
  const s = await personalWithHost();
  try {
    s.db.raw.prepare("UPDATE hosts SET memory_mode = 'off' WHERE id = ?").run(s.hostId);
    const t = await openTerminal(s.hostId, s.base, s.cookie);
    await t.waitFor(connected);
    await t.waitFor(memState("off"));
    t.send({ type: "memory_pause", paused: true });
    await t.type("whoami\n");
    await t.end();
    assert.deepEqual(await timelineOf(s.app, s.cookie, s.hostId), []);
    assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE kind = 'pause'").get() as any).n, 0);
    assert.equal(t.lastMemoryState(), "off");
  } finally { await s.close(); }
});

test("pausing drops the commands run meanwhile and leaves a visible gap, resuming remembers again", async () => {
  const s = await personalWithHost();
  try {
    const t = await openTerminal(s.hostId, s.base, s.cookie);
    await pauseScenario(t);
    await t.end();
    const entries = await timelineOf(s.app, s.cookie, s.hostId);
    assert.deepEqual(shape(entries), ["uptime", "pause", "whoami"]);
    const gap = entries.find((e: any) => e.kind === "pause");
    assert.ok(gap.finishedAt, "the gap has an end");
    assert.equal(gap.by, null, "personal mode has no usernames");
    assert.ok(entries.filter((e: any) => e.kind !== "pause").every((e: any) => e.kind === "command"));
  } finally { await s.close(); }
});

test("ending the session while paused closes the gap", async () => {
  const s = await personalWithHost();
  try {
    const t = await openTerminal(s.hostId, s.base, s.cookie);
    await t.waitFor(connected);
    await t.waitFor(memState("remembering"));
    t.send({ type: "memory_pause", paused: true });
    await t.waitFor(memState("paused"));
    await t.end();
    const entries = await timelineOf(s.app, s.cookie, s.hostId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "pause");
    assert.ok(entries[0].finishedAt, "the open pause was closed when the session ended");
  } finally { await s.close(); }
});

test("a window that reattaches to a paused session is told it is paused, and can resume", async () => {
  const s = await personalWithHost();
  try {
    const t1 = await openTerminal(s.hostId, s.base, s.cookie);
    await t1.waitFor(connected);
    await t1.waitFor(memState("remembering"));
    t1.send({ type: "memory_pause", paused: true });
    await t1.waitFor(memState("paused"));
    t1.ws.close(); // detach only; the session lives on
    await new Promise((r) => setTimeout(r, 400));
    const t2 = await openTerminal(s.hostId, s.base, s.cookie);
    await t2.waitFor((m) => m.type === "status" && m.message === "Reattached");
    await t2.waitFor(memState("paused"));
    t2.send({ type: "memory_pause", paused: false });
    await t2.waitFor(memState("remembering"));
    await t2.end();
  } finally { await s.close(); }
});

test("a window that has been superseded is closed and cannot touch the session", async () => {
  const s = await personalWithHost();
  try {
    const t1 = await openTerminal(s.hostId, s.base, s.cookie);
    await t1.waitFor(connected);
    await t1.waitFor(memState("remembering"));
    const t2 = await openTerminal(s.hostId, s.base, s.cookie);
    await t2.waitFor((m) => m.type === "status" && m.message === "Reattached");
    await t2.waitFor(memState("remembering"));
    for (let i = 0; i < 20 && t1.ws.readyState !== 3; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(t1.ws.readyState, 3, "the old window was closed by the session manager");
    t2.send({ type: "memory_pause", paused: true });
    await t2.waitFor(memState("paused"));
    t2.send({ type: "memory_pause", paused: false });
    await t2.waitFor((m) => m.type === "memory" && m.state === "remembering" && t2.msgs.filter(memState("remembering")).length >= 2 ? true : false);
    await t2.end();
  } finally { await s.close(); }
});

test("team mode: the pause names who paused; members see their own, admins see all", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const { app, adminCookie, login } = await teamApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  try {
    const hostId = await newHost(app, adminCookie, sshd.address().port, "127.0.0.1");
    const bob = await login("bob");
    const carol = await login("carol");
    const t = await openTerminal(hostId, base, bob);
    await t.waitFor(connected);
    await t.waitFor(memState("remembering"));
    t.send({ type: "memory_pause", paused: true });
    await t.waitFor(memState("paused"));
    t.send({ type: "memory_pause", paused: false });
    await t.waitFor((m) => m.type === "memory" && m.state === "remembering" && t.msgs.filter(memState("remembering")).length >= 2 ? true : false);
    await t.type("whoami\n");
    await t.end();

    const asAdmin = await timelineOf(app, adminCookie, hostId);
    assert.deepEqual(shape(asAdmin), ["whoami", "pause"]);
    assert.equal(asAdmin.find((e: any) => e.kind === "pause").by, "bob");
    assert.deepEqual(await timelineOf(app, carol, hostId), []);
    assert.deepEqual(shape(await timelineOf(app, bob, hostId)), ["whoami", "pause"]);
  } finally { await app.close(); sshd.close(); }
});

test("pause rows have no detail view and are not searchable", async () => {
  const s = await personalWithHost();
  try {
    const t = await openTerminal(s.hostId, s.base, s.cookie);
    await pauseScenario(t);
    await t.end();
    const entries = await timelineOf(s.app, s.cookie, s.hostId);
    const gap = entries.find((e: any) => e.kind === "pause");
    assert.equal((await s.app.inject({ method: "GET", url: `/api/memory/entries/${gap.id}`, headers: { cookie: s.cookie } })).statusCode, 404);
    const hits = ((await s.app.inject({ method: "GET", url: "/api/memory/search?q=uptime", headers: { cookie: s.cookie } })).json() as any).data.entries;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].command, "uptime");
  } finally { await s.close(); }
});
