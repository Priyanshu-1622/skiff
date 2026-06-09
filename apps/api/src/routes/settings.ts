import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { deriveVaultKey, computeVerifier, generateKdfParams, encrypt, decrypt } from "../crypto/vault.js";
import { provisionUser } from "../crypto/team-vault.js";
import type { SessionStore } from "../crypto/session-store.js";
import type { Config } from "../config.js";
import { sessionCookieOptions } from "../lib/cookie.js";
import { requireUnlocked } from "../lib/auth-middleware.js";
import { writeAudit } from "../lib/audit.js";
import { ok, err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";
import { generateId } from "../lib/id.js";

export interface SettingsRouteDeps {
  sessionStore: SessionStore;
  config: Config;
}

export const settingsRoutes: (deps: SettingsRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const { sessionStore, config } = deps;
    const auth = requireUnlocked(sessionStore);

    app.put("/api/settings/password", { preHandler: auth }, async (req, reply) => {
      const body = z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8).max(256),
      }).parse(req.body);

      const db = app.skiffDb.raw;
      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as any;
      if (!meta) return reply.code(400).send(err(ApiErrorCode.VAULT_NOT_INITIALIZED, "No vault"));
      // This route changes the single personal master password and re-encrypts
      // every credential under a new key. In team mode that would break every
      // other member's access, and the per-user password isn't stored here.
      // Team password changes go through admin reprovision (or a future
      // per-user change flow), so refuse here.
      if (meta.mode === "team") {
        return reply.code(400).send(err(ApiErrorCode.WRONG_MODE, "In team mode, ask an admin to reset your password"));
      }

      const currentKey = await deriveVaultKey(body.currentPassword, {
        algorithm: "argon2id",
        salt: meta.kdf_salt,
        iterations: meta.kdf_iterations,
        memoryKib: meta.kdf_memory_kib,
        parallelism: meta.kdf_parallelism,
      });
      if (!Buffer.from(computeVerifier(currentKey)).equals(Buffer.from(meta.verifier))) {
        return reply.code(401).send(err(ApiErrorCode.INVALID_PASSWORD, "Current password is wrong"));
      }

      const newParams = generateKdfParams();
      const newKey = await deriveVaultKey(body.newPassword, newParams);
      const newVerifier = computeVerifier(newKey);
      const creds = db.prepare("SELECT * FROM credentials").all() as any[];
      const updateCred = db.prepare("UPDATE credentials SET nonce = ?, encrypted_blob = ? WHERE id = ?");

      db.transaction(() => {
        for (const cred of creds) {
          const plaintext = decrypt(Buffer.from(cred.encrypted_blob), Buffer.from(cred.nonce), currentKey);
          const { nonce, ciphertext } = encrypt(plaintext, newKey);
          updateCred.run(nonce, ciphertext, cred.id);
        }
        db.prepare(
          `UPDATE vault_meta SET kdf_salt=?, kdf_iterations=?, kdf_memory_kib=?, kdf_parallelism=?, verifier=? WHERE id=1`
        ).run(newParams.salt, newParams.iterations, newParams.memoryKib, newParams.parallelism, newVerifier);
      })();

      sessionStore.destroyAll();
      const sessionId = sessionStore.create(newKey);
      reply.setCookie("skiff_session", sessionId, sessionCookieOptions(config));
      return ok({ message: "Password changed" });
    });

    app.put("/api/settings/idle-timeout", { preHandler: auth }, async (req) => {
      const body = z.object({ minutes: z.number().int().min(1).max(1440) }).parse(req.body);
      app.skiffDb.raw.prepare("UPDATE vault_meta SET idle_timeout_minutes = ? WHERE id = 1").run(body.minutes);
      sessionStore.setIdleTimeout(body.minutes);
      return ok({ idleTimeoutMinutes: body.minutes });
    });

    app.get("/api/settings/backup", { preHandler: auth }, async () => {
      const db = app.skiffDb.raw;
      const hosts = db.prepare("SELECT * FROM hosts").all();
      const folders = db.prepare("SELECT * FROM folders").all();
      const credentials = db.prepare("SELECT * FROM credentials").all();
      const knownHosts = db.prepare("SELECT * FROM known_hosts").all();
      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get();
      const normalizedMeta = meta ? {
        ...(meta as any),
        kdf_salt: Buffer.from((meta as any).kdf_salt).toString("base64"),
        verifier: Buffer.from((meta as any).verifier).toString("base64"),
      } : null;
      return ok({
        version: 1,
        exportedAt: new Date().toISOString(),
        vaultMeta: normalizedMeta,
        folders, hosts,
        credentials: credentials.map((c: any) => ({
          ...c,
          nonce: Buffer.from(c.nonce).toString("base64"),
          encrypted_blob: Buffer.from(c.encrypted_blob).toString("base64"),
        })),
        knownHosts,
      });
    });

    // ── Upgrade Personal → Team ──────────────────────────────────
    // Converts a personal vault into a team vault. The existing vault key
    // (which already encrypts all credentials) becomes the shared key, so
    // NO credential re-encryption is needed. We just create the first admin
    // user with that key sealed to their password, and flip the mode.
    // Requires the current master password to confirm.
    app.post("/api/settings/upgrade-team", { preHandler: auth }, async (req, reply) => {
      const db = app.skiffDb.raw;
      const body = z.object({
        currentPassword: z.string().min(1),
        adminUsername: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
      }).parse(req.body);

      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as any;
      if (!meta) return reply.code(400).send(err(ApiErrorCode.VAULT_NOT_INITIALIZED, "No vault"));
      if (meta.mode === "team") {
        return reply.code(409).send(err(ApiErrorCode.CONFLICT, "Already a team vault"));
      }

      // Verify the current master password and recover the vault key.
      const vaultKey = await deriveVaultKey(body.currentPassword, {
        algorithm: "argon2id",
        salt: meta.kdf_salt, iterations: meta.kdf_iterations,
        memoryKib: meta.kdf_memory_kib, parallelism: meta.kdf_parallelism,
      });
      if (!Buffer.from(computeVerifier(vaultKey)).equals(Buffer.from(meta.verifier))) {
        vaultKey.fill(0);
        return reply.code(401).send(err(ApiErrorCode.INVALID_PASSWORD, "Incorrect password"));
      }

      // The vault key becomes the shared key. Seal it to the admin's password.
      const provisioned = await provisionUser(body.currentPassword, vaultKey);
      const userId = generateId("usr");
      const now = new Date().toISOString();

      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO users (id, username, display_name, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, shared_key_blob, shared_key_nonce, is_admin, disabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`
        ).run(
          userId, body.adminUsername, null,
          provisioned.kdf.salt, provisioned.kdf.iterations, provisioned.kdf.memoryKib, provisioned.kdf.parallelism,
          provisioned.verifier, provisioned.sharedKeyBlob, provisioned.sharedKeyNonce, now,
        );
        db.prepare("UPDATE vault_meta SET mode = 'team' WHERE id = 1").run();
      });
      tx();

      // Re-issue the current session as this admin user.
      const sessionUser = { id: userId, username: body.adminUsername, isAdmin: true };
      sessionStore.destroy(req.sessionId);
      const sessionId = sessionStore.create(vaultKey, sessionUser);
      vaultKey.fill(0);
      reply.setCookie("skiff_session", sessionId, sessionCookieOptions(config));

      writeAudit(db, { user: sessionUser, action: "vault.upgrade_team", detail: { adminUsername: body.adminUsername }, ip: req.ip });
      return ok({ mode: "team", user: sessionUser });
    });

    // ── Restore from backup ──────────────────────────────────────
    // Imports a backup from GET /api/settings/backup. Only allowed on an
    // UNINITIALIZED instance — restoring over an existing vault would mix
    // credentials encrypted under different keys and corrupt things. After
    // restore the user unlocks with the ORIGINAL vault's password (the
    // backup carries that vault's KDF params + verifier).
    app.post("/api/settings/restore", async (req, reply) => {
      const db = app.skiffDb.raw;
      const existing = db.prepare("SELECT id FROM vault_meta WHERE id = 1").get();
      if (existing) {
        return reply.code(409).send(err(ApiErrorCode.CONFLICT, "A vault already exists here. Restore only works on a fresh instance."));
      }

      const Backup = z.object({
        version: z.literal(1),
        vaultMeta: z.object({
          schema_version: z.number(),
          kdf_salt: z.string(),
          kdf_iterations: z.number(),
          kdf_memory_kib: z.number(),
          kdf_parallelism: z.number(),
          verifier: z.string(),
          idle_timeout_minutes: z.number().optional(),
          created_at: z.string().optional(),
        }),
        folders: z.array(z.any()).default([]),
        hosts: z.array(z.any()).default([]),
        credentials: z.array(z.any()).default([]),
        knownHosts: z.array(z.any()).default([]),
      });

      const body = Backup.parse(req.body);
      const m = body.vaultMeta;

      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO vault_meta (id, schema_version, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, idle_timeout_minutes, mode, created_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'personal', ?)`
        ).run(
          m.schema_version,
          Buffer.from(m.kdf_salt, "base64"),
          m.kdf_iterations, m.kdf_memory_kib, m.kdf_parallelism,
          Buffer.from(m.verifier, "base64"),
          m.idle_timeout_minutes ?? 15,
          m.created_at ?? new Date().toISOString(),
        );

        for (const f of body.folders) {
          db.prepare("INSERT INTO folders (id, parent_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(f.id, f.parent_id ?? null, f.name, f.position ?? 0, f.created_at ?? new Date().toISOString());
        }
        for (const c of body.credentials) {
          db.prepare("INSERT INTO credentials (id, kind, nonce, encrypted_blob, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(c.id, c.kind, Buffer.from(c.nonce, "base64"), Buffer.from(c.encrypted_blob, "base64"), c.created_at ?? new Date().toISOString());
        }
        for (const h of body.hosts) {
          db.prepare(
            `INSERT INTO hosts (id, folder_id, label, hostname, port, username, auth_method, credential_id, tags, starred, created_at, last_connected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            h.id, h.folder_id ?? null, h.label, h.hostname, h.port, h.username,
            h.auth_method, h.credential_id ?? null,
            typeof h.tags === "string" ? h.tags : JSON.stringify(h.tags ?? []),
            h.starred ? 1 : 0, h.created_at ?? new Date().toISOString(), h.last_connected_at ?? null,
          );
        }
        for (const k of body.knownHosts) {
          db.prepare("INSERT INTO known_hosts (hostname, port, fingerprint, algorithm, first_seen_at) VALUES (?, ?, ?, ?, ?)")
            .run(k.hostname, k.port, k.fingerprint, k.algorithm ?? "unknown", k.first_seen_at ?? new Date().toISOString());
        }
      });
      tx();

      return ok({
        message: "Backup restored. Unlock with the password from the original vault.",
        counts: { hosts: body.hosts.length, folders: body.folders.length, credentials: body.credentials.length },
      });
    });
  };
