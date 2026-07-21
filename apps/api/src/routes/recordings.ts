import type { FastifyPluginAsync } from "fastify";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SessionStore } from "../crypto/session-store.js";
import type { SessionManager } from "../lib/session-manager.js";
import { requireUnlocked } from "../lib/auth-middleware.js";
import { writeAudit } from "../lib/audit.js";
import { ok, err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";

export interface RecordingsRouteDeps {
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  dataDir: string;
}

/**
 * Access model for recordings:
 *   - Personal mode: single user, all recordings are visible.
 *   - Team mode: a member sees only their own recordings; an admin sees all.
 * This mirrors the audit-log visibility rules.
 */
export const recordingsRoutes: (deps: RecordingsRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const auth = requireUnlocked(deps.sessionStore);
    const recordingsDir = join(deps.dataDir, "recordings");

    const isTeam = (): boolean => {
      const meta = app.skiffDb.raw
        .prepare("SELECT mode FROM vault_meta WHERE id = 1")
        .get() as { mode?: string } | undefined;
      return meta?.mode === "team";
    };

    // Returns the recording row only if the requester is allowed to see it.
    const getAccessibleRecording = (req: any, id: string): any | null => {
      const db = app.skiffDb.raw;
      const rec = db.prepare("SELECT * FROM session_recordings WHERE id = ?").get(id) as any;
      if (!rec) return null;
      if (isTeam() && !req.sessionUser?.isAdmin) {
        if (rec.user_id !== req.sessionUser?.id) return null; // not yours
      }
      return rec;
    };

    // ── List recordings ───────────────────────────────────────
    app.get("/api/recordings", { preHandler: auth }, async (req) => {
      const db = app.skiffDb.raw;
      let rows: any[];
      if (isTeam() && !req.sessionUser?.isAdmin) {
        rows = db
          .prepare("SELECT * FROM session_recordings WHERE user_id = ? ORDER BY started_at DESC LIMIT 500")
          .all(req.sessionUser?.id ?? null) as any[];
      } else {
        rows = db
          .prepare("SELECT * FROM session_recordings ORDER BY started_at DESC LIMIT 500")
          .all() as any[];
      }
      return ok(rows.map((r) => ({
        id: r.id,
        hostId: r.host_id,
        hostLabel: r.host_label,
        hostname: r.hostname,
        userId: r.user_id,
        username: r.username,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationMs: r.duration_ms,
        bytes: r.bytes,
        status: r.status,
      })));
    });

    // ── Playback data (the raw asciicast file) ────────────────
    app.get("/api/recordings/:id/cast", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      // Defense-in-depth: ids are generated as [a-z0-9_]; reject anything else
      // so a crafted id can never escape the recordings directory.
      if (!/^[a-z0-9_]+$/.test(id)) {
        return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Recording not found"));
      }
      const rec = getAccessibleRecording(req, id);
      if (!rec) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Recording not found"));

      const filePath = join(recordingsDir, `${id}.cast`);
      try {
        await stat(filePath); // 404 if the file is missing despite the row
      } catch {
        return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Recording file not found"));
      }
      reply.header("Content-Type", "application/x-asciicast");
      reply.header("Cache-Control", "private, no-store");
      return reply.send(createReadStream(filePath));
    });

    // ── Delete a recording (row + file) ───────────────────────
    app.delete("/api/recordings/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const db = app.skiffDb.raw;
      const rec = getAccessibleRecording(req, id);
      if (!rec) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Recording not found"));

      // Don't allow deleting a recording that's still being written.
      const live = deps.sessionManager
        .list()
        .some((s) => s.hostId === rec.host_id && !s.closed && s.onOutput);
      if (rec.status === "recording" && live) {
        return reply.code(409).send(err(ApiErrorCode.CONFLICT, "Recording is still in progress"));
      }

      db.prepare("DELETE FROM session_recordings WHERE id = ?").run(id);
      try { await unlink(join(recordingsDir, `${id}.cast`)); } catch { /* file already gone */ }

      writeAudit(db, {
        user: req.sessionUser, action: "recording.delete",
        resourceType: "recording", resourceId: id,
        detail: { hostLabel: rec.host_label, username: rec.username },
        ip: req.ip,
      });
      return ok({ deleted: true });
    });
  };
