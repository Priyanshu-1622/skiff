import type Database from "better-sqlite3";
import { generateId } from "./id.js";
import { newDataKey, wrapDataKey, unwrapDataKey } from "../crypto/data-keys.js";

export interface ServerRow { id: string; fingerprint: string; algorithm: string }

/**
 * Find or create the server behind a host key, and point the host entry at it.
 * Called once the host key has been verified (pinned or approved).
 *
 * Identity is the host key, not the host entry: two entries for the same
 * machine share one server, and a machine rebuilt with a new key becomes a
 * new server that remembers the one it replaced.
 */
export function linkServer(
  db: Database.Database,
  opts: { hostId: string; fingerprint: string; algorithm: string; vaultKey: Buffer },
): ServerRow {
  return db.transaction((): ServerRow => {
    let row = db.prepare("SELECT id, fingerprint, algorithm FROM servers WHERE fingerprint = ?")
      .get(opts.fingerprint) as ServerRow | undefined;
    if (!row) {
      const previous = (db.prepare("SELECT server_id FROM hosts WHERE id = ?")
        .get(opts.hostId) as { server_id: string | null } | undefined)?.server_id ?? null;
      const fileKey = newDataKey();
      const { nonce, wrapped } = wrapDataKey(fileKey, opts.vaultKey);
      fileKey.fill(0);
      row = { id: generateId("srv"), fingerprint: opts.fingerprint, algorithm: opts.algorithm };
      db.prepare(
        `INSERT INTO servers (id, fingerprint, algorithm, first_seen_at, previous_server_id, file_key_wrapped, file_key_nonce)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.id, row.fingerprint, row.algorithm, new Date().toISOString(), previous, wrapped, nonce);
    }
    db.prepare("UPDATE hosts SET server_id = ? WHERE id = ?").run(row.id, opts.hostId);
    return row;
  })();
}

/** The server's file key (phase C uses it to name watched files). Caller zeroes it. */
export function serverFileKey(db: Database.Database, serverId: string, vaultKey: Buffer): Buffer {
  const r = db.prepare("SELECT file_key_wrapped w, file_key_nonce n FROM servers WHERE id = ?").get(serverId) as
    | { w: Buffer; n: Buffer } | undefined;
  if (!r) throw new Error("unknown server");
  return unwrapDataKey(r.w, r.n, vaultKey);
}
