import type { FastifyPluginAsync } from "fastify";
import type { SessionStore } from "../crypto/session-store.js";
import { requireUnlocked } from "../lib/auth-middleware.js";
import { unwrapDataKey, openEntry } from "../crypto/data-keys.js";
import { ok, err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";

export interface MemoryRouteDeps {
  sessionStore: SessionStore;
}

interface EntryPayload {
  command: string;
  output: string;
  cwd: string | null;
}

export const memoryRoutes: (deps: MemoryRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const auth = requireUnlocked(deps.sessionStore);

    const isTeam = (): boolean => {
      const meta = app.skiffDb.raw.prepare("SELECT mode FROM vault_meta WHERE id = 1").get() as { mode?: string } | undefined;
      return meta?.mode === "team";
    };

    // Unwraps each row's session key at most once per call, even across
    // many entries from different memory_sessions — same batching
    // reasoning as lib/memory/store.ts's pruneOldOutput.
    function makeKeyCache(vaultKey: Buffer) {
      const cache = new Map<string, Buffer | null>();
      return (keyId: string): Buffer | null => {
        if (cache.has(keyId)) return cache.get(keyId)!;
        const row = app.skiffDb.raw.prepare("SELECT wrapped_key, nonce FROM session_keys WHERE id = ?").get(keyId) as
          | { wrapped_key: Buffer; nonce: Buffer } | undefined;
        let key: Buffer | null = null;
        if (row) {
          try { key = unwrapDataKey(row.wrapped_key, row.nonce, vaultKey); } catch { key = null; }
        }
        cache.set(keyId, key);
        return key;
      };
    }

    app.get("/api/memory/hosts/:hostId/timeline", { preHandler: auth }, async (req, reply) => {
      const { hostId } = req.params as { hostId: string };
      const { before, limit } = req.query as { before?: string; limit?: string };
      const pageSize = Math.min(Math.max(parseInt(limit ?? "50", 10) || 50, 1), 200);

      const conditions = ["ms.host_id = ?"];
      const params: unknown[] = [hostId];
      if (!isTeam()) {
        // personal mode: no filter, everything on this host is visible
      } else if (!req.sessionUser?.isAdmin) {
        conditions.push("me.user_id = ?");
        params.push(req.sessionUser?.id ?? "");
      }
      if (before) {
        conditions.push("me.started_at < ?");
        params.push(before);
      }

      const rows = app.skiffDb.raw.prepare(
        `SELECT me.id, me.started_at, me.finished_at, me.exit_code, me.confidence, me.flags, me.kind, me.nonce, me.data, ms.key_id
           FROM memory_entries me
           JOIN memory_sessions ms ON ms.id = me.memory_session_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY me.started_at DESC
          LIMIT ?`,
      ).all(...params, pageSize) as any[];

      const getKey = makeKeyCache(req.vaultKey);
      const entries = [];
      for (const row of rows) {
        const key = getKey(row.key_id);
        if (!key) continue; // key missing/locked — skip, don't fail the whole list
        let payload: EntryPayload;
        try {
          payload = JSON.parse(openEntry(key, `memory-entry:${row.id}`, row.nonce, row.data).toString("utf8"));
        } catch {
          continue; // corrupted entry — skip, matches pruneOldOutput's own tolerance
        }
        entries.push({
          id: row.id,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          command: payload.command,
          cwd: payload.cwd,
          exitCode: row.exit_code,
          confidence: row.confidence,
          flags: JSON.parse(row.flags),
          ended: row.finished_at ? "exited" : "running",
        });
      }

      return reply.send(ok({ entries }));
    });

    app.get("/api/memory/entries/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = app.skiffDb.raw.prepare(
        `SELECT me.id, me.started_at, me.finished_at, me.exit_code, me.confidence, me.flags,
                me.output_bytes, me.output_pruned, me.user_id, me.nonce, me.data, ms.key_id
           FROM memory_entries me
           JOIN memory_sessions ms ON ms.id = me.memory_session_id
          WHERE me.id = ?`,
      ).get(id) as any | undefined;
      if (!row) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Entry not found"));
      if (isTeam() && !req.sessionUser?.isAdmin && row.user_id !== req.sessionUser?.id) {
        return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Entry not found"));
      }
      const getKey = makeKeyCache(req.vaultKey);
      const key = getKey(row.key_id);
      if (!key) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Entry not found"));
      let payload: EntryPayload;
      try {
        payload = JSON.parse(openEntry(key, `memory-entry:${row.id}`, row.nonce, row.data).toString("utf8"));
      } catch {
        return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Entry not found"));
      }
      return reply.send(ok({
        id: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        command: payload.command,
        cwd: payload.cwd,
        output: payload.output,
        outputBytes: row.output_bytes,
        outputPruned: !!row.output_pruned,
        exitCode: row.exit_code,
        confidence: row.confidence,
        flags: JSON.parse(row.flags),
        ended: row.finished_at ? "exited" : "running",
      }));
    });
  };
