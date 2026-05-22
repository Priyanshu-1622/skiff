/**
 * Skiff API server entry point.
 *
 * Boots the Fastify app, binds to the configured host:port, and wires
 * up graceful shutdown on SIGINT/SIGTERM so SQLite gets a chance to
 * close cleanly (important — the WAL file matters).
 */

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

const app = await buildApp({ config });

async function shutdown(signal: string) {
  app.log.info({ signal }, "Shutting down");
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "Shutdown failed");
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { port: config.port, host: config.host, dataDir: config.dataDir },
    "Skiff API listening",
  );
} catch (err) {
  app.log.error({ err }, "Failed to start");
  process.exit(1);
}
