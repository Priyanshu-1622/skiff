import type { FastifyRequest, FastifyReply } from "fastify";
import type Database from "better-sqlite3";
import type { SessionStore, SessionUser } from "../crypto/session-store.js";
import { err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";

declare module "fastify" {
  interface FastifyRequest {
    vaultKey: Buffer;
    sessionId: string;
    /** Present in team mode; undefined in personal mode. */
    sessionUser?: SessionUser;
  }
}

export function requireUnlocked(sessionStore: SessionStore) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionId = req.cookies?.skiff_session;
    if (!sessionId) {
      return reply.code(401).send(err(ApiErrorCode.VAULT_LOCKED, "Vault is locked"));
    }

    const entry = sessionStore.getEntry(sessionId);
    if (!entry) {
      reply.clearCookie("skiff_session", { path: "/" });
      return reply.code(401).send(err(ApiErrorCode.VAULT_LOCKED, "Session expired"));
    }

    // A private copy per request, wiped when the response is sent (see
    // app.ts). The session's own buffer is zeroed the moment the vault locks;
    // a request mid-way through argon2 with that buffer would carry on with
    // an all-zero key — e.g. seal a new member's access to zeros.
    req.vaultKey = Buffer.from(entry.vaultKey);
    req.sessionId = sessionId;
    req.sessionUser = entry.user;
  };
}

/**
 * Guard for vault-wide actions (settings, backup, deleting recordings).
 * In personal mode the one person who can unlock the vault owns it, so being
 * unlocked is enough. In team mode only admins may do these — otherwise any
 * member could, say, switch off session recording before doing something.
 */
export function requireVaultOwner(sessionStore: SessionStore, db: Database.Database) {
  const unlocked = requireUnlocked(sessionStore);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await unlocked(req, reply);
    if (reply.sent) return;
    const meta = db.prepare("SELECT mode FROM vault_meta WHERE id = 1").get() as
      | { mode?: string } | undefined;
    if (meta?.mode === "team" && !req.sessionUser?.isAdmin) {
      return reply.code(403).send(err(ApiErrorCode.FORBIDDEN, "Only a team admin can do this"));
    }
  };
}

/**
 * Guard for admin-only routes in team mode. Self-contained: validates
 * the session and admin flag in one place so there's no reliance on
 * reply.sent bookkeeping. Must only be used on team-mode routes.
 */
export function requireAdmin(sessionStore: SessionStore) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionId = req.cookies?.skiff_session;
    if (!sessionId) {
      return reply.code(401).send(err(ApiErrorCode.VAULT_LOCKED, "Vault is locked"));
    }
    const entry = sessionStore.getEntry(sessionId);
    if (!entry) {
      reply.clearCookie("skiff_session", { path: "/" });
      return reply.code(401).send(err(ApiErrorCode.VAULT_LOCKED, "Session expired"));
    }
    if (!entry.user?.isAdmin) {
      return reply.code(403).send(err(ApiErrorCode.FORBIDDEN, "Admin access required"));
    }
    // A private copy per request, wiped when the response is sent (see
    // app.ts). The session's own buffer is zeroed the moment the vault locks;
    // a request mid-way through argon2 with that buffer would carry on with
    // an all-zero key — e.g. seal a new member's access to zeros.
    req.vaultKey = Buffer.from(entry.vaultKey);
    req.sessionId = sessionId;
    req.sessionUser = entry.user;
  };
}
