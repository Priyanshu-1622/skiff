import { posix } from "node:path";
import type Database from "better-sqlite3";
import { redact } from "../capture/redact.js";
import { extractCandidatePaths } from "./paths.js";
import { isTrackableText, unifiedDiff } from "./diff.js";
import { getContent, lastContentId, putContent, rememberFile, watchedPaths } from "./file-store.js";

export type ReadResult =
  | { kind: "file"; bytes: Buffer; resolvedPath: string }
  | { kind: "missing" }
  | { kind: "denied" }
  | { kind: "not-file" }
  | { kind: "too-large"; size: number }
  | { kind: "error" };

export interface FileReader {
  read(path: string): Promise<ReadResult>;
  home(): Promise<string | null>;
}

export interface FileEntryInput {
  path: string;
  change: "created" | "modified" | "deleted";
  diff: string;
  added: number;
  removed: number;
  oldContentId: string | null;
  newContentId: string | null;
  flags: string[];
  note: string | null;
  command: string;
  startedAt: number;
}

export interface FileTrackerDeps {
  db: Database.Database;
  fileKey: Buffer;
  serverId: string;
  reader: FileReader;
  save: (entry: FileEntryInput) => void;
}

/** What a file looked like at one moment. A note means "could not be tracked, and why". */
type Snap = { t: "text"; text: string } | { t: "missing" } | { t: "note"; note: string } | { t: "unknown" };

interface Target {
  path: string;
  flags: string[];
  before: Snap;
}

const MAX_WATCHED_CHECK = 50;
const SENSITIVE_NOTE = "sensitive file — not tracked";
const SHADOW = /^\/etc\/(g?shadow-?)$/;

/**
 * Notices when a remembered command changed a file. At the start of a command
 * it works out which files the command may write and remembers what each one
 * held; when the command ends it looks again and records the difference. Every
 * failure is swallowed: this must never get in the way of the terminal.
 */
export class FileTracker {
  /** What this session last saw at each path: the baseline for the next command. */
  private readonly seen = new Map<string, Snap>();
  private pending: { command: string; ready: Promise<Target[]> } | null = null;
  private disposed = false;

  constructor(private readonly deps: FileTrackerDeps) {}

  get isDisposed(): boolean { return this.disposed; }

  /** After this nothing is read or written: the key this tracker seals under may be about to be zeroed. */
  dispose(): void {
    this.disposed = true;
    this.pending = null;
  }

  onStart(info: { command: string; cwd: string | null }): void {
    if (this.disposed) return;
    const ready = this.prepare(info).catch(() => [] as Target[]);
    this.pending = { command: info.command, ready };
  }

  /** Resolves once the baseline reads for the current command are done (tests; onFinish waits on it too). */
  async settled(): Promise<void> {
    await this.pending?.ready;
  }

  async onFinish(info: { command: string; startedAt: number; ended: "exited" | "running"; exitCode: number | null }): Promise<void> {
    if (info.ended === "running") return;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    const command = redact(pending.command);
    try {
      const targets = await pending.ready;
      for (const target of targets) {
        if (this.disposed) return;
        try {
          const entry = await this.compare(target, command, info.startedAt);
          if (entry) this.deps.save(entry);
        } catch { /* one path failing must not stop the others */ }
      }
    } catch { /* never throw into the capture pipeline */ }
  }

  /**
   * At the start of a session: look again at every watched file and report the
   * ones that no longer match the version Skiff last stored — somebody changed
   * them while Skiff wasn't watching. Bounded in count and time; best-effort.
   */
  async checkWatched(opts: { budgetMs?: number; now?: () => number } = {}): Promise<void> {
    if (this.disposed) return;
    const now = opts.now ?? Date.now;
    const deadline = now() + (opts.budgetMs ?? 15_000);
    const { db, fileKey, serverId } = this.deps;
    let paths: string[];
    try { paths = watchedPaths(db, fileKey, serverId).slice(0, MAX_WATCHED_CHECK); } catch { return; }
    for (const path of paths) {
      if (this.disposed || now() > deadline) return;
      try {
        const id = lastContentId(db, fileKey, serverId, path);
        if (!id) continue; // last seen missing (or no stored version): nothing to compare with
        const oldText = getContent(db, fileKey, id);
        if (oldText === null) continue;
        const after = await this.read(path);
        if (this.disposed) return;
        const base = { path, flags: ["outside"], command: "", startedAt: Date.now() };
        if (after.t === "text") {
          this.seen.set(path, after);
          if (after.text === oldText) continue;
          const newId = putContent(db, fileKey, serverId, after.text);
          rememberFile(db, fileKey, serverId, path, newId);
          const d = unifiedDiff(oldText, after.text);
          this.deps.save({ ...base, change: "modified", diff: redactLines(d.diff), added: d.added, removed: d.removed, oldContentId: id, newContentId: newId, note: null });
        } else if (after.t === "missing") {
          this.seen.set(path, after);
          rememberFile(db, fileKey, serverId, path, null);
          const d = unifiedDiff(oldText, "");
          this.deps.save({ ...base, change: "deleted", diff: redactLines(d.diff), added: d.added, removed: d.removed, oldContentId: id, newContentId: null, note: null });
        }
        // A note (binary now, sensitive, denied…) or an unreadable result: say nothing.
      } catch { /* one path failing must not stop the sweep */ }
    }
  }

  private async prepare(info: { command: string; cwd: string | null }): Promise<Target[]> {
    const targets: Target[] = [];
    for (const c of extractCandidatePaths(info.command, info.cwd)) {
      const flags: string[] = [];
      let path = c.path;
      if (path === "~" || path.startsWith("~/")) {
        const home = await this.deps.reader.home();
        if (!home) continue;
        path = posix.join(home, path.slice(1));
      } else if (c.relative) {
        const home = await this.deps.reader.home();
        if (!home) continue;
        path = posix.join(home, path);
        flags.push("assumed-home");
      }
      path = posix.normalize(path);
      if (targets.some((t) => t.path === path)) continue;
      targets.push({ path, flags, before: await this.baseline(path, flags) });
    }
    return targets;
  }

  private async baseline(path: string, flags: string[]): Promise<Snap> {
    if (SHADOW.test(path)) return { t: "note", note: SENSITIVE_NOTE };
    const known = this.seen.get(path);
    if (known) return known;
    const id = lastContentId(this.deps.db, this.deps.fileKey, this.deps.serverId, path);
    if (id === null) return { t: "missing" };
    if (id !== undefined) {
      const text = getContent(this.deps.db, this.deps.fileKey, id);
      if (text !== null) return { t: "text", text };
    }
    // Never seen (or its stored version is gone): read it now, in the middle of the edit.
    flags.push("baseline-during-edit");
    return this.read(path);
  }

  private async read(path: string): Promise<Snap> {
    if (SHADOW.test(path)) return { t: "note", note: SENSITIVE_NOTE };
    let r: ReadResult;
    try { r = await this.deps.reader.read(path); } catch { return { t: "unknown" }; }
    switch (r.kind) {
      case "missing": return { t: "missing" };
      case "denied": return { t: "note", note: "permission denied" };
      case "not-file": return { t: "note", note: "not a regular file" };
      case "too-large": return { t: "note", note: "too large to track" };
      case "error": return { t: "unknown" };
      case "file": {
        const t = isTrackableText(r.bytes);
        if (t.ok) return { t: "text", text: t.text };
        return { t: "note", note: t.reason === "key-like" ? SENSITIVE_NOTE : t.reason === "too-large" ? "too large to track" : "binary file — not tracked" };
      }
    }
  }

  private async compare(target: Target, command: string, startedAt: number): Promise<FileEntryInput | null> {
    const after = await this.read(target.path);
    if (this.disposed) return null;
    if (after.t === "unknown") return null; // could not look: leave the baseline alone
    const { db, fileKey, serverId } = this.deps;
    const before = target.before;
    this.seen.set(target.path, after);
    const base = { path: target.path, flags: target.flags, command, startedAt };

    if (after.t === "note") {
      return { ...base, change: "modified", diff: "", added: 0, removed: 0, oldContentId: null, newContentId: null, note: after.note };
    }
    if (after.t === "missing") {
      if (before.t !== "text") return null;
      const oldId = putContent(db, fileKey, serverId, before.text);
      rememberFile(db, fileKey, serverId, target.path, null);
      const d = unifiedDiff(before.text, "");
      return { ...base, change: "deleted", diff: redactLines(d.diff), added: d.added, removed: d.removed, oldContentId: oldId, newContentId: null, note: null };
    }
    // after is text
    const newId = putContent(db, fileKey, serverId, after.text);
    rememberFile(db, fileKey, serverId, target.path, newId);
    if (before.t === "note" || before.t === "unknown") return null; // nothing trustworthy to compare with
    if (before.t === "text" && before.text === after.text) return null;
    const oldText = before.t === "text" ? before.text : "";
    const oldId = before.t === "text" ? putContent(db, fileKey, serverId, before.text) : null;
    const d = unifiedDiff(oldText, after.text);
    return {
      ...base,
      change: before.t === "missing" ? "created" : "modified",
      diff: redactLines(d.diff), added: d.added, removed: d.removed,
      oldContentId: oldId, newContentId: newId, note: null,
    };
  }
}

function redactLines(diff: string): string {
  return diff.split("\n").map((line) => redact(line)).join("\n");
}
