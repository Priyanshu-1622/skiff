-- ============================================================
-- Skiff schema (v1)
--
-- Design notes:
--   * Single-user vault for v1. No `users` table — there's exactly one
--     master password, stored hashed in `vault_meta`.
--   * Credentials live in a separate table from hosts so one credential
--     (e.g. an SSH key) can back many hosts without duplicating the
--     encrypted blob.
--   * Every encrypted blob carries its own nonce.
--   * Timestamps are ISO-8601 strings (TEXT). SQLite has no native
--     datetime; storing as text keeps queries readable and round-trips
--     cleanly through JSON.
--   * Foreign keys are ON; deletes cascade where it would orphan data.
-- ============================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- ─── vault_meta ────────────────────────────────────────────────────
-- Single-row table. Stores the master password verifier and KDF params
-- so unlock can re-derive the vault key. No other table is readable
-- without that key (credentials are encrypted; hosts are not, since
-- only the credential blobs are sensitive).

CREATE TABLE IF NOT EXISTS vault_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  -- argon2id parameters used at setup time. We store these so we can
  -- re-derive the vault key on every unlock with the same params, even
  -- if we change defaults for new vaults later.
  kdf_algorithm TEXT NOT NULL DEFAULT 'argon2id',
  kdf_salt BLOB NOT NULL,
  kdf_iterations INTEGER NOT NULL,
  kdf_memory_kib INTEGER NOT NULL,
  kdf_parallelism INTEGER NOT NULL,
  -- Verifier: an HMAC(vault_key, "skiff-verifier-v1") computed at
  -- setup. Used to check the master password is correct without ever
  -- decrypting a real credential.
  verifier BLOB NOT NULL,
  idle_timeout_minutes INTEGER NOT NULL DEFAULT 15,
  created_at TEXT NOT NULL
);

-- ─── folders ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

-- ─── credentials ───────────────────────────────────────────────────
-- The only place secrets live. `kind` records what the decrypted blob
-- contains so the SSH layer knows how to use it. `encrypted_blob` is
-- always a libsodium secretbox ciphertext.

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('password', 'key', 'key+passphrase')),
  nonce BLOB NOT NULL,
  encrypted_blob BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- ─── hosts ─────────────────────────────────────────────────────────
-- Hosts are NOT encrypted — knowing that you have a server called
-- "prod-db-1" at 10.0.9.6 leaks much less than knowing its password.
-- All the sensitive bits live in `credentials`.

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  hostname TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('password', 'key', 'key+passphrase')),
  credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
  tags TEXT NOT NULL DEFAULT '[]',  -- JSON array
  starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1)),
  last_connected_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hosts_folder ON hosts(folder_id);
CREATE INDEX IF NOT EXISTS idx_hosts_starred ON hosts(starred) WHERE starred = 1;
CREATE INDEX IF NOT EXISTS idx_hosts_last_connected ON hosts(last_connected_at DESC);

-- ─── known_hosts ───────────────────────────────────────────────────
-- SSH fingerprint pinning. On first connection we save the fingerprint
-- and on every subsequent connection we refuse to proceed if it has
-- changed (the classic man-in-the-middle defense).

CREATE TABLE IF NOT EXISTS known_hosts (
  hostname TEXT NOT NULL,
  port INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,  -- e.g. "SHA256:abc..."
  algorithm TEXT NOT NULL,    -- e.g. "ssh-ed25519"
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (hostname, port)
);

-- ─── sessions ──────────────────────────────────────────────────────
-- HTTP session cookies for the unlocked vault. We deliberately do NOT
-- store the derived vault key here — that lives in process memory
-- only, keyed by the session id. If the server restarts, every
-- session must re-unlock.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ─── unlock_attempts ───────────────────────────────────────────────
-- Track failed unlock attempts for rate-limiting. Cleared on success.

CREATE TABLE IF NOT EXISTS unlock_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempted_at TEXT NOT NULL,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_unlock_attempts_at ON unlock_attempts(attempted_at DESC);
