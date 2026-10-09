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
  -- NOTE: stored for future multi-algorithm support but not yet read for dispatch.
  -- All code currently hardcodes argon2id. Read this column before adding new algorithms.
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
-- contains so the SSH layer knows how to use it. `encrypted_blob` is an
-- AES-256-GCM ciphertext with its 16-byte auth tag appended; `nonce` is
-- the 12-byte IV (see crypto/vault.ts).

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
-- NOTE: This table is NOT used by the current session implementation.
-- Sessions are managed entirely in-memory by SessionStore (crypto/session-store.ts).
-- The vault key never touches disk. This table is retained for a future
-- persistent-session feature. Do not read/write it in application code.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ─── unlock_attempts ───────────────────────────────────────────────
-- UNUSED since the per-client backoff in lib/attempt-limiter.ts replaced the
-- database lockout. Kept so existing databases keep a consistent schema.

CREATE TABLE IF NOT EXISTS unlock_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempted_at TEXT NOT NULL,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_unlock_attempts_at ON unlock_attempts(attempted_at DESC);

-- ════════════════════════════════════════════════════════════════════
-- Team mode tables
--
-- Populated only when vault_meta.mode = 'team'. Personal mode ignores
-- them. Crypto: one random shared_vault_key encrypts every credential
-- (same as personal); each user stores their own copy of that key
-- sealed to a key derived from their password. Any member can decrypt,
-- but each logs in separately so actions are attributable.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  kdf_salt BLOB NOT NULL,
  kdf_iterations INTEGER NOT NULL,
  kdf_memory_kib INTEGER NOT NULL,
  kdf_parallelism INTEGER NOT NULL,
  verifier BLOB NOT NULL,
  shared_key_blob BLOB,
  shared_key_nonce BLOB,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- UNUSED — see unlock_attempts above.
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(username, attempted_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  username TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  detail TEXT,
  ip TEXT,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

-- Session recordings (v3). Metadata only; the actual asciicast file lives
-- on disk under <dataDir>/recordings/<id>.cast. A row exists once a
-- recording starts; ended_at/duration/bytes are filled in when it closes.
CREATE TABLE IF NOT EXISTS session_recordings (
  id TEXT PRIMARY KEY,
  host_id TEXT,
  host_label TEXT,
  hostname TEXT,
  user_id TEXT,
  username TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'recording'
);

CREATE INDEX IF NOT EXISTS idx_recordings_started ON session_recordings(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_recordings_user ON session_recordings(user_id);
CREATE INDEX IF NOT EXISTS idx_recordings_host ON session_recordings(host_id);

-- ─── servers (v5) ─────────────────────────────────────────────────
-- A physical/virtual machine, identified by its SSH host key. Host entries
-- point at one, so memory follows the machine even if it is added twice or
-- renamed; a rebuilt server (new key) is a new row linked to the old one.
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  algorithm TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  previous_server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  file_key_wrapped BLOB NOT NULL,
  file_key_nonce BLOB NOT NULL
);

-- ─── session_keys (v5) ────────────────────────────────────────────
-- Per-session data keys, wrapped under the vault/shared key (crypto/data-keys.ts).
CREATE TABLE IF NOT EXISTS session_keys (
  id TEXT PRIMARY KEY,
  wrapped_key BLOB NOT NULL,
  nonce BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- ─── memory_sessions (v6) ─────────────────────────────────────────
-- One row per live SSH session that captured commands. `key_id` names the
-- session_keys row (the same key that seals this session's recording, if
-- any) used to seal every memory_entries row it owns.
CREATE TABLE IF NOT EXISTS memory_sessions (
  id TEXT PRIMARY KEY,
  server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  user_id TEXT,
  username TEXT,
  key_id TEXT NOT NULL REFERENCES session_keys(id),
  recording_id TEXT REFERENCES session_recordings(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  stats_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_memory_sessions_server ON memory_sessions(server_id);

-- ─── memory_entries (v6) ──────────────────────────────────────────
-- Plaintext columns are exactly what's needed to filter/sort without
-- decrypting (spec §4). `data` is the AEAD-sealed {command, output, cwd}
-- (crypto/data-keys.ts sealEntry/openEntry), bound to its own id via AAD.
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  memory_session_id TEXT NOT NULL REFERENCES memory_sessions(id) ON DELETE CASCADE,
  server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  user_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('command','file','pause','outside_change','snapshot_note')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  confidence TEXT,
  flags TEXT NOT NULL DEFAULT '[]',
  output_bytes INTEGER NOT NULL DEFAULT 0,
  output_pruned INTEGER NOT NULL DEFAULT 0,
  nonce BLOB NOT NULL,
  data BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_session ON memory_entries(memory_session_id);
CREATE INDEX IF NOT EXISTS idx_memory_entries_server_time ON memory_entries(server_id, started_at);

-- ─── Phase C: file versions (v6) ─────────────────────────────────
-- Watched paths per server. The real path is sealed under the server's file
-- key (path_nonce/path_data); path_hash = HMAC(file key, path) is only a lookup key.
CREATE TABLE IF NOT EXISTS server_files (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  path_hash TEXT NOT NULL,
  path_nonce BLOB NOT NULL,
  path_data BLOB NOT NULL,
  last_content_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server_id, path_hash)
);

-- Phase D: a living note per host, and a snippet library. Both are sealed under
-- the vault key (AAD host-note:<id> / snippet:<id>); user_id is plain so the
-- author can be checked without opening the row.
CREATE TABLE IF NOT EXISTS host_notes (
  host_id TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
  nonce BLOB NOT NULL,
  data BLOB NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snippets (
  id TEXT PRIMARY KEY,
  nonce BLOB NOT NULL,
  data BLOB NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Server snapshots (opt-in per host), sealed under the server's file key.
CREATE TABLE IF NOT EXISTS server_snapshots (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  taken_at TEXT NOT NULL,
  nonce BLOB NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_snapshots_server ON server_snapshots(server_id, taken_at);

-- File versions, sealed under the server's file key; id = HMAC(file key, text).
CREATE TABLE IF NOT EXISTS file_contents (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  nonce BLOB NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_contents_server ON file_contents(server_id);
