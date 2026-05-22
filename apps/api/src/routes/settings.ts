/**
 * Settings routes: change password, update idle timeout, backup/restore.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { deriveVaultKey, computeVerifier, generateKdfParams, encrypt, decrypt } from "../crypto/vault.js";
import type { SessionStore } from "../crypto/session-store.js";
import { requireUnlocked } from "../lib/auth-middleware.js";
import { ok, err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";

export interface SettingsRouteDeps {
  sessionStore: SessionStore;
}

export const settingsRoutes: (deps: SettingsRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const auth = requireUnlocked(deps.sessionStore);

    // ─── PUT /api/settings/password ─────────────────────────────
    app.put("/api/settings/password", { preHandler: auth }, async (req, reply) => {
      const body = z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(1).max(256),
      }).parse(req.body);

      const db = app.skiffDb.raw;
      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as any;
      if (!meta) return reply.code(400).send(err(ApiErrorCode.VAULT_NOT_INITIALIZED, "No vault"));

      // Verify current password
      const currentKey = await deriveVaultKey(body.currentPassword, {
        algorithm: "argon2id",
        salt: meta.kdf_salt,
        iterations: meta.kdf_iterations,
        memoryKib: meta.kdf_memory_kib,
        parallelism: meta.kdf_parallelism,
      });
      const currentVerifier = computeVerifier(currentKey);
      if (!Buffer.from(currentVerifier).equals(Buffer.from(meta.verifier))) {
        return reply.code(401).send(err(ApiErrorCode.INVALID_PASSWORD, "Current password is wrong"));
      }

      // Re-encrypt all credentials with new key
      const newParams = generateKdfParams();
      const newKey = await deriveVaultKey(body.newPassword, newParams);
      const newVerifier = computeVerifier(newKey);

      const creds = db.prepare("SELECT * FROM credentials").all() as any[];
      const updateCred = db.prepare("UPDATE credentials SET nonce = ?, encrypted_blob = ? WHERE id = ?");

      db.transaction(() => {
        for (const cred of creds) {
          const plaintext = decrypt(
            Buffer.from(cred.encrypted_blob),
            Buffer.from(cred.nonce),
            currentKey,
          );
          const { nonce, ciphertext } = encrypt(plaintext, newKey);
          updateCred.run(nonce, ciphertext, cred.id);
        }
        db.prepare(
          `UPDATE vault_meta SET kdf_salt=?, kdf_iterations=?, kdf_memory_kib=?, kdf_parallelism=?, verifier=? WHERE id=1`
        ).run(newParams.salt, newParams.iterations, newParams.memoryKib, newParams.parallelism, newVerifier);
      })();

      // Invalidate old sessions, create new one
      deps.sessionStore.destroyAll();
      const sessionId = deps.sessionStore.create(newKey);
      reply.setCookie("skiff_session", sessionId, {
        path: "/", httpOnly: true, sameSite: "lax", maxAge: 86400 * 30,
      });

      return ok({ message: "Password changed" });
    });

    // ─── PUT /api/settings/idle-timeout ─────────────────────────
    app.put("/api/settings/idle-timeout", { preHandler: auth }, async (req) => {
      const body = z.object({ minutes: z.number().int().min(1).max(1440) }).parse(req.body);
      app.skiffDb.raw.prepare("UPDATE vault_meta SET idle_timeout_minutes = ? WHERE id = 1").run(body.minutes);
      deps.sessionStore.setIdleTimeout(body.minutes);
      return ok({ idleTimeoutMinutes: body.minutes });
    });

    // ─── GET /api/settings/backup ───────────────────────────────
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
        folders,
        hosts,
        credentials: credentials.map((c: any) => ({
          ...c,
          nonce: Buffer.from(c.nonce).toString("base64"),
          encrypted_blob: Buffer.from(c.encrypted_blob).toString("base64"),
        })),
        knownHosts,
      });
    });
  };
