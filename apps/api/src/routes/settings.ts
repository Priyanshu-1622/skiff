import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { deriveVaultKey, computeVerifier, generateKdfParams, encrypt, decrypt } from "../crypto/vault.js";
import type { SessionStore } from "../crypto/session-store.js";
import type { Config } from "../config.js";
import { sessionCookieOptions } from "../lib/cookie.js";
import { requireUnlocked } from "../lib/auth-middleware.js";
import { ok, err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";

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
  };
