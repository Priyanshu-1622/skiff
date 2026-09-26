import type { FastifyRequest } from "fastify";
import type { Config } from "../config.js";

/** Production cookies are Secure (HTTPS-only) unless explicitly allowed. */
function secureCookies(config: Config): boolean {
  return config.nodeEnv === "production" && !config.allowInsecureHttp;
}

/**
 * Would the browser throw away a Secure session cookie on this request?
 *
 * In production the cookie is HTTPS-only. Opened over plain HTTP from
 * another machine, the browser silently drops it and the user lands back on
 * the login screen after typing the right password — a loop with no clue why.
 * Browsers treat localhost as secure, so local access is fine. Behind a TLS
 * proxy this relies on SKIFF_TRUST_PROXY so req.protocol reflects the
 * original https.
 */
export function cookieWouldBeDropped(req: FastifyRequest, config: Config): boolean {
  if (!secureCookies(config)) return false;
  if (req.protocol === "https") return false;
  const host = req.hostname.replace(/^\[|\]$/g, "");
  return !(host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1");
}

export const INSECURE_TRANSPORT_MESSAGE =
  "This page is open over plain HTTP, so your browser would throw away the login and send you straight back here. " +
  "Open Skiff over HTTPS (see docs/DEPLOYMENT.md), or — only on a network you trust — set SKIFF_INSECURE_HTTP=true.";

export function sessionCookieOptions(config: Config) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: 86400 * 30,
    secure: secureCookies(config),
  };
}

/**
 * Options for clearing the session cookie. A cookie is only removed by the
 * browser when the clearing response matches the original's path, sameSite,
 * httpOnly and secure attributes — passing only { path } can leave the cookie
 * in place (so the user appears still logged in). Mirror the set attributes.
 */
export function clearSessionCookieOptions(config: Config) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: secureCookies(config),
  };
}
