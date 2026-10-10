import Database from "better-sqlite3";
import type { FileMeta } from "./store.js";

export const OUTPUT_INDEX_CAP_CHARS = 8192;
const MAX_QUERY_TERMS = 12;
const MAX_TERM_CHARS = 64;

export interface IndexDoc {
  rowid: number; id: string; hostId: string | null; startedAt: string; finishedAt: string | null;
  exitCode: number | null; confidence: string | null; flags: string[]; ended: "exited" | "running";
  command: string; cwd: string; output: string;
  userId: string | null; username: string | null;
  /** Defaults to a command. A file entry's `command` is its path and `output` its redacted diff. */
  kind?: "command" | "file"; file?: FileMeta | null;
}
export interface IndexHit {
  id: string; hostId: string | null; startedAt: string; finishedAt: string | null; command: string; cwd: string | null;
  exitCode: number | null; confidence: string | null; flags: string[]; ended: "exited" | "running";
  userId: string | null; username: string | null;
  kind: "command" | "file"; file: FileMeta | null;
}
export interface SearchOptions {
  hostId?: string;
  /** host_id IN (...), at most 50; an empty list means no host filter. */
  hostIds?: string[];
  userId?: string;
  failedOnly?: boolean;
  since?: string;
  /** Paging cursor: entries strictly before (started_at, id); without beforeId just started_at. */
  before?: string;
  beforeId?: string;
  includeOutput?: boolean;
  /** Only commands or only file changes; omitted = both. */
  kind?: "command" | "file";
  /** An empty query lists everything matching the filters, newest first. */
  browse?: boolean;
  limit?: number;
}

/** Every term becomes a quoted phrase, so user text can never be read as FTS syntax (AND/NEAR/*, column filters, parentheses). */
export function toMatchQuery(raw: string, includeOutput: boolean): string | null {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").slice(0, MAX_TERM_CHARS))
    .filter((t) => t.length > 0)
    .slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) return null;
  const body = terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(" ");
  return includeOutput ? `(${body})` : `{command cwd} : (${body})`;
}

function capOutput(out: string): string {
  if (out.length <= OUTPUT_INDEX_CAP_CHARS) return out;
  const half = OUTPUT_INDEX_CAP_CHARS / 2;
  return out.slice(0, half) + "\n" + out.slice(-half);
}

/** In-memory FTS5 index of one login's visible entries. Never touches disk. */
export class MemoryIndex {
  private readonly db = new Database(":memory:");
  watermark = 0;

  constructor() {
    this.db.exec(`
      CREATE VIRTUAL TABLE fts USING fts5(command, cwd, output);
      CREATE TABLE meta (
        rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, host_id TEXT, started_at TEXT NOT NULL, finished_at TEXT,
        exit_code INTEGER, confidence TEXT, flags TEXT NOT NULL, ended TEXT NOT NULL,
        user_id TEXT, username TEXT, kind TEXT NOT NULL DEFAULT 'command', file TEXT
      );
      CREATE INDEX meta_started ON meta(started_at);
    `);
  }

  size(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM meta").get() as { n: number }).n;
  }

  add(d: IndexDoc): void {
    this.db.prepare("INSERT INTO fts(rowid, command, cwd, output) VALUES (?, ?, ?, ?)").run(d.rowid, d.command, d.cwd, capOutput(d.output));
    this.db.prepare("INSERT INTO meta VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      d.rowid, d.id, d.hostId, d.startedAt, d.finishedAt, d.exitCode, d.confidence, JSON.stringify(d.flags), d.ended, d.userId, d.username,
      d.kind ?? "command", d.file ? JSON.stringify(d.file) : null,
    );
    this.skip(d.rowid);
  }

  /** Advance the watermark past a row that could not be indexed (corrupt / unreadable key) so catch-up doesn't retry it forever. */
  skip(rowid: number): void {
    if (rowid > this.watermark) this.watermark = rowid;
  }

  remove(id: string): boolean {
    const row = this.db.prepare("SELECT rowid AS rid FROM meta WHERE id = ?").get(id) as { rid: number } | undefined;
    if (row) {
      this.db.prepare("DELETE FROM fts WHERE rowid = ?").run(row.rid);
      this.db.prepare("DELETE FROM meta WHERE rowid = ?").run(row.rid);
    }
    // SQLite reuses the highest rowid after a delete, so a watermark left at the old maximum would skip the next entry written there.
    const max = this.db.prepare("SELECT MAX(rowid) AS m FROM meta").get() as { m: number | null };
    this.watermark = max.m ?? 0;
    return !!row;
  }

  /** Retention removes output, while the remembered command still exists. */
  clearOutput(id: string): void {
    this.db.prepare("UPDATE fts SET output = '' WHERE rowid = (SELECT rowid FROM meta WHERE id = ?)").run(id);
  }

  search(q: string, opts: SearchOptions = {}): IndexHit[] {
    const match = toMatchQuery(q, !!opts.includeOutput);
    if (!match && !opts.browse) return [];
    const where: string[] = [];
    const params: unknown[] = [];
    if (match) { where.push("fts MATCH ?"); params.push(match); }
    const hosts = [...(opts.hostId ? [opts.hostId] : []), ...(opts.hostIds ?? [])];
    if (hosts.length > 0) {
      const ids = hosts.filter(Boolean).slice(0, 50);
      if (ids.length === 0) where.push("1 = 0");
      else { where.push(`m.host_id IN (${ids.map(() => "?").join(",")})`); params.push(...ids); }
    }
    if (opts.userId) { where.push("m.user_id = ?"); params.push(opts.userId); }
    if (opts.kind) { where.push("m.kind = ?"); params.push(opts.kind); }
    if (opts.failedOnly) where.push("m.exit_code IS NOT NULL AND m.exit_code != 0");
    if (opts.since) { where.push("m.started_at >= ?"); params.push(opts.since); }
    if (opts.before) {
      if (opts.beforeId) {
        where.push("(m.started_at < ? OR (m.started_at = ? AND m.id < ?))");
        params.push(opts.before, opts.before, opts.beforeId);
      } else {
        where.push("m.started_at < ?");
        params.push(opts.before);
      }
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = this.db.prepare(
      `SELECT m.id, m.host_id, m.started_at, m.finished_at, m.exit_code, m.confidence, m.flags, m.ended, m.user_id, m.username, m.kind, m.file, fts.command, fts.cwd
         FROM fts JOIN meta m ON m.rowid = fts.rowid
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY m.started_at DESC, m.id DESC LIMIT ?`,
    ).all(...params, limit) as any[];
    return rows.map((r) => ({
      id: r.id, hostId: r.host_id, startedAt: r.started_at, finishedAt: r.finished_at, command: r.command,
      cwd: r.cwd || null, exitCode: r.exit_code, confidence: r.confidence, flags: JSON.parse(r.flags), ended: r.ended,
      userId: r.user_id, username: r.username,
      kind: r.kind, file: r.file ? JSON.parse(r.file) : null,
    }));
  }

  close(): void {
    this.db.close();
  }
}
