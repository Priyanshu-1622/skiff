import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { generateKdfParams, deriveVaultKey, computeVerifier } from "../crypto/vault.js";
import { generateSharedKey, provisionUser } from "../crypto/team-vault.js";
import type { SessionStore } from "../crypto/session-store.js";
import type { Config } from "../config.js";
import { sessionCookieOptions } from "../lib/cookie.js";
import { ok, err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";
import { SCHEMA_VERSION } from "../db/client.js";
import { generateId } from "../lib/id.js";
import { writeAudit } from "../lib/audit.js";

const PasswordBody = z.object({ password: z.string().min(1).max(256) });
const SetupBody = z.object({
  password: z.string().min(8).max(256),
  mode: z.enum(["personal", "team"]).default("personal"),
  // Required when mode === 'team': the first admin's username.
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/).optional(),
});

export interface AuthRouteDeps {
  sessionStore: SessionStore;
  config: Config;
}

export const authRoutes: (deps: AuthRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const { sessionStore, config } = deps;

    app.get("/api/vault/status", async (req) => {
      const db = app.skiffDb.raw;
      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as
        | { idle_timeout_minutes: number; mode?: string } | undefined;
      const sessionId = req.cookies?.skiff_session;
      const entry = sessionId ? sessionStore.getEntry(sessionId) : null;
      return ok({
        initialized: !!meta,
        unlocked: !!entry,
        mode: meta?.mode ?? "personal",
        idleTimeoutMinutes: meta?.idle_timeout_minutes ?? 15,
        user: entry?.user ?? null,
      });
    });

    app.post("/api/vault/setup", async (req, reply) => {
      const db = app.skiffDb.raw;
      const existing = db.prepare("SELECT id FROM vault_meta WHERE id = 1").get();
      if (existing) {
        return reply.code(409).send(err(ApiErrorCode.VALIDATION_FAILED, "Vault already initialized"));
      }

      const body = SetupBody.parse(req.body);

      if (body.mode === "team") {
        if (!body.username) {
          return reply.code(400).send(err(ApiErrorCode.VALIDATION_FAILED, "Team setup requires a username"));
        }
        const sharedKey = generateSharedKey();
        const provisioned = await provisionUser(body.password, sharedKey);
        const now = new Date().toISOString();

        db.prepare(
          `INSERT INTO vault_meta (id, schema_version, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, mode, created_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, 'team', ?)`
        ).run(
          SCHEMA_VERSION,
          provisioned.kdf.salt, provisioned.kdf.iterations, provisioned.kdf.memoryKib, provisioned.kdf.parallelism,
          provisioned.verifier, now,
        );

        const userId = generateId("usr");
        db.prepare(
          `INSERT INTO users (id, username, display_name, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, shared_key_blob, shared_key_nonce, is_admin, disabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`
        ).run(
          userId, body.username, null,
          provisioned.kdf.salt, provisioned.kdf.iterations, provisioned.kdf.memoryKib, provisioned.kdf.parallelism,
          provisioned.verifier, provisioned.sharedKeyBlob, provisioned.sharedKeyNonce, now,
        );

        const sessionUser = { id: userId, username: body.username, isAdmin: true };
        const sessionId = sessionStore.create(sharedKey, sessionUser);
        sharedKey.fill(0);
        reply.setCookie("skiff_session", sessionId, sessionCookieOptions(config));
        writeAudit(db, { user: sessionUser, action: "vault.setup", detail: { mode: "team" }, ip: req.ip });
        return ok({ message: "Team vault initialized", mode: "team", user: sessionUser });
      }

      // personal mode (unchanged behaviour)
      const params = generateKdfParams();
      const vaultKey = await deriveVaultKey(body.password, params);
      const verifier = computeVerifier(vaultKey);

      db.prepare(
        `INSERT INTO vault_meta (id, schema_version, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, mode, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, 'personal', ?)`
      ).run(SCHEMA_VERSION, params.salt, params.iterations, params.memoryKib, params.parallelism, verifier, new Date().toISOString());

      const sessionId = sessionStore.create(vaultKey);
      reply.setCookie("skiff_session", sessionId, sessionCookieOptions(config));
      return ok({ message: "Vault initialized and unlocked", mode: "personal" });
    });

    app.post("/api/vault/unlock", {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      handler: async (req, reply) => {
        const db = app.skiffDb.raw;
        const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as any;
        if (!meta) {
          return reply.code(400).send(err(ApiErrorCode.VAULT_NOT_INITIALIZED, "Run setup first"));
        }
        // In team mode, unlocking is done per-user via /api/team/login. The
        // personal unlock path would create a session with no user identity
        // (no audit attribution, no admin flag), so refuse it here.
        if (meta.mode === "team") {
          return reply.code(400).send(err(ApiErrorCode.WRONG_MODE, "This is a team vault — sign in with your username"));
        }

        const recentFails = db
          .prepare("SELECT COUNT(*) as cnt FROM unlock_attempts WHERE succeeded = 0 AND attempted_at > datetime('now', '-5 minutes')")
          .get() as { cnt: number };
        if (recentFails.cnt >= 5) {
          return reply.code(429).send(err(ApiErrorCode.RATE_LIMITED, "Too many failed attempts. Try again later."));
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
        db.prepare("INSERT INTO unlock_attempts (attempted_at, succeeded) VALUES (datetime('now'), ?)").run(valid ? 1 : 0);
        // Keep the table from growing forever — drop rows older than a day.
        db.prepare("DELETE FROM unlock_attempts WHERE attempted_at < datetime('now', '-1 day')").run();

        if (!valid) {
          vaultKey.fill(0);
          return reply.code(401).send(err(ApiErrorCode.INVALID_PASSWORD, "Incorrect password"));
        }

        const sessionId = sessionStore.create(vaultKey);
        reply.setCookie("skiff_session", sessionId, sessionCookieOptions(config));
        return ok({ message: "Vault unlocked" });
      },
    });

    app.post("/api/vault/lock", async (req, reply) => {
      const sessionId = req.cookies?.skiff_session;
      if (sessionId) {
        sessionStore.destroy(sessionId);
        reply.clearCookie("skiff_session", { path: "/" });
      }
      return ok({ message: "Vault locked" });
    });
  };
