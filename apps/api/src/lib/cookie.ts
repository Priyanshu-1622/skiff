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
