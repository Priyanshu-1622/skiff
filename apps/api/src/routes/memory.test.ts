import { waitForShellReady } from "../test-support/terminal-ready.js";
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
  await waitForShellReady(ws, true);
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

async function appWithHost(sshd: any) {
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
  const cookie = cookieFrom(setup);
  const host = (await app.inject({
    method: "POST", url: "/api/hosts", headers: { cookie },
    payload: { label: "t", hostname: "127.0.0.1", port: sshd.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
  })).json() as any;
  return { app, base, cookie, hostId: host.data.id as string };
}

const search = (app: any, cookie: string, qs: string) =>
  app.inject({ method: "GET", url: `/api/memory/search?${qs}`, headers: { cookie } });

test("search finds a captured command by word and by prefix, returns timeline-shaped hits without output, and [] for no match", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const { app, base, cookie, hostId } = await appWithHost(sshd);
  try {
    await runTwoCommands(hostId, base, cookie);
    const res = await search(app, cookie, "q=whoami");
    assert.equal(res.statusCode, 200);
    const { entries } = (res.json() as any).data;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].command, "whoami");
    assert.equal(entries[0].hostId, hostId);
    assert.ok(entries[0].id && entries[0].startedAt);
    assert.equal("output" in entries[0], false);
    assert.deepEqual(((await search(app, cookie, "q=pw")).json() as any).data.entries.map((e: any) => e.command), ["pwd"]);
    assert.deepEqual(((await search(app, cookie, "q=nomatchzzz")).json() as any).data.entries, []);
  } finally { await app.close(); sshd.close(); }
});

test("search can be scoped to a host", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const { app, base, cookie, hostId } = await appWithHost(sshd);
  try {
    const other = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: { label: "o", hostname: "10.0.0.9", port: 22, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;
    await runTwoCommands(hostId, base, cookie);
    assert.equal(((await search(app, cookie, `q=whoami&hostId=${hostId}`)).json() as any).data.entries.length, 1);
    assert.deepEqual(((await search(app, cookie, `q=whoami&hostId=${other.data.id}`)).json() as any).data.entries, []);
  } finally { await app.close(); sshd.close(); }
});

test("output is searched only when output=1", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const { app, base, cookie, hostId } = await appWithHost(sshd);
  try {
    await runTwoCommands(hostId, base, cookie);
    assert.deepEqual(((await search(app, cookie, "q=fakeuser")).json() as any).data.entries, []);
    const withOutput = ((await search(app, cookie, "q=fakeuser&output=1")).json() as any).data.entries;
    assert.deepEqual(withOutput.map((e: any) => e.command), ["whoami"]);
  } finally { await app.close(); sshd.close(); }
});

test("commands captured after the first search are found by a later search, without duplicating earlier hits", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const { app, base, cookie, hostId } = await appWithHost(sshd);
  try {
    await runTwoCommands(hostId, base, cookie);
    const first = ((await search(app, cookie, "q=whoami")).json() as any).data.entries;
    assert.equal(first.length, 1);
    await runTwoCommands(hostId, base, cookie);
    const second = ((await search(app, cookie, "q=whoami")).json() as any).data.entries;
    assert.equal(second.length, 2);
    assert.equal(new Set(second.map((e: any) => e.id)).size, 2, "two distinct entries, none repeated");
  } finally { await app.close(); sshd.close(); }
});

test("odd search input never errors", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const { app, base, cookie, hostId } = await appWithHost(sshd);
  try {
    await runTwoCommands(hostId, base, cookie);
    for (const q of ['"', "*", "AND", "(", "NEAR(", "-", "  ", "", "a:b"]) {
      const res = await search(app, cookie, `q=${encodeURIComponent(q)}`);
      assert.equal(res.statusCode, 200, `q=${JSON.stringify(q)}`);
      assert.ok(Array.isArray((res.json() as any).data.entries));
    }
    assert.equal((await search(app, cookie, "")).statusCode, 200, "missing q is an empty result, not an error");
  } finally { await app.close(); sshd.close(); }
});

test("search without a login is refused", async () => {
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  try {
    await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const res = await app.inject({ method: "GET", url: "/api/memory/search?q=whoami" });
    assert.equal(res.statusCode, 401);
  } finally { await app.close(); }
});

test("team mode: a member only finds their own commands; an admin finds everyone's", async () => {
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
    const login = async (username: string) => {
      await app.inject({
        method: "POST", url: "/api/team/users", headers: { cookie: adminCookie },
        payload: { username, tempPassword: `${username}-temp-password`, isAdmin: false },
      });
      return cookieFrom(await app.inject({ method: "POST", url: "/api/team/login", payload: { username, password: `${username}-temp-password` } }));
    };
    const bobCookie = await login("bob");
    const carolCookie = await login("carol");
    await runTwoCommands(host.data.id, base, bobCookie);

    const hits = async (cookie: string) => ((await search(app, cookie, "q=whoami")).json() as any).data.entries;
    assert.equal((await hits(bobCookie)).length, 1);
    assert.deepEqual(await hits(carolCookie), [], "another member cannot find it by searching");
    assert.equal((await hits(adminCookie)).length, 1);
  } finally { await app.close(); sshd.close(); }
});

test("after lock and unlock the search still works, rebuilt from the database", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const { app, base, cookie, hostId } = await appWithHost(sshd);
  try {
    await runTwoCommands(hostId, base, cookie);
    assert.equal(((await search(app, cookie, "q=whoami")).json() as any).data.entries.length, 1);
    await app.inject({ method: "POST", url: "/api/vault/lock", headers: { cookie } });
    assert.equal((await search(app, cookie, "q=whoami")).statusCode, 401, "locked: nothing is searchable");
    const unlocked = await app.inject({ method: "POST", url: "/api/vault/unlock", payload: { password: "master-pass-1" } });
    const cookie2 = cookieFrom(unlocked);
    assert.equal(((await search(app, cookie2, "q=whoami")).json() as any).data.entries.length, 1);
  } finally { await app.close(); sshd.close(); }
});

const forget = (app: any, cookie: string | null, id: string) =>
  app.inject({ method: "DELETE", url: `/api/memory/entries/${id}`, headers: cookie ? { cookie } : {} });

const timelineCommands = async (app: any, cookie: string, hostId: string) =>
  ((await app.inject({ method: "GET", url: `/api/memory/hosts/${hostId}/timeline`, headers: { cookie } })).json() as any).data.entries.map((e: any) => e.command);

test("forgetting an entry removes it from the timeline, the detail view and the search index, and leaves the others", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const { app, base, cookie, hostId } = await appWithHost(sshd);
  try {
    await runTwoCommands(hostId, base, cookie);
    const hit = ((await search(app, cookie, "q=whoami")).json() as any).data.entries;
    assert.equal(hit.length, 1, "the index is built and holds the entry");
    const res = await forget(app, cookie, hit[0].id);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await timelineCommands(app, cookie, hostId), ["pwd"]);
    assert.equal((await app.inject({ method: "GET", url: `/api/memory/entries/${hit[0].id}`, headers: { cookie } })).statusCode, 404);
    assert.deepEqual(((await search(app, cookie, "q=whoami")).json() as any).data.entries, []);
    assert.equal(((await search(app, cookie, "q=pwd")).json() as any).data.entries.length, 1);
  } finally { await app.close(); sshd.close(); }
});

test("forgetting twice, or an unknown id, is a plain 404; without a login it is a 401", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const { app, base, cookie, hostId } = await appWithHost(sshd);
  try {
    await runTwoCommands(hostId, base, cookie);
    const id = ((await search(app, cookie, "q=whoami")).json() as any).data.entries[0].id;
    assert.equal((await forget(app, cookie, id)).statusCode, 200);
    assert.equal((await forget(app, cookie, id)).statusCode, 404);
    assert.equal((await forget(app, cookie, "nope")).statusCode, 404);
    assert.equal((await forget(app, null, id)).statusCode, 401);
  } finally { await app.close(); sshd.close(); }
});

test("a new command captured after forgetting the newest entry is still searchable (rowid reuse)", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const { app, base, cookie, hostId } = await appWithHost(sshd);
  try {
    await runTwoCommands(hostId, base, cookie); // whoami, pwd
    const pwdId = ((await search(app, cookie, "q=pwd")).json() as any).data.entries[0].id; // builds the index
    assert.equal((await forget(app, cookie, pwdId)).statusCode, 200);
    await runTwoCommands(hostId, base, cookie); // whoami, pwd again; the first of these reuses the freed rowid
    assert.equal(((await search(app, cookie, "q=whoami")).json() as any).data.entries.length, 2);
    assert.equal(((await search(app, cookie, "q=pwd")).json() as any).data.entries.length, 1);
  } finally { await app.close(); sshd.close(); }
});

test("team mode: a member can forget only their own entries, an admin anyone's, and the audit row carries no command text", async () => {
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
    const login = async (username: string) => {
      await app.inject({
        method: "POST", url: "/api/team/users", headers: { cookie: adminCookie },
        payload: { username, tempPassword: `${username}-temp-password`, isAdmin: false },
      });
      return cookieFrom(await app.inject({ method: "POST", url: "/api/team/login", payload: { username, password: `${username}-temp-password` } }));
    };
    const bobCookie = await login("bob");
    const carolCookie = await login("carol");
    await runTwoCommands(host.data.id, base, bobCookie);
    const entries = ((await app.inject({ method: "GET", url: `/api/memory/hosts/${host.data.id}/timeline`, headers: { cookie: bobCookie } })).json() as any).data.entries;
    const whoamiId = entries.find((e: any) => e.command === "whoami").id;
    const pwdId = entries.find((e: any) => e.command === "pwd").id;

    assert.equal((await forget(app, carolCookie, whoamiId)).statusCode, 404, "another member cannot forget it");
    assert.deepEqual((await timelineCommands(app, bobCookie, host.data.id)).sort(), ["pwd", "whoami"], "and it is still there");
    assert.equal((await forget(app, bobCookie, whoamiId)).statusCode, 200, "the owner can");
    assert.equal((await forget(app, adminCookie, pwdId)).statusCode, 200, "an admin can forget anyone's");
    assert.deepEqual(await timelineCommands(app, adminCookie, host.data.id), []);

    const audit = db.raw.prepare("SELECT username, resource_type, resource_id, detail FROM audit_log WHERE action = 'memory.forget' ORDER BY id").all() as any[];
    assert.equal(audit.length, 2);
    assert.deepEqual(audit.map((a) => a.username), ["bob", "admin"]);
    assert.equal(audit[0].resource_id, whoamiId);
    assert.equal(audit[0].resource_type, "memory_entry");
    assert.ok(!audit[0].detail.includes("whoami") && !audit[1].detail.includes("pwd"), "no command text in the audit detail");
  } finally { await app.close(); sshd.close(); }
});

const entriesOf = async (app: any, cookie: string, qs: string) => ((await search(app, cookie, qs)).json() as any).data.entries as any[];

test("browse lists everything newest first when the query is empty, and an empty query without browse stays empty", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const { app, base, cookie, hostId } = await appWithHost(sshd);
  try {
    await runTwoCommands(hostId, base, cookie); // whoami, pwd
    assert.deepEqual((await entriesOf(app, cookie, "q=&browse=1")).map((e) => e.command), ["pwd", "whoami"]);
    assert.deepEqual(await entriesOf(app, cookie, "q="), []);
    assert.deepEqual((await entriesOf(app, cookie, "browse=1")).map((e) => e.command), ["pwd", "whoami"], "a missing q counts as empty too");
  } finally { await app.close(); sshd.close(); }
});

test("hosts accepts a list, and an unknown or empty id matches nothing instead of erroring", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const { app, base, cookie, hostId } = await appWithHost(sshd);
  try {
    const other = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: { label: "o", hostname: "10.0.0.9", port: 22, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;
    await runTwoCommands(hostId, base, cookie);
    assert.equal((await entriesOf(app, cookie, `q=whoami&hosts=${hostId},${other.data.id}`)).length, 1);
    assert.deepEqual(await entriesOf(app, cookie, `q=whoami&hosts=${other.data.id}`), []);
    const unknown = await search(app, cookie, "q=whoami&hosts=nope,");
    assert.equal(unknown.statusCode, 200);
    assert.deepEqual((unknown.json() as any).data.entries, []);
  } finally { await app.close(); sshd.close(); }
});

test("before and beforeId page through browse results without repeating or skipping", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const { app, base, cookie, hostId } = await appWithHost(sshd);
  try {
    await runTwoCommands(hostId, base, cookie);
    const first = await entriesOf(app, cookie, "q=&browse=1&limit=1");
    assert.deepEqual(first.map((e) => e.command), ["pwd"]);
    const second = await entriesOf(app, cookie, `q=&browse=1&limit=1&before=${encodeURIComponent(first[0].startedAt)}&beforeId=${first[0].id}`);
    assert.deepEqual(second.map((e) => e.command), ["whoami"]);
    assert.deepEqual(await entriesOf(app, cookie, `q=&browse=1&limit=1&before=${encodeURIComponent(second[0].startedAt)}&beforeId=${second[0].id}`), []);
  } finally { await app.close(); sshd.close(); }
});

test("team: an admin can narrow to one person; a member's user filter is ignored and never shows anyone else's entries", async () => {
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
    const login = async (username: string) => {
      await app.inject({
        method: "POST", url: "/api/team/users", headers: { cookie: adminCookie },
        payload: { username, tempPassword: `${username}-temp-password`, isAdmin: false },
      });
      return cookieFrom(await app.inject({ method: "POST", url: "/api/team/login", payload: { username, password: `${username}-temp-password` } }));
    };
    const idOf = async (cookie: string) => ((await app.inject({ method: "GET", url: "/api/team/me", headers: { cookie } })).json() as any).data.user.id as string;
    const bob = await login("bob");
    const carol = await login("carol");
    const bobId = await idOf(bob);
    await runTwoCommands(host.data.id, base, bob);
    await runTwoCommands(host.data.id, base, carol);

    const names = (entries: any[]) => [...new Set(entries.map((e) => e.username))].sort();
    const everyone = await entriesOf(app, adminCookie, "q=&browse=1");
    assert.equal(everyone.length, 4);
    assert.deepEqual(names(everyone), ["bob", "carol"]);
    const justBob = await entriesOf(app, adminCookie, `q=&browse=1&user=${bobId}`);
    assert.equal(justBob.length, 2);
    assert.deepEqual(names(justBob), ["bob"]);
    const carolAsksForBob = await entriesOf(app, carol, `q=&browse=1&user=${bobId}`);
    assert.equal(carolAsksForBob.length, 2, "her own two entries, not an empty list and not bob's");
    assert.deepEqual(names(carolAsksForBob), ["carol"]);
  } finally { await app.close(); sshd.close(); }
});
