import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { buildApp } from "../app.js";
import { runColumnMigrations } from "../db/client.js";

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

// Same fake shell as terminal-memory.test.ts: echoes input, answers "whoami"
// with a distinct output line, redraws the prompt.
function fakeSshdWithShell() {
  return new Server({ hostKeys: [utils.generateKeyPairSync("ed25519").private] }, (c: any) => {
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

test("timeline returns decrypted entries for a host, newest first, with no output field", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const cookie = cookieFrom(setup);
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: { label: "t", hostname: "127.0.0.1", port: sshd.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;
    const hostId = host.data.id;

    await runTwoCommands(hostId, base, cookie);

    const res = await app.inject({ method: "GET", url: `/api/memory/hosts/${hostId}/timeline`, headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const { entries } = (res.json() as any).data;
    assert.equal(entries.length, 2);
    // Newest first: "pwd" was typed after "whoami".
    assert.equal(entries[0].command, "pwd");
    assert.equal(entries[1].command, "whoami");
    assert.equal(entries[1].exitCode, null); // screen mode, no OSC133 markers from this fake shell
    assert.equal("output" in entries[0], false, "the list response never includes output");
  } finally {
    await app.close();
    sshd.close();
  }
});

test("timeline for a host with no memory sessions returns an empty list, not an error", async () => {
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const cookie = cookieFrom(setup);
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: { label: "t", hostname: "10.0.0.1", port: 22, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;

    const res = await app.inject({ method: "GET", url: `/api/memory/hosts/${host.data.id}/timeline`, headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.json() as any).data.entries, []);
  } finally { await app.close(); }
});

test("the before cursor actually pages: a second page does not repeat the first page's rows", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const cookie = cookieFrom(setup);
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: { label: "t", hostname: "127.0.0.1", port: sshd.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;
    const hostId = host.data.id;

    await runTwoCommands(hostId, base, cookie); // whoami, pwd

    const page1 = await app.inject({ method: "GET", url: `/api/memory/hosts/${hostId}/timeline?limit=1`, headers: { cookie } });
    const firstPage = (page1.json() as any).data.entries;
    assert.equal(firstPage.length, 1);
    assert.equal(firstPage[0].command, "pwd");

    const page2 = await app.inject({
      method: "GET",
      url: `/api/memory/hosts/${hostId}/timeline?limit=1&before=${encodeURIComponent(firstPage[0].startedAt)}`,
      headers: { cookie },
    });
    const secondPage = (page2.json() as any).data.entries;
    assert.equal(secondPage.length, 1);
    assert.equal(secondPage[0].command, "whoami");
    assert.notEqual(secondPage[0].id, firstPage[0].id);
  } finally {
    await app.close();
    sshd.close();
  }
});

test("entry detail returns the full decrypted entry including output", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const cookie = cookieFrom(setup);
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: { label: "t", hostname: "127.0.0.1", port: sshd.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;
    await runTwoCommands(host.data.id, base, cookie);

    const list = await app.inject({ method: "GET", url: `/api/memory/hosts/${host.data.id}/timeline`, headers: { cookie } });
    const whoamiId = (list.json() as any).data.entries.find((e: any) => e.command === "whoami").id;

    const res = await app.inject({ method: "GET", url: `/api/memory/entries/${whoamiId}`, headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const entry = (res.json() as any).data;
    assert.equal(entry.command, "whoami");
    assert.ok(entry.output.includes("fakeuser"));
  } finally {
    await app.close();
    sshd.close();
  }
});

test("entry detail 404s for an id that doesn't exist", async () => {
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const res = await app.inject({ method: "GET", url: "/api/memory/entries/nope", headers: { cookie: cookieFrom(setup) } });
    assert.equal(res.statusCode, 404);
  } finally { await app.close(); }
});

test("a corrupted entry, or an unreadable session key, is skipped instead of failing the whole timeline", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const cookie = cookieFrom(setup);
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: { label: "t", hostname: "127.0.0.1", port: sshd.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;
    const hostId = host.data.id;
    await runTwoCommands(hostId, base, cookie);

    const list = (await app.inject({ method: "GET", url: `/api/memory/hosts/${hostId}/timeline`, headers: { cookie } })).json() as any;
    const whoamiId = list.data.entries.find((e: any) => e.command === "whoami").id;

    // Corrupt the whoami ciphertext: the list keeps pwd, the detail 404s, nothing 500s.
    const row = db.raw.prepare("SELECT data FROM memory_entries WHERE id = ?").get(whoamiId) as { data: Buffer };
    db.raw.prepare("UPDATE memory_entries SET data = ? WHERE id = ?").run(Buffer.alloc(row.data.length, 7), whoamiId);
    const afterEntry = await app.inject({ method: "GET", url: `/api/memory/hosts/${hostId}/timeline`, headers: { cookie } });
    assert.equal(afterEntry.statusCode, 200);
    assert.deepEqual((afterEntry.json() as any).data.entries.map((e: any) => e.command), ["pwd"]);
    const detail = await app.inject({ method: "GET", url: `/api/memory/entries/${whoamiId}`, headers: { cookie } });
    assert.equal(detail.statusCode, 404);

    // Corrupt the session's wrapped key: nothing is readable, but the list is still a clean 200.
    const key = db.raw.prepare("SELECT id, wrapped_key FROM session_keys LIMIT 1").get() as { id: string; wrapped_key: Buffer };
    db.raw.prepare("UPDATE session_keys SET wrapped_key = ? WHERE id = ?").run(Buffer.alloc(key.wrapped_key.length, 9), key.id);
    const afterKey = await app.inject({ method: "GET", url: `/api/memory/hosts/${hostId}/timeline`, headers: { cookie } });
    assert.equal(afterKey.statusCode, 200);
    assert.deepEqual((afterKey.json() as any).data.entries, []);
  } finally {
    await app.close();
    sshd.close();
  }
});

test("team mode: a member sees only their own entries, another member gets 404 by id, an admin sees all", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/vault/setup",
      payload: { password: "admin-password-1", mode: "team", username: "admin" },
    });
    const adminCookie = cookieFrom(setup);
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie: adminCookie },
      payload: { label: "t", hostname: "127.0.0.1", port: sshd.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;
    const hostId = host.data.id;

    const login = async (username: string) => {
      await app.inject({
        method: "POST", url: "/api/team/users", headers: { cookie: adminCookie },
        payload: { username, tempPassword: `${username}-temp-password`, isAdmin: false },
      });
      const res = await app.inject({ method: "POST", url: "/api/team/login", payload: { username, password: `${username}-temp-password` } });
      return cookieFrom(res);
    };
    const bobCookie = await login("bob");
    const carolCookie = await login("carol");

    await runTwoCommands(hostId, base, bobCookie);

    const timeline = async (cookie: string) =>
      ((await app.inject({ method: "GET", url: `/api/memory/hosts/${hostId}/timeline`, headers: { cookie } })).json() as any).data.entries;
    const bobEntries = await timeline(bobCookie);
    assert.equal(bobEntries.length, 2, "the owner sees their own entries");
    assert.deepEqual(await timeline(carolCookie), [], "another member sees none of them");
    assert.equal((await timeline(adminCookie)).length, 2, "an admin sees everything");

    const id = bobEntries[0].id;
    const asCarol = await app.inject({ method: "GET", url: `/api/memory/entries/${id}`, headers: { cookie: carolCookie } });
    assert.equal(asCarol.statusCode, 404, "fetching another member's entry directly by id is a 404");
    const asBob = await app.inject({ method: "GET", url: `/api/memory/entries/${id}`, headers: { cookie: bobCookie } });
    assert.equal(asBob.statusCode, 200);
    const asAdmin = await app.inject({ method: "GET", url: `/api/memory/entries/${id}`, headers: { cookie: adminCookie } });
    assert.equal(asAdmin.statusCode, 200);
  } finally {
    await app.close();
    sshd.close();
  }
});
