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
const status = async (app: any, cookie?: string) =>
  ((await app.inject({ method: "GET", url: "/api/vault/status", headers: cookie ? { cookie } : {} })).json() as any).data;

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

test("status exposes memory settings; the notice flag is null when locked and false until dismissed", async () => {
  const { app, cookie } = await personalApp();
  try {
    const anon = await status(app);
    assert.equal(anon.memoryNoticeSeen, null);
    const s = await status(app, cookie);
    assert.equal(s.memoryEnabled, true);
    assert.equal(s.memoryOutputDays, 90);
    assert.equal(s.memoryNoticeSeen, false);
    const res = await app.inject({ method: "POST", url: "/api/memory/notice-seen", headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.equal((await status(app, cookie)).memoryNoticeSeen, true);
  } finally { await app.close(); }
});

test("notice-seen without a login is refused", async () => {
  const { app } = await personalApp();
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/memory/notice-seen" })).statusCode, 401);
  } finally { await app.close(); }
});

test("team mode: one member dismissing the notice does not dismiss it for anyone else", async () => {
  const { app, adminCookie, login } = await teamApp();
  try {
    const bob = await login("bob");
    const carol = await login("carol");
    await app.inject({ method: "POST", url: "/api/memory/notice-seen", headers: { cookie: bob } });
    assert.equal((await status(app, bob)).memoryNoticeSeen, true);
    assert.equal((await status(app, carol)).memoryNoticeSeen, false);
    assert.equal((await status(app, adminCookie)).memoryNoticeSeen, false);
  } finally { await app.close(); }
});

const putSettings = (app: any, cookie: string, body: unknown) =>
  app.inject({ method: "PUT", url: "/api/settings/memory", headers: { cookie }, payload: body as any });

test("the owner can turn Memory off and change output retention, and status reflects it", async () => {
  const { app, cookie } = await personalApp();
  try {
    const res = await putSettings(app, cookie, { enabled: false, outputDays: 30 });
    assert.equal(res.statusCode, 200);
    const s = await status(app, cookie);
    assert.equal(s.memoryEnabled, false);
    assert.equal(s.memoryOutputDays, 30);
  } finally { await app.close(); }
});

test("invalid memory settings are a 400 and change nothing", async () => {
  const { app, cookie } = await personalApp();
  try {
    for (const body of [{ enabled: true, outputDays: 0 }, { enabled: true, outputDays: 5000 }, { enabled: true, outputDays: 1.5 }, { enabled: true, outputDays: "30" }, { enabled: "yes", outputDays: 30 }, {}]) {
      assert.equal((await putSettings(app, cookie, body)).statusCode, 400, JSON.stringify(body));
    }
    const s = await status(app, cookie);
    assert.equal(s.memoryEnabled, true);
    assert.equal(s.memoryOutputDays, 90);
  } finally { await app.close(); }
});

test("team mode: a member cannot change memory settings, an admin can, and the audit row holds only the values", async () => {
  const { app, db, adminCookie, login } = await teamApp();
  try {
    const bob = await login("bob");
    assert.equal((await putSettings(app, bob, { enabled: false, outputDays: 7 })).statusCode, 403);
    assert.equal((await status(app, adminCookie)).memoryEnabled, true);
    assert.equal((await putSettings(app, adminCookie, { enabled: false, outputDays: 7 })).statusCode, 200);
    const audit = db.raw.prepare("SELECT username, detail FROM audit_log WHERE action = 'settings.memory'").all() as any[];
    assert.equal(audit.length, 1);
    assert.equal(audit[0].username, "admin");
    assert.deepEqual(JSON.parse(audit[0].detail), { enabled: false, outputDays: 7 });
  } finally { await app.close(); }
});

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

async function runTwoCommands(hostId: string, base: string, cookie: string): Promise<void> {
  const ws = new WebSocket(`ws://${base}/api/terminal/${hostId}`, { headers: { cookie } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no Connected within 10s")), 10_000);
    ws.on("message", (raw: Buffer) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "fingerprint_new") ws.send(JSON.stringify({ type: "fingerprint_approve" }));
      if (m.type === "status" && m.message === "Connected") { clearTimeout(timer); resolve(); }
      if (m.type === "error") { clearTimeout(timer); reject(new Error(m.message)); }
    });
  });
  ws.send(JSON.stringify({ type: "input", data: Buffer.from("whoami\n").toString("base64") }));
  await new Promise((r) => setTimeout(r, 300));
  ws.send(JSON.stringify({ type: "input", data: Buffer.from("pwd\n").toString("base64") }));
  await new Promise((r) => setTimeout(r, 300));
  ws.send(JSON.stringify({ type: "end_session" }));
  await new Promise((r) => setTimeout(r, 300));
  try { ws.close(); } catch { /* ignore */ }
}

const putHostMemory = (app: any, cookie: string, id: string, body: unknown) =>
  app.inject({ method: "PUT", url: `/api/hosts/${id}/memory`, headers: { cookie }, payload: body as any });

const newHost = async (app: any, cookie: string, port = 22, hostname = "10.0.0.1") =>
  ((await app.inject({
    method: "POST", url: "/api/hosts", headers: { cookie },
    payload: { label: "t", hostname, port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
  })).json() as any).data.id as string;

const getHost = async (app: any, cookie: string, id: string) =>
  ((await app.inject({ method: "GET", url: `/api/hosts/${id}`, headers: { cookie } })).json() as any).data;

test("the owner can switch Memory off and on for one host", async () => {
  const { app, cookie } = await personalApp();
  try {
    const id = await newHost(app, cookie);
    assert.equal((await getHost(app, cookie, id)).memory_mode, "on");
    assert.equal((await putHostMemory(app, cookie, id, { memoryMode: "off" })).statusCode, 200);
    assert.equal((await getHost(app, cookie, id)).memory_mode, "off");
    assert.equal((await putHostMemory(app, cookie, id, { memoryMode: "on" })).statusCode, 200);
    assert.equal((await getHost(app, cookie, id)).memory_mode, "on");
  } finally { await app.close(); }
});

test("invalid host memory input is a 400 and an unknown host a 404", async () => {
  const { app, cookie } = await personalApp();
  try {
    const id = await newHost(app, cookie);
    for (const body of [{ memoryMode: "maybe" }, {}, { memoryMode: 1 }]) {
      assert.equal((await putHostMemory(app, cookie, id, body)).statusCode, 400, JSON.stringify(body));
    }
    assert.equal((await getHost(app, cookie, id)).memory_mode, "on");
    assert.equal((await putHostMemory(app, cookie, "nope", { memoryMode: "off" })).statusCode, 404);
  } finally { await app.close(); }
});

test("team mode: a member cannot change a host's memory switch, an admin can, and the audit row holds only the mode", async () => {
  const { app, db, adminCookie, login } = await teamApp();
  try {
    const bob = await login("bob");
    const id = await newHost(app, adminCookie);
    assert.equal((await putHostMemory(app, bob, id, { memoryMode: "off" })).statusCode, 403);
    assert.equal((await getHost(app, adminCookie, id)).memory_mode, "on");
    assert.equal((await putHostMemory(app, adminCookie, id, { memoryMode: "off" })).statusCode, 200);
    const audit = db.raw.prepare("SELECT username, resource_type, resource_id, detail FROM audit_log WHERE action = 'host.memory'").all() as any[];
    assert.equal(audit.length, 1);
    assert.equal(audit[0].resource_id, id);
    assert.equal(audit[0].resource_type, "host");
    assert.deepEqual(JSON.parse(audit[0].detail), { memoryMode: "off" });
  } finally { await app.close(); }
});

test("capture follows the host switch: nothing is remembered while it is off, and it resumes when switched back on", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const cookie = cookieFrom(setup);
    const id = await newHost(app, cookie, sshd.address().port, "127.0.0.1");
    const timeline = async () =>
      ((await app.inject({ method: "GET", url: `/api/memory/hosts/${id}/timeline`, headers: { cookie } })).json() as any).data.entries.map((e: any) => e.command).sort();

    await putHostMemory(app, cookie, id, { memoryMode: "off" });
    await runTwoCommands(id, base, cookie);
    assert.deepEqual(await timeline(), []);

    await putHostMemory(app, cookie, id, { memoryMode: "on" });
    await runTwoCommands(id, base, cookie);
    assert.deepEqual(await timeline(), ["pwd", "whoami"]);
  } finally { await app.close(); sshd.close(); }
});

test("preciseMode can be switched on and off, alone or with memoryMode, and each field leaves the other alone", async () => {
  const { app, cookie } = await personalApp();
  try {
    const id = await newHost(app, cookie);
    assert.equal((await getHost(app, cookie, id)).precise_mode, 0, "off by default");
    const on = await putHostMemory(app, cookie, id, { preciseMode: true });
    assert.equal(on.statusCode, 200);
    assert.deepEqual((on.json() as any).data, { id, memoryMode: "on", preciseMode: true, snapshots: false });
    assert.equal((await getHost(app, cookie, id)).precise_mode, 1);
    await putHostMemory(app, cookie, id, { memoryMode: "off" });
    const afterMemory = await getHost(app, cookie, id);
    assert.equal(afterMemory.memory_mode, "off");
    assert.equal(afterMemory.precise_mode, 1, "changing memoryMode did not touch preciseMode");
    await putHostMemory(app, cookie, id, { memoryMode: "on", preciseMode: false });
    const both = await getHost(app, cookie, id);
    assert.equal(both.memory_mode, "on");
    assert.equal(both.precise_mode, 0);
  } finally { await app.close(); }
});

test("a host memory update with no recognised field, or a wrong type, is a 400", async () => {
  const { app, cookie } = await personalApp();
  try {
    const id = await newHost(app, cookie);
    for (const body of [{}, { preciseMode: "yes" }, { preciseMode: 1 }, { memoryMode: "on", preciseMode: "no" }, { other: true }]) {
      assert.equal((await putHostMemory(app, cookie, id, body)).statusCode, 400, JSON.stringify(body));
    }
    assert.equal((await getHost(app, cookie, id)).precise_mode, 0);
  } finally { await app.close(); }
});

test("team mode: a member cannot enable precise mode, an admin can, and the audit row names only what was set", async () => {
  const { app, db, adminCookie, login } = await teamApp();
  try {
    const bob = await login("bob");
    const id = await newHost(app, adminCookie);
    assert.equal((await putHostMemory(app, bob, id, { preciseMode: true })).statusCode, 403);
    assert.equal((await getHost(app, adminCookie, id)).precise_mode, 0);
    assert.equal((await putHostMemory(app, adminCookie, id, { preciseMode: true })).statusCode, 200);
    const audit = db.raw.prepare("SELECT detail FROM audit_log WHERE action = 'host.memory'").all() as any[];
    assert.equal(audit.length, 1);
    assert.deepEqual(JSON.parse(audit[0].detail), { preciseMode: true });
  } finally { await app.close(); }
});

test("the exact lines precise mode types are available to the UI, to logged-in users only", async () => {
  const { app, cookie } = await personalApp();
  try {
    const res = await app.inject({ method: "GET", url: "/api/memory/precise-snippets", headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const snippets = (res.json() as any).data;
    assert.deepEqual(Object.keys(snippets).sort(), ["bash", "fish", "zsh"]);
    assert.ok(snippets.bash.includes("133;"), "the real text, not a placeholder");
    assert.equal((await app.inject({ method: "GET", url: "/api/memory/precise-snippets" })).statusCode, 401);
  } finally { await app.close(); }
});
