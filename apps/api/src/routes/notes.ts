import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { SessionStore } from "../crypto/session-store.js";
import { requireUnlocked } from "../lib/auth-middleware.js";
import { openEntry } from "../crypto/data-keys.js";
import { makeKeyCache } from "../lib/memory/keys.js";
import { writeAudit } from "../lib/audit.js";
import {
  MAX_NOTE_CHARS, appendToNote, createSnippet, deleteSnippet, formatPin, getNote, getSnippet, listSnippets, putNote, updateSnippet,
  type NoteResult,
} from "../lib/memory/vault-docs.js";
import type { FileMeta } from "../lib/memory/store.js";
import { ok, err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";

export interface NotesRouteDeps { sessionStore: SessionStore }

/** Host notes, "Pin to notes", and the snippet library (all sealed under the vault key). */
export const notesRoutes: (deps: NotesRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const auth = requireUnlocked(deps.sessionStore);
    const db = () => app.skiffDb.raw;
    const isTeam = (): boolean => {
      const meta = db().prepare("SELECT mode FROM vault_meta WHERE id = 1").get() as { mode?: string } | undefined;
      return meta?.mode === "team";
    };
    const hostExists = (id: string) => !!db().prepare("SELECT 1 FROM hosts WHERE id = ?").get(id);
    const noteBody = (n: { text: string; version: number; updatedAt: string; updatedBy: string | null }) =>
      ({ text: n.text, version: n.version, updatedAt: n.updatedAt || null, updatedBy: n.updatedBy });
    const noteFailure = (reply: any, r: Extract<NoteResult, { ok: false }>) => {
      if (r.reason === "conflict") {
        return reply.code(409).send({ ok: false, error: { code: ApiErrorCode.CONFLICT, message: "This note was changed by someone else", current: r.current ? noteBody(r.current) : null } });
      }
      if (r.reason === "too-long") return reply.code(413).send(err(ApiErrorCode.VALIDATION_FAILED, `Notes are limited to ${MAX_NOTE_CHARS} characters`));
      return reply.code(409).send(err(ApiErrorCode.VALIDATION_FAILED, "This note can't be read with the current key"));
    };

    app.get("/api/hosts/:id/notes", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!hostExists(id)) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Host not found"));
      const note = getNote(db(), req.vaultKey, id);
      if (!note) return reply.code(409).send(err(ApiErrorCode.VALIDATION_FAILED, "This note can't be read with the current key"));
      return reply.send(ok(noteBody(note)));
    });

    app.put("/api/hosts/:id/notes", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z.object({ text: z.string(), baseVersion: z.number().int().min(0) }).parse(req.body);
      if (!hostExists(id)) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Host not found"));
      const r = putNote(db(), req.vaultKey, id, body.text, body.baseVersion, req.sessionUser?.username ?? null);
      if (!r.ok) return noteFailure(reply, r);
      writeAudit(db(), { user: req.sessionUser, action: "host.notes", resourceType: "host", resourceId: id, detail: { length: body.text.length, version: r.note.version }, ip: req.ip });
      return reply.send(ok(noteBody(r.note)));
    });

    // Append an entry (a command or a file change) to its host's note.
    app.post("/api/memory/entries/:id/pin", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const notFound = () => reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Entry not found"));
      const row = db().prepare(
        `SELECT me.kind, me.started_at, me.exit_code, me.user_id, me.nonce, me.data, ms.key_id, ms.host_id
           FROM memory_entries me JOIN memory_sessions ms ON ms.id = me.memory_session_id WHERE me.id = ?`,
      ).get(id) as any;
      if (!row || (row.kind !== "command" && row.kind !== "file") || !row.host_id) return notFound();
      if (isTeam() && !req.sessionUser?.isAdmin && row.user_id !== req.sessionUser?.id) return notFound();
      const keys = makeKeyCache(db(), req.vaultKey);
      let payload: { command: string; output: string; cwd: string | null; file?: FileMeta };
      try {
        const key = keys.get(row.key_id);
        if (!key) return notFound();
        payload = JSON.parse(openEntry(key, `memory-entry:${id}`, row.nonce, row.data).toString("utf8"));
      } catch {
        return notFound();
      } finally {
        keys.dispose();
      }
      const block = formatPin({
        kind: row.kind === "file" ? "file" : "command", command: payload.command, startedAt: row.started_at,
        exitCode: row.exit_code, cwd: payload.cwd, file: payload.file, diff: row.kind === "file" ? payload.output : undefined,
      });
      const r = appendToNote(db(), req.vaultKey, row.host_id, block, req.sessionUser?.username ?? null);
      if (!r.ok) return noteFailure(reply, r);
      writeAudit(db(), { user: req.sessionUser, action: "host.notes.pin", resourceType: "host", resourceId: row.host_id, detail: { entryId: id, version: r.note.version }, ip: req.ip });
      return reply.send(ok({ hostId: row.host_id, ...noteBody(r.note) }));
    });

    // ── Snippets ──
    const snippetBody = z.object({ name: z.string().trim().min(1).max(100), command: z.string().min(1).max(4000) });
    const view = (s: { id: string; name: string; command: string; username: string | null; userId: string | null; createdAt: string; updatedAt: string }) =>
      ({ id: s.id, name: s.name, command: s.command, by: isTeam() ? s.username : null, createdAt: s.createdAt, updatedAt: s.updatedAt });
    const canChange = (req: any, ownerId: string | null) => !isTeam() || !!req.sessionUser?.isAdmin || ownerId === req.sessionUser?.id;

    app.get("/api/snippets", { preHandler: auth }, async (req, reply) => reply.send(ok({ snippets: listSnippets(db(), req.vaultKey).map(view) })));

    app.post("/api/snippets", { preHandler: auth }, async (req, reply) => {
      const body = snippetBody.parse(req.body);
      const s = createSnippet(db(), req.vaultKey, { ...body, userId: req.sessionUser?.id ?? null, username: req.sessionUser?.username ?? null });
      writeAudit(db(), { user: req.sessionUser, action: "snippet.create", resourceType: "snippet", resourceId: s.id, ip: req.ip });
      return reply.send(ok(view(s)));
    });

    app.put("/api/snippets/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = snippetBody.partial().refine((b) => b.name !== undefined || b.command !== undefined, { message: "name or command is required" }).parse(req.body);
      const current = getSnippet(db(), req.vaultKey, id);
      if (!current) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Snippet not found"));
      if (!canChange(req, current.userId)) return reply.code(403).send(err(ApiErrorCode.FORBIDDEN, "Only the author or an admin can change this snippet"));
      const s = updateSnippet(db(), req.vaultKey, id, body)!;
      writeAudit(db(), { user: req.sessionUser, action: "snippet.update", resourceType: "snippet", resourceId: id, ip: req.ip });
      return reply.send(ok(view(s)));
    });

    app.delete("/api/snippets/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const current = getSnippet(db(), req.vaultKey, id);
      if (!current) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Snippet not found"));
      if (!canChange(req, current.userId)) return reply.code(403).send(err(ApiErrorCode.FORBIDDEN, "Only the author or an admin can change this snippet"));
      deleteSnippet(db(), id);
      writeAudit(db(), { user: req.sessionUser, action: "snippet.delete", resourceType: "snippet", resourceId: id, ip: req.ip });
      return reply.send(ok({ id }));
    });
  };
