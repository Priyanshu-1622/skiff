import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runColumnMigrations } from "../../db/client.js";
import { newDataKey } from "../../crypto/data-keys.js";
import { FileTracker, type FileEntryInput, type FileReader, type ReadResult } from "./file-tracker.js";
import { getContent, lastContentId, watchedPaths } from "./file-store.js";

const here = dirname(fileURLToPath(import.meta.url));

function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(readFileSync(join(here, "../../db/schema.sql"), "utf-8"));
  runColumnMigrations(d);
  d.prepare("INSERT INTO servers (id, fingerprint, algorithm, first_seen_at, file_key_wrapped, file_key_nonce) VALUES ('srv1', 'fp', 'ssh-ed25519', 'then', x'00', x'00')").run();
  return d;
}

/** An in-memory filesystem behind the FileReader interface. */
class FakeFs implements FileReader {
  files = new Map<string, Buffer | ReadResult>();
  reads: string[] = [];
  homeDir: string | null = "/home/u";
  throwOn: string | null = null;
  set(path: string, text: string | Buffer) { this.files.set(path, typeof text === "string" ? Buffer.from(text) : text); }
  remove(path: string) { this.files.delete(path); }
  async home() { return this.homeDir; }
  async read(path: string): Promise<ReadResult> {
    this.reads.push(path);
    if (this.throwOn === path) throw new Error("sftp exploded");
    const v = this.files.get(path);
    if (v === undefined) return { kind: "missing" };
    if (Buffer.isBuffer(v)) return { kind: "file", bytes: v, resolvedPath: path };
    return v;
  }
}

function setup(opts: { fs?: FakeFs; db?: Database.Database; key?: Buffer } = {}) {
  const db = opts.db ?? freshDb();
  const key = opts.key ?? newDataKey();
  const fs = opts.fs ?? new FakeFs();
  const saved: FileEntryInput[] = [];
  const tracker = new FileTracker({ db, fileKey: key, serverId: "srv1", reader: fs, save: (e) => saved.push(e) });
  /** Run one command: baseline read at start, `mutate` stands for the command itself, re-read at finish. */
  async function run(command: string, mutate: () => void, cwd: string | null = "/srv", extra: { ended?: "exited" | "running"; exitCode?: number | null } = {}) {
    tracker.onStart({ command, cwd });
    await tracker.settled();
    mutate();
    await tracker.onFinish({ command, startedAt: 1234, ended: extra.ended ?? "exited", exitCode: extra.exitCode ?? 0 });
  }
  return { db, key, fs, saved, tracker, run };
}

test("a modified file produces one entry with the diff, counts and both versions stored", async () => {
  const { fs, saved, run, db, key } = setup();
  fs.set("/srv/app.conf", "port = 80\nname = a\n");
  await run("vim /srv/app.conf", () => fs.set("/srv/app.conf", "port = 8080\nname = a\n"));
  assert.equal(saved.length, 1);
  const e = saved[0]!;
  assert.equal(e.path, "/srv/app.conf");
  assert.equal(e.change, "modified");
  assert.equal(e.added, 1);
  assert.equal(e.removed, 1);
  assert.match(e.diff, /-port = 80/);
  assert.match(e.diff, /\+port = 8080/);
  assert.equal(e.note, null);
  assert.equal(e.command, "vim /srv/app.conf");
  assert.equal(e.startedAt, 1234);
  assert.equal(getContent(db, key, e.oldContentId!), "port = 80\nname = a\n");
  assert.equal(getContent(db, key, e.newContentId!), "port = 8080\nname = a\n");
  assert.deepEqual(watchedPaths(db, key, "srv1"), ["/srv/app.conf"]);
});

test("opening a file and quitting without changes produces nothing", async () => {
  const { fs, saved, run } = setup();
  fs.set("/srv/app.conf", "same\n");
  await run("vim /srv/app.conf", () => {});
  assert.equal(saved.length, 0);
});

test("a created file and a deleted file are reported as such", async () => {
  const { fs, saved, run } = setup();
  await run("echo hi > /srv/new.txt", () => fs.set("/srv/new.txt", "hi\n"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.change, "created");
  assert.equal(saved[0]!.oldContentId, null);
  assert.ok(saved[0]!.newContentId);
  assert.equal(saved[0]!.added, 1);
  await run("sed -i s/x/y/ /srv/new.txt", () => fs.remove("/srv/new.txt"));
  assert.equal(saved.length, 2);
  assert.equal(saved[1]!.change, "deleted");
  assert.equal(saved[1]!.newContentId, null);
  assert.ok(saved[1]!.oldContentId);
  assert.equal(saved[1]!.removed, 1);
});

test("missing both before and after produces no entry and nothing is remembered", async () => {
  const { fs, saved, run, db, key } = setup();
  await run("vim /srv/never.txt", () => {});
  assert.equal(saved.length, 0);
  assert.equal(lastContentId(db, key, "srv1", "/srv/never.txt"), undefined);
  assert.ok(fs.reads.length >= 2);
});

test("the baseline carries across commands in a session without re-reading the store", async () => {
  const { fs, saved, run } = setup();
  fs.set("/srv/a", "1\n");
  await run("vim /srv/a", () => fs.set("/srv/a", "2\n"));
  // Changed behind Skiff's back between commands: the next edit's baseline is what Skiff last saw, so that change shows up too.
  fs.set("/srv/a", "3\n");
  await run("vim /srv/a", () => fs.set("/srv/a", "4\n"));
  assert.equal(saved.length, 2);
  assert.match(saved[1]!.diff, /-2/);
  assert.match(saved[1]!.diff, /\+4/);
});

test("a baseline from a previous session is read from the store; an unseen file gets a first-sight baseline flagged", async () => {
  const first = setup();
  first.fs.set("/srv/a", "old\n");
  await first.run("vim /srv/a", () => first.fs.set("/srv/a", "mid\n"));
  // New session, same db and key: someone edited the file outside Skiff in between.
  const fs2 = new FakeFs();
  fs2.set("/srv/a", "outside\n");
  const second = setup({ db: first.db, key: first.key, fs: fs2 });
  await second.run("vim /srv/a", () => fs2.set("/srv/a", "after\n"));
  assert.equal(second.saved.length, 1);
  assert.match(second.saved[0]!.diff, /-mid/, "baseline is what Skiff stored, not what the server held at start");
  assert.deepEqual(second.saved[0]!.flags, []);

  const third = setup();
  third.fs.set("/srv/b", "x\n");
  await third.run("vim /srv/b", () => third.fs.set("/srv/b", "y\n"));
  assert.deepEqual(third.saved[0]!.flags, ["baseline-during-edit"]);
});

test("sensitive, binary, too-large, denied and not-a-file produce a note and never content", async () => {
  const { fs, saved, run, db } = setup();
  fs.set("/srv/key.pem", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n");
  fs.set("/srv/blob", Buffer.from([1, 2, 0, 3]));
  fs.set("/srv/huge", { kind: "too-large", size: 999999 });
  fs.set("/srv/locked", { kind: "denied" });
  fs.set("/srv/dir", { kind: "not-file" });
  fs.set("/etc/shadow", "root:$6$abc:1:0\n");
  const cases: [string, RegExp][] = [
    ["vim /srv/key.pem", /sensitive/],
    ["vim /srv/blob", /binary/],
    ["vim /srv/huge", /too large/],
    ["vim /srv/locked", /permission denied/],
    ["vim /srv/dir", /not a regular file/],
    ["vim /etc/shadow", /sensitive/],
  ];
  for (const [cmd, re] of cases) {
    const before = saved.length;
    await run(cmd, () => {});
    assert.equal(saved.length, before + 1, cmd);
    const e = saved[saved.length - 1]!;
    assert.match(e.note ?? "", re, cmd);
    assert.equal(e.diff, "");
    assert.equal(e.oldContentId, null);
    assert.equal(e.newContentId, null);
  }
  assert.equal((db.prepare("SELECT COUNT(*) n FROM file_contents").get() as any).n, 0, "no content stored for any of them");
  // The shadow-like path is never even read.
  assert.ok(!fs.reads.includes("/etc/shadow"));
});

test("a file that becomes sensitive during the command yields a note, not a diff", async () => {
  const { fs, saved, run } = setup();
  fs.set("/srv/c", "plain\n");
  await run("vim /srv/c", () => fs.set("/srv/c", "-----BEGIN RSA PRIVATE KEY-----\nzzz\n"));
  assert.equal(saved.length, 1);
  assert.match(saved[0]!.note ?? "", /sensitive/);
  assert.equal(saved[0]!.diff, "");
});

test("~/ expands through the reader, and a relative path without a cwd is resolved against home and flagged", async () => {
  const { fs, saved, run } = setup();
  fs.set("/home/u/.bashrc", "a\n");
  fs.set("/home/u/notes.txt", "n1\n");
  await run("vim ~/.bashrc", () => fs.set("/home/u/.bashrc", "b\n"));
  assert.equal(saved[0]!.path, "/home/u/.bashrc");
  assert.ok(!saved[0]!.flags.includes("assumed-home"), "~/ is exact, not assumed");
  await run("vim notes.txt", () => fs.set("/home/u/notes.txt", "n2\n"), null);
  assert.equal(saved[1]!.path, "/home/u/notes.txt");
  assert.ok(saved[1]!.flags.includes("assumed-home"));
});

test("without a known home, ~ and cwd-less relative paths are skipped quietly", async () => {
  const { fs, saved, run } = setup();
  fs.homeDir = null;
  await run("vim ~/x", () => {});
  await run("vim y", () => {}, null);
  assert.equal(saved.length, 0);
  assert.equal(fs.reads.length, 0);
});

test("several paths in one command are all tracked, capped at five", async () => {
  const { fs, saved, run } = setup();
  const names = ["a", "b", "c", "d", "e", "f", "g"];
  for (const n of names) fs.set(`/srv/${n}`, "1\n");
  await run(`cp ${names.map((n) => `/srv/${n}`).join(" ")} /srv/d`, () => { for (const n of names) fs.set(`/srv/${n}`, "2\n"); });
  assert.ok(saved.length >= 1 && saved.length <= 5);
  const run2 = await (async () => {
    const t = setup();
    for (const n of names) t.fs.set(`/srv/${n}`, "1\n");
    await t.run("vim /srv/a; vim /srv/b; vim /srv/c", () => { for (const n of ["a", "b", "c"]) t.fs.set(`/srv/${n}`, "2\n"); });
    return t.saved.map((e) => e.path).sort();
  })();
  assert.deepEqual(run2, ["/srv/a", "/srv/b", "/srv/c"]);
});

test("finishes that are still running are ignored; a second start replaces the first", async () => {
  const { fs, saved, run, tracker } = setup();
  fs.set("/srv/a", "1\n");
  fs.set("/srv/b", "1\n");
  await run("vim /srv/a", () => fs.set("/srv/a", "2\n"), "/srv", { ended: "running" });
  assert.equal(saved.length, 0);
  tracker.onStart({ command: "vim /srv/a", cwd: "/srv" });
  await run("vim /srv/b", () => { fs.set("/srv/a", "3\n"); fs.set("/srv/b", "2\n"); });
  assert.deepEqual(saved.map((e) => e.path), ["/srv/b"], "only the command that finished is tracked");
});

test("a finish without a matching start does nothing", async () => {
  const { saved, tracker } = setup();
  await tracker.onFinish({ command: "vim /srv/a", startedAt: 1, ended: "exited", exitCode: 0 });
  assert.equal(saved.length, 0);
});

test("reader errors and a throwing save never throw out of the tracker", async () => {
  const { fs, run, saved } = setup();
  fs.set("/srv/a", "1\n");
  fs.throwOn = "/srv/a";
  await run("vim /srv/a", () => {});
  assert.equal(saved.length, 0);
  fs.throwOn = null;
  const db = freshDb();
  const t = new FileTracker({ db, fileKey: newDataKey(), serverId: "srv1", reader: fs, save: () => { throw new Error("db full"); } });
  t.onStart({ command: "vim /srv/a", cwd: "/srv" });
  await t.settled();
  fs.set("/srv/a", "2\n");
  await t.onFinish({ command: "vim /srv/a", startedAt: 1, ended: "exited", exitCode: 0 });
});

test("diffs are redacted line by line while the stored full versions keep the text", async () => {
  const { fs, saved, run, db, key } = setup();
  fs.set("/srv/env", "user=bob\npassword=hunter2\n");
  await run("vim /srv/env", () => fs.set("/srv/env", "user=bob\npassword=hunter3\n"));
  const e = saved[0]!;
  assert.ok(!e.diff.includes("hunter2") && !e.diff.includes("hunter3"), e.diff);
  assert.match(e.diff, /password/);
  assert.equal(getContent(db, key, e.oldContentId!), "user=bob\npassword=hunter2\n");
  assert.equal(getContent(db, key, e.newContentId!), "user=bob\npassword=hunter3\n");
});

test("the command text in the entry is redacted", async () => {
  const { fs, saved, run } = setup();
  await run("echo token=abc123secret > /srv/t", () => fs.set("/srv/t", "x\n"));
  assert.equal(saved.length, 1);
  assert.ok(!saved[0]!.command.includes("abc123secret"), saved[0]!.command);
});

// ── checkWatched: changes made outside Skiff since the last session ──────────

test("checkWatched notices a previously deleted file recreated outside Skiff, including an empty file", async () => {
  for (const text of ["recreated\n", ""]) {
    const first = setup();
    first.fs.set("/srv/a", "old\n");
    await first.run("vim /srv/a", () => first.fs.remove("/srv/a"));
    const fs2 = new FakeFs();
    fs2.set("/srv/a", text);
    const second = setup({ db: first.db, key: first.key, fs: fs2 });
    await second.tracker.checkWatched();
    assert.equal(second.saved.length, 1);
    const entry = second.saved[0]!;
    assert.equal(entry.change, "created");
    assert.equal(entry.oldContentId, null);
    assert.equal(getContent(second.db, second.key, entry.newContentId!), text);
    await second.tracker.checkWatched();
    assert.equal(second.saved.length, 1, "the recreated baseline is remembered");
  }
});

test("checkWatched reports a file that differs from the stored version, flagged outside, and moves the baseline", async () => {
  const first = setup();
  first.fs.set("/srv/a", "one\n");
  await first.run("vim /srv/a", () => first.fs.set("/srv/a", "two\n")); // the store now holds "two"
  const fs2 = new FakeFs();
  fs2.set("/srv/a", "two\nsomeone else was here\n");
  const second = setup({ db: first.db, key: first.key, fs: fs2 });
  await second.tracker.checkWatched();
  assert.equal(second.saved.length, 1);
  const e = second.saved[0]!;
  assert.equal(e.path, "/srv/a");
  assert.equal(e.change, "modified");
  assert.deepEqual(e.flags, ["outside"]);
  assert.match(e.diff, /\+someone else was here/);
  assert.equal(e.command, "");
  assert.equal(getContent(second.db, second.key, e.oldContentId!), "two\n");
  assert.equal(getContent(second.db, second.key, e.newContentId!), "two\nsomeone else was here\n");
  assert.equal(lastContentId(second.db, second.key, "srv1", "/srv/a"), e.newContentId, "the stored version moved on, so the next session won't report it again");
  // The next command's baseline is what was just seen, so its diff doesn't repeat the outside change.
  await second.run("vim /srv/a", () => fs2.set("/srv/a", "two\nsomeone else was here\nmine\n"));
  assert.equal(second.saved.length, 2);
  assert.ok(!second.saved[1]!.diff.includes("someone else was here\n-"), second.saved[1]!.diff);
  assert.match(second.saved[1]!.diff, /\+mine/);
  assert.ok(!second.saved[1]!.flags.includes("outside"));
  // And a second check finds nothing new.
  const before = second.saved.length;
  await second.tracker.checkWatched();
  assert.equal(second.saved.length, before);
});

test("checkWatched: unchanged, never-watched, and still-missing files produce nothing; a deleted one is reported", async () => {
  const first = setup();
  first.fs.set("/srv/keep", "k\n");
  first.fs.set("/srv/gone", "g\n");
  await first.run("vim /srv/keep", () => first.fs.set("/srv/keep", "k2\n"));
  await first.run("vim /srv/gone", () => first.fs.set("/srv/gone", "g2\n"));
  const fs2 = new FakeFs();
  fs2.set("/srv/keep", "k2\n");           // unchanged
  fs2.set("/srv/unwatched", "x\n");       // never watched: not even read
  const second = setup({ db: first.db, key: first.key, fs: fs2 });
  await second.tracker.checkWatched();    // /srv/gone is missing now
  assert.deepEqual(second.saved.map((e) => [e.path, e.change, e.flags]), [["/srv/gone", "deleted", ["outside"]]]);
  assert.ok(!fs2.reads.includes("/srv/unwatched"));
  // Missing before and still missing: nothing more.
  await second.tracker.checkWatched();
  assert.equal(second.saved.length, 1);
});

test("checkWatched ignores reader errors, files that became binary or sensitive, and stays quiet with no watched paths", async () => {
  const empty = setup();
  await empty.tracker.checkWatched();
  assert.equal(empty.saved.length, 0);
  assert.equal(empty.fs.reads.length, 0);

  const first = setup();
  for (const p of ["/srv/a", "/srv/b", "/srv/c"]) first.fs.set(p, "v1\n");
  for (const p of ["/srv/a", "/srv/b", "/srv/c"]) await first.run(`vim ${p}`, () => first.fs.set(p, "v2\n"));
  const fs2 = new FakeFs();
  fs2.throwOn = "/srv/a";
  fs2.set("/srv/b", Buffer.from([0, 1, 2]));
  fs2.set("/srv/c", "-----BEGIN RSA PRIVATE KEY-----\nzz\n");
  const second = setup({ db: first.db, key: first.key, fs: fs2 });
  await second.tracker.checkWatched();
  assert.equal(second.saved.length, 0);
});

test("checkWatched stops when disposed or past its time budget", async () => {
  const first = setup();
  for (const p of ["/srv/a", "/srv/b", "/srv/c"]) first.fs.set(p, "v1\n");
  for (const p of ["/srv/a", "/srv/b", "/srv/c"]) await first.run(`vim ${p}`, () => first.fs.set(p, "v2\n"));
  const mk = () => { const f = new FakeFs(); for (const p of ["/srv/a", "/srv/b", "/srv/c"]) f.set(p, "v3\n"); return f; };

  const disposed = setup({ db: first.db, key: first.key, fs: mk() });
  disposed.tracker.dispose();
  await disposed.tracker.checkWatched();
  assert.equal(disposed.saved.length, 0);

  let t = 0;
  const slow = setup({ db: first.db, key: first.key, fs: mk() });
  await slow.tracker.checkWatched({ budgetMs: 100, now: () => (t += 60) }); // each look at the clock costs 60 ms
  assert.ok(slow.saved.length >= 1 && slow.saved.length < 3, `budget stops the sweep part-way (saw ${slow.saved.length})`);
});
