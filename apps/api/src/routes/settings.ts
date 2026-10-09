import type { FastifyPluginAsync } from "fastify";
import { rewrapDocs } from "../lib/memory/vault-docs.js";
import { z } from "zod";
import { deriveVaultKey, computeVerifier, generateKdfParams, encrypt, decrypt, verifierMatches } from "../crypto/vault.js";
import { provisionUser } from "../crypto/team-vault.js";
import type { SessionStore } from "../crypto/session-store.js";
import { type SessionManager, ownerKeyFor } from "../lib/session-manager.js";
import type { Config } from "../config.js";
import { sessionCookieOptions } from "../lib/cookie.js";
import { requireUnlocked, requireVaultOwner } from "../lib/auth-middleware.js";
import { unwrapDataKey, wrapDataKey } from "../crypto/data-keys.js";
import { writeAudit } from "../lib/audit.js";
import { ok, err } from "../lib/response.js";
import { ApiErrorCode } from "@skiff/shared";
import { generateId } from "../lib/id.js";
import type { SetupGate } from "../lib/setup-token.js";

export interface SettingsRouteDeps {
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  config: Config;
  setupGate: SetupGate;
}

export const settingsRoutes: (deps: SettingsRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const { sessionStore, sessionManager, config, setupGate } = deps;
    const auth = requireUnlocked(sessionStore);
    const ownerOnly = requireVaultOwner(sessionStore, app.skiffDb.raw);

    app.put("/api/settings/password", { preHandler: auth }, async (req, reply) => {
      const body = z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8).max(256),
      }).parse(req.body);

      const db = app.skiffDb.raw;
      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as any;
      if (!meta) return reply.code(400).send(err(ApiErrorCode.VAULT_NOT_INITIALIZED, "No vault"));
      // This route changes the single personal master password and re-encrypts
      // every credential under a new key. In team mode that would break every
      // other member's access, and the per-user password isn't stored here.
      // Team password changes go through admin reprovision (or a future
      // per-user change flow), so refuse here.
      if (meta.mode === "team") {
        return reply.code(400).send(err(ApiErrorCode.WRONG_MODE, "In team mode, ask an admin to reset your password"));
      }

      const currentKey = await deriveVaultKey(body.currentPassword, {
        algorithm: "argon2id",
        salt: meta.kdf_salt,
        iterations: meta.kdf_iterations,
        memoryKib: meta.kdf_memory_kib,
        parallelism: meta.kdf_parallelism,
      });
      if (!verifierMatches(computeVerifier(currentKey), meta.verifier)) {
        return reply.code(401).send(err(ApiErrorCode.INVALID_PASSWORD, "Current password is wrong"));
      }

      const newParams = generateKdfParams();
      const newKey = await deriveVaultKey(body.newPassword, newParams);
      const newVerifier = computeVerifier(newKey);
      const creds = db.prepare("SELECT * FROM credentials").all() as any[];
      const updateCred = db.prepare("UPDATE credentials SET nonce = ?, encrypted_blob = ? WHERE id = ?");
      // Every session's own key (recordings, later memory) and every server's
      // file key are wrapped under the vault key too — they must move with it,
      // or a session/server sealed under the old password becomes unreadable.
      const sessionKeyRows = db.prepare("SELECT id, wrapped_key, nonce FROM session_keys").all() as any[];
      const updateSessionKey = db.prepare("UPDATE session_keys SET wrapped_key = ?, nonce = ? WHERE id = ?");
      const serverRows = db.prepare("SELECT id, file_key_wrapped, file_key_nonce FROM servers").all() as any[];
      const updateServerKey = db.prepare("UPDATE servers SET file_key_wrapped = ?, file_key_nonce = ? WHERE id = ?");

      db.transaction(() => {
        for (const cred of creds) {
          const plaintext = decrypt(Buffer.from(cred.encrypted_blob), Buffer.from(cred.nonce), currentKey);
          const { nonce, ciphertext } = encrypt(plaintext, newKey);
          updateCred.run(nonce, ciphertext, cred.id);
        }
        for (const row of sessionKeyRows) {
          const dataKey = unwrapDataKey(Buffer.from(row.wrapped_key), Buffer.from(row.nonce), currentKey);
          const { nonce, wrapped } = wrapDataKey(dataKey, newKey);
          dataKey.fill(0);
          updateSessionKey.run(wrapped, nonce, row.id);
        }
        // Notes and snippets are sealed under the vault key itself.
        rewrapDocs(db, currentKey, newKey);
        for (const row of serverRows) {
          const fileKey = unwrapDataKey(Buffer.from(row.file_key_wrapped), Buffer.from(row.file_key_nonce), currentKey);
          const { nonce, wrapped } = wrapDataKey(fileKey, newKey);
          fileKey.fill(0);
          updateServerKey.run(wrapped, nonce, row.id);
        }
        db.prepare(
          `UPDATE vault_meta SET kdf_salt=?, kdf_iterations=?, kdf_memory_kib=?, kdf_parallelism=?, verifier=? WHERE id=1`
        ).run(newParams.salt, newParams.iterations, newParams.memoryKib, newParams.parallelism, newVerifier);
      })();

      sessionStore.destroyAll();
      const sessionId = sessionStore.create(newKey);
      reply.setCookie("skiff_session", sessionId, sessionCookieOptions(config));
      return ok({ message: "Password changed" });
    });

    app.put("/api/settings/idle-timeout", { preHandler: ownerOnly }, async (req) => {
      const body = z.object({ minutes: z.number().int().min(1).max(1440) }).parse(req.body);
      app.skiffDb.raw.prepare("UPDATE vault_meta SET idle_timeout_minutes = ? WHERE id = 1").run(body.minutes);
      sessionStore.setIdleTimeout(body.minutes);
      writeAudit(app.skiffDb.raw, {
        user: req.sessionUser, action: "settings.idle_timeout",
        detail: { minutes: body.minutes }, ip: req.ip,
      });
      return ok({ idleTimeoutMinutes: body.minutes });
    });

    app.put("/api/settings/recording", { preHandler: ownerOnly }, async (req) => {
      const body = z.object({ enabled: z.boolean() }).parse(req.body);
      app.skiffDb.raw
        .prepare("UPDATE vault_meta SET recording_enabled = ? WHERE id = 1")
        .run(body.enabled ? 1 : 0);
      writeAudit(app.skiffDb.raw, {
        user: req.sessionUser, action: body.enabled ? "settings.recording_on" : "settings.recording_off",
        ip: req.ip,
      });
      return ok({ recordingEnabled: body.enabled });
    });

    app.put("/api/settings/memory", { preHandler: ownerOnly }, async (req) => {
      const body = z.object({ enabled: z.boolean(), outputDays: z.number().int().min(1).max(3650) }).parse(req.body);
      app.skiffDb.raw
        .prepare("UPDATE vault_meta SET memory_enabled = ?, memory_output_days = ? WHERE id = 1")
        .run(body.enabled ? 1 : 0, body.outputDays);
      writeAudit(app.skiffDb.raw, {
        user: req.sessionUser, action: "settings.memory",
        detail: { enabled: body.enabled, outputDays: body.outputDays }, ip: req.ip,
      });
      return ok({ memoryEnabled: body.enabled, memoryOutputDays: body.outputDays });
    });

    app.get("/api/settings/backup", { preHandler: ownerOnly }, async (req) => {
      const db = app.skiffDb.raw;
      // A backup is every credential in the vault — always leave a trace.
      writeAudit(db, { user: req.sessionUser, action: "vault.backup", ip: req.ip });
      const hosts = db.prepare("SELECT * FROM hosts").all();
      const folders = db.prepare("SELECT * FROM folders").all();
      const credentials = db.prepare("SELECT * FROM credentials").all();
      const knownHosts = db.prepare("SELECT * FROM known_hosts").all();
      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get();
      const normalizedMeta = meta ? {
        ...(meta as any),
        kdf_salt: Buffer.from((meta as any).kdf_salt).toString("base64"),
        verifier: Buffer.from((meta as any).verifier).toString("base64"),
      } : null;
      // Team vaults: every credential is encrypted with a random shared key that
      // exists on disk ONLY sealed inside each member's row. Without the users
      // table a team backup can never be decrypted, so it is part of the backup.
      // The sealed copies are as safe to export as the credentials themselves:
      // opening one needs that member's password.
      const users = (db.prepare("SELECT * FROM users ORDER BY created_at").all() as any[]).map((u) => ({
        ...u,
        kdf_salt: Buffer.from(u.kdf_salt).toString("base64"),
        verifier: Buffer.from(u.verifier).toString("base64"),
        shared_key_blob: u.shared_key_blob ? Buffer.from(u.shared_key_blob).toString("base64") : null,
        shared_key_nonce: u.shared_key_nonce ? Buffer.from(u.shared_key_nonce).toString("base64") : null,
      }));
      // Servers and session keys: without these a restored vault can still
      // unlock, but every existing recording (and later, memory) is
      // unreadable — the key that seals them never leaves this file.
      const servers = (db.prepare("SELECT * FROM servers").all() as any[]).map((s) => ({
        ...s,
        file_key_wrapped: Buffer.from(s.file_key_wrapped).toString("base64"),
        file_key_nonce: Buffer.from(s.file_key_nonce).toString("base64"),
      }));
      const sessionKeys = (db.prepare("SELECT * FROM session_keys").all() as any[]).map((k) => ({
        ...k,
        wrapped_key: Buffer.from(k.wrapped_key).toString("base64"),
        nonce: Buffer.from(k.nonce).toString("base64"),
      }));
      // Watched files and their stored versions (sealed under each server's file
      // key, which is in `servers` above): kept so a restored vault still knows
      // what each file last looked like.
      const serverFiles = (db.prepare("SELECT * FROM server_files").all() as any[]).map((f) => ({
        ...f,
        path_nonce: Buffer.from(f.path_nonce).toString("base64"),
        path_data: Buffer.from(f.path_data).toString("base64"),
      }));
      const hostNotes = (db.prepare("SELECT * FROM host_notes").all() as any[]).map((f) => ({
        ...f,
        nonce: Buffer.from(f.nonce).toString("base64"),
        data: Buffer.from(f.data).toString("base64"),
      }));
      const snippets = (db.prepare("SELECT * FROM snippets").all() as any[]).map((f) => ({
        ...f,
        nonce: Buffer.from(f.nonce).toString("base64"),
        data: Buffer.from(f.data).toString("base64"),
      }));
      const serverSnapshots = (db.prepare("SELECT * FROM server_snapshots").all() as any[]).map((f) => ({
        ...f,
        nonce: Buffer.from(f.nonce).toString("base64"),
        data: Buffer.from(f.data).toString("base64"),
      }));
      const fileContents = (db.prepare("SELECT * FROM file_contents").all() as any[]).map((f) => ({
        ...f,
        nonce: Buffer.from(f.nonce).toString("base64"),
        data: Buffer.from(f.data).toString("base64"),
      }));
      return ok({
        version: 2,
        exportedAt: new Date().toISOString(),
        vaultMeta: normalizedMeta,
        users,
        servers, sessionKeys, serverFiles, fileContents, serverSnapshots, hostNotes, snippets,
        folders, hosts,
        credentials: credentials.map((c: any) => ({
          ...c,
          nonce: Buffer.from(c.nonce).toString("base64"),
          encrypted_blob: Buffer.from(c.encrypted_blob).toString("base64"),
        })),
        knownHosts,
      });
    });

    // ── Upgrade Personal → Team ──────────────────────────────────
    // Converts a personal vault into a team vault. The existing vault key
    // (which already encrypts all credentials) becomes the shared key, so
    // NO credential re-encryption is needed. We just create the first admin
    // user with that key sealed to their password, and flip the mode.
    // Requires the current master password to confirm.
    app.post("/api/settings/upgrade-team", { preHandler: auth }, async (req, reply) => {
      const db = app.skiffDb.raw;
      const body = z.object({
        currentPassword: z.string().min(1),
        adminUsername: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
      }).parse(req.body);

      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as any;
      if (!meta) return reply.code(400).send(err(ApiErrorCode.VAULT_NOT_INITIALIZED, "No vault"));
      if (meta.mode === "team") {
        return reply.code(409).send(err(ApiErrorCode.CONFLICT, "Already a team vault"));
      }

      // Verify the current master password and recover the vault key.
      const vaultKey = await deriveVaultKey(body.currentPassword, {
        algorithm: "argon2id",
        salt: meta.kdf_salt, iterations: meta.kdf_iterations,
        memoryKib: meta.kdf_memory_kib, parallelism: meta.kdf_parallelism,
      });
      if (!verifierMatches(computeVerifier(vaultKey), meta.verifier)) {
        vaultKey.fill(0);
        return reply.code(401).send(err(ApiErrorCode.INVALID_PASSWORD, "Incorrect password"));
      }

      // The vault key becomes the shared key. Seal it to the admin's password.
      const provisioned = await provisionUser(body.currentPassword, vaultKey);
      const userId = generateId("usr");
      const now = new Date().toISOString();

      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO users (id, username, display_name, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, shared_key_blob, shared_key_nonce, is_admin, disabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`
        ).run(
          userId, body.adminUsername, null,
          provisioned.kdf.salt, provisioned.kdf.iterations, provisioned.kdf.memoryKib, provisioned.kdf.parallelism,
          provisioned.verifier, provisioned.sharedKeyBlob, provisioned.sharedKeyNonce, now,
        );
        // Team mode enables session recording by default (admins can review
        // member sessions). Matches the default for freshly-created team vaults.
        db.prepare("UPDATE vault_meta SET mode = 'team', recording_enabled = 1 WHERE id = 1").run();
      });
      tx();

      // Re-issue the current session as this admin user.
      const sessionUser = { id: userId, username: body.adminUsername, isAdmin: true };
      // The vault owner is now this admin: their running SSH sessions follow.
      sessionManager.transferOwner(ownerKeyFor(undefined), ownerKeyFor(sessionUser), sessionUser);
      // Every personal-mode login (this one, and any other browser) has no user
      // identity, which a team vault can't attribute — sign them all out.
      sessionStore.destroyAnonymous();
      const sessionId = sessionStore.create(vaultKey, sessionUser);
      vaultKey.fill(0);
      reply.setCookie("skiff_session", sessionId, sessionCookieOptions(config));

      writeAudit(db, { user: sessionUser, action: "vault.upgrade_team", detail: { adminUsername: body.adminUsername }, ip: req.ip });
      return ok({ mode: "team", user: sessionUser });
    });

    // ── Restore from backup ──────────────────────────────────────
    // Imports a backup from GET /api/settings/backup. Only allowed on an
    // UNINITIALIZED instance — restoring over an existing vault would mix
    // credentials encrypted under different keys and corrupt things.
    //
    //   personal backup → unlock with the original master password
    //   team backup (v2) → every member signs in with their own password
    //   team backup (v1, older Skiff) → no member accounts in the file, so it
    //     can only come back as a personal vault. That works for a vault that
    //     was upgraded from personal (the original master password still
    //     derives the key); for one created in team mode it cannot be
    //     decrypted, and we say so rather than pretend.
    // Backups carry every key and credential; a few hundred hosts with 4096-bit
    // keys passes the app-wide 1 MB body limit, so restore gets its own.
    app.post("/api/settings/restore", { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
      const db = app.skiffDb.raw;
      const existing = db.prepare("SELECT id FROM vault_meta WHERE id = 1").get();
      if (existing) {
        return reply.code(409).send(err(ApiErrorCode.CONFLICT, "A vault already exists here. Restore only works on a fresh instance."));
      }
      if (!setupGate.check(req)) {
        return reply.code(403).send(err(ApiErrorCode.FORBIDDEN, "Setup token missing or incorrect. It is printed in the server log (docker compose logs skiff)."));
      }

      const b64 = z.string();
      const Backup = z.object({
        version: z.union([z.literal(1), z.literal(2)]),
        vaultMeta: z.object({
          schema_version: z.number(),
          kdf_salt: b64,
          kdf_iterations: z.number().int().positive(),
          kdf_memory_kib: z.number().int().positive(),
          kdf_parallelism: z.number().int().positive(),
          verifier: b64,
          idle_timeout_minutes: z.number().int().min(1).max(1440).optional(),
          mode: z.enum(["personal", "team"]).optional(),
          recording_enabled: z.number().optional(),
          memory_enabled: z.number().optional(),
          memory_output_days: z.number().int().positive().optional(),
          created_at: z.string().optional(),
        }),
        users: z.array(z.object({
          id: z.string().min(1),
          username: z.string().min(1).max(64),
          display_name: z.string().nullable().optional(),
          kdf_salt: b64,
          kdf_iterations: z.number().int().positive(),
          kdf_memory_kib: z.number().int().positive(),
          kdf_parallelism: z.number().int().positive(),
          verifier: b64,
          shared_key_blob: b64.nullable(),
          shared_key_nonce: b64.nullable(),
          is_admin: z.number(),
          disabled: z.number(),
          must_change_password: z.number().optional(),
          created_at: z.string().optional(),
        })).default([]),
        servers: z.array(z.object({
          id: z.string().min(1),
          fingerprint: z.string().min(1),
          algorithm: z.string().min(1),
          first_seen_at: z.string().optional(),
          previous_server_id: z.string().nullable().optional(),
          file_key_wrapped: b64,
          file_key_nonce: b64,
        })).default([]),
        sessionKeys: z.array(z.object({
          id: z.string().min(1),
          wrapped_key: b64,
          nonce: b64,
          created_at: z.string().optional(),
        })).default([]),
        serverFiles: z.array(z.object({
          server_id: z.string().min(1),
          path_hash: z.string().min(1),
          path_nonce: b64,
          path_data: b64,
          last_content_id: z.string().nullable().optional(),
          updated_at: z.string().optional(),
        })).default([]),
        hostNotes: z.array(z.object({
          host_id: z.string().min(1),
          nonce: b64,
          data: b64,
          version: z.number().int().min(1),
          updated_at: z.string(),
        })).default([]),
        snippets: z.array(z.object({
          id: z.string().min(1),
          nonce: b64,
          data: b64,
          user_id: z.string().nullable().optional(),
          created_at: z.string(),
          updated_at: z.string(),
        })).default([]),
        serverSnapshots: z.array(z.object({
          id: z.string().min(1),
          server_id: z.string().min(1),
          taken_at: z.string(),
          nonce: b64,
          data: b64,
        })).default([]),
        fileContents: z.array(z.object({
          id: z.string().min(1),
          server_id: z.string().min(1),
          nonce: b64,
          data: b64,
        })).default([]),
        folders: z.array(z.any()).default([]),
        hosts: z.array(z.any()).default([]),
        credentials: z.array(z.any()).default([]),
        knownHosts: z.array(z.any()).default([]),
      });

      const body = Backup.parse(req.body);
      const m = body.vaultMeta;
      const wasTeam = m.mode === "team";
      const restoreAsTeam = wasTeam && body.users.length > 0;

      if (restoreAsTeam) {
        const canSignIn = body.users.some((u) => u.is_admin === 1 && u.disabled === 0 && u.shared_key_blob && u.shared_key_nonce);
        if (!canSignIn) {
          return reply.code(400).send(err(ApiErrorCode.VALIDATION_FAILED, "This team backup has no active admin who could sign in."));
        }
      }

      const mode = restoreAsTeam ? "team" : "personal";
      const recording = m.recording_enabled ?? (restoreAsTeam ? 1 : 0);
      const memoryEnabled = m.memory_enabled ?? 1;
      const memoryOutputDays = m.memory_output_days ?? 90;

      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO vault_meta (id, schema_version, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, idle_timeout_minutes, mode, recording_enabled, memory_enabled, memory_output_days, created_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          m.schema_version,
          Buffer.from(m.kdf_salt, "base64"),
          m.kdf_iterations, m.kdf_memory_kib, m.kdf_parallelism,
          Buffer.from(m.verifier, "base64"),
          m.idle_timeout_minutes ?? 15,
          mode, recording ? 1 : 0,
          memoryEnabled ? 1 : 0, memoryOutputDays,
          m.created_at ?? new Date().toISOString(),
        );

        if (restoreAsTeam) {
          const insertUser = db.prepare(
            `INSERT INTO users (id, username, display_name, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, shared_key_blob, shared_key_nonce, is_admin, disabled, must_change_password, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          );
          for (const u of body.users) {
            insertUser.run(
              u.id, u.username, u.display_name ?? null,
              Buffer.from(u.kdf_salt, "base64"),
              u.kdf_iterations, u.kdf_memory_kib, u.kdf_parallelism,
              Buffer.from(u.verifier, "base64"),
              u.shared_key_blob ? Buffer.from(u.shared_key_blob, "base64") : null,
              u.shared_key_nonce ? Buffer.from(u.shared_key_nonce, "base64") : null,
              u.is_admin ? 1 : 0, u.disabled ? 1 : 0, u.must_change_password ? 1 : 0,
              u.created_at ?? new Date().toISOString(),
            );
          }
        }

        // Before hosts: hosts.server_id references servers(id).
        for (const s of body.servers) {
          db.prepare(
            `INSERT INTO servers (id, fingerprint, algorithm, first_seen_at, previous_server_id, file_key_wrapped, file_key_nonce)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(
            s.id, s.fingerprint, s.algorithm, s.first_seen_at ?? new Date().toISOString(),
            s.previous_server_id ?? null,
            Buffer.from(s.file_key_wrapped, "base64"), Buffer.from(s.file_key_nonce, "base64"),
          );
        }
        for (const f of body.serverSnapshots) {
          db.prepare("INSERT INTO server_snapshots (id, server_id, taken_at, nonce, data) VALUES (?, ?, ?, ?, ?)")
            .run(f.id, f.server_id, f.taken_at, Buffer.from(f.nonce, "base64"), Buffer.from(f.data, "base64"));
        }
        for (const f of body.fileContents) {
          db.prepare("INSERT INTO file_contents (id, server_id, nonce, data) VALUES (?, ?, ?, ?)")
            .run(f.id, f.server_id, Buffer.from(f.nonce, "base64"), Buffer.from(f.data, "base64"));
        }
        for (const f of body.serverFiles) {
          db.prepare("INSERT INTO server_files (server_id, path_hash, path_nonce, path_data, last_content_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(f.server_id, f.path_hash, Buffer.from(f.path_nonce, "base64"), Buffer.from(f.path_data, "base64"), f.last_content_id ?? null, f.updated_at ?? new Date().toISOString());
        }
        for (const k of body.sessionKeys) {
          db.prepare("INSERT INTO session_keys (id, wrapped_key, nonce, created_at) VALUES (?, ?, ?, ?)")
            .run(k.id, Buffer.from(k.wrapped_key, "base64"), Buffer.from(k.nonce, "base64"), k.created_at ?? new Date().toISOString());
        }
        for (const f of body.folders) {
          db.prepare("INSERT INTO folders (id, parent_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(f.id, f.parent_id ?? null, f.name, f.position ?? 0, f.created_at ?? new Date().toISOString());
        }
        for (const c of body.credentials) {
          db.prepare("INSERT INTO credentials (id, kind, nonce, encrypted_blob, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(c.id, c.kind, Buffer.from(c.nonce, "base64"), Buffer.from(c.encrypted_blob, "base64"), c.created_at ?? new Date().toISOString());
        }
        for (const h of body.hosts) {
          db.prepare(
            `INSERT INTO hosts (id, folder_id, label, hostname, port, username, auth_method, credential_id, tags, starred, server_id, memory_mode, precise_mode, snapshots, created_at, last_connected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            h.id, h.folder_id ?? null, h.label, h.hostname, h.port, h.username,
            h.auth_method, h.credential_id ?? null,
            typeof h.tags === "string" ? h.tags : JSON.stringify(h.tags ?? []),
            h.starred ? 1 : 0, h.server_id ?? null, h.memory_mode === "off" ? "off" : "on",
            h.precise_mode ? 1 : 0, h.snapshots ? 1 : 0,
            h.created_at ?? new Date().toISOString(), h.last_connected_at ?? null,
          );
        }
        for (const n of body.hostNotes) {
          db.prepare("INSERT INTO host_notes (host_id, nonce, data, version, updated_at) VALUES (?, ?, ?, ?, ?)")
            .run(n.host_id, Buffer.from(n.nonce, "base64"), Buffer.from(n.data, "base64"), n.version, n.updated_at);
        }
        for (const s of body.snippets) {
          db.prepare("INSERT INTO snippets (id, nonce, data, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(s.id, Buffer.from(s.nonce, "base64"), Buffer.from(s.data, "base64"), s.user_id ?? null, s.created_at, s.updated_at);
        }
        for (const k of body.knownHosts) {
          db.prepare("INSERT INTO known_hosts (hostname, port, fingerprint, algorithm, first_seen_at) VALUES (?, ?, ?, ?, ?)")
            .run(k.hostname, k.port, k.fingerprint, k.algorithm ?? "unknown", k.first_seen_at ?? new Date().toISOString());
        }
      });
      tx();

      if (restoreAsTeam) {
        writeAudit(db, { action: "vault.restore", detail: { mode: "team", users: body.users.length }, ip: req.ip });
      }

      const message = restoreAsTeam
        ? "Team backup restored. Every member signs in with their own username and password."
        : wasTeam
          ? "Restored as a personal vault: this backup was made by an older Skiff and has no member accounts. " +
            "If the vault was originally a personal vault upgraded to team, unlock with that original master password. " +
            "If it was created in team mode, its credentials cannot be decrypted from this file — make a new backup from the original server if you still can."
          : "Backup restored. Unlock with the password from the original vault.";

      return ok({
        mode,
        message,
        counts: {
          hosts: body.hosts.length, folders: body.folders.length,
          credentials: body.credentials.length, users: restoreAsTeam ? body.users.length : 0,
        },
      });
    });
  };
