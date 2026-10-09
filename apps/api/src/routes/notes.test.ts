import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildApp } from "../app.js";
import { runColumnMigrations } from "../db/client.js";

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
const newHost = async (app: any, cookie: string, label = "t") =>
  ((await app.inject({
    method: "POST", url: "/api/hosts", headers: { cookie },
    payload: { label, hostname: "10.0.0.1", port: 22, username: "u", authMethod: "password", credential: { kind: "password", value: "pw" } },
  })).json() as any).data.id as string;

async function personal() {
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  const cookie = cookieFrom(await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "master-pass-1" } }));
  return { app, db, cookie, hostId: await newHost(app, cookie) };
}
async function team() {
  const db = memDb();
  const app = await buildApp({ config: TEST_CONFIG, db });
  const adminCookie = cookieFrom(await app.inject({ method: "POST", url: "/api/vault/setup", payload: { password: "admin-password-1", mode: "team", username: "admin" } }));
  const login = async (username: string) => {
    await app.inject({ method: "POST", url: "/api/team/users", headers: { cookie: adminCookie }, payload: { username, tempPassword: `${username}-temp-password`, isAdmin: false } });
    return cookieFrom(await app.inject({ method: "POST", url: "/api/team/login", payload: { username, password: `${username}-temp-password` } }));
  };
  return { app, db, adminCookie, login, hostId: await newHost(app, adminCookie) };
}
const putNoteReq = (s: { app: any; hostId: string }, cookie: string, body: unknown) =>
  s.app.inject({ method: "PUT", url: `/api/hosts/${s.hostId}/notes`, headers: { cookie }, payload: body });
const getNoteReq = (s: { app: any; hostId: string }, cookie: string) =>
  s.app.inject({ method: "GET", url: `/api/hosts/${s.hostId}/notes`, headers: { cookie } });

test("notes need an unlocked vault and an existing host", async () => {
  const s = await personal();
  assert.equal((await s.app.inject({ method: "GET", url: `/api/hosts/${s.hostId}/notes` })).statusCode, 401);
  assert.equal((await s.app.inject({ method: "PUT", url: `/api/hosts/${s.hostId}/notes`, payload: { text: "x", baseVersion: 0 } })).statusCode, 401);
  assert.equal((await s.app.inject({ method: "GET", url: "/api/hosts/nope/notes", headers: { cookie: s.cookie } })).statusCode, 404);
  assert.equal((await s.app.inject({ method: "PUT", url: "/api/hosts/nope/notes", headers: { cookie: s.cookie }, payload: { text: "x", baseVersion: 0 } })).statusCode, 404);
  await s.app.close();
});

test("a note round-trips, versions advance, a stale save is a 409 with the current text, and bad input is a 400", async () => {
  const s = await personal();
  const empty = (await getNoteReq(s, s.cookie)).json() as any;
  assert.deepEqual([empty.data.text, empty.data.version], ["", 0]);
  const a = (await putNoteReq(s, s.cookie, { text: "restart: systemctl restart app", baseVersion: 0 })).json() as any;
  assert.equal(a.data.version, 1);
  assert.equal((await getNoteReq(s, s.cookie)).json<any>().data.text, "restart: systemctl restart app");
  const stale = await putNoteReq(s, s.cookie, { text: "mine", baseVersion: 0 });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json<any>().error.current.text, "restart: systemctl restart app");
  assert.equal((await putNoteReq(s, s.cookie, { text: "v2", baseVersion: 1 })).json<any>().data.version, 2);
  assert.equal((await putNoteReq(s, s.cookie, { text: 5, baseVersion: 2 })).statusCode, 400);
  assert.equal((await putNoteReq(s, s.cookie, { text: "x", baseVersion: -1 })).statusCode, 400);
  assert.equal((await putNoteReq(s, s.cookie, { text: "x".repeat(100_001), baseVersion: 2 })).statusCode, 413);
  await s.app.close();
});

test("saving a note is audited by length only", async () => {
  const s = await team();
  await putNoteReq(s, s.adminCookie, { text: "the root password is hunter2", baseVersion: 0 });
  const rows = s.db.raw.prepare("SELECT detail FROM audit_log WHERE action = 'host.notes'").all() as any[];
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].detail), { length: 28, version: 1 });
  await s.app.close();
});

test("team: members share one note per host and the last editor is shown", async () => {
  const s = await team();
  const bob = await s.login("bob");
  await putNoteReq(s, bob, { text: "from bob", baseVersion: 0 });
  const seen = (await getNoteReq(s, s.adminCookie)).json<any>().data;
  assert.equal(seen.text, "from bob");
  assert.equal(seen.updatedBy, "bob");
  await s.app.close();
});

test("snippets: create, list, edit, delete; validation; locked vault refused", async () => {
  const s = await personal();
  const post = (body: unknown) => s.app.inject({ method: "POST", url: "/api/snippets", headers: { cookie: s.cookie }, payload: body as any });
  assert.equal((await s.app.inject({ method: "GET", url: "/api/snippets" })).statusCode, 401);
  assert.equal((await post({ name: "", command: "ls" })).statusCode, 400);
  assert.equal((await post({ name: "x", command: "" })).statusCode, 400);
  assert.equal((await post({ name: "x".repeat(101), command: "ls" })).statusCode, 400);
  assert.equal((await post({ name: "x", command: "y".repeat(4001) })).statusCode, 400);
  const a = (await post({ name: "  disk usage ", command: "df -h" })).json<any>().data;
  assert.equal(a.name, "disk usage");
  assert.equal(a.by, null, "personal mode shows no author");
  const list = (await s.app.inject({ method: "GET", url: "/api/snippets", headers: { cookie: s.cookie } })).json<any>().data.snippets;
  assert.deepEqual(list.map((x: any) => x.command), ["df -h"]);
  const put = (id: string, body: unknown) => s.app.inject({ method: "PUT", url: `/api/snippets/${id}`, headers: { cookie: s.cookie }, payload: body as any });
  assert.equal((await put(a.id, { name: "disk" })).json<any>().data.command, "df -h");
  assert.equal((await put(a.id, {})).statusCode, 400);
  assert.equal((await put("snip_nope", { name: "z" })).statusCode, 404);
  assert.equal((await s.app.inject({ method: "DELETE", url: `/api/snippets/${a.id}`, headers: { cookie: s.cookie } })).statusCode, 200);
  assert.equal((await s.app.inject({ method: "DELETE", url: `/api/snippets/${a.id}`, headers: { cookie: s.cookie } })).statusCode, 404);
  await s.app.close();
});

test("team snippets: shared library with authors; only the author or an admin can change one", async () => {
  const s = await team();
  const bob = await s.login("bob");
  const carol = await s.login("carol");
  const created = (await s.app.inject({ method: "POST", url: "/api/snippets", headers: { cookie: bob }, payload: { name: "mine", command: "uptime" } })).json<any>().data;
  assert.equal(created.by, "bob");
  const asCarol = (await s.app.inject({ method: "GET", url: "/api/snippets", headers: { cookie: carol } })).json<any>().data.snippets;
  assert.equal(asCarol.length, 1, "everyone sees the shared library");
  assert.equal((await s.app.inject({ method: "PUT", url: `/api/snippets/${created.id}`, headers: { cookie: carol }, payload: { name: "hijack" } })).statusCode, 403);
  assert.equal((await s.app.inject({ method: "DELETE", url: `/api/snippets/${created.id}`, headers: { cookie: carol } })).statusCode, 403);
  assert.equal((await s.app.inject({ method: "PUT", url: `/api/snippets/${created.id}`, headers: { cookie: bob }, payload: { name: "renamed" } })).statusCode, 200);
  assert.equal((await s.app.inject({ method: "DELETE", url: `/api/snippets/${created.id}`, headers: { cookie: s.adminCookie } })).statusCode, 200);
  await s.app.close();
});

test("a personal password change keeps notes and snippets readable", async () => {
  const s = await personal();
  await putNoteReq(s, s.cookie, { text: "survives a password change", baseVersion: 0 });
  await s.app.inject({ method: "POST", url: "/api/snippets", headers: { cookie: s.cookie }, payload: { name: "n", command: "whoami" } });
  const res = await s.app.inject({ method: "PUT", url: "/api/settings/password", headers: { cookie: s.cookie }, payload: { currentPassword: "master-pass-1", newPassword: "another-pass-2" } });
  assert.equal(res.statusCode, 200, res.body);
  const fresh = cookieFrom(res);
  assert.equal((await getNoteReq(s, fresh)).json<any>().data.text, "survives a password change");
  assert.equal((await s.app.inject({ method: "GET", url: "/api/snippets", headers: { cookie: fresh } })).json<any>().data.snippets[0].command, "whoami");
  await s.app.close();
});

test("a backup carries notes and snippets still sealed, and a restore brings them back", async () => {
  const s = await personal();
  await putNoteReq(s, s.cookie, { text: "prod notes with a secret", baseVersion: 0 });
  await s.app.inject({ method: "POST", url: "/api/snippets", headers: { cookie: s.cookie }, payload: { name: "named thing", command: "mysql -pSECRET" } });
  const backup = ((await s.app.inject({ method: "GET", url: "/api/settings/backup", headers: { cookie: s.cookie } })).json() as any).data;
  assert.equal(backup.hostNotes.length, 1);
  assert.equal(backup.snippets.length, 1);
  const flat = JSON.stringify([backup.hostNotes, backup.snippets]);
  assert.ok(!flat.includes("secret") && !flat.includes("SECRET") && !flat.includes("named thing"));
  const db2 = memDb();
  const app2 = await buildApp({ config: TEST_CONFIG, db: db2 });
  assert.equal((await app2.inject({ method: "POST", url: "/api/settings/restore", payload: backup })).statusCode, 200);
  const unlock = await app2.inject({ method: "POST", url: "/api/vault/unlock", payload: { password: "master-pass-1" } });
  const c2 = cookieFrom(unlock);
  assert.equal((await app2.inject({ method: "GET", url: `/api/hosts/${s.hostId}/notes`, headers: { cookie: c2 } })).json<any>().data.text, "prod notes with a secret");
  assert.equal((await app2.inject({ method: "GET", url: "/api/snippets", headers: { cookie: c2 } })).json<any>().data.snippets[0].command, "mysql -pSECRET");
  await app2.close();
  await s.app.close();
});
