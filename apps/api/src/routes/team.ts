/**
 * Team-mode routes: login, logout, and user management.
 *
 * These only operate when the vault is in 'team' mode. In personal mode
 * they return WRONG_MODE. The shared vault key is unsealed on login and
 * held in the session (same slot personal mode uses for its vault key),
 * so all existing host/credential routes work unchanged regardless of
 * mode — they just call req.vaultKey.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { SessionStore } from "../crypto/session-store.js";
import type { Config } from "../config.js";
import { sessionCookieOptions } from "../lib/cookie.js";
import { requireUnlocked, requireAdmin } from "../lib/auth-middleware.js";
import { ok, err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";
import { generateId } from "../lib/id.js";
import { writeAudit } from "../lib/audit.js";
import {
  provisionUser,
  unlockSharedKey,
} from "../crypto/team-vault.js";

export interface TeamRouteDeps {
  sessionStore: SessionStore;
  config: Config;
}

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
    const { sessionStore, config } = deps;
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

        // Per-username lockout: 5 fails in 5 minutes
        const recentFails = db
          .prepare(
            "SELECT COUNT(*) as cnt FROM login_attempts WHERE username = ? AND succeeded = 0 AND attempted_at > datetime('now','-5 minutes')"
          )
          .get(body.username) as { cnt: number };
        if (recentFails.cnt >= 5) {
          return reply.code(429).send(err(ApiErrorCode.RATE_LIMITED, "Too many attempts. Try later."));
        }

        const user = db
          .prepare("SELECT * FROM users WHERE username = ?")
          .get(body.username) as any;

        const logAttempt = (ok0: boolean) => {
          db.prepare(
            "INSERT INTO login_attempts (username, attempted_at, succeeded) VALUES (?, datetime('now'), ?)"
          ).run(body.username, ok0 ? 1 : 0);
          db.prepare("DELETE FROM login_attempts WHERE attempted_at < datetime('now','-1 day')").run();
        };

        // Run unseal even if user is missing? No — but avoid leaking which
        // usernames exist via timing is out of scope; we just deny.
        if (!user || user.disabled) {
          logAttempt(false);
          return reply.code(401).send(err(ApiErrorCode.INVALID_PASSWORD, "Invalid credentials"));
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

        if (!sharedKey) {
          logAttempt(false);
          return reply.code(401).send(err(ApiErrorCode.INVALID_PASSWORD, "Invalid credentials"));
        }

        logAttempt(true);
        // Clear this user's failed attempts so a success resets the lockout.
        db.prepare("DELETE FROM login_attempts WHERE username = ? AND succeeded = 0").run(body.username);
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
          user: { id: user.id, username: user.username, displayName: user.display_name, isAdmin: sessionUser.isAdmin },
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
          `INSERT INTO users (id, username, display_name, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, shared_key_blob, shared_key_nonce, is_admin, disabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
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
        `UPDATE users SET kdf_salt=?, kdf_iterations=?, kdf_memory_kib=?, kdf_parallelism=?, verifier=?, shared_key_blob=?, shared_key_nonce=? WHERE id=?`
      ).run(
        provisioned.kdf.salt, provisioned.kdf.iterations, provisioned.kdf.memoryKib, provisioned.kdf.parallelism,
        provisioned.verifier, provisioned.sharedKeyBlob, provisioned.sharedKeyNonce, body.userId,
      );

      // Force re-login everywhere for that user.
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
      if (disabled) sessionStore.destroyUserSessions(id);

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
