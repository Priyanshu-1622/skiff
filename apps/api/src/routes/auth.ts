import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { generateKdfParams, deriveVaultKey, computeVerifier, verifierMatches } from "../crypto/vault.js";
import { generateSharedKey, provisionUser } from "../crypto/team-vault.js";
import type { SessionStore } from "../crypto/session-store.js";
import type { Config } from "../config.js";
import { sessionCookieOptions, clearSessionCookieOptions, cookieWouldBeDropped, INSECURE_TRANSPORT_MESSAGE } from "../lib/cookie.js";
import { ok, err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";
import { SCHEMA_VERSION } from "../db/client.js";
import { generateId } from "../lib/id.js";
import { writeAudit } from "../lib/audit.js";
import type { SetupGate } from "../lib/setup-token.js";
import type { AttemptLimiter } from "../lib/attempt-limiter.js";

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
  setupGate: SetupGate;
  attemptLimiter: AttemptLimiter;
}

function tooManyAttempts(reply: FastifyReply, waitMs: number) {
  const seconds = Math.ceil(waitMs / 1000);
  reply.header("Retry-After", String(seconds));
  return reply.code(429).send(err(
    ApiErrorCode.RATE_LIMITED,
    `Too many wrong passwords from this device. Try again in ${seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`}.`,
  ));
}

export const authRoutes: (deps: AuthRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const { sessionStore, config, setupGate, attemptLimiter } = deps;

    const mustChange = (userId: string): boolean => {
      const row = app.skiffDb.raw.prepare("SELECT must_change_password FROM users WHERE id = ?").get(userId) as
        | { must_change_password: number } | undefined;
      return row?.must_change_password === 1;
    };

    app.get("/api/vault/status", async (req, reply) => {
      // Never let the browser (or an intermediate proxy) cache this — a
      // stale "unlocked" response served after logout would bounce the
      // user straight back into the app.
      reply.header("Cache-Control", "no-store");
      const db = app.skiffDb.raw;
      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as
        | { idle_timeout_minutes: number; mode?: string; recording_enabled?: number; memory_enabled?: number; memory_output_days?: number; memory_notice_seen?: number } | undefined;
      const sessionId = req.cookies?.skiff_session;
      const entry = sessionId ? sessionStore.getEntry(sessionId) : null;
      let memoryNoticeSeen: boolean | null = null;
      if (entry) {
        if (entry.user) {
          const u = db.prepare("SELECT memory_notice_seen FROM users WHERE id = ?").get(entry.user.id) as { memory_notice_seen: number } | undefined;
          memoryNoticeSeen = !!u?.memory_notice_seen;
        } else {
          memoryNoticeSeen = !!meta?.memory_notice_seen;
        }
      }
      return ok({
        initialized: !!meta,
        unlocked: !!entry,
        mode: meta?.mode ?? "personal",
        idleTimeoutMinutes: meta?.idle_timeout_minutes ?? 15,
        recordingEnabled: !!meta?.recording_enabled,
        memoryEnabled: meta ? !!meta.memory_enabled : true,
        memoryOutputDays: meta?.memory_output_days ?? 90,
        memoryNoticeSeen,
        setupTokenRequired: !meta && setupGate.required,
        insecureTransport: cookieWouldBeDropped(req, config),
        user: entry?.user ? { ...entry.user, mustChangePassword: mustChange(entry.user.id) } : null,
      });
    });

    app.post("/api/vault/setup", async (req, reply) => {
      const db = app.skiffDb.raw;
      const existing = db.prepare("SELECT id FROM vault_meta WHERE id = 1").get();
      if (existing) {
        return reply.code(409).send(err(ApiErrorCode.VALIDATION_FAILED, "Vault already initialized"));
      }
      if (!setupGate.check(req)) {
        return reply.code(403).send(err(ApiErrorCode.FORBIDDEN, "Setup token missing or incorrect. It is printed in the server log (docker compose logs skiff)."));
      }

      if (cookieWouldBeDropped(req, config)) {
        return reply.code(400).send(err(ApiErrorCode.INSECURE_TRANSPORT, INSECURE_TRANSPORT_MESSAGE));
      }
      const body = SetupBody.parse(req.body);

      if (body.mode === "team") {
        if (!body.username) {
          return reply.code(400).send(err(ApiErrorCode.VALIDATION_FAILED, "Team setup requires a username"));
        }
        const sharedKey = generateSharedKey();
        const provisioned = await provisionUser(body.password, sharedKey);
        if (db.prepare("SELECT id FROM vault_meta WHERE id = 1").get()) {
          sharedKey.fill(0);
          return reply.code(409).send(err(ApiErrorCode.VALIDATION_FAILED, "Vault already initialized"));
        }
        const now = new Date().toISOString();
        const userId = generateId("usr");
        try {
          db.transaction(() => {
            db.prepare(
              `INSERT INTO vault_meta (id, schema_version, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, mode, recording_enabled, created_at)
               VALUES (1, ?, ?, ?, ?, ?, ?, 'team', 1, ?)`
            ).run(
              SCHEMA_VERSION,
              provisioned.kdf.salt, provisioned.kdf.iterations, provisioned.kdf.memoryKib, provisioned.kdf.parallelism,
              provisioned.verifier, now,
            );

            db.prepare(
              `INSERT INTO users (id, username, display_name, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, shared_key_blob, shared_key_nonce, is_admin, disabled, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`
            ).run(
              userId, body.username, null,
              provisioned.kdf.salt, provisioned.kdf.iterations, provisioned.kdf.memoryKib, provisioned.kdf.parallelism,
              provisioned.verifier, provisioned.sharedKeyBlob, provisioned.sharedKeyNonce, now,
            );
          })();
        } catch (e) {
          sharedKey.fill(0);
          throw e;
        }

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
      if (db.prepare("SELECT id FROM vault_meta WHERE id = 1").get()) {
        vaultKey.fill(0);
        return reply.code(409).send(err(ApiErrorCode.VALIDATION_FAILED, "Vault already initialized"));
      }
      const verifier = computeVerifier(vaultKey);

      db.prepare(
        `INSERT INTO vault_meta (id, schema_version, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, mode, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, 'personal', ?)`
      ).run(SCHEMA_VERSION, params.salt, params.iterations, params.memoryKib, params.parallelism, verifier, new Date().toISOString());

      const sessionId = sessionStore.create(vaultKey);
      vaultKey.fill(0);
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

        // Backoff is per client, so someone guessing from elsewhere can never
        // lock the owner out of their own vault.
        if (cookieWouldBeDropped(req, config)) {
          return reply.code(400).send(err(ApiErrorCode.INSECURE_TRANSPORT, INSECURE_TRANSPORT_MESSAGE));
        }
        const limiterKey = `unlock:${req.ip}`;
        const waitMs = attemptLimiter.retryAfterMs(limiterKey);
        if (waitMs > 0) return tooManyAttempts(reply, waitMs);

        const body = PasswordBody.parse(req.body);
        const vaultKey = await deriveVaultKey(body.password, {
          algorithm: "argon2id",
          salt: meta.kdf_salt,
          iterations: meta.kdf_iterations,
          memoryKib: meta.kdf_memory_kib,
          parallelism: meta.kdf_parallelism,
        });

        if (!verifierMatches(computeVerifier(vaultKey), meta.verifier)) {
          vaultKey.fill(0);
          attemptLimiter.recordFailure(limiterKey);
          return reply.code(401).send(err(ApiErrorCode.INVALID_PASSWORD, "Incorrect password"));
        }
        attemptLimiter.recordSuccess(limiterKey);

        const sessionId = sessionStore.create(vaultKey);
        reply.setCookie("skiff_session", sessionId, sessionCookieOptions(config));
        return ok({ message: "Vault unlocked" });
      },
    });

    app.post("/api/vault/lock", async (req, reply) => {
      const sessionId = req.cookies?.skiff_session;
      if (sessionId) {
        const user = sessionStore.getEntry(sessionId)?.user;
        if (user) writeAudit(app.skiffDb.raw, { user, action: "logout", ip: req.ip });
        sessionStore.destroy(sessionId);
      }
      // Clear with the same attributes the cookie was set with, otherwise the
      // browser may keep it and the next status check still looks logged in.
      reply.clearCookie("skiff_session", clearSessionCookieOptions(config));
      return ok({ message: "Vault locked" });
    });
  };
