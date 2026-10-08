import type Database from "better-sqlite3";
import { generateId } from "../id.js";
import { openEntry, sealEntry } from "../../crypto/data-keys.js";
import { redact } from "../capture/redact.js";
import { unifiedDiff } from "./diff.js";

/**
 * Opt-in server snapshots: a fixed, read-only, visible set of commands run on
 * a separate exec channel when a session starts. The result is compared with
 * the previous snapshot; what changed and isn't explained by a command Skiff
 * remembered is reported as "changed outside Skiff". Nothing here writes to
 * the server, uses the network or escalates privileges.
 */

export const SNAPSHOT_SECTIONS = [
  { id: "os", label: "Operating system" },
  { id: "kernel", label: "Kernel" },
  { id: "packages", label: "Installed packages" },
  { id: "services", label: "Enabled services" },
  { id: "ports", label: "Listening ports" },
  { id: "cron", label: "Scheduled jobs (cron)" },
  { id: "docker", label: "Docker containers" },
] as const;

export type SectionId = (typeof SNAPSHOT_SECTIONS)[number]["id"];
export type Snapshot = Record<SectionId, string[]>;

const END = "@@skiff:end";
const MAX_DIFF_LINES = 400;
const KEEP_SNAPSHOTS = 5;

/** Run through `sh -c` (see shellQuote), so the user's login shell (fish, csh…) never has to parse it. */
export const SNAPSHOT_SCRIPT = [
  `echo '@@skiff:os'; (. /etc/os-release 2>/dev/null && printf '%s\\n' "$PRETTY_NAME")`,
  `echo '@@skiff:kernel'; uname -sr 2>/dev/null`,
  `echo '@@skiff:packages'; if command -v dpkg-query >/dev/null 2>&1; then dpkg-query -W -f='\${binary:Package} \${Version}\\n' 2>/dev/null; elif command -v rpm >/dev/null 2>&1; then rpm -qa --qf '%{NAME} %{VERSION}-%{RELEASE}\\n' 2>/dev/null; elif command -v apk >/dev/null 2>&1; then apk info -v 2>/dev/null; fi | sort`,
  `echo '@@skiff:services'; command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files --type=service --state=enabled --no-legend --no-pager 2>/dev/null | awk '{print $1}' | sort`,
  `echo '@@skiff:ports'; command -v ss >/dev/null 2>&1 && ss -tlnH 2>/dev/null | awk '{print $4}' | sort -u`,
  `echo '@@skiff:cron'; { crontab -l 2>/dev/null; ls -1 /etc/cron.d /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly 2>/dev/null; } | sort`,
  `echo '@@skiff:docker'; command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | sort`,
  `echo '${END}'`,
].join("\n");

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The command line actually sent over the exec channel. */
export const SNAPSHOT_COMMAND = `sh -c ${shellQuote(SNAPSHOT_SCRIPT)}`;

/** Null when the output is not a complete run (no end marker: cut off, refused, or not our output at all). */
export function parseSnapshot(output: string): Snapshot | null {
  const lines = output.split(/\r?\n/);
  if (!lines.some((l) => l.trim() === END)) return null;
  const known = new Set<string>(SNAPSHOT_SECTIONS.map((s) => s.id));
  const snap = Object.fromEntries(SNAPSHOT_SECTIONS.map((s) => [s.id, [] as string[]])) as Snapshot;
  let current: SectionId | null = null;
  let sawAny = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === END) break;
    const m = /^@@skiff:(\w+)$/.exec(line);
    if (m) {
      current = known.has(m[1]!) ? (m[1] as SectionId) : null;
      if (current) sawAny = true;
      continue;
    }
    if (current && line.trim() !== "") snap[current].push(line.trim());
  }
  if (!sawAny) return null;
  for (const s of SNAPSHOT_SECTIONS) snap[s.id].sort();
  return snap;
}

export interface SectionChange { id: SectionId; label: string; diff: string; added: number; removed: number }

function cap(diff: string): string {
  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= MAX_DIFF_LINES) return lines.join("\n") + "\n";
  return lines.slice(0, MAX_DIFF_LINES).join("\n") + `\n… ${lines.length - MAX_DIFF_LINES} more lines not shown\n`;
}

export function diffSnapshots(prev: Snapshot, next: Snapshot): SectionChange[] {
  const out: SectionChange[] = [];
  for (const { id, label } of SNAPSHOT_SECTIONS) {
    const a = prev[id], b = next[id];
    if (!a || !b) continue;
    if (a.length === b.length && a.every((l, i) => l === b[i])) continue;
    const d = unifiedDiff(a.join("\n") + (a.length ? "\n" : ""), b.join("\n") + (b.length ? "\n" : ""));
    if (d.added === 0 && d.removed === 0) continue;
    out.push({ id, label, diff: cap(d.diff.split("\n").map((l) => redact(l)).join("\n")), added: d.added, removed: d.removed });
  }
  return out;
}

const PKG = /\b(apt|apt-get|aptitude|dpkg|yum|dnf|rpm|zypper|apk|pacman|snap|do-release-upgrade|unattended-upgrade)\b/;
const SVC = /\b(systemctl|service|chkconfig|update-rc\.d|rc-update|rc-service)\b/;
const CRON = /\b(crontab|anacron)\b|\/etc\/cron|\/var\/spool\/cron/;
const DOCKER = /\b(docker|docker-compose|podman|nerdctl)\b/;

/** A rough "did something the user ran probably cause this?" per section; used so Skiff doesn't call its own user's work an outside change. */
export function explainedBy(section: SectionId, commands: string[]): boolean {
  const any = (re: RegExp) => commands.some((c) => re.test(c));
  switch (section) {
    case "os":
    case "kernel":
    case "packages": return any(PKG) || (section !== "packages" && any(/\b(reboot|shutdown|init)\b/));
    case "services": return any(SVC) || any(PKG);
    case "ports": return any(SVC) || any(DOCKER) || any(PKG);
    case "cron": return any(CRON);
    case "docker": return any(DOCKER);
  }
}

export function saveSnapshot(db: Database.Database, fileKey: Buffer, serverId: string, snapshot: Snapshot, takenAt = new Date().toISOString()): string {
  const id = generateId("snap");
  const { nonce, data } = sealEntry(fileKey, `server-snapshot:${id}`, Buffer.from(JSON.stringify(snapshot), "utf8"));
  db.prepare("INSERT INTO server_snapshots (id, server_id, taken_at, nonce, data) VALUES (?, ?, ?, ?, ?)").run(id, serverId, takenAt, nonce, data);
  db.prepare(
    `DELETE FROM server_snapshots WHERE server_id = ? AND id NOT IN
       (SELECT id FROM server_snapshots WHERE server_id = ? ORDER BY taken_at DESC, rowid DESC LIMIT ${KEEP_SNAPSHOTS})`,
  ).run(serverId, serverId);
  return id;
}

export function latestSnapshot(db: Database.Database, fileKey: Buffer, serverId: string): { id: string; takenAt: string; snapshot: Snapshot } | null {
  const row = db.prepare("SELECT id, taken_at, nonce, data FROM server_snapshots WHERE server_id = ? ORDER BY taken_at DESC, rowid DESC LIMIT 1")
    .get(serverId) as { id: string; taken_at: string; nonce: Buffer; data: Buffer } | undefined;
  if (!row) return null;
  try {
    return { id: row.id, takenAt: row.taken_at, snapshot: JSON.parse(openEntry(fileKey, `server-snapshot:${row.id}`, row.nonce, row.data).toString("utf8")) as Snapshot };
  } catch {
    return null;
  }
}
