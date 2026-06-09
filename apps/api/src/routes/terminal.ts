import type { FastifyPluginAsync } from "fastify";
import { Client as SSH2Client } from "ssh2";
import type { SessionStore } from "../crypto/session-store.js";
import { decrypt } from "../crypto/vault.js";
import { writeAudit } from "../lib/audit.js";
import { ApiErrorCode } from "@skiff/shared";

export interface TerminalRouteDeps {
  sessionStore: SessionStore;
}

const FINGERPRINT_TIMEOUT_MS = 60_000;

export const terminalRoutes: (deps: TerminalRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    app.get("/api/terminal/:hostId", { websocket: true }, (socket, req) => {
      const { hostId } = req.params as { hostId: string };

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

      const db = app.skiffDb.raw;
      const host = db.prepare("SELECT * FROM hosts WHERE id = ?").get(hostId) as any;
      if (!host) {
        socket.send(JSON.stringify({ type: "error", code: ApiErrorCode.NOT_FOUND }));
        socket.close(4004);
        return;
      }

      const credential = host.credential_id
        ? (db.prepare("SELECT * FROM credentials WHERE id = ?").get(host.credential_id) as any)
        : null;

      const ssh = new SSH2Client();
      let sshStream: any = null;

      // Single unified WS message handler — covers pings before shell is ready
      // and input/resize/ping/fingerprint responses after.
      socket.on("message", (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
          if (msg.type === "ping") {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: "pong", t: msg.t }));
            }
          } else if (msg.type === "input" && sshStream) {
            sshStream.write(Buffer.from(msg.data, "base64"));
          } else if (msg.type === "resize" && sshStream) {
            sshStream.setWindow(msg.rows, msg.cols, 0, 0);
          }
          // fingerprint_approve / fingerprint_reject are handled inline
          // inside decryptAndConnect via the pendingFingerprint promise
        } catch { /* ignore malformed messages */ }
      });

      socket.on("close", () => { ssh.end(); });

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
              // Known host — check fingerprint matches
              if (knownHost.fingerprint !== fp) {
                socket.send(JSON.stringify({
                  type: "fingerprint_mismatch",
                  expected: knownHost.fingerprint,
                  actual: fp,
                }));
                callback(false);
                return;
              }
              callback(true);
              return;
            }

            // Send fingerprint to browser and wait for explicit user approval
            // before persisting or proceeding. Timeout after 60s.
            socket.send(JSON.stringify({
              type: "fingerprint_new",
              fingerprint: fp,
              hostname: host.hostname,
            }));

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

            // If the user closes the tab while we're waiting, stop waiting.
            socket.on("close", () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              callback(false);
            });

            // Listen for one-time approval/rejection from the browser
            const onApproval = (raw: Buffer | string) => {
              if (settled) return;
              try {
                const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
                if (msg.type === "fingerprint_approve") {
                  settled = true;
                  clearTimeout(timer);
                  socket.removeListener("message", onApproval);
                  // Only persist AFTER user approves
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
                // other message types (ping etc) fall through to the main handler
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
        socket.send(JSON.stringify({ type: "status", message: "Connected" }));
        db.prepare("UPDATE hosts SET last_connected_at = ? WHERE id = ?")
          .run(new Date().toISOString(), hostId);
        writeAudit(db, {
          user: entry.user, action: "host.connect",
          resourceType: "host", resourceId: hostId,
          detail: { label: host.label, hostname: host.hostname, username: host.username },
          ip: req.ip,
        });

        ssh.shell({ term: "xterm-256color" }, (shellErr, stream) => {
          if (shellErr) {
            socket.send(JSON.stringify({ type: "error", message: shellErr.message }));
            socket.close(4003);
            return;
          }

          sshStream = stream;

          stream.on("data", (data: Buffer) => {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: "data", data: data.toString("base64") }));
            }
          });

          stream.stderr.on("data", (data: Buffer) => {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: "data", data: data.toString("base64") }));
            }
          });

          stream.on("close", () => {
            sshStream = null;
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: "status", message: "Session ended" }));
            }
            socket.close(1000);
          });
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
