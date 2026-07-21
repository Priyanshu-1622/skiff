import type { Config } from "../config.js";

export function sessionCookieOptions(config: Config) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: 86400 * 30,
    secure: config.nodeEnv === "production",
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
    secure: config.nodeEnv === "production",
  };
}
