/**
 * Auth middleware: require an unlocked vault for protected routes.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import type { SessionStore } from "../crypto/session-store.js";
import { err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";

declare module "fastify" {
  interface FastifyRequest {
    vaultKey: Buffer;
    sessionId: string;
  }
}

export function requireUnlocked(sessionStore: SessionStore) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionId = req.cookies?.skiff_session;
    if (!sessionId) {
      return reply.code(401).send(err(ApiErrorCode.VAULT_LOCKED, "Vault is locked"));
    }

    const vaultKey = sessionStore.get(sessionId);
    if (!vaultKey) {
      reply.clearCookie("skiff_session", { path: "/" });
      return reply.code(401).send(err(ApiErrorCode.VAULT_LOCKED, "Session expired"));
    }

    req.vaultKey = vaultKey;
    req.sessionId = sessionId;
  };
}
