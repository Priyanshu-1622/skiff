/**
 * SSH config import route.
 * Parses ~/.ssh/config format and bulk-creates hosts.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ok } from "../lib/response.js";
import { generateId } from "../lib/id.js";
import { encrypt } from "../crypto/vault.js";
import type { SessionStore } from "../crypto/session-store.js";
import { requireUnlocked } from "../lib/auth-middleware.js";

const ImportBody = z.object({
  configText: z.string().min(1),
  selectedHosts: z.array(z.string()).optional(),
  folderId: z.string().nullable().default(null),
});

export interface ImportRouteDeps {
  sessionStore: SessionStore;
}

export const importRoutes: (deps: ImportRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    const auth = requireUnlocked(deps.sessionStore);

    // ─── POST /api/import/parse — parse config, return preview ───
    app.post("/api/import/parse", { preHandler: auth }, async (req) => {
      const { configText } = z.object({ configText: z.string() }).parse(req.body);
      const hosts = parseSSHConfig(configText);
      return ok({ hosts });
    });

    // ─── POST /api/import/apply — create hosts from parsed config ─
    app.post("/api/import/apply", { preHandler: auth }, async (req) => {
      const body = ImportBody.parse(req.body);
      const parsed = parseSSHConfig(body.configText);
      const selected = body.selectedHosts
        ? parsed.filter((h) => body.selectedHosts!.includes(h.alias))
        : parsed;

      const created: string[] = [];
      const db = app.skiffDb.raw;

      const insertHost = db.prepare(
        `INSERT INTO hosts (id, folder_id, label, hostname, port, username, auth_method, credential_id, tags, starred, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?)`
      );

      const insertCred = db.prepare(
        "INSERT INTO credentials (id, kind, nonce, encrypted_blob, created_at) VALUES (?, ?, ?, ?, ?)"
      );

      const tx = db.transaction(() => {
        for (const h of selected) {
          const hostId = generateId("hst");
          let credentialId: string | null = null;

          if (h.identityFile) {
            credentialId = generateId("crd");
            const encrypted = encrypt(
              `# Imported from SSH config\n# IdentityFile: ${h.identityFile}\n# You may need to update this with the actual private key content`,
              req.vaultKey,
            );
            insertCred.run(credentialId, "key", encrypted.nonce, encrypted.ciphertext, new Date().toISOString());
          }

          insertHost.run(
            hostId, body.folderId, h.alias, h.hostname || h.alias,
            h.port || 22, h.user || "root",
            h.identityFile ? "key" : "password",
            credentialId, new Date().toISOString(),
          );
          created.push(hostId);
        }
      });

      tx();
      return ok({ imported: created.length, hostIds: created });
    });
  };

// ─── SSH Config Parser ──────────────────────────────────────────

interface ParsedHost {
  alias: string;
  hostname: string | null;
  port: number | null;
  user: string | null;
  identityFile: string | null;
}

function parseSSHConfig(text: string): ParsedHost[] {
  const hosts: ParsedHost[] = [];
  let current: ParsedHost | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;

    const [, keyword, value] = match;
    const kw = keyword!.toLowerCase();

    if (kw === "host") {
      // Skip wildcards
      if (value!.includes("*") || value!.includes("?")) continue;
      // Commit previous host
      if (current) hosts.push(current);
      current = { alias: value!.trim(), hostname: null, port: null, user: null, identityFile: null };
    } else if (current) {
      switch (kw) {
        case "hostname": current.hostname = value!.trim(); break;
        case "port": current.port = parseInt(value!.trim(), 10) || null; break;
        case "user": current.user = value!.trim(); break;
        case "identityfile": current.identityFile = value!.trim(); break;
      }
    }
  }

  if (current) hosts.push(current);
  return hosts;
}
