import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runColumnMigrations } from "../../db/client.js";
import { newDataKey } from "../../crypto/data-keys.js";
import {
  SNAPSHOT_SECTIONS, SNAPSHOT_SCRIPT, explainedBy, diffSnapshots, latestSnapshot, parseSnapshot, saveSnapshot, shellQuote, type Snapshot,
} from "./snapshot.js";

const here = dirname(fileURLToPath(import.meta.url));

function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(readFileSync(join(here, "../../db/schema.sql"), "utf-8"));
  runColumnMigrations(d);
  d.prepare("INSERT INTO servers (id, fingerprint, algorithm, first_seen_at, file_key_wrapped, file_key_nonce) VALUES ('srv1', 'fp', 'ssh-ed25519', 'then', x'00', x'00')").run();
  d.prepare("INSERT INTO servers (id, fingerprint, algorithm, first_seen_at, file_key_wrapped, file_key_nonce) VALUES ('srv2', 'fp2', 'ssh-ed25519', 'then', x'00', x'00')").run();
  return d;
}

const OUTPUT = [
  "@@skiff:os", "Ubuntu 22.04.4 LTS",
  "@@skiff:kernel", "Linux 5.15.0-101-generic",
  "@@skiff:packages", "bash 5.1-6", "nginx 1.18.0-6", "openssl 3.0.2-0",
  "@@skiff:services", "cron.service", "ssh.service",
  "@@skiff:ports", "0.0.0.0:22", "0.0.0.0:80",
  "@@skiff:cron", "0 3 * * * /usr/local/bin/backup.sh", "logrotate",
  "@@skiff:docker",
  "@@skiff:end", "",
].join("\n");

test("a complete run parses into one list of lines per section", () => {
  const s = parseSnapshot(OUTPUT)!;
  assert.deepEqual(Object.keys(s).sort(), SNAPSHOT_SECTIONS.map((x) => x.id).sort());
  assert.deepEqual(s.os, ["Ubuntu 22.04.4 LTS"]);
  assert.deepEqual(s.packages, ["bash 5.1-6", "nginx 1.18.0-6", "openssl 3.0.2-0"]);
  assert.deepEqual(s.docker, [], "a section with nothing in it is an empty list");
});

test("output cut off before the end marker, or with no markers at all, is not a snapshot", () => {
  assert.equal(parseSnapshot(OUTPUT.replace("@@skiff:end\n", "")), null);
  assert.equal(parseSnapshot(""), null);
  assert.equal(parseSnapshot("Welcome to Ubuntu\nlast login: today\n"), null);
});

test("CRLF line endings, blank lines, stray text before the first marker and unknown markers are tolerated", () => {
  const messy = "motd junk\r\n" + OUTPUT.split("\n").join("\r\n").replace("@@skiff:ports", "\r\n@@skiff:mystery\r\nignored\r\n@@skiff:ports");
  const s = parseSnapshot(messy)!;
  assert.deepEqual(s.ports, ["0.0.0.0:22", "0.0.0.0:80"]);
  assert.deepEqual(s.services, ["cron.service", "ssh.service"]);
});

test("lines are sorted for list sections, so order alone never counts as a change", () => {
  const a = parseSnapshot(OUTPUT)!;
  const b = parseSnapshot(OUTPUT.replace("nginx 1.18.0-6\n", "").replace("bash 5.1-6\n", "nginx 1.18.0-6\nbash 5.1-6\n"))!;
  assert.deepEqual(diffSnapshots(a, b), []);
});

test("diffSnapshots reports each changed section with a diff and counts, and nothing for unchanged ones", () => {
  const prev = parseSnapshot(OUTPUT)!;
  const next = parseSnapshot(OUTPUT.replace("nginx 1.18.0-6", "nginx 1.24.0-1").replace("0.0.0.0:80", "0.0.0.0:8080").replace("Linux 5.15.0-101-generic", "Linux 5.15.0-105-generic"))!;
  const changes = diffSnapshots(prev, next);
  assert.deepEqual(changes.map((c) => c.id).sort(), ["kernel", "packages", "ports"]);
  const pk = changes.find((c) => c.id === "packages")!;
  assert.equal(pk.label, "Installed packages");
  assert.equal(pk.added, 1);
  assert.equal(pk.removed, 1);
  assert.match(pk.diff, /-nginx 1\.18\.0-6/);
  assert.match(pk.diff, /\+nginx 1\.24\.0-1/);
  assert.deepEqual(diffSnapshots(prev, prev), []);
});

test("a new package, a removed service and a new container are plain additions and removals", () => {
  const prev = parseSnapshot(OUTPUT)!;
  const next = parseSnapshot(OUTPUT.replace("@@skiff:docker", "@@skiff:docker\nweb nginx:1.24").replace("openssl 3.0.2-0", "openssl 3.0.2-0\nredis 7.0").replace("cron.service\n", ""))!;
  const by = Object.fromEntries(diffSnapshots(prev, next).map((c) => [c.id, c]));
  assert.equal(by.packages!.added, 1);
  assert.equal(by.packages!.removed, 0);
  assert.equal(by.services!.removed, 1);
  assert.equal(by.docker!.added, 1);
});

test("a very long diff is cut to a readable size and says so", () => {
  const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `pkg${String(i).padStart(5, "0")} ${tag}`).join("\n");
  const prev = parseSnapshot(OUTPUT.replace(/@@skiff:packages[\s\S]*?@@skiff:services/, `@@skiff:packages\n${many(3000, "1")}\n@@skiff:services`))!;
  const next = parseSnapshot(OUTPUT.replace(/@@skiff:packages[\s\S]*?@@skiff:services/, `@@skiff:packages\n${many(3000, "2")}\n@@skiff:services`))!;
  const c = diffSnapshots(prev, next).find((x) => x.id === "packages")!;
  assert.equal(c.added, 3000);
  assert.equal(c.removed, 3000);
  assert.ok(c.diff.split("\n").length <= 410, `diff lines: ${c.diff.split("\n").length}`);
  assert.match(c.diff, /more lines not shown/);
});

test("diff lines are redacted (a cron line can carry a password)", () => {
  const prev = parseSnapshot(OUTPUT)!;
  const next = parseSnapshot(OUTPUT.replace("@@skiff:cron", "@@skiff:cron\n* * * * * curl -u bob:s3cr3t-pass https://x password=hunter2"))!;
  const c = diffSnapshots(prev, next).find((x) => x.id === "cron")!;
  assert.ok(!c.diff.includes("hunter2"), c.diff);
});

test("commands the user ran explain the matching sections, and only those", () => {
  assert.equal(explainedBy("packages", ["sudo apt-get install nginx"]), true);
  assert.equal(explainedBy("packages", ["dnf upgrade -y"]), true);
  assert.equal(explainedBy("kernel", ["apt full-upgrade"]), true);
  assert.equal(explainedBy("os", ["do-release-upgrade"]), true);
  assert.equal(explainedBy("services", ["sudo systemctl enable nginx"]), true);
  assert.equal(explainedBy("ports", ["systemctl restart nginx"]), true);
  assert.equal(explainedBy("ports", ["docker run -p 80:80 nginx"]), true);
  assert.equal(explainedBy("cron", ["crontab -e"]), true);
  assert.equal(explainedBy("cron", ["vim /etc/cron.d/backup"]), true);
  assert.equal(explainedBy("docker", ["docker compose up -d"]), true);
  assert.equal(explainedBy("packages", ["ls -la", "whoami", "systemctl status nginx"]), false);
  assert.equal(explainedBy("cron", ["apt install cron"]), false);
  assert.equal(explainedBy("docker", []), false);
});

test("the script is read-only and visible: no writes, no network, no privilege escalation, and it ends with the marker", () => {
  const forbidden = [/\brm\b/, /\bmv\b/, /\bcp\b/, /\btee\b/, /\bsudo\b/, /\bcurl\b/, /\bwget\b/, /\bkill\b/, /\bchmod\b/, /\bchown\b/, /\bmkdir\b/, /\btouch\b/, /\bdd\b/,
    /systemctl\s+(start|stop|restart|enable|disable|daemon-reload|mask)/, /docker\s+(run|rm|stop|start|exec|pull|kill)/];
  for (const f of forbidden) assert.ok(!f.test(SNAPSHOT_SCRIPT), `forbidden ${f}`);
  // The only redirections are to /dev/null or stderr merging.
  const withoutAllowed = SNAPSHOT_SCRIPT.replace(/2>\/dev\/null|>\/dev\/null|2>&1/g, "");
  assert.ok(!withoutAllowed.includes(">"), "a redirection other than to /dev/null");
  assert.ok(SNAPSHOT_SCRIPT.trimEnd().endsWith("echo '@@skiff:end'"));
  for (const s of SNAPSHOT_SECTIONS) assert.ok(SNAPSHOT_SCRIPT.includes(`'@@skiff:${s.id}'`), s.id);
});

test("shellQuote survives single quotes, so the script can be handed to sh -c", () => {
  assert.equal(shellQuote("echo 'hi'"), `'echo '\\''hi'\\'''`);
  assert.equal(shellQuote("plain"), "'plain'");
});

test("snapshots are stored sealed under the server's file key, the latest wins, only the newest five are kept", () => {
  const d = freshDb();
  const key = newDataKey();
  assert.equal(latestSnapshot(d, key, "srv1"), null);
  const base = parseSnapshot(OUTPUT)!;
  for (let i = 0; i < 7; i++) {
    const s: Snapshot = { ...base, kernel: [`Linux 5.15.0-${100 + i}`] };
    saveSnapshot(d, key, "srv1", s, new Date(2026, 9, 1 + i).toISOString());
  }
  saveSnapshot(d, key, "srv2", base, new Date(2026, 9, 1).toISOString());
  assert.equal((d.prepare("SELECT COUNT(*) n FROM server_snapshots WHERE server_id = 'srv1'").get() as any).n, 5);
  assert.equal((d.prepare("SELECT COUNT(*) n FROM server_snapshots WHERE server_id = 'srv2'").get() as any).n, 1, "pruning one server never touches another");
  const latest = latestSnapshot(d, key, "srv1")!;
  assert.deepEqual(latest.snapshot.kernel, ["Linux 5.15.0-106"]);
  assert.equal(latestSnapshot(d, newDataKey(), "srv1"), null, "a wrong key reads as nothing");
  const raw = (d.prepare("SELECT * FROM server_snapshots").all() as any[]).map((r) => Object.values(r).map((v) => (Buffer.isBuffer(v) ? v.toString("latin1") : String(v))).join("|")).join("\n");
  assert.ok(!raw.includes("nginx") && !raw.includes("backup.sh"), "nothing readable in the table");
});
