import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import { openEntry, sealEntry } from "../../crypto/data-keys.js";

/**
 * Versions of files seen on a server, kept encrypted under that server's file
 * key (not a session key, so a later session can still read them). Content is
 * addressed by HMAC(file key, text), so equal texts share one row without the
 * database revealing which known file a version is. Paths are never stored in
 * the clear: server_files is keyed by HMAC(file key, path) and keeps the real
 * path sealed, so the next session can re-read the watched files.
 */

export function pathHash(fileKey: Buffer, path: string): string {
  return createHmac("sha256", fileKey).update("path:").update(path).digest("hex");
}

export function contentIdFor(fileKey: Buffer, text: string): string {
  return createHmac("sha256", fileKey).update("content:").update(text).digest("hex");
}

export function putContent(db: Database.Database, fileKey: Buffer, serverId: string, text: string): string {
  const id = contentIdFor(fileKey, text);
  if (db.prepare("SELECT 1 FROM file_contents WHERE id = ?").get(id)) return id;
  const { nonce, data } = sealEntry(fileKey, `file-content:${id}`, Buffer.from(text, "utf8"));
  db.prepare("INSERT OR IGNORE INTO file_contents (id, server_id, nonce, data) VALUES (?, ?, ?, ?)").run(id, serverId, nonce, data);
  return id;
}

export function getContent(db: Database.Database, fileKey: Buffer, contentId: string): string | null {
  const row = db.prepare("SELECT nonce, data FROM file_contents WHERE id = ?").get(contentId) as { nonce: Buffer; data: Buffer } | undefined;
  if (!row) return null;
  try {
    return openEntry(fileKey, `file-content:${contentId}`, row.nonce, row.data).toString("utf8");
  } catch {
    return null;
  }
}

/** Remember a watched path and the version last seen there (null = last seen missing/unreadable). */
export function rememberFile(db: Database.Database, fileKey: Buffer, serverId: string, path: string, contentId: string | null): void {
  const hash = pathHash(fileKey, path);
  const { nonce, data } = sealEntry(fileKey, `server-file:${hash}`, Buffer.from(path, "utf8"));
  db.prepare(
    `INSERT INTO server_files (server_id, path_hash, path_nonce, path_data, last_content_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, path_hash) DO UPDATE SET last_content_id = excluded.last_content_id, updated_at = excluded.updated_at`,
  ).run(serverId, hash, nonce, data, contentId, new Date().toISOString());
}

/** undefined = never seen; null = last seen missing; otherwise the content id last seen. */
export function lastContentId(db: Database.Database, fileKey: Buffer, serverId: string, path: string): string | null | undefined {
  const row = db.prepare("SELECT last_content_id FROM server_files WHERE server_id = ? AND path_hash = ?")
    .get(serverId, pathHash(fileKey, path)) as { last_content_id: string | null } | undefined;
  return row === undefined ? undefined : row.last_content_id;
}

export function watchedPaths(db: Database.Database, fileKey: Buffer, serverId: string): string[] {
  const rows = db.prepare("SELECT path_hash, path_nonce, path_data FROM server_files WHERE server_id = ?").all(serverId) as
    { path_hash: string; path_nonce: Buffer; path_data: Buffer }[];
  const paths: string[] = [];
  for (const r of rows) {
    try { paths.push(openEntry(fileKey, `server-file:${r.path_hash}`, r.path_nonce, r.path_data).toString("utf8")); } catch { /* unreadable: skip */ }
  }
  return paths;
}

/** Delete the given stored versions unless some entry or watched path still refers to them. */
export function releaseContents(db: Database.Database, serverId: string, candidateIds: string[]): void {
  const stillUsed = db.prepare(
    `SELECT 1 FROM memory_entries WHERE content_old_id = ? OR content_new_id = ?
     UNION SELECT 1 FROM server_files WHERE last_content_id = ? LIMIT 1`,
  );
  const remove = db.prepare("DELETE FROM file_contents WHERE id = ? AND server_id = ?");
  for (const id of new Set(candidateIds)) {
    if (!id) continue;
    if (!stillUsed.get(id, id, id)) remove.run(id, serverId);
  }
}
