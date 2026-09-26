/**
 * Team-mode routes: login, logout, and user management.
 *
 * These only operate when the vault is in 'team' mode. In personal mode
 * they return WRONG_MODE. The shared vault key is unsealed on login and
 * held in the session (same slot personal mode uses for its vault key),
 * so all existing host/credential routes work unchanged regardless of
 * mode — they just call req.vaultKey.
 */

import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import type { SessionStore } from "../crypto/session-store.js";
import { type SessionManager, ownerKeyFor } from "../lib/session-manager.js";
import type { Config } from "../config.js";
import { sessionCookieOptions, cookieWouldBeDropped, INSECURE_TRANSPORT_MESSAGE } from "../lib/cookie.js";
import { requireUnlocked, requireAdmin } from "../lib/auth-middleware.js";
import { ok, err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";
import { generateId } from "../lib/id.js";
import { writeAudit } from "../lib/audit.js";
import type { AttemptLimiter } from "../lib/attempt-limiter.js";
import { deriveVaultKey, generateKdfParams } from "../crypto/vault.js";
import {
  provisionUser,
  unlockSharedKey,
} from "../crypto/team-vault.js";

export interface TeamRouteDeps {
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  config: Config;
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

// Unknown and disabled usernames still pay for one argon2 derivation, so the
// response time doesn't reveal which usernames exist.
const DUMMY_KDF = generateKdfParams();


const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

const CreateUserBody = z.object({
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, "letters, numbers, . _ - only"),
  displayName: z.string().max(120).optional(),
  tempPassword: z.string().min(8).max(256),
  isAdmin: z.boolean().default(false),
});

const ReprovisionBody = z.object({
  userId: z.string().min(1),
  tempPassword: z.string().min(8).max(256),
});

function getMode(db: any): string {
  const meta = db.prepare("SELECT mode FROM vault_meta WHERE id = 1").get() as
    | { mode?: string } | undefined;
  return meta?.mode ?? "personal";
}

export const teamRoutes: (deps: TeamRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const { sessionStore, sessionManager, config, attemptLimiter } = deps;
    const adminOnly = requireAdmin(sessionStore);
    const loggedIn = requireUnlocked(sessionStore);

    // ── Team login ───────────────────────────────────────────────
    app.post("/api/team/login", {
      config: { rateLimit: { max: 8, timeWindow: "1 minute" } },
      handler: async (req, reply) => {
        const db = app.skiffDb.raw;
        if (getMode(db) !== "team") {
          return reply.code(400).send(err(ApiErrorCode.WRONG_MODE, "Not a team vault"));
        }

        const body = LoginBody.parse(req.body);

        // Backoff per client, not per username: keying on the username would
        // let anyone lock a colleague out just by typing their name wrong.
        if (cookieWouldBeDropped(req, config)) {
          return reply.code(400).send(err(ApiErrorCode.INSECURE_TRANSPORT, INSECURE_TRANSPORT_MESSAGE));
        }
        const limiterKey = `login:${req.ip}`;
        const waitMs = attemptLimiter.retryAfterMs(limiterKey);
        if (waitMs > 0) return tooManyAttempts(reply, waitMs);

        const user = db
          .prepare("SELECT * FROM users WHERE username = ?")
          .get(body.username) as any;

        const fail = () => {
          attemptLimiter.recordFailure(limiterKey);
          writeAudit(db, {
            action: "login.failed", resourceType: "user", resourceId: user?.id,
            detail: { username: body.username }, ip: req.ip,
          });
          return reply.code(401).send(err(ApiErrorCode.INVALID_PASSWORD, "Invalid credentials"));
        };

        if (!user || user.disabled) {
          (await deriveVaultKey(body.password, DUMMY_KDF)).fill(0);
          return fail();
        }

        const sharedKey = await unlockSharedKey(
          body.password,
          {
            algorithm: "argon2id",
            salt: user.kdf_salt,
            iterations: user.kdf_iterations,
            memoryKib: user.kdf_memory_kib,
            parallelism: user.kdf_parallelism,
          },
          user.verifier,
          user.shared_key_blob,
          user.shared_key_nonce,
        );

        if (!sharedKey) return fail();
        attemptLimiter.recordSuccess(limiterKey);
        const sessionUser = {
          id: user.id,
          username: user.username,
          isAdmin: user.is_admin === 1,
        };
        const sessionId = sessionStore.create(sharedKey, sessionUser);
        sharedKey.fill(0);
        reply.setCookie("skiff_session", sessionId, sessionCookieOptions(config));
        writeAudit(db, { user: sessionUser, action: "login", ip: req.ip });
        return ok({
          user: {
            id: user.id, username: user.username, displayName: user.display_name,
            isAdmin: sessionUser.isAdmin, mustChangePassword: user.must_change_password === 1,
          },
        });
      },
    });

    // ── Who am I ─────────────────────────────────────────────────
    app.get("/api/team/me", { preHandler: loggedIn }, async (req, reply) => {
      if (!req.sessionUser) {
        return reply.code(400).send(err(ApiErrorCode.WRONG_MODE, "Not a team session"));
      }
      return ok({ user: req.sessionUser });
    });

    // ── Change my own password ───────────────────────────────────
    // Members get a temporary password from an admin; this is how they replace
    // it (and change it later). Re-seals the shared key to the new password —
    // no credential is re-encrypted, and nobody else is affected.
    app.post("/api/team/me/password", { preHandler: loggedIn }, async (req, reply) => {
      const me = req.sessionUser;
      if (!me) return reply.code(400).send(err(ApiErrorCode.WRONG_MODE, "Not a team session"));
      const body = z.object({
        currentPassword: z.string().min(1).max(256),
        newPassword: z.string().min(8).max(256),
      }).parse(req.body);
      if (body.newPassword === body.currentPassword) {
        return reply.code(400).send(err(ApiErrorCode.VALIDATION_FAILED, "The new password must be different."));
      }

      // Same guessing protection as sign-in: a stolen, unlocked browser must
      // not become a way to brute-force the member's real password.
      const limiterKey = `pwchange:${me.id}`;
      const waitMs = attemptLimiter.retryAfterMs(limiterKey);
      if (waitMs > 0) return tooManyAttempts(reply, waitMs);

      const db = app.skiffDb.raw;
      const row = db.prepare("SELECT * FROM users WHERE id = ?").get(me.id) as any;
      if (!row || row.disabled) return reply.code(403).send(err(ApiErrorCode.FORBIDDEN, "Account disabled"));

      const sharedKey = await unlockSharedKey(
        body.currentPassword,
        { algorithm: "argon2id", salt: row.kdf_salt, iterations: row.kdf_iterations, memoryKib: row.kdf_memory_kib, parallelism: row.kdf_parallelism },
        row.verifier, row.shared_key_blob, row.shared_key_nonce,
      );
      if (!sharedKey) {
        attemptLimiter.recordFailure(limiterKey);
        return reply.code(401).send(err(ApiErrorCode.INVALID_PASSWORD, "Current password is wrong"));
      }
      attemptLimiter.recordSuccess(limiterKey);

      const provisioned = await provisionUser(body.newPassword, sharedKey);
      sharedKey.fill(0);
      db.prepare(
        `UPDATE users SET kdf_salt=?, kdf_iterations=?, kdf_memory_kib=?, kdf_parallelism=?, verifier=?, shared_key_blob=?, shared_key_nonce=?, must_change_password=0 WHERE id=?`
      ).run(
        provisioned.kdf.salt, provisioned.kdf.iterations, provisioned.kdf.memoryKib, provisioned.kdf.parallelism,
        provisioned.verifier, provisioned.sharedKeyBlob, provisioned.sharedKeyNonce, me.id,
      );

      // Sign out this member's other browsers (the password they used is no
      // longer valid) but keep this one, and leave their SSH sessions running.
      sessionStore.destroyUserSessions(me.id, req.sessionId);
      writeAudit(db, { user: me, action: "user.password_change", resourceType: "user", resourceId: me.id, ip: req.ip });
      return ok({ changed: true });
    });

    // ── List users (admin) ───────────────────────────────────────
    app.get("/api/team/users", { preHandler: adminOnly }, async () => {
      const db = app.skiffDb.raw;
      const users = db
        .prepare("SELECT id, username, display_name, is_admin, disabled, created_at FROM users ORDER BY created_at")
        .all() as any[];
      return ok(users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        isAdmin: u.is_admin === 1,
        disabled: u.disabled === 1,
        createdAt: u.created_at,
      })));
    });

    // ── Create user (admin) ──────────────────────────────────────
    // The admin's session holds the shared key, so we can seal a copy of
    // it to the new user's temp-password KEK.
    app.post("/api/team/users", { preHandler: adminOnly }, async (req, reply) => {
      const db = app.skiffDb.raw;
      const body = CreateUserBody.parse(req.body);

      const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(body.username);
      if (exists) {
        return reply.code(409).send(err(ApiErrorCode.CONFLICT, "Username already taken"));
      }

      // req.vaultKey is the unsealed shared key for this admin's session.
      const provisioned = await provisionUser(body.tempPassword, req.vaultKey);
      const id = generateId("usr");
      try {
        db.prepare(
          `INSERT INTO users (id, username, display_name, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, shared_key_blob, shared_key_nonce, is_admin, disabled, must_change_password, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`
        ).run(
          id, body.username, body.displayName ?? null,
          provisioned.kdf.salt, provisioned.kdf.iterations, provisioned.kdf.memoryKib, provisioned.kdf.parallelism,
          provisioned.verifier, provisioned.sharedKeyBlob, provisioned.sharedKeyNonce,
          body.isAdmin ? 1 : 0, new Date().toISOString(),
        );
      } catch (e: any) {
        // Race: another request created this username between the check and here.
        if (String(e?.message).includes("UNIQUE")) {
          return reply.code(409).send(err(ApiErrorCode.CONFLICT, "Username already taken"));
        }
        throw e;
      }

      writeAudit(db, {
        user: req.sessionUser, action: "user.create",
        resourceType: "user", resourceId: id,
        detail: { username: body.username, isAdmin: body.isAdmin }, ip: req.ip,
      });
      return ok({ id, username: body.username });
    });

    // ── Re-provision user / reset password (admin) ───────────────
    // For the "forgot password" case. Admin's session holds the shared
    // key, so we reseal it to a fresh temp-password KEK. No data is lost
    // because all credentials are encrypted with the shared key, not the
    // user's personal key.
    app.post("/api/team/users/reprovision", { preHandler: adminOnly }, async (req, reply) => {
      const db = app.skiffDb.raw;
      const body = ReprovisionBody.parse(req.body);

      const target = db.prepare("SELECT id, username FROM users WHERE id = ?").get(body.userId) as any;
      if (!target) {
        return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "User not found"));
      }

      const provisioned = await provisionUser(body.tempPassword, req.vaultKey);
      db.prepare(
        `UPDATE users SET kdf_salt=?, kdf_iterations=?, kdf_memory_kib=?, kdf_parallelism=?, verifier=?, shared_key_blob=?, shared_key_nonce=?, must_change_password=1 WHERE id=?`
      ).run(
        provisioned.kdf.salt, provisioned.kdf.iterations, provisioned.kdf.memoryKib, provisioned.kdf.parallelism,
        provisioned.verifier, provisioned.sharedKeyBlob, provisioned.sharedKeyNonce, body.userId,
      );

      // Cut any SSH session they have open — a reset usually means the account
      // may be compromised — then force re-login everywhere. Sessions first:
      // ending the logins first would detach their terminals with "your session
      // is still running", which is exactly what is not true here.
      sessionManager.endByOwner(ownerKeyFor({ id: body.userId, username: target.username, isAdmin: false }), "Your password was reset by an admin");
      sessionStore.destroyUserSessions(body.userId);

      writeAudit(db, {
        user: req.sessionUser, action: "user.reprovision",
        resourceType: "user", resourceId: body.userId,
        detail: { username: target.username }, ip: req.ip,
      });
      return ok({ id: body.userId, message: "User re-provisioned. They can log in with the temporary password." });
    });

    // ── Enable/disable user (admin) ──────────────────────────────
    app.post("/api/team/users/:id/disabled", { preHandler: adminOnly }, async (req, reply) => {
      const db = app.skiffDb.raw;
      const { id } = req.params as { id: string };
      const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);

      const target = db.prepare("SELECT id, username, is_admin FROM users WHERE id = ?").get(id) as any;
      if (!target) return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "User not found"));

      // Don't allow disabling the last admin.
      if (disabled && target.is_admin === 1) {
        const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE is_admin = 1 AND disabled = 0").get() as { c: number };
        if (adminCount.c <= 1) {
          return reply.code(409).send(err(ApiErrorCode.CONFLICT, "Cannot disable the last admin"));
        }
      }

      db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, id);
      if (disabled) {
        // Sessions before logins — see the reprovision route for why.
        sessionManager.endByOwner(ownerKeyFor({ id, username: target.username, isAdmin: false }), "Your account was disabled");
        sessionStore.destroyUserSessions(id);
      }

      writeAudit(db, {
        user: req.sessionUser, action: disabled ? "user.disable" : "user.enable",
        resourceType: "user", resourceId: id, detail: { username: target.username }, ip: req.ip,
      });
      return ok({ id, disabled });
    });

    // ── Audit log (admin) ────────────────────────────────────────
    app.get("/api/team/audit", { preHandler: adminOnly }, async (req) => {
      const db = app.skiffDb.raw;
      const q = z.object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.string().optional(),
      }).parse(req.query);

      const rows = q.before
        ? db.prepare("SELECT * FROM audit_log WHERE at < ? ORDER BY at DESC LIMIT ?").all(q.before, q.limit)
        : db.prepare("SELECT * FROM audit_log ORDER BY at DESC LIMIT ?").all(q.limit);

      return ok((rows as any[]).map((r) => {
        let detail = null;
        if (r.detail) {
          try { detail = JSON.parse(r.detail); }
          catch { detail = null; } // never let one bad row break the whole log
        }
        return {
          id: r.id, username: r.username, action: r.action,
          resourceType: r.resource_type, resourceId: r.resource_id,
          detail, ip: r.ip, at: r.at,
        };
      }));
    });
  };
