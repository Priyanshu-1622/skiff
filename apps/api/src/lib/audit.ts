/**
 * Audit logging for team mode.
 *
 * Records who did what, when. Never stores secrets — `detail` is for
 * non-sensitive context only (e.g. a host label, a target username),
 * never passwords or credential contents. In personal mode there are no
 * users and these calls are simply no-ops if userId is absent, but most
 * callers only invoke this when a session user exists.
 */

import type Database from "better-sqlite3";
import type { SessionUser } from "../crypto/session-store.js";

export interface AuditEvent {
  user?: SessionUser;
  action: string;
  resourceType?: string;
  resourceId?: string;
  detail?: Record<string, unknown>;
  ip?: string;
}

export function writeAudit(db: Database.Database, event: AuditEvent): void {
  try {
    db.prepare(
      `INSERT INTO audit_log (user_id, username, action, resource_type, resource_id, detail, ip, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.user?.id ?? null,
      event.user?.username ?? null,
      event.action,
      event.resourceType ?? null,
      event.resourceId ?? null,
      event.detail ? JSON.stringify(event.detail) : null,
      event.ip ?? null,
      new Date().toISOString(),
    );
  } catch {
    // Audit logging must never break the request it's recording.
  }
}
