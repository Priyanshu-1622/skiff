import type { FastifyPluginAsync } from "fastify";
import { Client as SSH2Client } from "ssh2";
import { join } from "node:path";
import type { SessionStore } from "../crypto/session-store.js";
import type { SessionManager } from "../lib/session-manager.js";
import { decrypt } from "../crypto/vault.js";
import { writeAudit } from "../lib/audit.js";
import { SessionRecorder } from "../lib/recorder.js";
import { generateId } from "../lib/id.js";
import { ApiErrorCode } from "@skiff/shared";

export interface TerminalRouteDeps {
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  dataDir: string;
}

const FINGERPRINT_TIMEOUT_MS = 60_000;

export const terminalRoutes: (deps: TerminalRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    app.get("/api/terminal/:hostId", { websocket: true }, (socket, req) => {
      const { hostId } = req.params as { hostId: string };
      const db = app.skiffDb.raw;

      // ── Auth ──────────────────────────────────────────────────
      const sessionId = req.cookies?.skiff_session;
      if (!sessionId) {
        socket.send(JSON.stringify({ type: "error", code: ApiErrorCode.VAULT_LOCKED }));
        socket.close(4001);
        return;
      }
      const entry = deps.sessionStore.getEntry(sessionId);
      if (!entry) {
        socket.send(JSON.stringify({ type: "error", code: ApiErrorCode.VAULT_LOCKED }));
        socket.close(4001);
        return;
      }
      const vaultKey = entry.vaultKey;

      const host = db.prepare("SELECT * FROM hosts WHERE id = ?").get(hostId) as any;
      if (!host) {
        socket.send(JSON.stringify({ type: "error", code: ApiErrorCode.NOT_FOUND }));
        socket.close(4004);
        return;
      }

      // managed-session id is per (browser session cookie + host) so the same
      // user reopening the same host reattaches to their live session.
      const managedId = `${sessionId}:${hostId}`;

      const client = {
        send: (chunk: Buffer) => {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: "data", data: chunk.toString("base64") }));
          }
        },
        end: (reason: string) => {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: "status", message: reason }));
            socket.close(1000);
          }
        },
      };

      socket.on("message", (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
          if (msg.type === "ping") {
            if (socket.readyState === 1) socket.send(JSON.stringify({ type: "pong", t: msg.t }));
          } else if (msg.type === "input") {
            deps.sessionManager.write(managedId, Buffer.from(msg.data, "base64"));
          } else if (msg.type === "resize") {
            deps.sessionManager.resize(managedId, msg.rows, msg.cols);
          }
        } catch { /* ignore malformed messages */ }
      });

      // Detaching (not ending) on socket close is what makes sessions persist.
      socket.on("close", () => {
        deps.sessionManager.detach(managedId, client);
      });

      // Fast path: an existing live session for this host? Reattach + replay.
      const existing = deps.sessionManager.get(managedId);
      if (existing && !existing.closed) {
        const scrollback = deps.sessionManager.attach(managedId, client);
        socket.send(JSON.stringify({ type: "status", message: "Reattached" }));
        if (scrollback && scrollback.length) {
          socket.send(JSON.stringify({ type: "data", data: scrollback.toString("base64") }));
        }
        return;
      }

      // Slow path: open a brand-new SSH session.
      const credential = host.credential_id
        ? (db.prepare("SELECT * FROM credentials WHERE id = ?").get(host.credential_id) as any)
        : null;

      const ssh = new SSH2Client();

      let connected = false;
      const onEarlyClose = () => { if (!connected) { try { ssh.end(); } catch { /* */ } } };
      socket.on("close", onEarlyClose);

      const decryptAndConnect = async () => {
        try {
          const connConfig: any = {
            host: host.hostname,
            port: host.port,
            username: host.username,
            readyTimeout: 10000,
            keepaliveInterval: 30000,
          };

          const knownHost = db
            .prepare("SELECT fingerprint FROM known_hosts WHERE hostname = ? AND port = ?")
            .get(host.hostname, host.port) as { fingerprint: string } | undefined;

          connConfig.hostVerifier = (hashedKey: Buffer, callback: (approved: boolean) => void) => {
            const fp = `SHA256:${hashedKey.toString("base64")}`;

            if (knownHost) {
              if (knownHost.fingerprint !== fp) {
                socket.send(JSON.stringify({ type: "fingerprint_mismatch", expected: knownHost.fingerprint, actual: fp }));
                callback(false);
                return;
              }
              callback(true);
              return;
            }

            socket.send(JSON.stringify({ type: "fingerprint_new", fingerprint: fp, hostname: host.hostname }));

            let settled = false;
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              if (socket.readyState === 1) {
                try {
                  socket.send(JSON.stringify({ type: "error", message: "Fingerprint confirmation timed out" }));
                  socket.close(4005);
                } catch { /* socket already gone */ }
              }
              callback(false);
            }, FINGERPRINT_TIMEOUT_MS);

            socket.on("close", () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              callback(false);
            });

            const onApproval = (raw: Buffer | string) => {
              if (settled) return;
              try {
                const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
                if (msg.type === "fingerprint_approve") {
                  settled = true;
                  clearTimeout(timer);
                  socket.removeListener("message", onApproval);
                  db.prepare(
                    "INSERT OR REPLACE INTO known_hosts (hostname, port, fingerprint, algorithm, first_seen_at) VALUES (?, ?, ?, ?, ?)"
                  ).run(host.hostname, host.port, fp, "unknown", new Date().toISOString());
                  callback(true);
                } else if (msg.type === "fingerprint_reject") {
                  settled = true;
                  clearTimeout(timer);
                  socket.removeListener("message", onApproval);
                  callback(false);
                  socket.close(4006);
                }
              } catch { /* ignore */ }
            };
            socket.on("message", onApproval);
          };

          if (credential) {
            const plaintext = decrypt(
              Buffer.from(credential.encrypted_blob),
              Buffer.from(credential.nonce),
              vaultKey,
            );
            if (credential.kind === "password") {
              connConfig.password = plaintext;
            } else {
              let parsed: { value: string; passphrase?: string };
              try { parsed = JSON.parse(plaintext); }
              catch { parsed = { value: plaintext }; }
              connConfig.privateKey = parsed.value;
              if (parsed.passphrase) connConfig.passphrase = parsed.passphrase;
            }
          }

          socket.send(JSON.stringify({ type: "status", message: "Connecting..." }));
          ssh.connect(connConfig);
        } catch (e: any) {
          socket.send(JSON.stringify({ type: "error", message: e.message }));
          socket.close(4002);
        }
      };

      ssh.on("ready", () => {
        connected = true;
        socket.removeListener("close", onEarlyClose);

        socket.send(JSON.stringify({ type: "status", message: "Connected" }));
        db.prepare("UPDATE hosts SET last_connected_at = ? WHERE id = ?")
          .run(new Date().toISOString(), hostId);
        writeAudit(db, {
          user: entry.user, action: "host.connect",
          resourceType: "host", resourceId: hostId,
          detail: { label: host.label, hostname: host.hostname, username: host.username },
          ip: req.ip,
        });

        ssh.shell({ term: "xterm-256color" }, async (shellErr, stream) => {
          if (shellErr) {
            socket.send(JSON.stringify({ type: "error", message: shellErr.message }));
            socket.close(4003);
            return;
          }

          const session = deps.sessionManager.register({
            id: managedId, hostId, user: entry.user, ssh, stream,
          });

          // Optional recording (per-vault setting; mode-aware default).
          const meta = db.prepare("SELECT recording_enabled FROM vault_meta WHERE id = 1").get() as
            | { recording_enabled: number } | undefined;
          if (meta?.recording_enabled) {
            const recId = generateId("rec");
            try {
              const recorder = await SessionRecorder.create({
                dir: join(deps.dataDir, "recordings"),
                id: recId,
                cols: 80, rows: 24,
                title: `${host.label} (${host.username}@${host.hostname})`,
              });
              db.prepare(
                `INSERT INTO session_recordings
                   (id, host_id, host_label, hostname, user_id, username, started_at, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'recording')`
              ).run(
                recId, hostId, host.label, host.hostname,
                entry.user?.id ?? null, entry.user?.username ?? null,
                new Date().toISOString(),
              );

              session.onOutput = (chunk) => recorder.writeOutput(chunk);
              session.onEnd = () => {
                const { durationMs, bytes } = recorder.finalize();
                try {
                  db.prepare(
                    "UPDATE session_recordings SET ended_at = ?, duration_ms = ?, bytes = ?, status = 'complete' WHERE id = ?"
                  ).run(new Date().toISOString(), durationMs, bytes, recId);
                } catch { /* db may be closing on shutdown */ }
              };
            } catch {
              // Recording setup failed — proceed without it; session must work.
            }
          }

          // If the browser already went away while we were connecting, the
          // detach handler ran before this session existed — so it never
          // started a reap timer. Tear the session down now instead of
          // leaking an orphaned SSH connection (and a recording stuck in
          // 'recording' state).
          if (socket.readyState !== 1) {
            deps.sessionManager.end(managedId, "Client gone");
            return;
          }

          deps.sessionManager.attach(managedId, client);
        });
      });

      ssh.on("error", (sshErr) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "error", message: sshErr.message }));
        }
        socket.close(4002);
      });

      decryptAndConnect();
    });
  };
