/**
 * A live terminal session gets its own wrapped data key, its host is linked to
 * the server behind the host key, and the key is wiped when the session ends.
 * Runs a real WebSocket session against an in-process SSH server.
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

test("a session gets a wrapped data key and its host is linked to a server", async () => {
  const sshd = new Server({ hostKeys: [utils.generateKeyPairSync("ed25519").private] }, (c: any) => {
    c.on("authentication", (ctx: any) => (ctx.method === "password" && ctx.password === "pw" ? ctx.accept() : ctx.reject()));
    c.on("ready", () => c.on("session", (acc: any) => {
      const s = acc();
      s.on("pty", (a: any) => a && a());
      s.on("shell", (a: any) => { const st = a(); st.write("$ "); st.on("data", (d: Buffer) => st.write(d)); });
    }));
    c.on("error", () => {});
  });
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({
    config: { dataDir: "/tmp/skiff-test-unused", port: 0, host: "127.0.0.1", nodeEnv: "test", trustedOrigins: [], cookieSecret: "x".repeat(40), setupToken: null },
    db,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  let ws: any;
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const cookie = String(setup.headers["set-cookie"]).split(";")[0];
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: { label: "t", hostname: "127.0.0.1", port: sshd.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;

    let fingerprint = "";
    ws = new WebSocket(`ws://${base}/api/terminal/${host.data.id}`, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no Connected within 10s")), 10_000);
      ws.on("message", (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "fingerprint_new") { fingerprint = m.fingerprint; ws.send(JSON.stringify({ type: "fingerprint_approve" })); }
        if (m.type === "status" && m.message === "Connected") { clearTimeout(timer); resolve(); }
        if (m.type === "error") { clearTimeout(timer); reject(new Error(m.message)); }
      });
    });

    assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM session_keys").get() as any).c, 1, "one wrapped key per session");
    const linked = db.raw.prepare("SELECT s.fingerprint f FROM hosts h JOIN servers s ON s.id = h.server_id").get() as any;
    assert.equal(linked?.f, fingerprint, "host linked to the server behind the approved key");

    const session = (app as any).sessionManager.list()[0];
    const key = session.dataKey as Buffer;
    assert.equal(key.length, 32);
    assert.ok(key.some((b: number) => b !== 0), "key is live while the session runs");
    assert.ok(session.keyId, "session knows which stored key it uses");

    ws.send(JSON.stringify({ type: "end_session" }));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(key.every((b: number) => b === 0), "data key zeroed when the session ends");
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    await app.close();
    sshd.close();
  }
});

test("when the server refuses a shell, the SSH connection is closed, not leaked", async () => {
  let clientClosed = false;
  const sshd = new Server({ hostKeys: [utils.generateKeyPairSync("ed25519").private] }, (c: any) => {
    c.on("authentication", (ctx: any) => (ctx.method === "password" && ctx.password === "pw" ? ctx.accept() : ctx.reject()));
    c.on("ready", () => c.on("session", (acc: any) => {
      const s = acc();
      s.on("pty", (a: any) => a && a());
      s.on("shell", (_a: any, reject: any) => reject()); // e.g. ForceCommand / no shell for this user
    }));
    c.on("close", () => { clientClosed = true; });
    c.on("error", () => {});
  });
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({
    config: { dataDir: "/tmp/skiff-test-unused", port: 0, host: "127.0.0.1", nodeEnv: "test", trustedOrigins: [], cookieSecret: "x".repeat(40), setupToken: null },
    db,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  let ws: any;
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } });
    const cookie = String(setup.headers["set-cookie"]).split(";")[0];
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie },
      payload: { label: "t", hostname: "127.0.0.1", port: sshd.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;
    ws = new WebSocket(`ws://${base}/api/terminal/${host.data.id}`, { headers: { cookie } });
    const error = await new Promise<string>((resolve) => {
      ws.on("message", (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "fingerprint_new") ws.send(JSON.stringify({ type: "fingerprint_approve" }));
        if (m.type === "error") resolve(m.message);
      });
    });
    assert.ok(error, "the browser is told the shell failed");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(clientClosed, true, "Skiff hung up the SSH connection");
    assert.equal((app as any).sessionManager.list().length, 0);
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    await app.close();
    sshd.close();
  }
});

test("a password change while a fingerprint prompt is pending must not permanently break future password changes", async () => {
  // Reproduces a race a fresh reviewer found in Phase A: the WS handler keeps
  // its own copy of the vault key for the whole connect (so a lock mid-connect
  // can't yank it out from under an in-flight session). If the MASTER PASSWORD
  // changes during that same window — while a human is still deciding whether
  // to trust a new host's fingerprint — the connect's copy goes stale. Sealing
  // a servers/session_keys row under that stale key writes something nobody
  // can ever unwrap again (the old key-derivation params are gone the moment
  // vault_meta is overwritten), and every future password change then hits
  // that poisoned row and fails.
  const sshd = new Server({ hostKeys: [utils.generateKeyPairSync("ed25519").private] }, (c: any) => {
    c.on("authentication", (ctx: any) => (ctx.method === "password" && ctx.password === "pw" ? ctx.accept() : ctx.reject()));
    c.on("ready", () => c.on("session", (acc: any) => {
      const s = acc();
      s.on("pty", (a: any) => a && a());
      s.on("shell", (a: any) => { const st = a(); st.write("$ "); st.on("data", (d: Buffer) => st.write(d)); });
    }));
    c.on("error", () => {});
  });
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({
    config: { dataDir: "/tmp/skiff-test-unused", port: 0, host: "127.0.0.1", nodeEnv: "test", trustedOrigins: [], cookieSecret: "x".repeat(40), setupToken: null },
    db,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  let ws: any;
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "old-password-1" } });
    const cookie1 = String(setup.headers["set-cookie"]).split(";")[0];
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie: cookie1 },
      payload: { label: "t", hostname: "127.0.0.1", port: sshd.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;

    // Open the connection and stop right at the human-decision point: a new
    // host's fingerprint has arrived, but nothing has been approved yet.
    ws = new WebSocket(`ws://${base}/api/terminal/${host.data.id}`, { headers: { cookie: cookie1 } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no fingerprint_new within 10s")), 10_000);
      ws.on("message", (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "fingerprint_new") { clearTimeout(timer); resolve(); }
        if (m.type === "error") { clearTimeout(timer); reject(new Error(m.message)); }
      });
    });

    // While that prompt is still pending, the master password changes — in
    // another tab, say. This is a completely ordinary request; the cookie
    // behind the open WebSocket is still valid for it.
    const changed = await app.inject({
      method: "PUT", url: "/api/settings/password", headers: { cookie: cookie1 },
      payload: { currentPassword: "old-password-1", newPassword: "new-password-2" },
    });
    assert.equal(changed.statusCode, 200);
    const cookie2 = String(changed.headers["set-cookie"]).split(";")[0];

    // Only now does the human approve the (still correct) fingerprint.
    const settled = new Promise<void>((resolve) => {
      ws.on("message", (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "status" || m.type === "error") resolve(); // whatever happens, happens
      });
      ws.on("close", () => resolve());
    });
    ws.send(JSON.stringify({ type: "fingerprint_approve" }));
    await settled;
    await new Promise((r) => setTimeout(r, 300)); // let any DB writes from the connect finish

    // Directly: nothing was sealed under the now-unrecoverable stale key.
    assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM session_keys").get() as any).c, 0,
      "no session key should be sealed under a vault key that went stale mid-connect");
    assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM servers").get() as any).c, 0,
      "no server identity should be sealed under a vault key that went stale mid-connect");

    // The sharpest, most user-visible proof: the vault must still be able to
    // change its password again. Before the fix this returns 500 forever.
    const changedAgain = await app.inject({
      method: "PUT", url: "/api/settings/password", headers: { cookie: cookie2 },
      payload: { currentPassword: "new-password-2", newPassword: "new-password-3" },
    });
    assert.equal(changedAgain.statusCode, 200, "the vault must not be permanently unable to change its password");
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    await app.close();
    sshd.close();
  }
});

test("if recording is on but the vault key went stale mid-connect, no recording is written — never a silent plaintext fallback", async () => {
  const sshd = new Server({ hostKeys: [utils.generateKeyPairSync("ed25519").private] }, (c: any) => {
    c.on("authentication", (ctx: any) => (ctx.method === "password" && ctx.password === "pw" ? ctx.accept() : ctx.reject()));
    c.on("ready", () => c.on("session", (acc: any) => {
      const s = acc();
      s.on("pty", (a: any) => a && a());
      s.on("shell", (a: any) => { const st = a(); st.write("$ "); st.on("data", (d: Buffer) => st.write(d)); });
    }));
    c.on("error", () => {});
  });
  await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
  const db = memDb();
  const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dataDir = mkdtempSync(join(tmpdir(), "skiff-stale-rec-"));
  const app = await buildApp({
    config: { dataDir, port: 0, host: "127.0.0.1", nodeEnv: "test", trustedOrigins: [], cookieSecret: "x".repeat(40), setupToken: null },
    db,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  let ws: any;
  try {
    const setup = await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "old-password-1" } });
    const cookie1 = String(setup.headers["set-cookie"]).split(";")[0];
    await app.inject({ method: "PUT", url: "/api/settings/recording", headers: { cookie: cookie1 }, payload: { enabled: true } });
    const host = (await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie: cookie1 },
      payload: { label: "t", hostname: "127.0.0.1", port: sshd.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any;

    ws = new WebSocket(`ws://${base}/api/terminal/${host.data.id}`, { headers: { cookie: cookie1 } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no fingerprint_new within 10s")), 10_000);
      ws.on("message", (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "fingerprint_new") { clearTimeout(timer); resolve(); }
        if (m.type === "error") { clearTimeout(timer); reject(new Error(m.message)); }
      });
    });

    const changed = await app.inject({
      method: "PUT", url: "/api/settings/password", headers: { cookie: cookie1 },
      payload: { currentPassword: "old-password-1", newPassword: "new-password-2" },
    });
    assert.equal(changed.statusCode, 200);

    const settled = new Promise<void>((resolve) => {
      ws.on("message", (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "status" || m.type === "error") resolve();
      });
      ws.on("close", () => resolve());
    });
    ws.send(JSON.stringify({ type: "fingerprint_approve" }));
    await settled;
    await new Promise((r) => setTimeout(r, 300));

    assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM session_recordings").get() as any).c, 0,
      "recording was skipped, not silently written unencrypted");
    let files: string[] = [];
    try { files = readdirSync(join(dataDir, "recordings")); } catch { /* directory never created — also fine */ }
    assert.deepEqual(files, [], "no .cast file (encrypted or otherwise) was left on disk");
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    await app.close();
    sshd.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
