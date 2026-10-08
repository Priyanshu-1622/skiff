import type { FastifyPluginAsync } from "fastify";
// ssh2 is CommonJS: Node can't see `utils` as a named ESM export (the import
// typechecks but throws at startup), so take it off the default export.
import ssh2 from "ssh2";
const sshUtils = ssh2.utils;
import { z } from "zod";
import { ok, err } from "../lib/response.js";
import { generateId } from "../lib/id.js";
import { encrypt, decrypt } from "../crypto/vault.js";
import type { SessionStore } from "../crypto/session-store.js";
import { requireUnlocked, requireVaultOwner } from "../lib/auth-middleware.js";
import { writeAudit } from "../lib/audit.js";
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

type CredentialInput = NonNullable<z.infer<typeof HostInput>["credential"]>;

/**
 * Check a credential before storing it, and settle its kind from what it is
 * rather than from which tab the form was on. A private key that can't be
 * parsed — or an encrypted one saved without its passphrase — used to be
 * accepted and only fail later, at connect time, with an ssh2 error.
 * Returns an error message, or the normalised credential.
 */
function checkCredential(c: CredentialInput): { error: string } | { cred: CredentialInput } {
  if (c.kind === "password") return { cred: { kind: "password", value: c.value } };

  const passphrase = c.passphrase || undefined;
  const parsed = sshUtils.parseKey(c.value.trim(), passphrase);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) {
    const msg = key instanceof Error ? key.message : "";
    if (/passphrase/i.test(msg) && !passphrase) {
      return { error: "This private key is encrypted. Enter its passphrase too." };
    }
    if (/passphrase|decrypt/i.test(msg)) {
      return { error: "That passphrase doesn't unlock this private key." };
    }
    return { error: "That doesn't look like a private key. Paste the whole file, including the BEGIN and END lines." };
  }
  if (typeof key.isPrivateKey === "function" && !key.isPrivateKey()) {
    return { error: "That's a public key. Paste the private key (the file without .pub)." };
  }
  return passphrase
    ? { cred: { kind: "key+passphrase", value: c.value.trim(), passphrase } }
    : { cred: { kind: "key", value: c.value.trim() } };
}

export interface HostRouteDeps {
  sessionStore: SessionStore;
}

export const hostRoutes: (deps: HostRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const auth = requireUnlocked(deps.sessionStore);
    const ownerOnly = requireVaultOwner(deps.sessionStore, app.skiffDb.raw);

    const folderExists = (id: string | null) =>
      id === null || !!app.skiffDb.raw.prepare("SELECT 1 FROM folders WHERE id = ?").get(id);

    /** Would making `parentId` the parent of `id` create a loop? */
    const wouldCycle = (id: string, parentId: string | null): boolean => {
      const db = app.skiffDb.raw;
      for (let cur = parentId, hops = 0; cur; hops++) {
        if (cur === id || hops > 1000) return true;
        cur = (db.prepare("SELECT parent_id FROM folders WHERE id = ?").get(cur) as { parent_id: string | null } | undefined)?.parent_id ?? null;
      }
      return false;
    };

    // Validates the parts of a host body that zod can't: the folder exists
    // and any new credential is usable. Returns the credential to store.
    const checkHostBody = (body: z.infer<typeof HostInput>): { error: string } | { cred: CredentialInput | undefined } => {
      if (!folderExists(body.folderId)) return { error: "That folder doesn't exist." };
      if (!body.credential) return { cred: undefined };
      return checkCredential(body.credential);
    };

    app.get("/api/folders", { preHandler: auth }, async () => {
      const rows = app.skiffDb.raw
        .prepare("SELECT * FROM folders ORDER BY position ASC, name ASC")
        .all();
      return ok(rows);
    });

    app.post("/api/folders", { preHandler: auth }, async (req, reply) => {
      const body = FolderInput.parse(req.body);
      if (!folderExists(body.parentId)) {
        return reply.code(400).send(err(ApiErrorCode.VALIDATION_FAILED, "Parent folder doesn't exist."));
      }
      const id = generateId("fld");
      const maxPos = (body.parentId === null
        ? app.skiffDb.raw.prepare("SELECT COALESCE(MAX(position), 0) + 1 as p FROM folders WHERE parent_id IS NULL").get()
        : app.skiffDb.raw.prepare("SELECT COALESCE(MAX(position), 0) + 1 as p FROM folders WHERE parent_id = ?").get(body.parentId)) as { p: number };

      app.skiffDb.raw.prepare(
        "INSERT INTO folders (id, parent_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(id, body.parentId, body.name, maxPos.p, new Date().toISOString());

      const row = app.skiffDb.raw.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      writeAudit(app.skiffDb.raw, {
        user: req.sessionUser, action: "folder.create",
        resourceType: "folder", resourceId: id, detail: { name: body.name }, ip: req.ip,
      });
      return ok(row);
    });

    app.put("/api/folders/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = FolderInput.parse(req.body);
      if (!folderExists(body.parentId)) {
        return reply.code(400).send(err(ApiErrorCode.VALIDATION_FAILED, "Parent folder doesn't exist."));
      }
      if (wouldCycle(id, body.parentId)) {
        return reply.code(400).send(err(ApiErrorCode.VALIDATION_FAILED, "A folder can't be moved inside itself."));
      }
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
      const db = app.skiffDb.raw;
      const tx = db.transaction(() => {
        // Explicitly detach hosts so they fall back to "All hosts" even if
        // the FK cascade isn't active on this connection.
        db.prepare("UPDATE hosts SET folder_id = NULL WHERE folder_id = ?").run(id);
        db.prepare("UPDATE folders SET parent_id = NULL WHERE parent_id = ?").run(id);
        return db.prepare("DELETE FROM folders WHERE id = ?").run(id);
      });
      const result = tx();
      if (result.changes === 0) {
        return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Folder not found"));
      }
      return ok({ deleted: true });
    });

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

    app.post("/api/hosts", { preHandler: auth }, async (req, reply) => {
      const body = HostInput.parse(req.body);
      const checked = checkHostBody(body);
      if ("error" in checked) return reply.code(400).send(err(ApiErrorCode.VALIDATION_FAILED, checked.error));
      const cred = checked.cred;
      if (cred) body.authMethod = cred.kind;
      const hostId = generateId("hst");
      let credentialId: string | null = null;

      if (cred) {
        credentialId = generateId("crd");
        const plaintext = cred.passphrase
          ? JSON.stringify({ value: cred.value, passphrase: cred.passphrase })
          : cred.value;
        const encrypted = encrypt(plaintext, req.vaultKey);
        app.skiffDb.raw.prepare(
          "INSERT INTO credentials (id, kind, nonce, encrypted_blob, created_at) VALUES (?, ?, ?, ?, ?)"
        ).run(credentialId, cred.kind, encrypted.nonce, encrypted.ciphertext, new Date().toISOString());
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
      writeAudit(app.skiffDb.raw, {
        user: req.sessionUser, action: "host.create",
        resourceType: "host", resourceId: hostId,
        detail: { label: body.label, hostname: body.hostname }, ip: req.ip,
      });
      return ok(normalizeHost(row));
    });

    app.put("/api/hosts/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = app.skiffDb.raw.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as any;
      if (!existing) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Host not found"));

      const body = HostInput.parse(req.body);
      const checked = checkHostBody(body);
      if ("error" in checked) return reply.code(400).send(err(ApiErrorCode.VALIDATION_FAILED, checked.error));
      const cred = checked.cred;
      // A new credential decides the auth method. Without one, keep the stored
      // method: switching the form's tab without supplying a new secret must
      // not leave the host claiming "key" while holding a password.
      if (cred) body.authMethod = cred.kind;
      else if (existing.credential_id) body.authMethod = existing.auth_method;
      const db = app.skiffDb.raw;

      const tx = db.transaction(() => {
        let credentialId = existing.credential_id;
        if (cred) {
          const newCredId = generateId("crd");
          const plaintext = cred.passphrase
            ? JSON.stringify({ value: cred.value, passphrase: cred.passphrase })
            : cred.value;
          const encrypted = encrypt(plaintext, req.vaultKey);
          // Insert the new credential first, then remove the old one — so a
          // failure never leaves the host pointing at a deleted credential.
          db.prepare(
            "INSERT INTO credentials (id, kind, nonce, encrypted_blob, created_at) VALUES (?, ?, ?, ?, ?)"
          ).run(newCredId, cred.kind, encrypted.nonce, encrypted.ciphertext, new Date().toISOString());
          if (credentialId) {
            db.prepare("DELETE FROM credentials WHERE id = ?").run(credentialId);
          }
          credentialId = newCredId;
        }

        db.prepare(
          `UPDATE hosts SET folder_id=?, label=?, hostname=?, port=?, username=?,
           auth_method=?, credential_id=?, tags=?, starred=? WHERE id=?`
        ).run(
          body.folderId, body.label, body.hostname, body.port,
          body.username, body.authMethod, credentialId,
          JSON.stringify(body.tags), body.starred ? 1 : 0, id,
        );
      });
      tx();

      writeAudit(app.skiffDb.raw, {
        user: req.sessionUser, action: "host.update",
        resourceType: "host", resourceId: id,
        detail: { label: body.label, hostname: body.hostname }, ip: req.ip,
      });
      return ok(normalizeHost(db.prepare("SELECT * FROM hosts WHERE id = ?").get(id)));
    });

    // Forget a host's pinned SSH key so the next connection asks to trust the
    // new one — for a server that was legitimately rebuilt. Accepting a changed
    // key is exactly what a man-in-the-middle wants, so it's owner/admin only
    // and audited with the key being forgotten.
    app.put("/api/hosts/:id/memory", { preHandler: ownerOnly }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z.object({
        memoryMode: z.enum(["on", "off"]).optional(),
        preciseMode: z.boolean().optional(),
        snapshots: z.boolean().optional(),
      }).refine((b) => b.memoryMode !== undefined || b.preciseMode !== undefined || b.snapshots !== undefined, { message: "memoryMode, preciseMode or snapshots is required" }).parse(req.body);
      const db = app.skiffDb.raw;
      const host = db.prepare("SELECT id FROM hosts WHERE id = ?").get(id);
      if (!host) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Host not found"));
      if (body.memoryMode !== undefined) db.prepare("UPDATE hosts SET memory_mode = ? WHERE id = ?").run(body.memoryMode, id);
      if (body.preciseMode !== undefined) db.prepare("UPDATE hosts SET precise_mode = ? WHERE id = ?").run(body.preciseMode ? 1 : 0, id);
      if (body.snapshots !== undefined) db.prepare("UPDATE hosts SET snapshots = ? WHERE id = ?").run(body.snapshots ? 1 : 0, id);
      const detail: Record<string, unknown> = {};
      if (body.snapshots !== undefined) detail.snapshots = body.snapshots;
      if (body.memoryMode !== undefined) detail.memoryMode = body.memoryMode;
      if (body.preciseMode !== undefined) detail.preciseMode = body.preciseMode;
      writeAudit(db, { user: req.sessionUser, action: "host.memory", resourceType: "host", resourceId: id, detail, ip: req.ip });
      const now = db.prepare("SELECT memory_mode, precise_mode, snapshots FROM hosts WHERE id = ?").get(id) as { memory_mode: string; precise_mode: number; snapshots: number };
      return reply.send(ok({ id, memoryMode: now.memory_mode, preciseMode: !!now.precise_mode, snapshots: !!now.snapshots }));
    });

    app.delete("/api/hosts/:id/known-host", { preHandler: ownerOnly }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const db = app.skiffDb.raw;
      const host = db.prepare("SELECT hostname, port, label FROM hosts WHERE id = ?").get(id) as any;
      if (!host) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Host not found"));
      const pinned = db.prepare("SELECT fingerprint FROM known_hosts WHERE hostname = ? AND port = ?")
        .get(host.hostname, host.port) as { fingerprint: string } | undefined;
      db.prepare("DELETE FROM known_hosts WHERE hostname = ? AND port = ?").run(host.hostname, host.port);
      writeAudit(db, {
        user: req.sessionUser, action: "host.fingerprint_reset",
        resourceType: "host", resourceId: id,
        detail: { label: host.label, hostname: host.hostname, port: host.port, forgotten: pinned?.fingerprint ?? null },
        ip: req.ip,
      });
      return ok({ reset: !!pinned });
    });

    app.delete("/api/hosts/:id", { preHandler: auth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = app.skiffDb.raw.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as any;
      if (!existing) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Host not found"));
      if (existing.credential_id) {
        app.skiffDb.raw.prepare("DELETE FROM credentials WHERE id = ?").run(existing.credential_id);
      }
      app.skiffDb.raw.prepare("DELETE FROM hosts WHERE id = ?").run(id);
      writeAudit(app.skiffDb.raw, {
        user: req.sessionUser, action: "host.delete",
        resourceType: "host", resourceId: id,
        detail: { label: existing.label, hostname: existing.hostname }, ip: req.ip,
      });
      return ok({ deleted: true });
    });
  };

function normalizeHost(row: any) {
  let tags: unknown = row.tags;
  if (typeof row.tags === "string") {
    try { tags = JSON.parse(row.tags); }
    catch { tags = []; } // a malformed tags blob shouldn't break the whole list
  }
  return {
    ...row,
    tags,
    starred: !!row.starred,
  };
}
