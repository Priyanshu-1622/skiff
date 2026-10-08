import type Database from "better-sqlite3";
import { openEntry } from "../../crypto/data-keys.js";
import { makeKeyCache } from "./keys.js";
import type { FileEntryInput } from "./file-tracker.js";
import {
  SNAPSHOT_COMMAND, diffSnapshots, explainedBy, latestSnapshot, parseSnapshot, saveSnapshot,
} from "./snapshot.js";

const SNAPSHOT_TIMEOUT_MS = 10_000;
const MAX_COMMANDS_CONSIDERED = 500;

export interface SnapshotRunDeps {
  db: Database.Database;
  fileKey: Buffer;
  serverId: string;
  /** Runs one command on a separate exec channel; null = could not run or timed out. */
  exec: (command: string, timeoutMs: number) => Promise<string | null>;
  /** Commands Skiff remembered on this server since the previous snapshot (see commandsSince). */
  recentCommands: string[];
  save: (entry: FileEntryInput) => void;
  /** Return false once the session is over, so nothing is sealed under a key that is being zeroed. */
  isActive?: () => boolean;
}

export type SnapshotResult = "first" | "unchanged" | "changed" | "failed" | "stopped";

/** Has a failure already been noted since the last good snapshot? (One note per stretch of failures.) */
function failureAlreadyNoted(db: Database.Database, serverId: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM memory_entries
      WHERE server_id = ? AND kind = 'file' AND flags LIKE '%"snapshot-failed"%'
        AND started_at > COALESCE((SELECT MAX(taken_at) FROM server_snapshots WHERE server_id = ?), '')
      LIMIT 1`,
  ).get(serverId, serverId);
  return !!row;
}

export async function runSnapshot(deps: SnapshotRunDeps): Promise<SnapshotResult> {
  const { db, fileKey, serverId } = deps;
  let output: string | null = null;
  try { output = await deps.exec(SNAPSHOT_COMMAND, SNAPSHOT_TIMEOUT_MS); } catch { output = null; }
  if (deps.isActive && !deps.isActive()) return "stopped";
  const snap = output === null ? null : parseSnapshot(output);

  if (!snap) {
    if (!failureAlreadyNoted(db, serverId)) {
      deps.save({
        path: "Server snapshot", change: "modified", diff: "", added: 0, removed: 0, oldContentId: null, newContentId: null,
        flags: ["snapshot", "snapshot-failed"], command: "", startedAt: Date.now(),
        note: "Couldn't take a server snapshot (the server didn't answer in time or refused). Skiff will keep trying at the start of each session.",
      });
    }
    return "failed";
  }

  const prev = latestSnapshot(db, fileKey, serverId);
  saveSnapshot(db, fileKey, serverId, snap);
  if (!prev) return "first";

  const changes = diffSnapshots(prev.snapshot, snap).filter((c) => !explainedBy(c.id, deps.recentCommands));
  for (const c of changes) {
    deps.save({
      path: c.label, change: "modified", diff: c.diff, added: c.added, removed: c.removed,
      oldContentId: null, newContentId: null, flags: ["snapshot", "outside"], note: null, command: "", startedAt: Date.now(),
    });
  }
  return changes.length > 0 ? "changed" : "unchanged";
}

/**
 * The commands remembered on a server after `sinceIso` (all sessions, all
 * people: only used to decide which snapshot differences the user's own work
 * explains). Needs the vault key to open the session keys, so it runs at
 * session start while that key is still held.
 */
export function commandsSince(db: Database.Database, vaultKey: Buffer, serverId: string, sinceIso: string | null): string[] {
  const rows = db.prepare(
    `SELECT me.id, me.nonce, me.data, ms.key_id
       FROM memory_entries me JOIN memory_sessions ms ON ms.id = me.memory_session_id
      WHERE me.server_id = ? AND me.kind = 'command' AND (? IS NULL OR me.started_at > ?)
      ORDER BY me.started_at DESC LIMIT ?`,
  ).all(serverId, sinceIso, sinceIso, MAX_COMMANDS_CONSIDERED) as { id: string; nonce: Buffer; data: Buffer; key_id: string }[];
  const keys = makeKeyCache(db, vaultKey);
  const out: string[] = [];
  try {
    for (const r of rows) {
      const key = keys.get(r.key_id);
      if (!key) continue;
      try {
        const p = JSON.parse(openEntry(key, `memory-entry:${r.id}`, r.nonce, r.data).toString("utf8")) as { command?: string };
        if (p.command) out.push(p.command);
      } catch { /* unreadable entry: skip */ }
    }
  } finally {
    keys.dispose();
  }
  return out;
}
