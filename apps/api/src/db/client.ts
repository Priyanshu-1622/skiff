import Database from "better-sqlite3";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const SCHEMA_VERSION = 3;

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

  // Additive column migrations. ALTER TABLE ADD COLUMN isn't idempotent,
  // so we check the existing columns first. Safe to run on every boot.
  runColumnMigrations(db);

  // Reconcile recordings left mid-write by a crash or hard stop. On a clean
  // shutdown these are marked 'complete'; anything still 'recording' at boot
  // had no graceful finalize, so flag it 'interrupted' (the .cast file is
  // still playable up to the last flushed event).
  try {
    db.prepare(
      "UPDATE session_recordings SET status = 'interrupted' WHERE status = 'recording'"
    ).run();
  } catch { /* table may not exist on a very old db; schema.exec above creates it */ }

  return {
    raw: db,
    close: () => db.close(),
  };
}

/**
 * Add columns that can't live in schema.sql because ADD COLUMN errors if
 * the column already exists. Each migration checks before applying.
 */
export function runColumnMigrations(db: Database.Database): void {
  const hasColumn = (table: string, column: string): boolean => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  };

  // v2: vault mode — 'personal' (default, unchanged) or 'team'
  if (!hasColumn("vault_meta", "mode")) {
    db.exec(
      "ALTER TABLE vault_meta ADD COLUMN mode TEXT NOT NULL DEFAULT 'personal'"
    );
  }

  // v3: session recording toggle. Default off (0); existing team vaults are
  // flipped on below so team admins get recording without extra setup.
  if (!hasColumn("vault_meta", "recording_enabled")) {
    db.exec(
      "ALTER TABLE vault_meta ADD COLUMN recording_enabled INTEGER NOT NULL DEFAULT 0"
    );
    // Existing team vaults get recording on by default; personal stays off.
    db.exec(
      "UPDATE vault_meta SET recording_enabled = 1 WHERE mode = 'team'"
    );
  }
}
