/**
 * SQLite database client.
 *
 * Single-file SQLite database at `${SKIFF_DATA_DIR}/skiff.sqlite`.
 * Schema is applied on every boot via CREATE IF NOT EXISTS — that's
 * idempotent so it's safe to run on startup. When we later need real
 * migrations (Day 12+), we'll add a `migrations/` folder and version
 * the schema in `vault_meta.schema_version`.
 */

import Database from "better-sqlite3";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const SCHEMA_VERSION = 1;

export interface DbConfig {
  /** Absolute path to the data directory. Created if it doesn't exist. */
  dataDir: string;
  /** Database file name within dataDir. */
  filename?: string;
}

export interface SkiffDb {
  /** The underlying better-sqlite3 instance. */
  raw: Database.Database;
  /** Close the database (used on graceful shutdown). */
  close: () => void;
}

/**
 * Open or create the Skiff database, applying the schema on first boot.
 */
export function openDatabase(config: DbConfig): SkiffDb {
  const filename = config.filename ?? "skiff.sqlite";

  if (!existsSync(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true });
  }

  const dbPath = join(config.dataDir, filename);
  const db = new Database(dbPath);

  // PRAGMAs that aren't in the schema file because they apply per
  // connection, not per database.
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  // Apply the schema. This is idempotent because every CREATE in
  // schema.sql uses IF NOT EXISTS.
  const schemaPath = join(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  return {
    raw: db,
    close: () => db.close(),
  };
}
