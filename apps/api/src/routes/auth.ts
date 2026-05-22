/**
 * Auth routes: vault setup, unlock, lock, status.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  generateKdfParams,
  deriveVaultKey,
  computeVerifier,
} from "../crypto/vault.js";
import type { SessionStore } from "../crypto/session-store.js";
import { ok, err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";
import { SCHEMA_VERSION } from "../db/client.js";

const PasswordBody = z.object({ password: z.string().min(1).max(256) });

export interface AuthRouteDeps {
  sessionStore: SessionStore;
}

export const authRoutes: (deps: AuthRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const { sessionStore } = deps;

    // ─── GET /api/vault/status ─────────────────────────────────
    app.get("/api/vault/status", async (req) => {
      const db = app.skiffDb.raw;
      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as
        | { idle_timeout_minutes: number }
        | undefined;

      const sessionId = req.cookies?.skiff_session;
      const unlocked = !!(sessionId && sessionStore.get(sessionId));

      return ok({
        initialized: !!meta,
        unlocked,
        idleTimeoutMinutes: meta?.idle_timeout_minutes ?? 15,
      });
    });

    // ─── POST /api/vault/setup ─────────────────────────────────
    app.post("/api/vault/setup", async (req, reply) => {
      const db = app.skiffDb.raw;
      const existing = db
        .prepare("SELECT id FROM vault_meta WHERE id = 1")
        .get();
      if (existing) {
        return reply
          .code(409)
          .send(err(ApiErrorCode.VALIDATION_FAILED, "Vault already initialized"));
      }

      const body = PasswordBody.parse(req.body);
      const params = generateKdfParams();
      const vaultKey = await deriveVaultKey(body.password, params);
      const verifier = computeVerifier(vaultKey);

      db.prepare(
        `INSERT INTO vault_meta (id, schema_version, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        SCHEMA_VERSION,
        params.salt,
        params.iterations,
        params.memoryKib,
        params.parallelism,
        verifier,
        new Date().toISOString(),
      );

      const sessionId = sessionStore.create(vaultKey);
      reply.setCookie("skiff_session", sessionId, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 86400 * 30, // 30 days
      });

      return ok({ message: "Vault initialized and unlocked" });
    });

    // ─── POST /api/vault/unlock ────────────────────────────────
    app.post("/api/vault/unlock", {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      handler: async (req, reply) => {
        const db = app.skiffDb.raw;
        const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as
          | {
              kdf_salt: Buffer;
              kdf_iterations: number;
              kdf_memory_kib: number;
              kdf_parallelism: number;
              verifier: Buffer;
            }
          | undefined;

        if (!meta) {
          return reply
            .code(400)
            .send(err(ApiErrorCode.VAULT_NOT_INITIALIZED, "Run setup first"));
        }

        // Check rate limit from unlock_attempts table
        const recentFails = db
          .prepare(
            "SELECT COUNT(*) as cnt FROM unlock_attempts WHERE succeeded = 0 AND attempted_at > datetime('now', '-5 minutes')",
          )
          .get() as { cnt: number };

        if (recentFails.cnt >= 5) {
          return reply
            .code(429)
            .send(err(ApiErrorCode.RATE_LIMITED, "Too many failed attempts. Try again later."));
        }

        const body = PasswordBody.parse(req.body);
        const vaultKey = await deriveVaultKey(body.password, {
          algorithm: "argon2id",
          salt: meta.kdf_salt,
          iterations: meta.kdf_iterations,
          memoryKib: meta.kdf_memory_kib,
          parallelism: meta.kdf_parallelism,
        });

        const verifier = computeVerifier(vaultKey);
        const valid = Buffer.from(verifier).equals(Buffer.from(meta.verifier));

        // Log the attempt
        db.prepare(
          "INSERT INTO unlock_attempts (attempted_at, succeeded) VALUES (datetime('now'), ?)",
        ).run(valid ? 1 : 0);

        if (!valid) {
          vaultKey.fill(0);
          return reply
            .code(401)
            .send(err(ApiErrorCode.INVALID_PASSWORD, "Incorrect password"));
        }

        // Clear failed attempts on success
        db.prepare("DELETE FROM unlock_attempts WHERE succeeded = 0").run();

        const sessionId = sessionStore.create(vaultKey);
        reply.setCookie("skiff_session", sessionId, {
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          maxAge: 86400 * 30,
        });

        return ok({ message: "Vault unlocked" });
      },
    });

    // ─── POST /api/vault/lock ──────────────────────────────────
    app.post("/api/vault/lock", async (req, reply) => {
      const sessionId = req.cookies?.skiff_session;
      if (sessionId) {
        sessionStore.destroy(sessionId);
        reply.clearCookie("skiff_session", { path: "/" });
      }
      return ok({ message: "Vault locked" });
    });
  };
