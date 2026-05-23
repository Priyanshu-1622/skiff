/**
 * WebSocket SSH terminal endpoint.
 *
 * Flow: client opens WS → server authenticates session cookie →
 * server decrypts host credential → ssh2 connects to target →
 * stdin/stdout piped both ways.
 */

import type { FastifyPluginAsync } from "fastify";
import { Client as SSH2Client } from "ssh2";
import type { SessionStore } from "../crypto/session-store.js";
import { decrypt } from "../crypto/vault.js";
import { ApiErrorCode } from "@skiff/shared";

export interface TerminalRouteDeps {
  sessionStore: SessionStore;
}

export const terminalRoutes: (deps: TerminalRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    app.get("/api/terminal/:hostId", { websocket: true }, (socket, req) => {
      const { hostId } = req.params as { hostId: string };

      // Auth: check session cookie from the WS upgrade request
      const sessionId = req.cookies?.skiff_session;
      if (!sessionId) {
        socket.send(JSON.stringify({ type: "error", code: ApiErrorCode.VAULT_LOCKED }));
        socket.close(4001);
        return;
      }

      const vaultKey = deps.sessionStore.get(sessionId);
      if (!vaultKey) {
        socket.send(JSON.stringify({ type: "error", code: ApiErrorCode.VAULT_LOCKED }));
        socket.close(4001);
        return;
      }

      // Load host + credential
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

      // Connection config
      const connConfig: any = {
        host: host.hostname,
        port: host.port,
        username: host.username,
        readyTimeout: 10000,
        keepaliveInterval: 30000,
      };

      // Known hosts check
      const knownHost = db
        .prepare("SELECT fingerprint FROM known_hosts WHERE hostname = ? AND port = ?")
        .get(host.hostname, host.port) as { fingerprint: string } | undefined;

      connConfig.hostVerifier = (hashedKey: Buffer) => {
        const fp = `SHA256:${hashedKey.toString("base64")}`;
        if (knownHost) {
          if (knownHost.fingerprint !== fp) {
            socket.send(JSON.stringify({
              type: "fingerprint_mismatch",
              expected: knownHost.fingerprint,
              actual: fp,
            }));
            return false;
          }
          return true;
        }
        // First connection — send fingerprint for user to confirm
        socket.send(JSON.stringify({ type: "fingerprint_new", fingerprint: fp, hostname: host.hostname }));
        // Auto-accept for v1 (user sees the fingerprint in the UI)
        db.prepare(
          "INSERT OR REPLACE INTO known_hosts (hostname, port, fingerprint, algorithm, first_seen_at) VALUES (?, ?, ?, ?, ?)"
        ).run(host.hostname, host.port, fp, "unknown", new Date().toISOString());
        return true;
      };

      // Decrypt credential
      const decryptAndConnect = async () => {
        try {
          if (credential) {
            const plaintext = decrypt(
              Buffer.from(credential.encrypted_blob),
              Buffer.from(credential.nonce),
              vaultKey,
            );
            if (credential.kind === "password") {
              connConfig.password = plaintext;
            } else {
              // key or key+passphrase
              let parsed: { value: string; passphrase?: string };
              try {
                parsed = JSON.parse(plaintext);
              } catch {
                parsed = { value: plaintext };
              }
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

        // Update last_connected_at
        db.prepare("UPDATE hosts SET last_connected_at = ? WHERE id = ?")
          .run(new Date().toISOString(), hostId);

        ssh.shell({ term: "xterm-256color" }, (shellErr, stream) => {
          if (shellErr) {
            socket.send(JSON.stringify({ type: "error", message: shellErr.message }));
            socket.close(4003);
            return;
          }

          // Pipe SSH stdout → WebSocket
          stream.on("data", (data: Buffer) => {
            if (socket.readyState === 1) { // OPEN
              socket.send(JSON.stringify({ type: "data", data: data.toString("base64") }));
            }
          });

          stream.stderr.on("data", (data: Buffer) => {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: "data", data: data.toString("base64") }));
            }
          });

          stream.on("close", () => {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: "status", message: "Session ended" }));
            }
            socket.close(1000);
          });

          // WebSocket → SSH stdin
          socket.on("message", (raw: Buffer | string) => {
            try {
              const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
              if (msg.type === "input") {
                stream.write(Buffer.from(msg.data, "base64"));
              } else if (msg.type === "resize") {
                stream.setWindow(msg.rows, msg.cols, 0, 0);
              } else if (msg.type === "ping") {
                if (socket.readyState === 1) {
                  socket.send(JSON.stringify({ type: "pong", t: msg.t }));
                }
              }
            } catch {
              // Ignore malformed messages
            }
          });
        });
      });

      ssh.on("error", (sshErr) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "error", message: sshErr.message }));
        }
        socket.close(4002);
      });

      // Handle ping messages even before shell is ready
      socket.on("message", (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
          if (msg.type === "ping" && socket.readyState === 1) {
            socket.send(JSON.stringify({ type: "pong", t: msg.t }));
          }
        } catch { /* ignore */ }
      });

      socket.on("close", () => {
        ssh.end();
      });

      decryptAndConnect();
    });
  };
