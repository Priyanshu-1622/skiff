/**
 * Fastify application factory.
 *
 * Exported as buildApp() so tests can spin up an in-memory app without
 * binding to a port. The server.ts entry point calls buildApp() then
 * listens.
 */

import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";

import { openDatabase, SCHEMA_VERSION, type SkiffDb } from "./db/client.js";
import type { Config } from "./config.js";
import { healthRoute } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { hostRoutes } from "./routes/hosts.js";
import { terminalRoutes } from "./routes/terminal.js";
import { importRoutes } from "./routes/import.js";
import { settingsRoutes } from "./routes/settings.js";
import { SessionStore } from "./crypto/session-store.js";
import { err } from "./lib/response.js";
import { ApiErrorCode } from "@skiff/shared";
import { ZodError } from "zod";

// Augment Fastify's instance type so app.skiffDb is properly typed.
declare module "fastify" {
  interface FastifyInstance {
    skiffDb: SkiffDb;
  }
}

export interface BuildAppOptions {
  config: Config;
  /** Optionally inject a pre-opened db (used in tests with :memory:). */
  db?: SkiffDb;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = opts;

  // Use pino-pretty if it's installed (dev convenience). Otherwise
  // fall back to default JSON logging, which is still fine to read.
  let prettyTransport: { target: string; options: object } | undefined;
  if (config.nodeEnv !== "production") {
    try {
      // Dynamic import behind a variable so TS doesn't fail when
      // pino-pretty isn't installed (it's an optional dep).
      const pinoPrettyModuleName = "pino-pretty";
      await import(pinoPrettyModuleName);
      prettyTransport = {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss" },
      };
    } catch {
      // pino-pretty not installed — that's fine, just use default JSON
    }
  }

  const app = Fastify({
    logger: prettyTransport
      ? { transport: prettyTransport }
      : true,
    disableRequestLogging: false,
    bodyLimit: 1024 * 1024, // 1 MB; ssh keys are well under this
    trustProxy: false,
  });

  // ─── DB ─────────────────────────────────────────────────────────
  const db = opts.db ?? openDatabase({ dataDir: config.dataDir });
  app.decorate("skiffDb", db);
  app.addHook("onClose", async () => {
    db.close();
  });

  // ─── Security headers ──────────────────────────────────────────
  // helmet sets a sane CSP, HSTS, frame-options, etc. We deliberately
  // do NOT enable contentSecurityPolicy here because the web client is
  // served separately (Vite in dev, or behind a reverse proxy in prod);
  // CSP for the API JSON responses isn't useful.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  // ─── CORS ──────────────────────────────────────────────────────
  // In dev: allow the Vite origin so we can also call from the browser
  // directly during debugging (the proxy is the normal path).
  // In prod: only allow trustedOrigins. If empty, refuse all cross-origin.
  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin requests have no Origin header.
      if (!origin) {
        cb(null, true);
        return;
      }
      if (config.nodeEnv === "development") {
        const devAllowed = ["http://localhost:5173", "http://127.0.0.1:5173"];
        cb(null, devAllowed.includes(origin));
        return;
      }
      cb(null, config.trustedOrigins.includes(origin));
    },
    credentials: true,
  });

  // ─── Cookies ───────────────────────────────────────────────────
  await app.register(cookie, {
    secret: config.cookieSecret,
    parseOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      path: "/",
    },
  });

  // ─── Global rate limit ─────────────────────────────────────────
  // Soft global ceiling. Auth-specific routes layer additional, much
  // stricter limits on top.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
  });

  // ─── Error handler ─────────────────────────────────────────────
  // Normalize errors into the ApiResult envelope so the client never
  // has to handle two response shapes.
  app.setErrorHandler((error: FastifyError, req, reply) => {
    req.log.error({ err: error }, "Request failed");

    // Zod schema validation
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      const message = firstIssue
        ? `${firstIssue.path.join(".") || "body"}: ${firstIssue.message}`
        : "Validation failed";
      return reply.code(400).send(err(ApiErrorCode.VALIDATION_FAILED, message));
    }

    // Fastify built-in validation errors
    if (error.statusCode === 400 || error.validation) {
      return reply
        .code(400)
        .send(err(ApiErrorCode.VALIDATION_FAILED, error.message));
    }

    // Rate limit
    if (error.statusCode === 429) {
      return reply
        .code(429)
        .send(err(ApiErrorCode.RATE_LIMITED, "Too many requests"));
    }

    // Fallback
    return reply
      .code(error.statusCode ?? 500)
      .send(
        err(
          ApiErrorCode.INTERNAL,
          config.nodeEnv === "production"
            ? "Internal server error"
            : (error.message ?? "Internal server error"),
        ),
      );
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Not found"));
  });

  // ─── WebSocket ──────────────────────────────────────────────
  await app.register(websocket);

  // ─── Session store ─────────────────────────────────────────
  const sessionStore = new SessionStore(15);
  app.addHook("onClose", async () => {
    sessionStore.close();
  });

  // ─── Routes ────────────────────────────────────────────────────
  const startedAt = new Date();
  await app.register(healthRoute({ schemaVersion: SCHEMA_VERSION, startedAt }));
  await app.register(authRoutes({ sessionStore }));
  await app.register(hostRoutes({ sessionStore }));
  await app.register(terminalRoutes({ sessionStore }));
  await app.register(importRoutes({ sessionStore }));
  await app.register(settingsRoutes({ sessionStore }));

  return app;
}
