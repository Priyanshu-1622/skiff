import type Database from "better-sqlite3";
import { unwrapDataKey } from "../../crypto/data-keys.js";

export interface KeyCache {
  get(keyId: string): Buffer | null;
  /** Zero-fills every unwrapped key handed out. Call when the request/catch-up using them is done. */
  dispose(): void;
}

/** Unwraps each session key at most once per cache, even across many entries from different memory_sessions. */
export function makeKeyCache(db: Database.Database, vaultKey: Buffer): KeyCache {
  const cache = new Map<string, Buffer | null>();
  return {
    get(keyId) {
      if (cache.has(keyId)) return cache.get(keyId)!;
      const row = db.prepare("SELECT wrapped_key, nonce FROM session_keys WHERE id = ?").get(keyId) as
        | { wrapped_key: Buffer; nonce: Buffer } | undefined;
      let key: Buffer | null = null;
      if (row) {
        try { key = unwrapDataKey(row.wrapped_key, row.nonce, vaultKey); } catch { key = null; }
      }
      cache.set(keyId, key);
      return key;
    },
    dispose() {
      for (const k of cache.values()) k?.fill(0);
      cache.clear();
    },
  };
}
