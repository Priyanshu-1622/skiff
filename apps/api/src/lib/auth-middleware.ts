import type { FastifyRequest, FastifyReply } from "fastify";
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

    req.vaultKey = entry.vaultKey;
    req.sessionId = sessionId;
    req.sessionUser = entry.user;
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
    req.vaultKey = entry.vaultKey;
    req.sessionId = sessionId;
    req.sessionUser = entry.user;
  };
}
