import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ok, err } from "../lib/response.js";
import { generateId } from "../lib/id.js";
import type { SessionStore } from "../crypto/session-store.js";
import { requireUnlocked } from "../lib/auth-middleware.js";
import { writeAudit } from "../lib/audit.js";
import { ApiErrorCode } from "@skiff/shared";

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

    app.post("/api/import/parse", { preHandler: auth }, async (req) => {
      const { configText } = z.object({ configText: z.string() }).parse(req.body);
      const hosts = parseSSHConfig(configText);
      return ok({ hosts });
    });

    app.post("/api/import/apply", { preHandler: auth }, async (req, reply) => {
      const body = ImportBody.parse(req.body);
      const db = app.skiffDb.raw;
      if (body.folderId && !db.prepare("SELECT 1 FROM folders WHERE id = ?").get(body.folderId)) {
        return reply.code(400).send(err(ApiErrorCode.VALIDATION_FAILED, "That folder doesn't exist."));
      }

      const parsed = parseSSHConfig(body.configText);
      const selected = body.selectedHosts
        ? parsed.filter((h) => body.selectedHosts!.includes(h.alias))
        : parsed;

      const created: string[] = [];
      const skipped: string[] = [];

      const insertHost = db.prepare(
        `INSERT INTO hosts (id, folder_id, label, hostname, port, username, auth_method, credential_id, tags, starred, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]', 0, ?)`
      );
      // Importing the same config twice shouldn't double every host.
      const alreadyThere = db.prepare(
        "SELECT 1 FROM hosts WHERE label = ? AND hostname = ? AND port = ? AND username = ?"
      );

      const tx = db.transaction(() => {
        for (const h of selected) {
          const hostname = h.hostname || h.alias;
          const port = h.port || 22;
          const user = h.user || "root";
          if (alreadyThere.get(h.alias, hostname, port, user)) {
            skipped.push(h.alias);
            continue;
          }
          // No credential is stored: ~/.ssh/config only names key *files*,
          // which live on the user's machine, and never holds passwords. The
          // terminal tells the user to add one when they first connect.
          insertHost.run(
            generateId("hst"), body.folderId, h.alias, hostname, port, user,
            h.identityFile ? "key" : "password",
            new Date().toISOString(),
          );
          created.push(h.alias);
        }
      });
      tx();

      if (created.length) {
        writeAudit(db, {
          user: req.sessionUser, action: "host.import",
          detail: { imported: created.length, skipped: skipped.length }, ip: req.ip,
        });
      }

      return ok({
        imported: created.length,
        skipped,
        // Every imported host still needs its password or key pasted in.
        needsCredential: created,
      });
    });
  };

export interface ParsedHost {
  alias: string;
  hostname: string | null;
  port: number | null;
  user: string | null;
  identityFile: string | null;
}

/**
 * Parse the parts of an OpenSSH client config that map onto a Skiff host.
 *
 * Follows ssh_config(5) where it matters for that:
 *   - keywords are case-insensitive, and "Key value" and "Key=value" both work;
 *   - values may be double-quoted;
 *   - one `Host` line can name several aliases, each becoming a host;
 *   - patterns (`*`, `?`, `!negated`) aren't single hosts and are skipped;
 *   - a `Match` block ends the current host — its settings are conditional,
 *     so they must not be applied to whatever `Host` came before it;
 *   - the first value given for a keyword wins, as in ssh.
 * `Include` isn't followed: the included files aren't available here.
 */
export function parseSSHConfig(text: string): ParsedHost[] {
  const hosts: ParsedHost[] = [];
  let current: ParsedHost[] = [];

  const unquote = (v: string) => {
    const t = v.trim();
    return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
  };
  const firstWins = (key: keyof ParsedHost, value: string | number | null) => {
    for (const h of current) if (h[key] === null) (h as any)[key] = value;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.+)$/);
    if (!match) continue;
    const kw = match[1]!.toLowerCase();
    const value = match[2]!.trim();

    if (kw === "host") {
      hosts.push(...current);
      current = value
        .split(/\s+/)
        .map(unquote)
        .filter((a) => a && !/[*?!]/.test(a))
        .map((alias) => ({ alias, hostname: null, port: null, user: null, identityFile: null }));
    } else if (kw === "match") {
      hosts.push(...current);
      current = [];
    } else if (current.length) {
      switch (kw) {
        case "hostname": firstWins("hostname", unquote(value)); break;
        case "port": {
          const port = parseInt(unquote(value), 10);
          if (port >= 1 && port <= 65535) firstWins("port", port);
          break;
        }
        case "user": firstWins("user", unquote(value)); break;
        case "identityfile": firstWins("identityFile", unquote(value)); break;
      }
    }
  }

  hosts.push(...current);
  // An alias listed under two Host blocks: keep the first, as ssh would.
  const seen = new Set<string>();
  return hosts.filter((h) => (seen.has(h.alias) ? false : (seen.add(h.alias), true)));
}
