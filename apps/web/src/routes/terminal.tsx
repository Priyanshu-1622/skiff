import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useVault } from "@/lib/vault";
import { apiGet } from "@/lib/api";
import { createTerminalSocket, type TerminalMessage } from "@/lib/ws";
import * as I from "@/components/icons";

export function TerminalRoute() {
  const { hostId } = useParams({ strict: false }) as { hostId: string };
  const navigate = useNavigate();
  const { status } = useVault();
  const termRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<any>(null);
  const [connState, setConnState] = useState<"connecting" | "connected" | "disconnected" | "error">("connecting");
  const [statusMsg, setStatusMsg] = useState("Connecting…");

  const host = useQuery({
    queryKey: ["host", hostId],
    queryFn: () => apiGet<any>(`/api/hosts/${hostId}`),
    enabled: !!hostId,
  });

  // Keyboard shortcut: Ctrl+Shift+W to disconnect
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "W") {
        socketRef.current?.close();
        navigate({ to: "/" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!hostId || !termRef.current) return;
    let term: any, fitAddon: any;

    const init = async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");

      term = new Terminal({
        cursorBlink: true, fontSize: 14,
        fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', monospace",
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
      fitAddon.fit();
      xtermRef.current = term;

      const socket = createTerminalSocket(hostId);
      socketRef.current = socket;

      socket.onmessage = (event) => {
        const msg: TerminalMessage = JSON.parse(event.data);
        switch (msg.type) {
          case "data":
            term.write(Uint8Array.from(atob(msg.data!), c => c.charCodeAt(0)));
            break;
          case "status":
            setStatusMsg(msg.message || "");
            if (msg.message === "Connected") setConnState("connected");
            if (msg.message === "Session ended") setConnState("disconnected");
            break;
          case "error":
            setConnState("error");
            setStatusMsg(msg.message || msg.code || "Error");
            term.writeln(`\r\n\x1b[31m✗ ${msg.message || "Connection error"}\x1b[0m`);
            break;
          case "fingerprint_new":
            term.writeln(`\r\n\x1b[33m⚠ New host fingerprint: ${msg.fingerprint}\x1b[0m`);
            term.writeln("\x1b[32m✓ Fingerprint saved\x1b[0m\r\n");
            break;
        }
      };

      socket.onclose = () => {
        setConnState("disconnected");
        setStatusMsg("Disconnected");
        term.writeln("\r\n\x1b[33m— Connection closed —\x1b[0m");
      };
      socket.onerror = () => { setConnState("error"); setStatusMsg("WebSocket error"); };

      term.onData((data: string) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "input", data: btoa(data) }));
        }
      });

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
      return () => { window.removeEventListener("resize", onResize); obs.disconnect(); };
    };

    const cleanup = init();
    return () => {
      cleanup.then(fn => fn?.());
      socketRef.current?.close();
      xtermRef.current?.dispose();
    };
  }, [hostId]);

  const h = host.data;
  const dotStyle: React.CSSProperties = {
    width: 8, height: 8, borderRadius: "50%",
    background: connState === "connected" ? "var(--status-connected)"
      : connState === "connecting" ? "var(--status-connecting)"
      : "var(--status-error)",
    boxShadow: connState === "connecting"
      ? "0 0 0 3px color-mix(in oklab, var(--status-connecting) 20%, transparent)"
      : undefined,
    flexShrink: 0,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100vw", height: "100vh", background: "var(--bg-0)", overflow: "hidden" }}>
      {/* Connection bar */}
      <div className="conn">
        <button
          style={{ background: "none", border: 0, cursor: "pointer", color: "var(--fg-2)", display: "flex", alignItems: "center", gap: 6, padding: "0 4px" }}
          onClick={() => navigate({ to: "/" })}
          title="Back to hosts"
        >
          <I.ArrowRight size={12} style={{ transform: "rotate(180deg)" }} />
        </button>
        <div className="conn__sep" />
        <div style={dotStyle} />
        <div className="conn__label">
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
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-2)" }}>
          {statusMsg}
        </span>
        <div className="conn__spacer" />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>
          Ctrl+Shift+W to disconnect
        </span>
        <button
          className="conn__btn disconnect"
          onClick={() => { socketRef.current?.close(); navigate({ to: "/" }); }}
        >
          <I.Close size={11} />
          Disconnect
        </button>
      </div>

      {/* xterm container - takes all remaining space */}
      <div
        ref={termRef}
        style={{ flex: 1, overflow: "hidden", background: "#0A0B0D" }}
      />
    </div>
  );
}
