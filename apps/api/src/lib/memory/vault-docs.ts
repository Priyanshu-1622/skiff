import type Database from "better-sqlite3";
import { generateId } from "../id.js";
import { openEntry, sealEntry } from "../../crypto/data-keys.js";
import type { FileMeta } from "./store.js";

/**
 * Small user-written documents — a note per host and a library of snippets —
 * sealed directly under the vault key (the one credentials use), so they stay
 * readable across sessions. A password change re-seals them (rewrapDocs).
 */

export const MAX_NOTE_CHARS = 100_000;
const MAX_PIN_DIFF_LINES = 60;

export interface HostNote { text: string; version: number; updatedAt: string; updatedBy: string | null }
export type NoteResult =
  | { ok: true; note: HostNote }
  | { ok: false; reason: "conflict" | "too-long" | "unreadable"; current: HostNote | null };

const noteAad = (hostId: string) => `host-note:${hostId}`;

/** A host with no note has an empty one at version 0. Null = a note exists but this key can't read it. */
export function getNote(db: Database.Database, vaultKey: Buffer, hostId: string): HostNote | null {
  const row = db.prepare("SELECT nonce, data, version, updated_at FROM host_notes WHERE host_id = ?").get(hostId) as
    { nonce: Buffer; data: Buffer; version: number; updated_at: string } | undefined;
  if (!row) return { text: "", version: 0, updatedAt: "", updatedBy: null };
  try {
    const p = JSON.parse(openEntry(vaultKey, noteAad(hostId), row.nonce, row.data).toString("utf8")) as { text: string; by: string | null };
    return { text: p.text, version: row.version, updatedAt: row.updated_at, updatedBy: p.by ?? null };
  } catch {
    return null;
  }
}

/** Saves `text` only if the note is still at `baseVersion` (0 = no note yet); otherwise reports the conflict. */
export function putNote(db: Database.Database, vaultKey: Buffer, hostId: string, text: string, baseVersion: number, by: string | null): NoteResult {
  if (text.length > MAX_NOTE_CHARS) return { ok: false, reason: "too-long", current: getNote(db, vaultKey, hostId) };
  const existing = db.prepare("SELECT version FROM host_notes WHERE host_id = ?").get(hostId) as { version: number } | undefined;
  const currentVersion = existing?.version ?? 0;
  if (baseVersion !== currentVersion) return { ok: false, reason: "conflict", current: getNote(db, vaultKey, hostId) };
  const { nonce, data } = sealEntry(vaultKey, noteAad(hostId), Buffer.from(JSON.stringify({ text, by }), "utf8"));
  const now = new Date().toISOString();
  if (existing) {
    db.prepare("UPDATE host_notes SET nonce = ?, data = ?, version = ?, updated_at = ? WHERE host_id = ?").run(nonce, data, currentVersion + 1, now, hostId);
  } else {
    db.prepare("INSERT INTO host_notes (host_id, nonce, data, version, updated_at) VALUES (?, ?, ?, 1, ?)").run(hostId, nonce, data, now);
  }
  return { ok: true, note: { text, version: currentVersion + 1, updatedAt: now, updatedBy: by } };
}

/** Adds a block to the end of a host's note, separated by a blank line. */
export function appendToNote(db: Database.Database, vaultKey: Buffer, hostId: string, block: string, by: string | null): NoteResult {
  const current = getNote(db, vaultKey, hostId);
  if (!current) return { ok: false, reason: "unreadable", current: null };
  const text = current.text ? `${current.text}\n\n${block}` : block;
  return putNote(db, vaultKey, hostId, text, current.version, by);
}

export interface PinInput {
  kind: "command" | "file";
  /** The command, or for a file change the path. */
  command: string;
  startedAt: string;
  exitCode: number | null;
  cwd: string | null;
  file?: FileMeta;
  /** A file change's (already redacted) diff. */
  diff?: string;
}

/** The block "Pin to notes" appends. Never includes a command's output. */
export function formatPin(p: PinInput): string {
  const when = `${p.startedAt.slice(0, 10)} ${p.startedAt.slice(11, 16)} UTC`;
  if (p.kind === "file" && p.file) {
    const head = p.file.note
      ? `✎ ${p.command} (${p.file.note})`
      : `✎ ${p.command} (${p.file.change}, +${p.file.added} −${p.file.removed})`;
    const out = [head, `  ${when}`];
    const lines = (p.diff ?? "").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const l of lines.slice(0, MAX_PIN_DIFF_LINES)) out.push(`    ${l}`);
    if (lines.length > MAX_PIN_DIFF_LINES) out.push(`    … ${lines.length - MAX_PIN_DIFF_LINES} more lines not shown`);
    return out.join("\n");
  }
  const bits = [when];
  if (p.exitCode !== null) bits.push(`exit ${p.exitCode}`);
  if (p.cwd) bits.push(`in ${p.cwd}`);
  return `$ ${p.command}\n  ${bits.join(" · ")}`;
}

// ── Snippets ────────────────────────────────────────────────────────────────

export interface Snippet {
  id: string;
  name: string;
  command: string;
  userId: string | null;
  username: string | null;
  createdAt: string;
  updatedAt: string;
}

const snippetAad = (id: string) => `snippet:${id}`;

function openSnippet(vaultKey: Buffer, row: { id: string; nonce: Buffer; data: Buffer; user_id: string | null; created_at: string; updated_at: string }): Snippet | null {
  try {
    const p = JSON.parse(openEntry(vaultKey, snippetAad(row.id), row.nonce, row.data).toString("utf8")) as { name: string; command: string; username: string | null };
    return { id: row.id, name: p.name, command: p.command, userId: row.user_id, username: p.username ?? null, createdAt: row.created_at, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

export function listSnippets(db: Database.Database, vaultKey: Buffer): Snippet[] {
  const rows = db.prepare("SELECT id, nonce, data, user_id, created_at, updated_at FROM snippets ORDER BY created_at DESC, rowid DESC").all() as any[];
  return rows.map((r) => openSnippet(vaultKey, r)).filter((s): s is Snippet => s !== null);
}

export function getSnippet(db: Database.Database, vaultKey: Buffer, id: string): Snippet | null {
  const row = db.prepare("SELECT id, nonce, data, user_id, created_at, updated_at FROM snippets WHERE id = ?").get(id) as any;
  return row ? openSnippet(vaultKey, row) : null;
}

export function createSnippet(
  db: Database.Database, vaultKey: Buffer,
  input: { name: string; command: string; userId: string | null; username: string | null },
): Snippet {
  const id = generateId("snip");
  const now = new Date().toISOString();
  const { nonce, data } = sealEntry(vaultKey, snippetAad(id), Buffer.from(JSON.stringify({ name: input.name, command: input.command, username: input.username }), "utf8"));
  db.prepare("INSERT INTO snippets (id, nonce, data, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, nonce, data, input.userId, now, now);
  return { id, name: input.name, command: input.command, userId: input.userId, username: input.username, createdAt: now, updatedAt: now };
}

export function updateSnippet(db: Database.Database, vaultKey: Buffer, id: string, changes: { name?: string; command?: string }): Snippet | null {
  const current = getSnippet(db, vaultKey, id);
  if (!current) return null;
  const next = { name: changes.name ?? current.name, command: changes.command ?? current.command };
  const now = new Date().toISOString();
  const { nonce, data } = sealEntry(vaultKey, snippetAad(id), Buffer.from(JSON.stringify({ ...next, username: current.username }), "utf8"));
  db.prepare("UPDATE snippets SET nonce = ?, data = ?, updated_at = ? WHERE id = ?").run(nonce, data, now, id);
  return { ...current, ...next, updatedAt: now };
}

export function deleteSnippet(db: Database.Database, id: string): boolean {
  return db.prepare("DELETE FROM snippets WHERE id = ?").run(id).changes > 0;
}

/** Re-seal every note and snippet from `oldKey` to `newKey` (a personal password change). Rows `oldKey` can't read are left alone. */
export function rewrapDocs(db: Database.Database, oldKey: Buffer, newKey: Buffer): void {
  const notes = db.prepare("SELECT host_id, nonce, data FROM host_notes").all() as { host_id: string; nonce: Buffer; data: Buffer }[];
  for (const n of notes) {
    try {
      const plain = openEntry(oldKey, noteAad(n.host_id), n.nonce, n.data);
      const sealed = sealEntry(newKey, noteAad(n.host_id), plain);
      db.prepare("UPDATE host_notes SET nonce = ?, data = ? WHERE host_id = ?").run(sealed.nonce, sealed.data, n.host_id);
    } catch { /* unreadable under the old key: leave it */ }
  }
  const snippets = db.prepare("SELECT id, nonce, data FROM snippets").all() as { id: string; nonce: Buffer; data: Buffer }[];
  for (const s of snippets) {
    try {
      const plain = openEntry(oldKey, snippetAad(s.id), s.nonce, s.data);
      const sealed = sealEntry(newKey, snippetAad(s.id), plain);
      db.prepare("UPDATE snippets SET nonce = ?, data = ? WHERE id = ?").run(sealed.nonce, sealed.data, s.id);
    } catch { /* leave it */ }
  }
}
