import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { createTerminalSocket, type TerminalMessage } from "@/lib/ws";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";

type ConnState = "connecting" | "connected" | "disconnected" | "error";

const MIN_FONT = 10;
const MAX_FONT = 24;
const DEFAULT_FONT = 14;
const FONT_STORAGE_KEY = "skiff.terminal.fontSize";

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
    const stored = parseInt(localStorage.getItem(FONT_STORAGE_KEY) || "");
    return stored >= MIN_FONT && stored <= MAX_FONT ? stored : DEFAULT_FONT;
  });
  const [reconnectKey, setReconnectKey] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [pendingFp, setPendingFp] = useState<{ fingerprint: string; hostname: string } | null>(null);

  const host = useQuery({
    queryKey: ["host", hostId],
    queryFn: () => apiGet<any>(`/api/hosts/${hostId}`),
    enabled: !!hostId,
  });

  // Persist font size
  useEffect(() => {
    localStorage.setItem(FONT_STORAGE_KEY, String(fontSize));
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
        socketRef.current?.close();
        navigate({ to: "/" });
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

  const reconnect = useCallback(() => {
    socketRef.current?.close();
    setConnState("connecting");
    setStatusMsg("Reconnecting…");
    setLatencyMs(null);
    setReconnectKey((k) => k + 1);
  }, []);

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

      // Auto-focus so users can type immediately
      term.focus();

      // Buffer keystrokes until the SSH shell is ready (fixes first-keystroke loss)
      term.onData((data: string) => {
        const sock = socketRef.current;
        if (!sock || sock.readyState !== WebSocket.OPEN) return;
        if (streamReadyRef.current) {
          sock.send(JSON.stringify({ type: "input", data: btoa(String.fromCharCode(...new TextEncoder().encode(data))) }));
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
          case "data":
            term.write(Uint8Array.from(atob(msg.data!), c => c.charCodeAt(0)));
            break;
          case "status":
            setStatusMsg(msg.message || "");
            if (msg.message === "Connected") {
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
                socket.send(JSON.stringify({ type: "input", data: btoa(String.fromCharCode(...new TextEncoder().encode(data))) }));
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
            setConnState("error");
            setStatusMsg(msg.message || msg.code || "Error");
            term.writeln(`\r\n\x1b[31m✗ ${msg.message || "Connection error"}\x1b[0m`);
            toast.error("Connection failed", { description: msg.message });
            break;
          case "fingerprint_new":
            term.writeln(`\r\n\x1b[33m⚠ Unrecognized host key for ${msg.hostname}\x1b[0m`);
            term.writeln(`  ${msg.fingerprint}`);
            term.writeln("  Verify this matches the server before continuing.\r\n");
            setPendingFp({ fingerprint: msg.fingerprint || "", hostname: msg.hostname || hostId });
            break;
          case "fingerprint_mismatch":
            term.writeln(`\r\n\x1b[31m✗ FINGERPRINT MISMATCH — possible MITM attack\x1b[0m`);
            term.writeln(`  expected: ${msg.expected}`);
            term.writeln(`  actual:   ${msg.actual}`);
            toast.error("Fingerprint mismatch", { description: "Connection refused for safety. Verify the host manually.", duration: 10000 });
            break;
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        setConnState((s) => s === "error" ? s : "disconnected");
        setStatusMsg("Disconnected");
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
          onClick={() => {
            socketRef.current?.close();
            navigate({ to: "/" });
          }}
        >
          <I.Close size={11} />
          Disconnect
        </button>
      </div>

      {/* xterm screen */}
      <div className="term__screen-wrap">
        <div ref={termRef} className="term__screen" />

        {/* Session-ended overlay */}
        {(connState === "disconnected" || connState === "error") && (
          <div className="term__overlay">
            <div className="term__overlay-card">
              <div className={`term__overlay-icon ${connState}`}>
                {connState === "error" ? <I.Close size={18} /> : <I.Info size={18} />}
              </div>
              <div className="term__overlay-title">
                {connState === "error" ? "Connection error" : "Session ended"}
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
                {pendingFp.fingerprint}
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
    </div>
  );
}
