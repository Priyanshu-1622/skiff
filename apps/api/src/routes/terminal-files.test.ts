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
const { STATUS_CODE } = utils.sftp;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

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

/**
 * A fake server: an SSH shell that really mutates an in-memory filesystem, and
 * an SFTP subsystem that serves that same filesystem.
 *   vim PATH                 appends "edited\n" to the file (creating it)
 *   echo TEXT > PATH         writes TEXT + newline
 *   sed -i d PATH            deletes the file
 *   cat PATH                 reads only
 *   whoami                   prints fakeuser
 */
function fakeServer(opts: { sftpDelayMs?: number } = {}) {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>(["/srv", "/home/u"]);
  const sftpOps: string[] = [];
  const execs: string[] = [];
  const box = { snapshotReply: null as string | null }; // what the snapshot script prints; null = the server prints nothing useful
  const server = new Server({ hostKeys: [generateEd25519(utils).private] }, (c: any) => {
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
          let m: RegExpMatchArray | null;
          if (cmd === "whoami") { st.write("\r\nfakeuser\r\n$ "); return; }
          // Commands take a moment, like real ones: the file changes (and the
          // prompt comes back) only after the tracker has had time to read its baseline.
          const finish = (mutate: () => void) => setTimeout(() => { mutate(); st.write("\r\n$ "); }, 250);
          if ((m = cmd.match(/^vim (\S+)$/))) { const p = m[1]!; finish(() => files.set(p, Buffer.concat([files.get(p) ?? Buffer.alloc(0), Buffer.from("edited\n")]))); }
          else if ((m = cmd.match(/^echo (.+) > (\S+)$/))) { const t = m[1]!, p = m[2]!; finish(() => files.set(p, Buffer.from(`${t}\n`))); }
          else if ((m = cmd.match(/^sed -i d (\S+)$/))) { const p = m[1]!; finish(() => files.delete(p)); }
          else st.write("\r\n$ ");
        });
      });
      s.on("exec", (acc: any, _rej: any, info: any) => {
        const st = acc();
        execs.push(info.command);
        if (info.command.includes("@@skiff:end") && box.snapshotReply !== null) st.write(box.snapshotReply);
        st.exit(0); st.end();
      });
      s.on("sftp", (accSftp: any) => {
        const sftp = accSftp();
        const later = (fn: () => void) => (opts.sftpDelayMs ? setTimeout(fn, opts.sftpDelayMs) : fn());
        const handles = new Map<string, string>();
        let next = 0;
        const attrsFor = (p: string) => {
          if (dirs.has(p)) return { mode: S_IFDIR | 0o755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 };
          const f = files.get(p);
          return f ? { mode: S_IFREG | 0o644, size: f.length, uid: 0, gid: 0, atime: 0, mtime: 0 } : null;
        };
        const stat = (op: string) => (reqid: number, path: string) => {
          sftpOps.push(`${op} ${path}`);
          later(() => {
            const a = attrsFor(path);
            if (a) sftp.attrs(reqid, a); else sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          });
        };
        sftp.on("REALPATH", (reqid: number, path: string) => sftp.name(reqid, [{ filename: path === "." ? "/home/u" : path, longname: "", attrs: {} }]));
        sftp.on("STAT", stat("STAT"));
        sftp.on("LSTAT", stat("LSTAT"));
        sftp.on("OPEN", (reqid: number, path: string) => {
          sftpOps.push(`OPEN ${path}`);
          if (!files.has(path)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          const h = Buffer.from(String(next++));
          handles.set(h.toString(), path);
          sftp.handle(reqid, h);
        });
        sftp.on("FSTAT", (reqid: number, handle: Buffer) => {
          const p = handles.get(handle.toString());
          const a = p ? attrsFor(p) : null;
          if (a) sftp.attrs(reqid, a); else sftp.status(reqid, STATUS_CODE.FAILURE);
        });
        sftp.on("READ", (reqid: number, handle: Buffer, offset: number, length: number) => {
          const p = handles.get(handle.toString());
          const f = p ? files.get(p) : undefined;
          if (!f || offset >= f.length) return sftp.status(reqid, STATUS_CODE.EOF);
          sftp.data(reqid, f.subarray(offset, Math.min(f.length, offset + length)));
        });
        sftp.on("CLOSE", (reqid: number, handle: Buffer) => { handles.delete(handle.toString()); sftp.status(reqid, STATUS_CODE.OK); });
      });
    }));
    c.on("error", () => {});
  });
  return { server, files, sftpOps, execs, box };
}

async function openTerminal(hostId: string, base: string, cookie: string) {
  const ws = new WebSocket(`ws://${base}/api/terminal/${hostId}`, { headers: { cookie } });
  const shellReady = waitForShellReady(ws);
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
  /** Type a line, then give the capture engine and the file tracker time to finish. */
  const type = async (s: string, settleMs = 700) => { send({ type: "input", data: Buffer.from(s).toString("base64") }); await new Promise((r) => setTimeout(r, settleMs)); };
  const end = async () => { send({ type: "end_session" }); await new Promise((r) => setTimeout(r, 400)); try { ws.close(); } catch { /* ignore */ } };
  await shellReady;
  return { ws, msgs, waitFor, send, type, end };
}
const connected = (m: any) => m.type === "status" && (m.message === "Connected" || m.message === "Reattached");
const memState = (s: string) => (m: any) => m.type === "memory" && m.state === s;

async function setup(opts: { sftpDelayMs?: number } = {}) {
  const fake = fakeServer(opts);
  await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  const cookie = cookieFrom(await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } }));
  const hostId = ((await app.inject({
    method: "POST", url: "/api/hosts", headers: { cookie },
    payload: { label: "t", hostname: "127.0.0.1", port: fake.server.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
  })).json() as any).data.id as string;
  const fileRows = () => db.raw.prepare("SELECT flags, content_old_id AS oldId, content_new_id AS newId FROM memory_entries WHERE kind = 'file' ORDER BY started_at").all() as
    { flags: string; oldId: string | null; newId: string | null }[];
  const contents = () => (db.raw.prepare("SELECT COUNT(*) n FROM file_contents").get() as any).n as number;
  async function session(run: (t: Awaited<ReturnType<typeof openTerminal>>) => Promise<void>) {
    const t = await openTerminal(hostId, base, cookie);
    await t.waitFor(connected);
    await t.waitFor(memState("remembering"));
    await run(t);
    await t.end();
  }
  return { ...fake, app, db, base, cookie, hostId, fileRows, contents, session, close: async () => { await app.close(); fake.server.close(); } };
}

test("editing an existing file records one file entry with both versions stored", async () => {
  const s = await setup();
  try {
    s.files.set("/srv/app.conf", Buffer.from("port = 80\n"));
    await s.session(async (t) => {
      await t.type("vim /srv/app.conf\n");
    });
    const rows = s.fileRows();
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.oldId && rows[0]!.newId && rows[0]!.oldId !== rows[0]!.newId);
    assert.equal(s.contents(), 2);
    assert.equal((s.db.raw.prepare("SELECT COUNT(*) n FROM server_files").get() as any).n, 1);
    assert.equal((s.db.raw.prepare("SELECT COUNT(*) n FROM memory_entries WHERE kind = 'command'").get() as any).n, 1, "the command itself is still remembered");
  } finally { await s.close(); }
});

test("creating a file and deleting it each record an entry; reading it records none", async () => {
  const s = await setup();
  try {
    await s.session(async (t) => {
      await t.type("echo hello > /srv/new.txt\n");
      await t.type("cat /srv/new.txt\n");
      await t.type("sed -i d /srv/new.txt\n");
    });
    const rows = s.fileRows();
    assert.equal(rows.length, 2, "created, then deleted (cat is not an edit)");
    assert.equal(rows[0]!.oldId, null);
    assert.ok(rows[0]!.newId);
    assert.ok(rows[1]!.oldId);
    assert.equal(rows[1]!.newId, null);
  } finally { await s.close(); }
});

test("a command run while paused is never tracked", async () => {
  const s = await setup();
  try {
    s.files.set("/srv/a", Buffer.from("1\n"));
    await s.session(async (t) => {
      t.send({ type: "memory_pause", paused: true });
      await t.waitFor(memState("paused"));
      await t.type("vim /srv/a\n");
    });
    assert.equal(s.fileRows().length, 0);
    assert.equal(s.contents(), 0);
  } finally { await s.close(); }
});

test("binary, key-like and oversized files leave a note entry and store no content", async () => {
  const s = await setup();
  try {
    s.files.set("/srv/blob", Buffer.from([1, 2, 0, 3]));
    s.files.set("/srv/id_rsa", Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n"));
    s.files.set("/srv/huge", Buffer.alloc(300 * 1024, 97));
    await s.session(async (t) => {
      await t.type("vim /srv/blob\n");
      await t.type("vim /srv/id_rsa\n");
      await t.type("vim /srv/huge\n");
    });
    const rows = s.fileRows();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.oldId === null && r.newId === null));
    assert.equal(s.contents(), 0);
  } finally { await s.close(); }
});

test("the shell stays responsive while SFTP is slow, and tracking gives up quietly", async () => {
  const s = await setup({ sftpDelayMs: 8000 });
  try {
    s.files.set("/srv/slow", Buffer.from("x\n"));
    await s.session(async (t) => {
      await t.type("vim /srv/slow\n", 600);
      const before = Date.now();
      await t.type("whoami\n", 100);
      await t.waitFor((m) => m.type === "data" && Buffer.from(m.data ?? "", "base64").toString().includes("fakeuser"), 3000);
      assert.ok(Date.now() - before < 3000, "whoami answered without waiting for SFTP");
      await new Promise((r) => setTimeout(r, 400));
    });
    assert.equal((s.db.raw.prepare("SELECT COUNT(*) n FROM memory_entries WHERE kind = 'command'").get() as any).n, 2);
  } finally { await s.close(); }
});

test("with Memory off for the host nothing is tracked or read over SFTP", async () => {
  const s = await setup();
  try {
    s.db.raw.prepare("UPDATE hosts SET memory_mode = 'off' WHERE id = ?").run(s.hostId);
    s.files.set("/srv/a", Buffer.from("1\n"));
    const t = await openTerminal(s.hostId, s.base, s.cookie);
    await t.waitFor(connected);
    await t.waitFor(memState("off"));
    await t.type("vim /srv/a\n");
    await t.end();
    assert.equal(s.fileRows().length, 0);
    assert.deepEqual(s.sftpOps, []);
  } finally { await s.close(); }
});

// ── API: timeline, detail, full versions, search, forget ─────────────────────

const get = async (s: Awaited<ReturnType<typeof setup>>, url: string, cookie = s.cookie) =>
  s.app.inject({ method: "GET", url, headers: { cookie } });
const timeline = async (s: Awaited<ReturnType<typeof setup>>, cookie = s.cookie) =>
  ((await get(s, `/api/memory/hosts/${s.hostId}/timeline`, cookie)).json() as any).data.entries as any[];

async function editedConf(s: Awaited<ReturnType<typeof setup>>) {
  s.files.set("/srv/app.conf", Buffer.from("port = 80\npassword=hunter2\n"));
  await s.session(async (t) => { await t.type("vim /srv/app.conf\n"); });
  return (await timeline(s)).find((e) => e.kind === "file");
}

test("the timeline shows a file row with the path and counts, and no diff", async () => {
  const s = await setup();
  try {
    const row = await editedConf(s);
    assert.ok(row, "a file row");
    assert.equal(row.command, "/srv/app.conf");
    assert.equal(row.change, "modified");
    assert.equal(row.added, 1);
    assert.equal(row.removed, 0);
    assert.equal(row.note, null);
    assert.equal(row.diff, undefined);
    assert.equal(row.output, undefined);
  } finally { await s.close(); }
});

test("the entry detail has the redacted diff; the full versions come from the file endpoint, unredacted", async () => {
  const s = await setup();
  try {
    const row = await editedConf(s);
    const d = ((await get(s, `/api/memory/entries/${row.id}`)).json() as any).data;
    assert.equal(d.kind, "file");
    assert.equal(d.path, "/srv/app.conf");
    assert.match(d.diff, /\+edited/);
    assert.ok(!d.diff.includes("hunter2"), "the diff is redacted");
    assert.equal(d.hasOld, true);
    assert.equal(d.hasNew, true);
    const oldV = ((await get(s, `/api/memory/entries/${row.id}/file?version=old`)).json() as any).data.content;
    const newV = ((await get(s, `/api/memory/entries/${row.id}/file?version=new`)).json() as any).data.content;
    assert.equal(oldV, "port = 80\npassword=hunter2\n", "stored versions are exactly what was on the server");
    assert.equal(newV, "port = 80\npassword=hunter2\nedited\n");
    assert.equal((await get(s, `/api/memory/entries/${row.id}/file?version=other`)).statusCode, 400);
    assert.equal((await get(s, `/api/memory/entries/nope/file?version=old`)).statusCode, 404);
  } finally { await s.close(); }
});

test("a created file has no old version; a note entry has neither", async () => {
  const s = await setup();
  try {
    s.files.set("/srv/blob", Buffer.from([0, 1, 2]));
    await s.session(async (t) => {
      await t.type("echo hello > /srv/made.txt\n");
      await t.type("vim /srv/blob\n");
    });
    const rows = (await timeline(s)).filter((e) => e.kind === "file");
    const created = rows.find((r) => r.command === "/srv/made.txt");
    const note = rows.find((r) => r.command === "/srv/blob");
    assert.equal(created.change, "created");
    assert.equal((await get(s, `/api/memory/entries/${created.id}/file?version=old`)).statusCode, 404);
    assert.equal((await get(s, `/api/memory/entries/${created.id}/file?version=new`)).statusCode, 200);
    const nd = ((await get(s, `/api/memory/entries/${note.id}`)).json() as any).data;
    assert.match(nd.note, /binary/);
    assert.equal(nd.hasOld, false);
    assert.equal(nd.hasNew, false);
    assert.equal((await get(s, `/api/memory/entries/${note.id}/file?version=new`)).statusCode, 404);
  } finally { await s.close(); }
});

test("search finds file changes by path and by diff text, and the types filter separates them", async () => {
  const s = await setup();
  try {
    s.files.set("/srv/app.conf", Buffer.from("port = 80\n"));
    await s.session(async (t) => {
      await t.type("vim /srv/app.conf\n");
      await t.type("whoami\n");
    });
    const q = async (qs: string) => ((await get(s, `/api/memory/search?${qs}`)).json() as any).data.entries as any[];
    const byPath = await q("q=app.conf");
    assert.ok(byPath.some((h) => h.kind === "file" && h.command === "/srv/app.conf" && h.file.added === 1));
    assert.ok(byPath.some((h) => h.kind === "command" && h.command === "vim /srv/app.conf"));
    assert.deepEqual((await q("q=app.conf&types=files")).map((h) => h.kind), ["file"]);
    assert.deepEqual((await q("q=app.conf&types=commands")).map((h) => h.kind), ["command"]);
    assert.equal((await q("q=edited")).length, 0, "diff text is searched only with output=1");
    assert.deepEqual((await q("q=edited&output=1&types=files")).map((h) => h.kind), ["file"]);
    assert.ok((await q("browse=1&types=files")).every((h) => h.kind === "file"));
  } finally { await s.close(); }
});

test("forgetting a file entry removes the versions only it used, keeps shared ones and the watched file's latest", async () => {
  const s = await setup();
  try {
    s.files.set("/srv/a", Buffer.from("one\n"));
    await s.session(async (t) => { await t.type("vim /srv/a\n"); });      // one → one+edited
    await s.session(async (t) => { await t.type("vim /srv/a\n"); });      // one+edited → one+edited+edited
    const rows = (await timeline(s)).filter((e) => e.kind === "file");
    assert.equal(rows.length, 2);
    assert.equal(s.contents(), 3);
    const [newer, older] = rows as [any, any];   // newest first
    // Forget the older entry: its old version ("one") is unique to it; its new version is the newer entry's old version.
    assert.equal((await s.app.inject({ method: "DELETE", url: `/api/memory/entries/${older.id}`, headers: { cookie: s.cookie } })).statusCode, 200);
    assert.equal(s.contents(), 2, "only the version nothing else uses was deleted");
    const stillThere = await get(s, `/api/memory/entries/${newer.id}/file?version=old`);
    assert.equal(stillThere.statusCode, 200);
    // Forget the newer one: its old version is now unused; its new version is the watched file's latest and stays.
    assert.equal((await s.app.inject({ method: "DELETE", url: `/api/memory/entries/${newer.id}`, headers: { cookie: s.cookie } })).statusCode, 200);
    assert.equal(s.contents(), 1);
    assert.equal((s.db.raw.prepare("SELECT COUNT(*) n FROM server_files").get() as any).n, 1);
  } finally { await s.close(); }
});

test("a backup carries the watched files and their versions, and a restore brings them back", async () => {
  const s = await setup();
  try {
    await editedConf(s);
    const backup = ((await s.app.inject({ method: "GET", url: "/api/settings/backup", headers: { cookie: s.cookie } })).json() as any).data;
    assert.equal(backup.serverFiles.length, 1);
    assert.equal(backup.fileContents.length, 2);
    assert.ok(!JSON.stringify(backup.serverFiles).includes("app.conf"), "paths stay encrypted in the backup");

    const db2 = memDb();
    const app2 = await buildApp({ config: TEST_CONFIG, db: db2 });
    const res = await app2.inject({ method: "POST", url: "/api/settings/restore", payload: backup });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((db2.raw.prepare("SELECT COUNT(*) n FROM server_files").get() as any).n, 1);
    assert.equal((db2.raw.prepare("SELECT COUNT(*) n FROM file_contents").get() as any).n, 2);
    await app2.close();
  } finally { await s.close(); }
});

test("team mode: a member sees and fetches only their own file changes; an admin sees all", async () => {
  const fake = fakeServer();
  await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  try {
    const adminCookie = cookieFrom(await app.inject({
      method: "POST", url: "/api/vault/setup", payload: { password: "admin-password-1", mode: "team", username: "admin" },
    }));
    const login = async (username: string) => {
      await app.inject({ method: "POST", url: "/api/team/users", headers: { cookie: adminCookie }, payload: { username, tempPassword: `${username}-temp-password`, isAdmin: false } });
      return cookieFrom(await app.inject({ method: "POST", url: "/api/team/login", payload: { username, password: `${username}-temp-password` } }));
    };
    const hostId = ((await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie: adminCookie },
      payload: { label: "t", hostname: "127.0.0.1", port: fake.server.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any).data.id as string;
    const bob = await login("bob");
    const carol = await login("carol");
    fake.files.set("/srv/team.conf", Buffer.from("a\n"));
    const t = await openTerminal(hostId, base, bob);
    await t.waitFor(connected);
    await t.waitFor(memState("remembering"));
    await t.type("vim /srv/team.conf\n");
    await t.end();

    const tl = async (cookie: string) =>
      ((await app.inject({ method: "GET", url: `/api/memory/hosts/${hostId}/timeline`, headers: { cookie } })).json() as any).data.entries as any[];
    const bobRow = (await tl(bob)).find((e) => e.kind === "file");
    assert.ok(bobRow, "bob sees his file change");
    assert.ok((await tl(adminCookie)).some((e) => e.kind === "file"), "an admin sees it too");
    assert.equal((await tl(carol)).length, 0);
    const fetchFile = (cookie: string) => app.inject({ method: "GET", url: `/api/memory/entries/${bobRow.id}/file?version=new`, headers: { cookie } });
    assert.equal((await fetchFile(bob)).statusCode, 200);
    assert.equal((await fetchFile(adminCookie)).statusCode, 200);
    assert.equal((await fetchFile(carol)).statusCode, 404, "another member cannot read bob's file versions");
    assert.equal((await app.inject({ method: "GET", url: `/api/memory/entries/${bobRow.id}`, headers: { cookie: carol } })).statusCode, 404);
  } finally { await app.close(); fake.server.close(); }
});

// ── Outside changes and server snapshots ─────────────────────────────────────

const snapOut = (over: Record<string, string[]> = {}) => {
  const base: Record<string, string[]> = { os: ["Ubuntu 22.04"], kernel: ["Linux 5.15.0-101"], packages: ["bash 5.1", "nginx 1.18"], services: ["ssh.service"], ports: ["0.0.0.0:22"], cron: [], docker: [] };
  return Object.entries({ ...base, ...over }).map(([k, v]) => [`@@skiff:${k}`, ...v].join("\n")).join("\n") + "\n@@skiff:end\n";
};
const putMemory = (s: Awaited<ReturnType<typeof setup>>, body: unknown, cookie = s.cookie) =>
  s.app.inject({ method: "PUT", url: `/api/hosts/${s.hostId}/memory`, headers: { cookie }, payload: body as any });
const fileRowsApi = async (s: Awaited<ReturnType<typeof setup>>) => (await timeline(s)).filter((e) => e.kind === "file");
const snapshotRuns = (s: Awaited<ReturnType<typeof setup>>) => s.execs.filter((c) => c.includes("@@skiff:end")).length;

test("a file changed on the server between sessions shows up as changed outside Skiff when the next session starts", async () => {
  const s = await setup();
  try {
    s.files.set("/srv/app.conf", Buffer.from("a\n"));
    await s.session(async (t) => { await t.type("vim /srv/app.conf\n"); });
    s.files.set("/srv/app.conf", Buffer.from("a\nedited\nsomeone else\n")); // not by Skiff
    await s.session(async (t) => { await t.type("whoami\n", 1500); });
    const rows = await fileRowsApi(s);
    const outside = rows.find((r) => r.flags.includes("outside"));
    assert.ok(outside, JSON.stringify(rows.map((r) => [r.command, r.flags])));
    assert.equal(outside.command, "/srv/app.conf");
    const d = ((await get(s, `/api/memory/entries/${outside.id}`)).json() as any).data;
    assert.match(d.diff, /\+someone else/);
    assert.equal(d.hasOld && d.hasNew, true);
  } finally { await s.close(); }
});

test("snapshots are off by default: nothing is run on the server", async () => {
  const s = await setup();
  try {
    s.box.snapshotReply = snapOut();
    await s.session(async (t) => { await t.type("whoami\n"); });
    assert.equal(snapshotRuns(s), 0);
  } finally { await s.close(); }
});

test("with snapshots on: the first run stores a baseline, an outside change in the next session is reported, an explained one is not", async () => {
  const s = await setup();
  try {
    assert.equal((await putMemory(s, { snapshots: true })).statusCode, 200);
    s.box.snapshotReply = snapOut();
    await s.session(async (t) => { await t.type("whoami\n", 1500); });
    assert.equal(snapshotRuns(s), 1);
    assert.equal((await fileRowsApi(s)).length, 0, "the first snapshot has nothing to compare with");
    assert.equal((s.db.raw.prepare("SELECT COUNT(*) n FROM server_snapshots").get() as any).n, 1);

    // Next session: packages and ports changed and nothing remembered explains them.
    s.box.snapshotReply = snapOut({ packages: ["bash 5.1", "nginx 1.24"], ports: ["0.0.0.0:22", "0.0.0.0:8080"] });
    await s.session(async (t) => { await t.type("whoami\n", 1500); });
    assert.equal(snapshotRuns(s), 2);
    const snapRows = (await fileRowsApi(s)).filter((r) => r.flags.includes("snapshot"));
    assert.deepEqual(snapRows.map((r) => r.command).sort(), ["Installed packages", "Listening ports"]);
    const pk = snapRows.find((r) => r.command === "Installed packages");
    assert.deepEqual(pk.flags, ["snapshot", "outside"]);
    assert.equal(pk.added, 1);
    assert.equal(pk.removed, 1);
    assert.match(((await get(s, `/api/memory/entries/${pk.id}`)).json() as any).data.diff, /\+nginx 1\.24/);

    // A session where the user ran an install; the next snapshot's package change is explained, cron is not.
    await s.session(async (t) => { await t.type("echo apt-get install redis > /srv/ignore\n", 800); });
    s.box.snapshotReply = snapOut({ packages: ["bash 5.1", "nginx 1.24", "redis 7"], ports: ["0.0.0.0:22", "0.0.0.0:8080"], cron: ["* * * * * job"] });
    const before = (await fileRowsApi(s)).filter((r) => r.flags.includes("snapshot")).length;
    await s.session(async (t) => { await t.type("whoami\n", 1500); });
    const after = (await fileRowsApi(s)).filter((r) => r.flags.includes("snapshot"));
    const fresh = after.slice(0, after.length - before).map((r) => r.command);
    assert.deepEqual(fresh, ["Scheduled jobs (cron)"], "packages were explained by the apt-get command; cron was not");
  } finally { await s.close(); }
});

test("a server that gives no usable snapshot gets one note, not one per session", async () => {
  const s = await setup();
  try {
    await putMemory(s, { snapshots: true });
    s.box.snapshotReply = null;
    await s.session(async (t) => { await t.type("whoami\n", 1500); });
    await s.session(async (t) => { await t.type("whoami\n", 1500); });
    const notes = (await fileRowsApi(s)).filter((r) => r.flags.includes("snapshot-failed"));
    assert.equal(notes.length, 1);
    assert.match(notes[0].note, /take a server snapshot/i);
  } finally { await s.close(); }
});

test("the host memory API takes snapshots on its own, validates it, audits it", async () => {
  const s = await setup();
  try {
    const on = (await putMemory(s, { snapshots: true })).json() as any;
    assert.equal(on.data.snapshots, true);
    assert.equal(on.data.preciseMode, false, "the other fields are left alone");
    assert.equal((await putMemory(s, { snapshots: "yes" })).statusCode, 400);
    assert.equal((await putMemory(s, {})).statusCode, 400);
    assert.equal(((await putMemory(s, { snapshots: false })).json() as any).data.snapshots, false);
  } finally { await s.close(); }
});

test("the exact snapshot commands are shown to logged-in users only, and are read-only", async () => {
  const s = await setup();
  try {
    assert.equal((await s.app.inject({ method: "GET", url: "/api/memory/snapshot-commands" })).statusCode, 401);
    const d = ((await get(s, "/api/memory/snapshot-commands")).json() as any).data;
    assert.ok(d.lines.length >= 7);
    assert.ok(d.sections.some((x: any) => x.id === "packages"));
    assert.ok(!d.lines.join("\n").includes("rm "));
  } finally { await s.close(); }
});

test("a backup carries snapshots and the per-host switches, and a restore brings them back", async () => {
  const s = await setup();
  try {
    await putMemory(s, { snapshots: true });
    s.box.snapshotReply = snapOut();
    await s.session(async (t) => { await t.type("whoami\n", 1500); });
    const backup = ((await s.app.inject({ method: "GET", url: "/api/settings/backup", headers: { cookie: s.cookie } })).json() as any).data;
    assert.equal(backup.serverSnapshots.length, 1);
    assert.ok(!JSON.stringify(backup.serverSnapshots).includes("nginx"), "snapshot contents stay encrypted in the backup");
    const db2 = memDb();
    const app2 = await buildApp({ config: TEST_CONFIG, db: db2 });
    const res = await app2.inject({ method: "POST", url: "/api/settings/restore", payload: backup });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((db2.raw.prepare("SELECT COUNT(*) n FROM server_snapshots").get() as any).n, 1);
    assert.equal((db2.raw.prepare("SELECT snapshots FROM hosts").get() as any).snapshots, 1);
    await app2.close();
  } finally { await s.close(); }
});

// ── Pin to notes ─────────────────────────────────────────────────────────────

const pin = (s: Awaited<ReturnType<typeof setup>>, id: string, cookie = s.cookie) =>
  s.app.inject({ method: "POST", url: `/api/memory/entries/${id}/pin`, headers: { cookie } });
const noteOf = async (s: Awaited<ReturnType<typeof setup>>, cookie = s.cookie) =>
  ((await get(s, `/api/hosts/${s.hostId}/notes`, cookie)).json() as any).data;

test("pinning a command adds it to the host's note without its output; pinning a file change adds the path and diff", async () => {
  const s = await setup();
  try {
    s.files.set("/srv/app.conf", Buffer.from("port = 80\n"));
    await s.session(async (t) => {
      await t.type("whoami\n", 900);
      await t.type("vim /srv/app.conf\n");
    });
    const entries = await timeline(s);
    const cmd = entries.find((e) => e.kind === "command" && e.command === "whoami");
    const file = entries.find((e) => e.kind === "file");
    const first = (await pin(s, cmd.id)).json() as any;
    assert.equal(first.ok, true);
    assert.equal(first.data.hostId, s.hostId);
    assert.equal(first.data.version, 1);
    assert.match(first.data.text, /^\$ whoami\n  \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    assert.ok(!first.data.text.includes("fakeuser"), "the command's output is never pinned");
    const second = (await pin(s, file.id)).json() as any;
    assert.equal(second.data.version, 2);
    const note = await noteOf(s);
    assert.match(note.text, /\n\n✎ \/srv\/app\.conf \(modified, \+1 −0\)\n/);
    assert.match(note.text, /\n    \+edited/);
    assert.equal((await pin(s, "nope")).statusCode, 404);
    assert.equal((await s.app.inject({ method: "POST", url: `/api/memory/entries/${cmd.id}/pin` })).statusCode, 401);
  } finally { await s.close(); }
});

test("team: a member can pin only their own entries", async () => {
  const fake = fakeServer();
  await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `127.0.0.1:${(app.server.address() as any).port}`;
  try {
    const adminCookie = cookieFrom(await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "admin-password-1", mode: "team", username: "admin" } }));
    const login = async (username: string) => {
      await app.inject({ method: "POST", url: "/api/team/users", headers: { cookie: adminCookie }, payload: { username, tempPassword: `${username}-temp-password`, isAdmin: false } });
      return cookieFrom(await app.inject({ method: "POST", url: "/api/team/login", payload: { username, password: `${username}-temp-password` } }));
    };
    const hostId = ((await app.inject({
      method: "POST", url: "/api/hosts", headers: { cookie: adminCookie },
      payload: { label: "t", hostname: "127.0.0.1", port: fake.server.address().port, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
    })).json() as any).data.id as string;
    const bob = await login("bob");
    const carol = await login("carol");
    const t = await openTerminal(hostId, base, bob);
    await t.waitFor(connected);
    await t.waitFor(memState("remembering"));
    await t.type("whoami\n", 900);
    await t.end();
    const entry = (((await app.inject({ method: "GET", url: `/api/memory/hosts/${hostId}/timeline`, headers: { cookie: bob } })).json() as any).data.entries as any[]).find((e) => e.command === "whoami");
    const doPin = (cookie: string) => app.inject({ method: "POST", url: `/api/memory/entries/${entry.id}/pin`, headers: { cookie } });
    assert.equal((await doPin(carol)).statusCode, 404);
    assert.equal((await doPin(bob)).statusCode, 200);
    assert.equal((await doPin(adminCookie)).statusCode, 200);
  } finally { await app.close(); fake.server.close(); }
});
