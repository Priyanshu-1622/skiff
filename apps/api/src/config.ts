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
  /**
   * Token required by setup/restore before a vault exists. Unset → a random
   * one is generated and logged at boot. null disables the gate (tests only).
   */
  setupToken: z.string().min(16).nullable().optional(),
  /**
   * Which reverse proxies may tell us the real client IP (X-Forwarded-For).
   * Passed to Fastify's trustProxy: false (default), a hop count, or a
   * comma-separated list of proxy IPs/CIDRs such as "127.0.0.1,172.16.0.0/12".
   * Without it, behind a proxy every client looks like the proxy: one shared
   * rate-limit bucket for everyone and the proxy's IP in every audit entry.
   */
  /**
   * Allow signing in over plain HTTP from another machine in production
   * (SKIFF_INSECURE_HTTP=true). Makes the session cookie non-Secure. Only for
   * a network you trust; HTTPS is the answer everywhere else.
   */
  allowInsecureHttp: z.boolean().optional(),
  /** Live SSH sessions one person may hold open at once (resource cap). */
  maxSessionsPerUser: z.number().int().min(1).max(1000).optional(),
  trustProxy: z.union([z.boolean(), z.number().int().min(1), z.string().min(1)]).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = raw?.trim();
  if (!v || v === "false" || v === "0") return false;
  // "true" trusts ANY client's X-Forwarded-For, so anyone could fake their IP
  // and dodge the login backoff. Only sensible if nothing but the proxy can
  // reach Skiff; prefer listing the proxy's address.
  if (v === "true") return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

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
    // Localhost unless told otherwise, so a server started by hand (node,
    // systemd, pm2) isn't reachable from the network before it's set up. The
    // Docker image sets SKIFF_HOST=0.0.0.0 itself because inside a container
    // the published port is what decides exposure.
    host: process.env.SKIFF_HOST || "127.0.0.1",
    nodeEnv,
    trustedOrigins,
    cookieSecret,
    setupToken: process.env.SKIFF_SETUP_TOKEN?.trim() || undefined,
    trustProxy: parseTrustProxy(process.env.SKIFF_TRUST_PROXY),
    allowInsecureHttp: process.env.SKIFF_INSECURE_HTTP === "true",
    maxSessionsPerUser: process.env.SKIFF_MAX_SESSIONS_PER_USER
      ? Number(process.env.SKIFF_MAX_SESSIONS_PER_USER)
      : undefined,
  };

  return ConfigSchema.parse(raw);
}
