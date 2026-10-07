/**
 * Full-stack wiring test: connect a real WebSocket terminal session against
 * an in-process fake SSH server, run a command, end the session, and check
 * a memory_entries row exists and decrypts to the right command.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { buildApp } from "../app.js";
import { runColumnMigrations } from "../db/client.js";
import { loadCommandEntry } from "../lib/memory/store.js";

const require = createRequire(import.meta.url);
const { Server, utils } = require("ssh2");
const WebSocket = require("ws");
const here = dirname(fileURLToPath(import.meta.url));

function memDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(join(here, "../db/schema.sql"), "utf-8"));
  runColumnMigrations(db);
  return { raw: db, close: () => db.close() };
}

// A fake shell that behaves like a real one for exactly one command: echoes
// the prompt, echoes typed input back (matching a real pty), then prints
// output distinguishable from the echo, then redraws the prompt — enough
// for CaptureEngine's screen-mode heuristic to read "whoami" back out.
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
          st.write(d); // pty echo
          const cmd = d.toString().replace(/\r?\n$/, "");
          st.write(cmd === "whoami" ? "\r\nfakeuser\r\n$ " : "\r\n$ ");
        });
      });
    }));
    c.on("error", () => {});
  });
}

async function connectAndRunWhoami(app: any, hostId: string, base: string, cookie: string): Promise<Buffer | null> {
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
  await new Promise((r) => setTimeout(r, 300)); // let the echo/output round-trip and capture process it
  // A second command so "whoami" actually finishes via the real
  // next-keystroke completion path (screen mode's only end signal) rather
  // than the session ending while it's still "running" — a real command
  // run mid-session, not just the end-of-session fallback path.
  ws.send(JSON.stringify({ type: "input", data: Buffer.from("pwd\n").toString("base64") }));
  await new Promise((r) => setTimeout(r, 300));
  // Grab the still-live data key before ending the session zeroes it —
  // same pattern terminal-keys.test.ts already uses.
  const dataKey: Buffer | null = app.sessionManager.list()[0]?.dataKey
    ? Buffer.from(app.sessionManager.list()[0].dataKey)
    : null;
  ws.send(JSON.stringify({ type: "end_session" }));
  await new Promise((r) => setTimeout(r, 300)); // let onEnd's endMemorySession run
  try { ws.close(); } catch { /* ignore */ }
  return dataKey;
}

test("a command run over a real session is captured, redacted-encrypted, and readable back with the session's data key", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({
    config: { dataDir: "/tmp/skiff-test-unused", port: 0, host: "127.0.0.1", nodeEnv: "test", trustedOrigins: [], cookieSecret: "x".repeat(40), setupToken: null },
    db,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const cookie = String(setup.headers["set-cookie"]).split(";")[0];
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: { label: "t", hostname: "127.0.0.1", port: sshd.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;

    const dataKey = await connectAndRunWhoami(app, host.data.id, base, cookie);
    assert.ok(dataKey, "the session had a live data key to capture with");

    const memSession = db.raw.prepare("SELECT id, key_id, ended_at FROM memory_sessions").get() as any;
    assert.ok(memSession, "a memory session was created");
    assert.ok(memSession.ended_at, "the memory session was ended alongside the SSH session");
    const entries = db.raw.prepare("SELECT * FROM memory_entries WHERE memory_session_id = ? ORDER BY rowid").all(memSession.id) as any[];
    assert.equal(entries.length, 2, "both whoami and pwd were captured");
    const [whoamiRow, pwdRow] = entries;
    assert.equal(whoamiRow.kind, "command");
    assert.equal(whoamiRow.confidence, "screen", "this fake shell sends no OSC 133 markers");
    assert.equal(whoamiRow.exit_code, null, "screen mode has no exit-code signal — only marker mode (133;D) provides one");
    assert.ok(whoamiRow.finished_at, "whoami finished when its prompt returned");
    assert.ok(pwdRow.finished_at, "pwd finished when its prompt returned too — the newest command no longer waits for a next keystroke or the end of the session");

    const decrypted = loadCommandEntry(db.raw, dataKey!, whoamiRow.id);
    assert.equal(decrypted.command, "whoami");
    assert.ok(decrypted.output.includes("fakeuser"));

    // The raw encrypted row must never contain the plaintext command or output.
    const raw = whoamiRow.data as Buffer;
    assert.equal(raw.includes(Buffer.from("whoami")), false, "command text is not stored in the clear");
    assert.equal(raw.includes(Buffer.from("fakeuser")), false, "output is not stored in the clear");
  } finally {
    await app.close();
    sshd.close();
  }
});

test("memory_mode 'off' on the host means nothing is captured at all", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({
    config: { dataDir: "/tmp/skiff-test-unused", port: 0, host: "127.0.0.1", nodeEnv: "test", trustedOrigins: [], cookieSecret: "x".repeat(40), setupToken: null },
    db,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const cookie = String(setup.headers["set-cookie"]).split(";")[0];
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: { label: "t", hostname: "127.0.0.1", port: sshd.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;
    db.raw.prepare("UPDATE hosts SET memory_mode = 'off' WHERE id = ?").run(host.data.id);

    await connectAndRunWhoami(app, host.data.id, base, cookie);

    assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM memory_sessions").get() as any).c, 0);
    assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM memory_entries").get() as any).c, 0);
  } finally {
    await app.close();
    sshd.close();
  }
});

test("vault_meta.memory_enabled = 0 means nothing is captured, even if the host itself is on", async () => {
  const sshd = fakeSshdWithShell();
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({
    config: { dataDir: "/tmp/skiff-test-unused", port: 0, host: "127.0.0.1", nodeEnv: "test", trustedOrigins: [], cookieSecret: "x".repeat(40), setupToken: null },
    db,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const cookie = String(setup.headers["set-cookie"]).split(";")[0];
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: { label: "t", hostname: "127.0.0.1", port: sshd.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;
    db.raw.prepare("UPDATE vault_meta SET memory_enabled = 0 WHERE id = 1").run();

    await connectAndRunWhoami(app, host.data.id, base, cookie);

    assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM memory_sessions").get() as any).c, 0);
  } finally {
    await app.close();
    sshd.close();
  }
});
