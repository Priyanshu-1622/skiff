import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

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

  const db = opts.db ?? openDatabase({ dataDir: config.dataDir });
  app.decorate("skiffDb", db);
  app.addHook("onClose", async () => {
    db.close();
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
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

  await app.register(cookie, {
    secret: config.cookieSecret,
    parseOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      path: "/",
    },
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
  });

  app.setErrorHandler((error: FastifyError, req, reply) => {
    req.log.error({ err: error }, "Request failed");

    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      const message = firstIssue
        ? `${firstIssue.path.join(".") || "body"}: ${firstIssue.message}`
        : "Validation failed";
      return reply.code(400).send(err(ApiErrorCode.VALIDATION_FAILED, message));
    }

    if (error.statusCode === 400 || error.validation) {
      return reply
        .code(400)
        .send(err(ApiErrorCode.VALIDATION_FAILED, error.message));
    }

    if (error.statusCode === 429) {
      return reply
        .code(429)
        .send(err(ApiErrorCode.RATE_LIMITED, "Too many requests"));
    }

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

  await app.register(websocket);

  // Serve the built web UI. In the Docker image the compiled API lives at
  // /app/apps/api/dist and the frontend at /app/apps/web/dist.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webDist = join(__dirname, "..", "..", "web", "dist");
  const hasWebBuild = existsSync(join(webDist, "index.html"));

  if (hasWebBuild) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      wildcard: false,
    });
  }

  app.setNotFoundHandler((req, reply) => {
    // API routes that don't exist return a JSON 404.
    if (req.url.startsWith("/api/") || !hasWebBuild || req.method !== "GET") {
      return reply.code(404).send(err(ApiErrorCode.NOT_FOUND, "Not found"));
    }
    // Everything else is a client-side route — hand back index.html and let
    // the SPA router take over (so refreshing /settings etc. works).
    return reply.sendFile("index.html");
  });


  // Idle timeout is read from the vault so it persists across restarts.
  const rawDb = db.raw;
  const vaultMeta = rawDb.prepare(
    "SELECT idle_timeout_minutes FROM vault_meta WHERE id = 1"
  ).get() as { idle_timeout_minutes: number } | undefined;
  const idleTimeout = vaultMeta?.idle_timeout_minutes ?? 15;
  const sessionStore = new SessionStore(idleTimeout);

  app.addHook("onClose", async () => {
    sessionStore.close();
  });

  const startedAt = new Date();
  await app.register(healthRoute({ schemaVersion: SCHEMA_VERSION, startedAt }));
  await app.register(authRoutes({ sessionStore, config }));
  await app.register(hostRoutes({ sessionStore }));
  await app.register(terminalRoutes({ sessionStore }));
  await app.register(importRoutes({ sessionStore }));
  await app.register(settingsRoutes({ sessionStore, config }));

  return app;
}
