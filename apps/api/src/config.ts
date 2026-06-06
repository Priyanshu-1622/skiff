import { z } from "zod";
import { resolve } from "node:path";

const ConfigSchema = z.object({
  /** Where the SQLite database file lives. */
  dataDir: z.string().min(1),
  /** Port the HTTP server listens on. */
  port: z.coerce.number().int().min(1).max(65535),
  /** Bind address. 127.0.0.1 locks the server to localhost. */
  host: z.string().min(1),
  /** "development" or "production". Controls logger format, CORS, etc. */
  nodeEnv: z.enum(["development", "production", "test"]),
  /** Trusted origins for CORS in production. Comma-separated. */
  trustedOrigins: z.array(z.string()),
  /** Cookie secret used to sign session cookies. MUST be set in prod. */
  cookieSecret: z.string().min(32),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as
    | "development"
    | "production"
    | "test";

  // In dev we generate a throwaway cookie secret so the server can boot
  // without setup. In prod, we require one explicitly — a leak of this
  // secret in any environment is bad, so we don't want a silent default.
  let cookieSecret = process.env.SKIFF_COOKIE_SECRET;
  if (!cookieSecret) {
    if (nodeEnv === "production") {
      throw new Error(
        "SKIFF_COOKIE_SECRET must be set in production. " +
          "Generate one with: openssl rand -hex 32",
      );
    }
    // Dev default: stable across restarts so cookies don't get
    // invalidated every reload, but obviously NOT a secret.
    cookieSecret = "dev-only-secret-not-for-production-use-please-replace";
  }

  const trustedOriginsRaw = process.env.SKIFF_TRUSTED_ORIGINS ?? "";
  const trustedOrigins = trustedOriginsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const raw = {
    dataDir: resolve(process.env.SKIFF_DATA_DIR ?? "./data"),
    port: process.env.SKIFF_PORT ?? 8080,
    // Docker without an explicit SKIFF_HOST env var. For local non-Docker dev,
    // set SKIFF_HOST=127.0.0.1 in your shell if you want localhost-only binding.
    host: process.env.SKIFF_HOST ?? "0.0.0.0",
    nodeEnv,
    trustedOrigins,
    cookieSecret,
  };

  return ConfigSchema.parse(raw);
}
