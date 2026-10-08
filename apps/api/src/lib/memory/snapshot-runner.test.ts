import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runColumnMigrations } from "../../db/client.js";
import { newDataKey } from "../../crypto/data-keys.js";
import { beginMemorySession, saveFileEntry } from "./store.js";
import { execOnce } from "./exec-once.js";
import { runSnapshot, commandsSince } from "./snapshot-runner.js";
import { SNAPSHOT_COMMAND, latestSnapshot } from "./snapshot.js";
import type { FileEntryInput } from "./file-tracker.js";

const here = dirname(fileURLToPath(import.meta.url));

function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(readFileSync(join(here, "../../db/schema.sql"), "utf-8"));
  runColumnMigrations(d);
  d.prepare("INSERT INTO hosts (id,label,hostname,port,username,auth_method,created_at) VALUES ('h1','prod','10.0.0.1',22,'deploy','password','then')").run();
  d.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES ('key1', x'00', x'00', 'then')").run();
  d.prepare("INSERT INTO servers (id, fingerprint, algorithm, first_seen_at, file_key_wrapped, file_key_nonce) VALUES ('srv1', 'fp', 'ssh-ed25519', 'then', x'00', x'00')").run();
  return d;
}

const out = (over: Record<string, string[]> = {}) => {
  const base: Record<string, string[]> = {
    os: ["Ubuntu 22.04"], kernel: ["Linux 5.15.0-101"], packages: ["bash 5.1", "nginx 1.18"], services: ["ssh.service"],
    ports: ["0.0.0.0:22"], cron: [], docker: [],
  };
  const merged = { ...base, ...over };
  return Object.entries(merged).map(([k, v]) => [`@@skiff:${k}`, ...v].join("\n")).join("\n") + "\n@@skiff:end\n";
};

function setup(opts: { reply?: (cmd: string) => string | null; commands?: string[] } = {}) {
  const db = freshDb();
  const key = newDataKey();
  const saved: FileEntryInput[] = [];
  const execs: Array<{ cmd: string; timeout: number }> = [];
  let reply = opts.reply ?? (() => out());
  const run = (commands: string[] = opts.commands ?? []) => runSnapshot({
    db, fileKey: key, serverId: "srv1",
    exec: async (cmd, timeout) => { execs.push({ cmd, timeout }); return reply(cmd); },
    recentCommands: commands,
    save: (e) => saved.push(e),
  });
  return { db, key, saved, execs, run, setReply: (r: (cmd: string) => string | null) => { reply = r; } };
}

test("the first snapshot is stored and reports nothing; it runs the fixed command with a 10 second limit", async () => {
  const s = setup();
  assert.equal(await s.run(), "first");
  assert.equal(s.saved.length, 0);
  assert.equal(s.execs.length, 1);
  assert.equal(s.execs[0]!.cmd, SNAPSHOT_COMMAND);
  assert.equal(s.execs[0]!.timeout, 10_000);
  assert.ok(latestSnapshot(s.db, s.key, "srv1"));
});

test("an unchanged server reports nothing and still stores the new snapshot", async () => {
  const s = setup();
  await s.run();
  assert.equal(await s.run(), "unchanged");
  assert.equal(s.saved.length, 0);
  assert.equal((s.db.prepare("SELECT COUNT(*) n FROM server_snapshots").get() as any).n, 2);
});

test("changes nobody explained become 'changed outside Skiff' entries, one per section", async () => {
  const s = setup();
  await s.run();
  s.setReply(() => out({ packages: ["bash 5.1", "nginx 1.24"], ports: ["0.0.0.0:22", "0.0.0.0:8080"] }));
  assert.equal(await s.run(["ls", "whoami"]), "changed");
  assert.deepEqual(s.saved.map((e) => e.path).sort(), ["Installed packages", "Listening ports"]);
  const pk = s.saved.find((e) => e.path === "Installed packages")!;
  assert.deepEqual(pk.flags, ["snapshot", "outside"]);
  assert.equal(pk.change, "modified");
  assert.equal(pk.added, 1);
  assert.equal(pk.removed, 1);
  assert.match(pk.diff, /\+nginx 1\.24/);
  assert.equal(pk.command, "");
  assert.equal(pk.oldContentId, null);
  assert.equal(pk.newContentId, null);
  assert.equal(pk.note, null);
});

test("sections a remembered command explains are not reported, others still are", async () => {
  const s = setup();
  await s.run();
  s.setReply(() => out({ packages: ["bash 5.1", "nginx 1.24"], cron: ["0 3 * * * x"] }));
  await s.run(["sudo apt-get install -y nginx"]);
  assert.deepEqual(s.saved.map((e) => e.path), ["Scheduled jobs (cron)"]);
});

test("a failed or cut-off run is skipped and noted once, until a snapshot succeeds again", async () => {
  const s = setup({ reply: () => null });
  assert.equal(await s.run(), "failed");
  assert.equal(s.saved.length, 1);
  assert.match(s.saved[0]!.note ?? "", /couldn't take a server snapshot/i);
  assert.deepEqual(s.saved[0]!.flags, ["snapshot", "snapshot-failed"]);
  // The tracker's save() writes the entry; mimic it so "already noted" can be seen in the db.
  const sid = beginMemorySession(s.db, { serverId: "srv1", hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  const note = (at: number) => saveFileEntry(s.db, s.key, {
    memorySessionId: sid, serverId: "srv1", userId: null, path: "Server snapshot", diff: "",
    meta: { change: "modified", added: 0, removed: 0, note: "x", by: "" }, flags: ["snapshot", "snapshot-failed"], oldContentId: null, newContentId: null, startedAt: at,
  });
  note(Date.now());
  assert.equal(await s.run(), "failed");
  assert.equal(s.saved.length, 1, "no second note");
  s.setReply(() => "Welcome!\nno markers here\n");   // not our output
  assert.equal(await s.run(), "failed");
  assert.equal(s.saved.length, 1);
  s.setReply(() => out());
  assert.equal(await s.run(), "first", "a good run stores a snapshot again");
  s.setReply(() => null);
  assert.equal(await s.run(), "failed");
  assert.equal(s.saved.length, 2, "after a success, the next failure is noted again");
});

test("an exec that throws is a failure, not a crash", async () => {
  const s = setup();
  const result = await runSnapshot({
    db: s.db, fileKey: s.key, serverId: "srv1", exec: async () => { throw new Error("channel refused"); },
    recentCommands: [], save: (e) => s.saved.push(e),
  });
  assert.equal(result, "failed");
});

test("commandsSince decrypts the remembered commands on a server after a point in time", async () => {
  const db = freshDb();
  const { sealEntry, newDataKey: nk } = await import("../../crypto/data-keys.js");
  void sealEntry; void nk;
  // Seed one real command entry through the store, sealed under a session key wrapped with a vault key.
  const { wrapDataKey } = await import("../../crypto/data-keys.js");
  const vaultKey = newDataKey();
  const dataKey = newDataKey();
  const w = wrapDataKey(dataKey, vaultKey);
  db.prepare("UPDATE session_keys SET wrapped_key = ?, nonce = ? WHERE id = 'key1'").run(w.wrapped, w.nonce);
  const sid = beginMemorySession(db, { serverId: "srv1", hostId: "h1", userId: null, username: null, keyId: "key1", recordingId: null });
  const { saveCommandEntry } = await import("./store.js");
  const ev = (command: string, startedAt: number) => ({ command, output: "", cwd: null, exitCode: 0, confidence: "screen", flags: [], outputBytes: 0, outputPruned: false, startedAt, ended: "exited" as const });
  saveCommandEntry(db, dataKey, { memorySessionId: sid, serverId: "srv1", userId: null, event: ev("apt update", Date.parse("2026-10-01T00:00:00Z")) as any });
  saveCommandEntry(db, dataKey, { memorySessionId: sid, serverId: "srv1", userId: null, event: ev("systemctl restart nginx", Date.parse("2026-10-03T00:00:00Z")) as any });
  assert.deepEqual(commandsSince(db, vaultKey, "srv1", "2026-10-02T00:00:00Z"), ["systemctl restart nginx"]);
  assert.deepEqual(commandsSince(db, vaultKey, "srv1", null).sort(), ["apt update", "systemctl restart nginx"]);
  assert.deepEqual(commandsSince(db, newDataKey(), "srv1", null), [], "a wrong key reads nothing");
  assert.deepEqual(commandsSince(db, vaultKey, "other-server", null), []);
});

test("execOnce collects output and closes; it gives up on a stuck channel and on errors", async () => {
  const fakeSsh = (behavior: "ok" | "stuck" | "error" | "throw") => ({
    exec(cmd: string, cb: (err: Error | undefined, stream: any) => void) {
      if (behavior === "throw") throw new Error("not connected");
      if (behavior === "error") return cb(new Error("refused"), undefined as any);
      const handlers: Record<string, (x?: any) => void> = {};
      const stream = { on(ev: string, fn: (x?: any) => void) { handlers[ev] = fn; return stream; }, close() { stream.closed = true; }, closed: false } as any;
      cb(undefined, stream);
      if (behavior === "ok") setImmediate(() => { handlers.data?.(Buffer.from("hello ")); handlers.data?.(Buffer.from(`${cmd}\n`)); handlers.close?.(); });
      return stream;
    },
  });
  assert.equal(await execOnce(fakeSsh("ok") as any, "ls", 1000), "hello ls\n");
  assert.equal(await execOnce(fakeSsh("stuck") as any, "ls", 50), null);
  assert.equal(await execOnce(fakeSsh("error") as any, "ls", 1000), null);
  assert.equal(await execOnce(fakeSsh("throw") as any, "ls", 1000), null);
});
