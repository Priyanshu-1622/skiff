import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet, apiDelete } from "@/lib/api";
import { createTerminalSocket, type TerminalMessage } from "@/lib/ws";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";
import { MemoryDrawer } from "@/components/MemoryDrawer";
import { MemoryNotice } from "@/components/MemoryNotice";
import { getStored, setStored } from "@/lib/safe-storage";

type ConnState = "connecting" | "connected" | "disconnected" | "error";

const MIN_FONT = 10;
const MAX_FONT = 24;
const DEFAULT_FONT = 14;
const FONT_STORAGE_KEY = "skiff.terminal.fontSize";

/**
 * Base64-encode a UTF-8 string without `String.fromCharCode(...bytes)`,
 * which throws RangeError (call stack exceeded) on large inputs such as
 * a pasted block of text. Builds the binary string in a simple loop.
 */
function encodeInputToBase64(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function TerminalRoute() {
  const { hostId } = useParams({ strict: false }) as { hostId: string };
  const navigate = useNavigate();

  const termRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const streamReadyRef = useRef(false);
  const pendingInputRef = useRef<string[]>([]);
  const pingIntervalRef = useRef<number | null>(null);
  const lastPingTsRef = useRef<number>(0);

  const [connState, setConnState] = useState<ConnState>("connecting");
  const [statusMsg, setStatusMsg] = useState("Connecting…");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [fontSize, setFontSize] = useState<number>(() => {
    const stored = parseInt(getStored(FONT_STORAGE_KEY) || "");
    return stored >= MIN_FONT && stored <= MAX_FONT ? stored : DEFAULT_FONT;
  });
  const [reconnectKey, setReconnectKey] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [showHistory, setShowHistory] = useState(() => getStored("skiff.memdrawer.open") === "1");
  useEffect(() => { setStored("skiff.memdrawer.open", showHistory ? "1" : "0"); }, [showHistory]);
  const [memoryState, setMemoryState] = useState<"remembering" | "paused" | "off" | "unavailable" | null>(null);
  const [pendingFp, setPendingFp] = useState<{ fingerprint: string; hostname: string; algorithm?: string } | null>(null);
  // The server presented a different key than the one pinned for this host.
  const [mismatch, setMismatch] = useState<{ expected: string; actual: string; algorithm?: string; canReset: boolean } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const host = useQuery({
    queryKey: ["host", hostId],
    queryFn: () => apiGet<any>(`/api/hosts/${hostId}`),
    enabled: !!hostId,
  });

  // Persist font size
  useEffect(() => {
    setStored(FONT_STORAGE_KEY, String(fontSize));
    if (xtermRef.current) {
      xtermRef.current.options.fontSize = fontSize;
      try { fitRef.current?.fit(); } catch { /* ignore */ }
    }
  }, [fontSize]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Shift+W: disconnect
      if (e.ctrlKey && e.shiftKey && (e.key === "W" || e.key === "w")) {
        e.preventDefault();
        endSessionRef.current?.();
        return;
      }
      // Ctrl+= or Ctrl++: increase font size
      if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setFontSize((s) => Math.min(s + 1, MAX_FONT));
        return;
      }
      // Ctrl+-: decrease font size
      if (e.ctrlKey && e.key === "-") {
        e.preventDefault();
        setFontSize((s) => Math.max(s - 1, MIN_FONT));
        return;
      }
      // Ctrl+0: reset font size
      if (e.ctrlKey && e.key === "0") {
        e.preventDefault();
        setFontSize(DEFAULT_FONT);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Tell the server to end the session, then leave.
   *
   * Closing the socket on its own only detaches — the session stays alive on
   * the server, which is the point of it. But that also means it never runs
   * its end hook, so a recording is never finalized and shows up as
   * "interrupted" with no duration or size. Anyone pressing Disconnect means
   * they are finished, so say so explicitly.
   */
  const endSession = useCallback(() => {
    const sock = socketRef.current;
    if (sock?.readyState === WebSocket.OPEN) {
      try { sock.send(JSON.stringify({ type: "end_session" })); } catch { /* closing anyway */ }
    }
    sock?.close();
    navigate({ to: "/" });
  }, [navigate]);

  const endSessionRef = useRef<(() => void) | null>(null);
  useEffect(() => { endSessionRef.current = endSession; }, [endSession]);

  const reconnect = useCallback(() => {
    setMismatch(null);
    setConfirmReset(false);
    socketRef.current?.close();
    setConnState("connecting");
    setStatusMsg("Reconnecting…");
    setLatencyMs(null);
    setReconnectKey((k) => k + 1);
  }, []);

  // Forget the pinned key and reconnect, which shows the normal "verify this
  // new host key" prompt for the key the server has now.
  const trustNewKey = useCallback(async () => {
    try {
      await apiDelete(`/api/hosts/${hostId}/known-host`);
      toast.info("Old host key forgotten", { description: "Check the new fingerprint before trusting it." });
      reconnect();
    } catch (e: any) {
      toast.error("Couldn't reset the host key", { description: e?.message });
    }
  }, [hostId, reconnect]);

  const setMemoryPaused = useCallback((paused: boolean) => {
    const sock = socketRef.current;
    if (sock?.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: "memory_pause", paused }));
    }
  }, []);

  // "Run again" from History: put the command on the prompt, never press Enter.
  // Every control character (incl. CR/LF) is stripped so it can't execute by itself.
  const runAgain = useCallback((command: string) => {
    const sock = socketRef.current;
    if (/[\r\n]/.test(command)) {
      toast.info("Copy this command block", { description: "Line breaks matter. Copy it and review the complete block before pasting." });
      return;
    }
    const text = command.replace(/[\u0000-\u001f\u007f]/g, "");
    if (!text || connState !== "connected" || sock?.readyState !== WebSocket.OPEN) return;
    sock.send(JSON.stringify({ type: "input", data: encodeInputToBase64(text) }));
    xtermRef.current?.focus();
  }, [connState]);

  const approveFingerprint = useCallback(() => {
    const sock = socketRef.current;
    if (sock?.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: "fingerprint_approve" }));
    }
    setPendingFp(null);
  }, []);

  const rejectFingerprint = useCallback(() => {
    const sock = socketRef.current;
    if (sock?.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: "fingerprint_reject" }));
    }
    setPendingFp(null);
  }, []);

  useEffect(() => {
    if (!hostId || !termRef.current) return;
    let term: any, fitAddon: any;
    let cancelled = false;
    streamReadyRef.current = false;
    pendingInputRef.current = [];

    const init = async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      if (cancelled) return;

      term = new Terminal({
        cursorBlink: true,
        fontSize,
        fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', 'Menlo', monospace",
        scrollback: 5000,
        allowProposedApi: true,
        macOptionIsMeta: true,
        rightClickSelectsWord: true,
        theme: {
          background: "#0A0B0D", foreground: "#E6E8EC",
          cursor: "#E6E8EC", selectionBackground: "#363A45",
          black: "#1C1F25", red: "#E06C75", green: "#98C379",
          yellow: "#E5C07B", blue: "#61AFEF", magenta: "#C678DD",
          cyan: "#56B6C2", white: "#ABB2BF",
          brightBlack: "#363A45", brightRed: "#E06C75",
          brightGreen: "#98C379", brightYellow: "#E5C07B",
          brightBlue: "#61AFEF", brightMagenta: "#C678DD",
          brightCyan: "#56B6C2", brightWhite: "#E6E8EC",
        },
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(termRef.current!);
      try { fitAddon.fit(); } catch { /* ignore */ }
      xtermRef.current = term;
      fitRef.current = fitAddon;

      // Keys Skiff handles itself. Returning false stops xterm from ALSO
      // sending them to the shell — Ctrl+- used to shrink the font and send
      // ^_ (readline "undo") at the same time. The window listener above
      // still sees the event and does the font change.
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== "keydown") return true;
        if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
          // Ctrl+Shift+C copies, like desktop terminals (Ctrl+C stays SIGINT).
          // In Chrome this key would otherwise open DevTools.
          e.preventDefault();
          const selection = term.getSelection();
          if (selection) navigator.clipboard?.writeText(selection).catch(() => {});
          return false;
        }
        if (e.ctrlKey && (e.key === "V" || e.key === "v")) {
          // Both browser paste shortcuts must bypass xterm's Ctrl+V (0x16).
          // In zsh that control quotes the following bracketed-paste marker,
          // inserting literal ^[[200~ instead of letting the shell parse it.
          return false; // native paste is delivered once through xterm's paste event
        }
        if (e.ctrlKey && !e.shiftKey && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
          return false;
        }
        return true;
      });

      // Auto-focus so users can type immediately
      term.focus();

      // Buffer keystrokes until the SSH shell is ready (fixes first-keystroke loss)
      term.onData((data: string) => {
        const sock = socketRef.current;
        if (!sock || sock.readyState !== WebSocket.OPEN) return;
        if (streamReadyRef.current) {
          sock.send(JSON.stringify({ type: "input", data: encodeInputToBase64(data) }));
        } else {
          pendingInputRef.current.push(data);
        }
      });

      const socket = createTerminalSocket(hostId);
      socketRef.current = socket;

      socket.onopen = () => {
        // Send initial size so the server starts with the right dimensions
        try {
          socket.send(JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }));
        } catch { /* ignore */ }
      };

      socket.onmessage = (event) => {
        let msg: TerminalMessage;
        try { msg = JSON.parse(event.data); } catch { return; }
        switch (msg.type) {
          case "memory":
            setMemoryState(msg.state ?? null);
            break;
          case "memory_note":
            if (msg.message) toast.info("Precise mode", { description: msg.message });
            break;
          case "data":
            term.write(Uint8Array.from(atob(msg.data!), c => c.charCodeAt(0)));
            break;
          case "status":
            setStatusMsg(msg.message || "");
            if (msg.message === "Connected" || msg.message === "Reattached") {
              setConnState("connected");
              streamReadyRef.current = true;
              // Make sure the server-side PTY has our dimensions before we
              // replay anything the user typed while waiting.
              try {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }));
                }
              } catch { /* ignore */ }
              // Flush any keystrokes buffered before the shell was ready
              while (pendingInputRef.current.length > 0) {
                const data = pendingInputRef.current.shift()!;
                socket.send(JSON.stringify({ type: "input", data: encodeInputToBase64(data) }));
              }
              // Start latency ping loop
              if (pingIntervalRef.current) window.clearInterval(pingIntervalRef.current);
              pingIntervalRef.current = window.setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                  lastPingTsRef.current = Date.now();
                  try { socket.send(JSON.stringify({ type: "ping", t: lastPingTsRef.current })); } catch { /* ignore */ }
                }
              }, 5000) as unknown as number;
            }
            if (msg.message === "Session ended") {
              setConnState("disconnected");
              streamReadyRef.current = false;
            }
            break;
          case "pong":
            if (lastPingTsRef.current > 0) {
              setLatencyMs(Date.now() - lastPingTsRef.current);
            }
            break;
          case "error":
            if (msg.code === "VAULT_LOCKED") {
              // The login expired or was locked. Any SSH session for this
              // host is still running on the server; unlocking reattaches it.
              cancelled = true;
              navigate({ to: "/unlock" });
              return;
            }
            setConnState("error");
            setStatusMsg(msg.message || msg.code || "Error");
            term.writeln(`\r\n\x1b[31m✗ ${msg.message || "Connection error"}\x1b[0m`);
            toast.error("Connection failed", { description: msg.message });
            break;
          case "fingerprint_new":
            term.writeln(`\r\n\x1b[33m⚠ Unrecognized host key for ${msg.hostname}\x1b[0m`);
            term.writeln(`  ${msg.algorithm ? msg.algorithm + " " : ""}${msg.fingerprint}`);
            term.writeln("  Verify this matches the server before continuing.\r\n");
            setPendingFp({ fingerprint: msg.fingerprint || "", hostname: msg.hostname || hostId, algorithm: msg.algorithm });
            break;
          case "fingerprint_mismatch":
            term.writeln(`\r\n\x1b[31m✗ FINGERPRINT MISMATCH — possible MITM attack\x1b[0m`);
            term.writeln(`  expected: ${msg.expected}`);
            term.writeln(`  actual:   ${msg.actual}`);
            setMismatch({
              expected: msg.expected || "", actual: msg.actual || "",
              algorithm: msg.algorithm, canReset: !!msg.canReset,
            });
            break;
        }
      };

      socket.onclose = (event) => {
        if (cancelled) return;
        if (event.code === 4001) {
          toast.info("Vault locked", { description: "Your SSH session is still running. Unlock to pick it back up." });
          navigate({ to: "/unlock" });
          return;
        }
        setConnState((s) => s === "error" ? s : "disconnected");
        setMemoryState(null);
        // Keep a specific reason the server already gave ("opened in another
        // window", "timed out"); only fall back to a generic one.
        setStatusMsg((m) => (!m || m === "Connected" || m === "Reattached" || m.endsWith("…")) ? "Disconnected" : m);
        streamReadyRef.current = false;
        if (pingIntervalRef.current) {
          window.clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
      };
      socket.onerror = () => {
        if (cancelled) return;
        setConnState("error");
        setStatusMsg("WebSocket error");
      };

      const onResize = () => {
        try {
          fitAddon.fit();
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }));
          }
        } catch { /* ignore resize errors */ }
      };
      window.addEventListener("resize", onResize);
      const obs = new ResizeObserver(onResize);
      if (termRef.current) obs.observe(termRef.current);

      // Re-focus terminal when the user clicks anywhere inside the screen area
      const clickHandler = () => term.focus();
      termRef.current?.addEventListener("click", clickHandler);

      return () => {
        window.removeEventListener("resize", onResize);
        obs.disconnect();
        termRef.current?.removeEventListener("click", clickHandler);
      };
    };

    const cleanupPromise = init();
    return () => {
      cancelled = true;
      cleanupPromise.then((fn) => fn?.());
      if (pingIntervalRef.current) {
        window.clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      socketRef.current?.close();
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
    // reconnectKey is what triggers a re-init when the user clicks Reconnect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, reconnectKey]);

  const h = host.data;
  const dotClass =
    connState === "connected" ? "connected"
    : connState === "connecting" ? "connecting"
    : connState === "error" ? "error"
    : "idle";

  const latencyTier =
    latencyMs == null ? null
    : latencyMs < 80 ? "good"
    : latencyMs < 200 ? "warn"
    : "bad";

  return (
    <div className="term-page">
      {/* Connection bar */}
      <div className="conn">
        <button
          type="button"
          className="conn__back"
          onClick={() => navigate({ to: "/" })}
          title="Back to hosts (does not disconnect)"
          aria-label="Back to hosts"
        >
          <I.ArrowRight size={12} style={{ transform: "rotate(180deg)" }} />
        </button>
        <div className="conn__sep" />
        <div className={`conn__label ${dotClass}`}>
          <span className="dot" />
          {h?.label || hostId}
        </div>
        {h && (
          <div className="conn__addr">
            <span className="user">{h.username}</span>
            <span className="at">@</span>
            <span>{h.hostname}</span>
            <span className="colon">:</span>
            <span className="port">{h.port}</span>
          </div>
        )}
        <div className="conn__sep" />
        <span className="conn__status">{statusMsg}</span>

        {latencyMs != null && (
          <div className={`conn__metric lat ${latencyTier ? latencyTier === "good" ? "" : latencyTier : ""}`}>
            <span className="v">{latencyMs}</span>
            <span className="ms">ms</span>
          </div>
        )}

        <div className="conn__spacer" />

        {/* Font size controls */}
        <div className="conn__font" role="group" aria-label="Terminal font size">
          <button
            type="button"
            onClick={() => setFontSize((s) => Math.max(s - 1, MIN_FONT))}
            disabled={fontSize <= MIN_FONT}
            title="Decrease font size (Ctrl+-)"
            aria-label="Decrease font size"
          >
            A−
          </button>
          <span className="conn__font-value" title="Current font size">{fontSize}</span>
          <button
            type="button"
            onClick={() => setFontSize((s) => Math.min(s + 1, MAX_FONT))}
            disabled={fontSize >= MAX_FONT}
            title="Increase font size (Ctrl+=)"
            aria-label="Increase font size"
          >
            A+
          </button>
        </div>

        {connState === "connected" && memoryState && (
          <button
            type="button"
            className={`conn__mem conn__mem--${memoryState}`}
            disabled={memoryState === "off" || memoryState === "unavailable"}
            onClick={() => setMemoryPaused(memoryState === "remembering")}
            title={
              memoryState === "remembering" ? "Skiff is remembering the commands you run here. Click to pause."
              : memoryState === "paused" ? "Paused: nothing you run is being remembered. Click to resume."
              : memoryState === "off" ? "Memory is off for this host."
              : "Memory couldn't keep up and stopped for this session."
            }
          >
            {memoryState === "remembering" ? "● Remembering"
              : memoryState === "paused" ? "❚❚ Paused — not remembering"
              : memoryState === "off" ? "Memory off"
              : "Memory unavailable"}
          </button>
        )}

        <button
          type="button"
          className="conn__help"
          onClick={() => setShowHistory((s) => !s)}
          title="Command history"
          aria-label="Toggle command history"
        >
          <I.Clock size={12} />
        </button>

        <button
          type="button"
          className="conn__help"
          onClick={() => setShowHelp((s) => !s)}
          title="Keyboard shortcuts"
          aria-label="Show keyboard shortcuts"
        >
          <I.Info size={12} />
        </button>

        {(connState === "disconnected" || connState === "error") && (
          <button
            type="button"
            className="conn__btn reconnect"
            onClick={reconnect}
            title="Reconnect to this host"
          >
            <I.ArrowRight size={11} />
            Reconnect
          </button>
        )}

        <button
          type="button"
          className="conn__btn disconnect"
          onClick={endSession}
        >
          <I.Close size={11} />
          Disconnect
        </button>
      </div>

      {/* xterm screen */}
      <div className="term__screen-wrap">
        <div ref={termRef} className="term__screen" />

        {connState === "connected" && <MemoryNotice memoryOnForHost={host.data?.memory_mode !== "off"} />}

        {/* Host key changed — takes the place of the generic error overlay */}
        {mismatch && (
          <div className="term__overlay">
            <div className="term__overlay-card" style={{ maxWidth: 520 }}>
              <div className="term__overlay-icon error"><I.Close size={18} /></div>
              <div className="term__overlay-title">This server's host key has changed</div>
              <div className="term__overlay-msg" style={{ lineHeight: 1.5 }}>
                Skiff refused to connect. Either the server was reinstalled or its keys were
                regenerated — or someone is intercepting the connection. Don't continue unless you
                know which.
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, margin: "12px 0", lineHeight: 1.7, wordBreak: "break-all", textAlign: "left" }}>
                <div><span style={{ color: "var(--fg-2)" }}>trusted:&nbsp;</span>{mismatch.expected}</div>
                <div><span style={{ color: "var(--fg-2)" }}>now:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>{mismatch.algorithm ? mismatch.algorithm + " " : ""}{mismatch.actual}</div>
              </div>
              {confirmReset ? (
                <>
                  <div className="term__overlay-msg" style={{ lineHeight: 1.5 }}>
                    On the server, run <code>ssh-keygen -lf /etc/ssh/ssh_host_{(mismatch.algorithm || "ed25519").replace(/^ssh-/, "")}_key.pub</code> and
                    check it prints the "now" fingerprint above. Only then continue.
                  </div>
                  <div className="term__overlay-actions">
                    <button type="button" className="btn btn--danger" onClick={trustNewKey}>It matches — forget the old key</button>
                    <button type="button" className="btn btn--secondary" onClick={() => setConfirmReset(false)}>Cancel</button>
                  </div>
                </>
              ) : (
                <div className="term__overlay-actions">
                  <button type="button" className="btn btn--secondary" onClick={() => navigate({ to: "/" })}>Back to hosts</button>
                  {mismatch.canReset
                    ? <button type="button" className="btn btn--secondary" onClick={() => setConfirmReset(true)}>The server was rebuilt…</button>
                    : <span style={{ fontSize: 12, color: "var(--fg-2)" }}>Ask a team admin if the server was rebuilt.</span>}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Session-ended overlay */}
        {!mismatch && (connState === "disconnected" || connState === "error") && (
          <div className="term__overlay">
            <div className="term__overlay-card">
              <div className={`term__overlay-icon ${connState}`}>
                {connState === "error" ? <I.Close size={18} /> : <I.Info size={18} />}
              </div>
              <div className="term__overlay-title">
                {connState === "error"
                  ? "Connection error"
                  : /another window/i.test(statusMsg)
                    ? "Opened in another window"
                    : "Disconnected"}
              </div>
              <div className="term__overlay-msg">{statusMsg}</div>
              <div className="term__overlay-actions">
                <button type="button" className="btn btn--primary" onClick={reconnect}>
                  Reconnect
                </button>
                <button type="button" className="btn btn--secondary" onClick={() => navigate({ to: "/" })}>
                  Back to hosts
                </button>
              </div>
            </div>
          </div>
        )}

        {/* New host fingerprint confirmation */}
        {pendingFp && (
          <div className="term__overlay">
            <div className="term__overlay-card" style={{ maxWidth: 460 }}>
              <div className="term__overlay-icon connecting">
                <I.Info size={18} />
              </div>
              <div className="term__overlay-title">Verify host key</div>
              <div className="term__overlay-msg" style={{ lineHeight: 1.5 }}>
                First time connecting to <strong>{pendingFp.hostname}</strong>. Confirm the
                fingerprint below matches the server before trusting it.
              </div>
              <div style={{
                fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-0)",
                background: "var(--bg-2)", border: "1px solid var(--border)",
                borderRadius: 6, padding: "8px 10px", margin: "12px 0", wordBreak: "break-all",
              }}>
                {pendingFp.algorithm ? `${pendingFp.algorithm} ` : ""}{pendingFp.fingerprint}
              </div>
              <div className="term__overlay-msg" style={{ fontSize: 12, lineHeight: 1.5 }}>
                On the server: <code>ssh-keygen -lf /etc/ssh/ssh_host_{(pendingFp.algorithm || "ed25519").replace(/^ssh-/, "")}_key.pub</code>
              </div>
              <div className="term__overlay-actions">
                <button type="button" className="btn btn--primary" onClick={approveFingerprint}>
                  Trust &amp; connect
                </button>
                <button type="button" className="btn btn--secondary" onClick={rejectFingerprint}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Keyboard shortcuts popover */}
        {showHelp && (
          <div className="term__help" onClick={() => setShowHelp(false)}>
            <div className="term__help-card" onClick={(e) => e.stopPropagation()}>
              <div className="term__help-head">
                <strong>Keyboard shortcuts</strong>
                <button type="button" onClick={() => setShowHelp(false)} aria-label="Close">
                  <I.Close size={12} />
                </button>
              </div>
              <ul>
                <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd><span>Copy selection</span></li>
                <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd><span>Paste</span></li>
                <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd><span>Disconnect &amp; go back</span></li>
                <li><kbd>Ctrl</kbd>+<kbd>+</kbd><span>Increase font size</span></li>
                <li><kbd>Ctrl</kbd>+<kbd>-</kbd><span>Decrease font size</span></li>
                <li><kbd>Ctrl</kbd>+<kbd>0</kbd><span>Reset font size</span></li>
              </ul>
            </div>
          </div>
        )}
      </div>

      <MemoryDrawer hostId={hostId} open={showHistory} onClose={() => setShowHistory(false)} onRunAgain={runAgain} />
    </div>
  );
}
