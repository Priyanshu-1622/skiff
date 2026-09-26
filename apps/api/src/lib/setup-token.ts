import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";

/**
 * One-time setup token.
 *
 * Before a vault exists, /api/vault/setup and /api/settings/restore have no
 * account to authenticate against — the first caller becomes the owner. On a
 * server that is reachable before its owner gets to it, that first caller
 * could be anyone. So an uninitialized server prints a random token to its own
 * log, and setup/restore must present it. Reading the server's log proves you
 * operate the server.
 *
 * SKIFF_SETUP_TOKEN pins the token (useful for automated deploys). Once the
 * vault is initialized the token is irrelevant: setup and restore refuse
 * anyway because a vault exists.
 */
export interface SetupGate {
  /** True if setup/restore must present a token. */
  readonly required: boolean;
  /** Whether this request carries the right token (always true if not required). */
  check(req: FastifyRequest): boolean;
}

export const SETUP_TOKEN_HEADER = "x-skiff-setup-token";

export function createSetupGate(opts: {
  /** undefined → generate one; null → gate disabled (tests only). */
  configured: string | null | undefined;
  vaultInitialized: boolean;
  log: FastifyBaseLogger;
}): SetupGate {
  if (opts.configured === null) {
    return { required: false, check: () => true };
  }

  const token = opts.configured ?? randomBytes(16).toString("hex");
  const expected = Buffer.from(token);

  if (!opts.vaultInitialized) {
    opts.log.warn(
      opts.configured
        ? "Vault not initialized. Setup requires the token from SKIFF_SETUP_TOKEN."
        : `Vault not initialized. Setup token: ${token}  (enter it on the setup screen; it changes on every restart until setup is done)`,
    );
  }

  return {
    required: true,
    check(req) {
      const raw = req.headers[SETUP_TOKEN_HEADER];
      const given = Buffer.from(typeof raw === "string" ? raw.trim() : "");
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}
