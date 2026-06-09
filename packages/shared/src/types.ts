// ─── Hosts & Folders ─────────────────────────────────────

export interface Host {
  id: string;
  folder_id: string | null;
  label: string;
  hostname: string;
  port: number;
  username: string;
  auth_method: "password" | "key" | "key+passphrase";
  credential_id: string | null;
  tags: string[];
  starred: boolean;
  last_connected_at: string | null;
  created_at: string;
}

export interface Folder {
  id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: string;
}

// ─── Vault ──────────────────────────────────────────────

export type VaultMode = "personal" | "team";

export interface TeamUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  idleTimeoutMinutes: number;
  mode: VaultMode;
  user: TeamUser | null;
}

export interface TeamMember {
  id: string;
  username: string;
  displayName: string | null;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  username: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  at: string;
}

// ─── API Envelope ───────────────────────────────────────

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ApiErrorCode; message: string } };

export const ApiErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL: "INTERNAL",
  RATE_LIMITED: "RATE_LIMITED",
  VAULT_LOCKED: "VAULT_LOCKED",
  VAULT_NOT_INITIALIZED: "VAULT_NOT_INITIALIZED",
  INVALID_PASSWORD: "INVALID_PASSWORD",
  FORBIDDEN: "FORBIDDEN",
  CONFLICT: "CONFLICT",
  WRONG_MODE: "WRONG_MODE",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
