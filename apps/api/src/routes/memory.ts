import type { FastifyPluginAsync } from "fastify";
import type { SessionStore } from "../crypto/session-store.js";
import { requireUnlocked } from "../lib/auth-middleware.js";
import { openEntry } from "../crypto/data-keys.js";
import { makeKeyCache } from "../lib/memory/keys.js";
import { MemoryIndexes } from "../lib/memory/indexes.js";
import { writeAudit } from "../lib/audit.js";
import { PRECISE_SNIPPETS } from "../lib/memory/precise.js";
import { serverFileKey } from "../lib/servers.js";
import { getContent, releaseContents } from "../lib/memory/file-store.js";
import type { FileMeta } from "../lib/memory/store.js";
import { ok, err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";

export interface MemoryRouteDeps {
  sessionStore: SessionStore;
}

interface EntryPayload {
  command?: string;
  output?: string;
  cwd?: string | null;
  by?: string | null;
  file?: FileMeta;
}

export const memoryRoutes: (deps: MemoryRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const auth = requireUnlocked(deps.sessionStore);
    // Per-login in-memory search indexes; each is dropped when its login session is destroyed.
    const indexes = new MemoryIndexes(app.skiffDb.raw, deps.sessionStore);
    app.addHook("onClose", async () => { indexes.closeAll(); });

    const isTeam = (): boolean => {
      const meta = app.skiffDb.raw.prepare("SELECT mode FROM vault_meta WHERE id = 1").get() as { mode?: string } | undefined;
      return meta?.mode === "team";
    };

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

      const keys = makeKeyCache(app.skiffDb.raw, req.vaultKey);
      const entries = [];
      try {
        for (const row of rows) {
          const key = keys.get(row.key_id);
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
            kind: row.kind,
            command: payload.command ?? "",
            cwd: payload.cwd ?? null,
            by: row.kind === "pause" ? (payload.by ?? null) : null,
            exitCode: row.exit_code,
            confidence: row.confidence,
            flags: JSON.parse(row.flags),
            ended: row.finished_at ? "exited" : "running",
            // File changes: the list carries the summary only; the diff comes with the entry.
            ...(row.kind === "file" && payload.file
              ? { added: payload.file.added, removed: payload.file.removed, change: payload.file.change, note: payload.file.note }
              : {}),
          });
        }
      } finally {
        keys.dispose();
      }

      return reply.send(ok({ entries }));
    });

    app.get("/api/memory/entries/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = app.skiffDb.raw.prepare(
        `SELECT me.id, me.kind, me.started_at, me.finished_at, me.exit_code, me.confidence, me.flags,
                me.output_bytes, me.output_pruned, me.user_id, me.nonce, me.data, ms.key_id,
                me.content_old_id, me.content_new_id
           FROM memory_entries me
           JOIN memory_sessions ms ON ms.id = me.memory_session_id
          WHERE me.id = ?`,
      ).get(id) as any | undefined;
      if (!row || (row.kind !== "command" && row.kind !== "file")) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Entry not found"));
      if (isTeam() && !req.sessionUser?.isAdmin && row.user_id !== req.sessionUser?.id) {
        return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Entry not found"));
      }
      const keys = makeKeyCache(app.skiffDb.raw, req.vaultKey);
      let payload: EntryPayload;
      try {
        const key = keys.get(row.key_id);
        if (!key) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Entry not found"));
        payload = JSON.parse(openEntry(key, `memory-entry:${row.id}`, row.nonce, row.data).toString("utf8"));
      } catch {
        return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Entry not found"));
      } finally {
        keys.dispose();
      }
      if (row.kind === "file" && payload.file) {
        return reply.send(ok({
          id: row.id,
          kind: "file",
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          path: payload.command,
          change: payload.file.change,
          added: payload.file.added,
          removed: payload.file.removed,
          note: payload.file.note,
          by: payload.file.by,
          diff: payload.output ?? "",
          diffPruned: !!row.output_pruned,
          flags: JSON.parse(row.flags),
          hasOld: !!row.content_old_id,
          hasNew: !!row.content_new_id,
        }));
      }
      return reply.send(ok({
        id: row.id,
        kind: "command",
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

    // One stored version of a file a file entry refers to (the full text, shown on request).
    app.get("/api/memory/entries/:id/file", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const { version } = req.query as { version?: string };
      const notFound = () => reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Entry not found"));
      if (version !== "old" && version !== "new") return reply.code(400).send(err(ApiErrorCode.VALIDATION_FAILED, "version must be old or new"));
      const db = app.skiffDb.raw;
      const row = db.prepare(
        "SELECT kind, user_id, server_id, content_old_id, content_new_id FROM memory_entries WHERE id = ?",
      ).get(id) as { kind: string; user_id: string | null; server_id: string | null; content_old_id: string | null; content_new_id: string | null } | undefined;
      if (!row || row.kind !== "file" || !row.server_id) return notFound();
      if (isTeam() && !req.sessionUser?.isAdmin && row.user_id !== req.sessionUser?.id) return notFound();
      const contentId = version === "old" ? row.content_old_id : row.content_new_id;
      if (!contentId) return notFound();
      let fileKey: Buffer | null = null;
      try {
        fileKey = serverFileKey(db, row.server_id, req.vaultKey);
        const content = getContent(db, fileKey, contentId);
        if (content === null) return notFound();
        return reply.send(ok({ content }));
      } catch {
        return notFound();
      } finally {
        fileKey?.fill(0);
      }
    });

    app.get("/api/memory/search", { preHandler: auth }, async (req, reply) => {
      const { q, hostId, hosts, user, failed, since, before, beforeId, output, browse, limit, types } = req.query as {
        q?: string; hostId?: string; hosts?: string; user?: string; failed?: string; since?: string;
        before?: string; beforeId?: string; output?: string; browse?: string; limit?: string; types?: string;
      };
      const visibleUserId = isTeam() && !req.sessionUser?.isAdmin ? (req.sessionUser?.id ?? "") : null;
      const index = await indexes.forLogin(req.sessionId, req.vaultKey, visibleUserId);
      const entries = index.search(q ?? "", {
        hostId: hostId || undefined,
        // An explicit list is passed as given, so an unknown or empty id matches nothing.
        hostIds: hosts !== undefined ? hosts.split(",") : undefined,
        // Only a team admin may narrow to one person; for everyone else the parameter is ignored.
        userId: isTeam() && req.sessionUser?.isAdmin ? (user || undefined) : undefined,
        failedOnly: failed === "1",
        since: since || undefined,
        before: before || undefined,
        beforeId: beforeId || undefined,
        includeOutput: output === "1",
        kind: types === "commands" ? "command" : types === "files" ? "file" : undefined,
        browse: browse === "1",
        limit: parseInt(limit ?? "50", 10) || 50,
      });
      return reply.send(ok({ entries }));
    });

    // The exact lines Precise mode types into a shell, so the UI can show them.
    app.get("/api/memory/precise-snippets", { preHandler: auth }, async (_req, reply) => reply.send(ok(PRECISE_SNIPPETS)));

    app.post("/api/memory/notice-seen", { preHandler: auth }, async (req, reply) => {
      const db = app.skiffDb.raw;
      if (isTeam() && req.sessionUser) {
        db.prepare("UPDATE users SET memory_notice_seen = 1 WHERE id = ?").run(req.sessionUser.id);
      } else {
        db.prepare("UPDATE vault_meta SET memory_notice_seen = 1 WHERE id = 1").run();
      }
      return reply.send(ok({ seen: true }));
    });

    app.delete("/api/memory/entries/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const db = app.skiffDb.raw;
      const row = db.prepare(
        `SELECT me.id, me.user_id, me.server_id, me.content_old_id, me.content_new_id, ms.host_id
           FROM memory_entries me JOIN memory_sessions ms ON ms.id = me.memory_session_id
          WHERE me.id = ?`,
      ).get(id) as { id: string; user_id: string | null; server_id: string | null; content_old_id: string | null; content_new_id: string | null; host_id: string | null } | undefined;
      if (!row) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Entry not found"));
      if (isTeam() && !req.sessionUser?.isAdmin && row.user_id !== req.sessionUser?.id) {
        return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Entry not found"));
      }
      db.prepare("DELETE FROM memory_entries WHERE id = ?").run(id);
      // File versions only this entry referred to go with it.
      if (row.server_id) releaseContents(db, row.server_id, [row.content_old_id, row.content_new_id].filter((c): c is string => !!c));
      await indexes.forget(id);
      if (req.sessionUser) {
        writeAudit(db, {
          user: req.sessionUser, action: "memory.forget", resourceType: "memory_entry", resourceId: id,
          detail: { hostId: row.host_id, ownerUserId: row.user_id }, ip: req.ip,
        });
      }
      return reply.send(ok({ id }));
    });
  };
