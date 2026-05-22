/**
 * Host + Folder CRUD routes.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ok, err } from "../lib/response.js";
import { generateId } from "../lib/id.js";
import { encrypt, decrypt } from "../crypto/vault.js";
import type { SessionStore } from "../crypto/session-store.js";
import { requireUnlocked } from "../lib/auth-middleware.js";
import { ApiErrorCode } from "@skiff/shared";

const HostInput = z.object({
  label: z.string().min(1).max(200),
  hostname: z.string().min(1).max(500),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(200),
  folderId: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  starred: z.boolean().default(false),
  authMethod: z.enum(["password", "key", "key+passphrase"]),
  credential: z.object({
    kind: z.enum(["password", "key", "key+passphrase"]),
    value: z.string().min(1),
    passphrase: z.string().optional(),
  }).optional(),
});

const FolderInput = z.object({
  name: z.string().min(1).max(200),
  parentId: z.string().nullable().default(null),
});

export interface HostRouteDeps {
  sessionStore: SessionStore;
}

export const hostRoutes: (deps: HostRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const auth = requireUnlocked(deps.sessionStore);

    // ─── Folders ─────────────────────────────────────────────

    app.get("/api/folders", { preHandler: auth }, async () => {
      const rows = app.skiffDb.raw
        .prepare("SELECT * FROM folders ORDER BY position ASC, name ASC")
        .all();
      return ok(rows);
    });

    app.post("/api/folders", { preHandler: auth }, async (req) => {
      const body = FolderInput.parse(req.body);
      const id = generateId("fld");
      const maxPos = (body.parentId === null
        ? app.skiffDb.raw.prepare("SELECT COALESCE(MAX(position), 0) + 1 as p FROM folders WHERE parent_id IS NULL").get()
        : app.skiffDb.raw.prepare("SELECT COALESCE(MAX(position), 0) + 1 as p FROM folders WHERE parent_id = ?").get(body.parentId)) as { p: number };

      app.skiffDb.raw.prepare(
        "INSERT INTO folders (id, parent_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(id, body.parentId, body.name, maxPos.p, new Date().toISOString());

      const row = app.skiffDb.raw.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      return ok(row);
    });

    app.put("/api/folders/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = FolderInput.parse(req.body);
      const result = app.skiffDb.raw.prepare(
        "UPDATE folders SET name = ?, parent_id = ? WHERE id = ?"
      ).run(body.name, body.parentId, id);
      if (result.changes === 0) {
        return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Folder not found"));
      }
      return ok(app.skiffDb.raw.prepare("SELECT * FROM folders WHERE id = ?").get(id));
    });

    app.delete("/api/folders/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = app.skiffDb.raw.prepare("DELETE FROM folders WHERE id = ?").run(id);
      if (result.changes === 0) {
        return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Folder not found"));
      }
      return ok({ deleted: true });
    });

    // ─── Hosts ───────────────────────────────────────────────

    app.get("/api/hosts", { preHandler: auth }, async (req) => {
      const { folderId, search, starred } = req.query as {
        folderId?: string; search?: string; starred?: string;
      };
      let sql = "SELECT * FROM hosts WHERE 1=1";
      const params: unknown[] = [];

      if (folderId) { sql += " AND folder_id = ?"; params.push(folderId); }
      if (starred === "true") { sql += " AND starred = 1"; }
      if (search) {
        sql += " AND (label LIKE ? OR hostname LIKE ? OR username LIKE ?)";
        const term = `%${search}%`;
        params.push(term, term, term);
      }
      sql += " ORDER BY starred DESC, (last_connected_at IS NULL), last_connected_at DESC, label ASC";

      const rows = app.skiffDb.raw.prepare(sql).all(...params);
      return ok(rows.map(normalizeHost));
    });

    app.get("/api/hosts/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = app.skiffDb.raw.prepare("SELECT * FROM hosts WHERE id = ?").get(id);
      if (!row) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Host not found"));
      return ok(normalizeHost(row));
    });

    app.post("/api/hosts", { preHandler: auth }, async (req) => {
      const body = HostInput.parse(req.body);
      const hostId = generateId("hst");
      let credentialId: string | null = null;

      if (body.credential) {
        credentialId = generateId("crd");
        const plaintext = body.credential.passphrase
          ? JSON.stringify({ value: body.credential.value, passphrase: body.credential.passphrase })
          : body.credential.value;
        const encrypted = encrypt(plaintext, req.vaultKey);
        app.skiffDb.raw.prepare(
          "INSERT INTO credentials (id, kind, nonce, encrypted_blob, created_at) VALUES (?, ?, ?, ?, ?)"
        ).run(credentialId, body.credential.kind, encrypted.nonce, encrypted.ciphertext, new Date().toISOString());
      }

      app.skiffDb.raw.prepare(
        `INSERT INTO hosts (id, folder_id, label, hostname, port, username, auth_method, credential_id, tags, starred, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        hostId, body.folderId, body.label, body.hostname, body.port,
        body.username, body.authMethod, credentialId,
        JSON.stringify(body.tags), body.starred ? 1 : 0,
        new Date().toISOString(),
      );

      const row = app.skiffDb.raw.prepare("SELECT * FROM hosts WHERE id = ?").get(hostId);
      return ok(normalizeHost(row));
    });

    app.put("/api/hosts/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = app.skiffDb.raw.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as any;
      if (!existing) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Host not found"));

      const body = HostInput.parse(req.body);
      let credentialId = existing.credential_id;

      if (body.credential) {
        // Remove old credential if exists
        if (credentialId) {
          app.skiffDb.raw.prepare("DELETE FROM credentials WHERE id = ?").run(credentialId);
        }
        credentialId = generateId("crd");
        const plaintext = body.credential.passphrase
          ? JSON.stringify({ value: body.credential.value, passphrase: body.credential.passphrase })
          : body.credential.value;
        const encrypted = encrypt(plaintext, req.vaultKey);
        app.skiffDb.raw.prepare(
          "INSERT INTO credentials (id, kind, nonce, encrypted_blob, created_at) VALUES (?, ?, ?, ?, ?)"
        ).run(credentialId, body.credential.kind, encrypted.nonce, encrypted.ciphertext, new Date().toISOString());
      }

      app.skiffDb.raw.prepare(
        `UPDATE hosts SET folder_id=?, label=?, hostname=?, port=?, username=?,
         auth_method=?, credential_id=?, tags=?, starred=? WHERE id=?`
      ).run(
        body.folderId, body.label, body.hostname, body.port,
        body.username, body.authMethod, credentialId,
        JSON.stringify(body.tags), body.starred ? 1 : 0, id,
      );

      return ok(normalizeHost(app.skiffDb.raw.prepare("SELECT * FROM hosts WHERE id = ?").get(id)));
    });

    app.delete("/api/hosts/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = app.skiffDb.raw.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as any;
      if (!existing) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Host not found"));
      if (existing.credential_id) {
        app.skiffDb.raw.prepare("DELETE FROM credentials WHERE id = ?").run(existing.credential_id);
      }
      app.skiffDb.raw.prepare("DELETE FROM hosts WHERE id = ?").run(id);
      return ok({ deleted: true });
    });
  };

function normalizeHost(row: any) {
  return {
    ...row,
    tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags,
    starred: !!row.starred,
  };
}
