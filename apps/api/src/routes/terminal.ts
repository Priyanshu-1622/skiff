import type { FastifyPluginAsync } from "fastify";
import { Client as SSH2Client } from "ssh2";
import { join } from "node:path";
import type { SessionStore } from "../crypto/session-store.js";
import type { Config } from "../config.js";
import { type SessionManager, type AttachedClient, ownerKeyFor, managedIdFor } from "../lib/session-manager.js";
import { decrypt } from "../crypto/vault.js";
import { writeAudit } from "../lib/audit.js";
import { SessionRecorder } from "../lib/recorder.js";
import { generateId } from "../lib/id.js";
import { hostKeyFingerprint, hostKeyType, legacyHostKeyId } from "../lib/host-key.js";
import { ApiErrorCode } from "@skiff/shared";

export interface TerminalRouteDeps {
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  dataDir: string;
  config: Pick<Config, "nodeEnv" | "trustedOrigins" | "maxSessionsPerUser">;
}

const FINGERPRINT_TIMEOUT_MS = 60_000;

/** Sent when a browser is detached because its login was locked or expired. */
const VAULT_LOCKED_REASON = "Vault locked — your session is still running. Unlock to reattach.";
const CLOSE_VAULT_LOCKED = 4001;

const DEFAULT_MAX_SESSIONS_PER_USER = 20;
const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

/** Show a stored pin as a real fingerprint, even if an older Skiff stored the whole key. */
function displayFingerprint(stored: string): string {
  const b64 = stored.startsWith("SHA256:") ? stored.slice(7) : stored;
  if (b64.length <= 44) return stored; // already a SHA-256 fingerprint
  try { return hostKeyFingerprint(Buffer.from(b64, "base64")); } catch { return stored; }
}

function clampDim(n: unknown, max: number): number | null {
  const v = Number(n);
  return Number.isInteger(v) && v >= 1 && v <= max ? v : null;
}

export const terminalRoutes: (deps: TerminalRouteDeps) => FastifyPluginAsync =
  (deps) => async (app) => {
    // A lock, idle expiry, or password change ends a browser login. Any
    // terminal attached through that login is detached — never left live on a
    // locked screen — but the SSH session itself keeps running for its owner.
    const stopListening = deps.sessionStore.onDestroy((loginSessionId) => {
      deps.sessionManager.detachByLogin(loginSessionId, VAULT_LOCKED_REASON);
    });
    app.addHook("onClose", async () => { stopListening(); });

    // Browsers attach cookies to WebSocket handshakes from any page, and
    // SameSite=Lax still lets another site on the same domain (another app on
    // this host, a sibling subdomain) through. So a browser handshake must come
    // from Skiff's own origin. Non-browser clients send no Origin; they still
    // need a valid session cookie.
    const originAllowed = (origin: string | undefined, host: string): boolean => {
      if (!origin) return true;
      if (deps.config.trustedOrigins.includes(origin)) return true;
      if (deps.config.nodeEnv === "development" && DEV_ORIGINS.includes(origin)) return true;
      try { return new URL(origin).host === host; } catch { return false; }
    };

    const maxSessions = deps.config.maxSessionsPerUser ?? DEFAULT_MAX_SESSIONS_PER_USER;
    // Connections still being set up, per owner, so a burst of clicks can't
    // slip past the cap before any of them has registered.
    const connecting = new Map<string, number>();
    app.get("/api/terminal/:hostId", { websocket: true }, (socket, req) => {
      const { hostId } = req.params as { hostId: string };
      const db = app.skiffDb.raw;

      // ── Origin ────────────────────────────────────────────────
      // req.host keeps the port (Fastify 5's req.hostname drops it), matching
      // URL.host of the Origin.
      if (!originAllowed(req.headers.origin, req.host)) {
        socket.send(JSON.stringify({ type: "error", code: ApiErrorCode.FORBIDDEN, message: "Connection refused: wrong origin" }));
        socket.close(4003);
        return;
      }

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

      // The live session belongs to the person (vault owner, or team member),
      // not to this browser login. Re-locking, re-logging in, or opening the
      // host from another device all land on the same id and reattach.
      const managedId = managedIdFor(ownerKeyFor(entry.user), hostId);

      const client: AttachedClient = {
        loginSessionId: sessionId,
        send: (chunk: Buffer) => {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: "data", data: chunk.toString("base64") }));
          }
        },
        end: (reason: string) => {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: "status", message: reason }));
            socket.close(reason === VAULT_LOCKED_REASON ? CLOSE_VAULT_LOCKED : 1000);
          }
        },
      };

      // Last size the browser reported. The PTY is opened at this size, so a
      // new shell doesn't start at 80x24 and wrap wrongly until the next resize.
      let lastSize: { rows: number; cols: number } | null = null;

      // Typing counts as activity for the vault's idle lock; pings and resizes
      // don't, or an open tab would keep the vault unlocked forever. If the
      // login has already expired, getEntry() destroys it, which detaches us.
      const touchLogin = () => { deps.sessionStore.getEntry(sessionId); };

      const isAttached = () => deps.sessionManager.get(managedId)?.attached === client;

      const sendReplay = (scrollback: Buffer | null, message: string) => {
        socket.send(JSON.stringify({ type: "status", message }));
        if (scrollback && scrollback.length) {
          socket.send(JSON.stringify({ type: "data", data: scrollback.toString("base64") }));
        }
      };

      socket.on("message", (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
          if (msg.type === "ping") {
            if (socket.readyState === 1) socket.send(JSON.stringify({ type: "pong", t: msg.t }));
          } else if (msg.type === "input") {
            touchLogin();
            deps.sessionManager.write(managedId, Buffer.from(msg.data, "base64"), client);
          } else if (msg.type === "resize") {
            const rows = clampDim(msg.rows, 1000);
            const cols = clampDim(msg.cols, 1000);
            if (rows && cols) {
              lastSize = { rows, cols };
              deps.sessionManager.resize(managedId, rows, cols, client);
            }
          } else if (msg.type === "end_session") {
            if (!isAttached()) return; // only the window actually showing it may end it
            // Closing the socket only detaches — that is what makes sessions
            // survive a closed tab. Ending one has to be asked for explicitly,
            // and it is the only path that runs onEnd, so it is also the only
            // path that finalizes a recording with its duration and byte count.
            // Without this every recording ended up "interrupted" with no
            // duration, because the session outlived every client that left.
            deps.sessionManager.end(managedId, "Session ended by user");
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
        sendReplay(deps.sessionManager.attach(managedId, client), "Reattached");
        return;
      }

      // Slow path: open a brand-new SSH session.
      //
      // Without a stored credential ssh2 would try "none" auth and fail with
      // "All configured authentication methods failed", which tells nobody
      // what to do. Hosts imported from ~/.ssh/config start out this way.
      if (!host.credential_id) {
        socket.send(JSON.stringify({
          type: "error", code: "NO_CREDENTIAL",
          message: "No password or key is saved for this host yet. Edit the host (the ⚙ button in the host list) and add one.",
        }));
        socket.close(4002);
        return;
      }

      // Within the owner's cap.
      const owner = ownerKeyFor(entry.user);
      const open = deps.sessionManager.countByOwner(owner) + (connecting.get(owner) ?? 0);
      if (open >= maxSessions) {
        socket.send(JSON.stringify({
          type: "error",
          message: `You already have ${open} open sessions (limit ${maxSessions}). End one before opening another.`,
        }));
        socket.close(4029);
        return;
      }
      connecting.set(owner, (connecting.get(owner) ?? 0) + 1);
      let released = false;
      const releaseSlot = () => {
        if (released) return;
        released = true;
        const n = (connecting.get(owner) ?? 1) - 1;
        if (n > 0) connecting.set(owner, n); else connecting.delete(owner);
      };

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

          // ssh2 passes the raw host key (no hostHash option), so compute the
          // same SHA256 fingerprint `ssh-keygen -lf` shows — the one a person
          // can actually compare against their server.
          connConfig.hostVerifier = (rawKey: Buffer, callback: (approved: boolean) => void) => {
            const fp = hostKeyFingerprint(rawKey);
            const algorithm = hostKeyType(rawKey);

            if (knownHost) {
              if (knownHost.fingerprint === fp) {
                callback(true);
                return;
              }
              // Pinned by an older Skiff, which stored the whole key instead of
              // its fingerprint. Same key → migrate the row and carry on.
              if (knownHost.fingerprint === legacyHostKeyId(rawKey)) {
                db.prepare("UPDATE known_hosts SET fingerprint = ?, algorithm = ? WHERE hostname = ? AND port = ?")
                  .run(fp, algorithm, host.hostname, host.port);
                callback(true);
                return;
              }
              const meta = db.prepare("SELECT mode FROM vault_meta WHERE id = 1").get() as { mode?: string } | undefined;
              socket.send(JSON.stringify({
                type: "fingerprint_mismatch",
                expected: displayFingerprint(knownHost.fingerprint),
                actual: fp,
                algorithm,
                hostId,
                // Only whoever owns the vault may re-trust a changed key.
                canReset: meta?.mode !== "team" || !!entry.user?.isAdmin,
              }));
              callback(false);
              return;
            }

            socket.send(JSON.stringify({ type: "fingerprint_new", fingerprint: fp, algorithm, hostname: host.hostname }));

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
                  ).run(host.hostname, host.port, fp, algorithm, new Date().toISOString());
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
          releaseSlot();
          socket.send(JSON.stringify({ type: "error", message: e.message }));
          socket.close(4002);
        }
      };

      ssh.on("ready", () => {
        connected = true;
        socket.removeListener("close", onEarlyClose);

        db.prepare("UPDATE hosts SET last_connected_at = ? WHERE id = ?")
          .run(new Date().toISOString(), hostId);
        writeAudit(db, {
          user: entry.user, action: "host.connect",
          resourceType: "host", resourceId: hostId,
          detail: { label: host.label, hostname: host.hostname, username: host.username },
          ip: req.ip,
        });

        const window = lastSize ? { rows: lastSize.rows, cols: lastSize.cols } : {};
        ssh.shell({ term: "xterm-256color", ...window }, (shellErr, stream) => {
          if (shellErr) {
            socket.send(JSON.stringify({ type: "error", message: shellErr.message }));
            socket.close(4003);
            return;
          }

          // Another window for the same owner+host finished connecting first
          // (double click, two tabs, Reconnect mid-connect). Join that session
          // instead of replacing it — replacing it orphaned one connection and
          // let its close handler kill the other.
          const raced = deps.sessionManager.get(managedId);
          if (raced && !raced.closed) {
            try { stream.close(); } catch { /* ignore */ }
            try { ssh.end(); } catch { /* ignore */ }
            if (socket.readyState === 1) {
              sendReplay(deps.sessionManager.attach(managedId, client), "Reattached");
            }
            return;
          }

          const session = deps.sessionManager.register({
            id: managedId, hostId, owner, user: entry.user, ssh, stream,
          });
          releaseSlot(); // now counted by the session manager itself

          // Optional recording (per-vault setting; mode-aware default).
          const meta = db.prepare("SELECT recording_enabled FROM vault_meta WHERE id = 1").get() as
            | { recording_enabled: number } | undefined;
          if (meta?.recording_enabled) {
            const recId = generateId("rec");
            try {
              // Synchronous, in the same tick the shell opened: output can't
              // arrive before onOutput is set, so the MOTD and first prompt
              // are in the recording too.
              const recorder = SessionRecorder.create({
                dir: join(deps.dataDir, "recordings"),
                id: recId,
                cols: lastSize?.cols ?? 80, rows: lastSize?.rows ?? 24,
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
              session.onResize = (rows, cols) => recorder.writeResize(cols, rows);
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

          // The login may have been locked while we were connecting. Keep the
          // new session for its owner (it reaps if nobody returns), but don't
          // attach a locked browser to a live shell.
          if (!deps.sessionStore.getEntry(sessionId)) {
            client.end(VAULT_LOCKED_REASON);
            return;
          }

          // Only now is there a session to receive input and resizes, so only
          // now tell the browser it's connected — it flushes buffered
          // keystrokes on this message, and they used to arrive too early.
          sendReplay(deps.sessionManager.attach(managedId, client), "Connected");
        });
      });

      // Any way the connection ends before registering frees the slot.
      ssh.on("close", releaseSlot);

      ssh.on("error", (sshErr) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "error", message: sshErr.message }));
        }
        socket.close(4002);
      });

      decryptAndConnect();
    });
  };
