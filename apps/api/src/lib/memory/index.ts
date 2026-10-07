import Database from "better-sqlite3";

export const OUTPUT_INDEX_CAP_CHARS = 8192;
const MAX_QUERY_TERMS = 12;
const MAX_TERM_CHARS = 64;

export interface IndexDoc {
  rowid: number; id: string; hostId: string | null; startedAt: string; finishedAt: string | null;
  exitCode: number | null; confidence: string | null; flags: string[]; ended: "exited" | "running";
  command: string; cwd: string; output: string;
}
export interface IndexHit {
  id: string; hostId: string | null; startedAt: string; finishedAt: string | null; command: string; cwd: string | null;
  exitCode: number | null; confidence: string | null; flags: string[]; ended: "exited" | "running";
}
export interface SearchOptions { hostId?: string; failedOnly?: boolean; since?: string; includeOutput?: boolean; limit?: number }

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
        exit_code INTEGER, confidence TEXT, flags TEXT NOT NULL, ended TEXT NOT NULL
      );
      CREATE INDEX meta_started ON meta(started_at);
    `);
  }

  size(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM meta").get() as { n: number }).n;
  }

  add(d: IndexDoc): void {
    this.db.prepare("INSERT INTO fts(rowid, command, cwd, output) VALUES (?, ?, ?, ?)").run(d.rowid, d.command, d.cwd, capOutput(d.output));
    this.db.prepare("INSERT INTO meta VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      d.rowid, d.id, d.hostId, d.startedAt, d.finishedAt, d.exitCode, d.confidence, JSON.stringify(d.flags), d.ended,
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

  search(q: string, opts: SearchOptions = {}): IndexHit[] {
    const match = toMatchQuery(q, !!opts.includeOutput);
    if (!match) return [];
    const where = ["fts MATCH ?"];
    const params: unknown[] = [match];
    if (opts.hostId) { where.push("m.host_id = ?"); params.push(opts.hostId); }
    if (opts.failedOnly) where.push("m.exit_code IS NOT NULL AND m.exit_code != 0");
    if (opts.since) { where.push("m.started_at >= ?"); params.push(opts.since); }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = this.db.prepare(
      `SELECT m.id, m.host_id, m.started_at, m.finished_at, m.exit_code, m.confidence, m.flags, m.ended, fts.command, fts.cwd
         FROM fts JOIN meta m ON m.rowid = fts.rowid
        WHERE ${where.join(" AND ")}
        ORDER BY m.started_at DESC LIMIT ?`,
    ).all(...params, limit) as any[];
    return rows.map((r) => ({
      id: r.id, hostId: r.host_id, startedAt: r.started_at, finishedAt: r.finished_at, command: r.command,
      cwd: r.cwd || null, exitCode: r.exit_code, confidence: r.confidence, flags: JSON.parse(r.flags), ended: r.ended,
    }));
  }

  close(): void {
    this.db.close();
  }
}
