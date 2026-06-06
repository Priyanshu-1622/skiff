import type { FastifyPluginAsync } from "fastify";
import { ok } from "../lib/response.js";

export interface HealthRouteDeps {
  schemaVersion: number;
  startedAt: Date;
}

export const healthRoute: (deps: HealthRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    app.get("/api/health", async (_req, _reply) => {
      // Check the DB connection by running a trivial query that
      // hits SQLite's schema. If this throws, the route returns 500.
      const db = app.skiffDb.raw;
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1")
        .get();

      const uptimeSeconds = Math.floor(
        (Date.now() - deps.startedAt.getTime()) / 1000,
      );

      return ok({
        status: "ok" as const,
        version: "0.1.0",
        schemaVersion: deps.schemaVersion,
        uptimeSeconds,
        db: row ? "connected" : "empty",
      });
    });
  };
