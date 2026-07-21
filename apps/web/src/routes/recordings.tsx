import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { apiGet, apiDelete } from "@/lib/api";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";
import "@/styles/recordings.css";

interface Recording {
  id: string;
  hostId: string | null;
  hostLabel: string | null;
  hostname: string | null;
  userId: string | null;
  username: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  bytes: number | null;
  status: string;
}

// asciinema-player is an open-source embeddable player. Loaded from CDN on
// demand so it doesn't bloat the main bundle.
const PLAYER_JS = "https://cdn.jsdelivr.net/npm/asciinema-player@3.8.0/dist/bundle/asciinema-player.min.js";
const PLAYER_CSS = "https://cdn.jsdelivr.net/npm/asciinema-player@3.8.0/dist/bundle/asciinema-player.css";

let playerLoading: Promise<void> | null = null;
function loadPlayer(): Promise<void> {
  if ((window as any).AsciinemaPlayer) return Promise.resolve();
  if (playerLoading) return playerLoading;
  playerLoading = new Promise<void>((resolve, reject) => {
    if (!document.querySelector(`link[href="${PLAYER_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = PLAYER_CSS;
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = PLAYER_JS;
    script.onload = () => resolve();
    script.onerror = () => {
      playerLoading = null; // allow a later retry instead of caching the failure
      reject(new Error("Failed to load player"));
    };
    document.head.appendChild(script);
  });
  return playerLoading;
}

function fmtDuration(ms: number | null): string {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtBytes(b: number | null): string {
  if (!b) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function PlayerModal({ rec, onClose }: { rec: Recording; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let player: any = null;
    let cancelled = false;
    loadPlayer()
      .then(() => {
        if (cancelled || !containerRef.current) return;
        const AsciinemaPlayer = (window as any).AsciinemaPlayer;
        player = AsciinemaPlayer.create(
          `/api/recordings/${rec.id}/cast`,
          containerRef.current,
          { fit: "width", terminalFontSize: "14px", theme: "asciinema" },
        );
      })
      .catch(() => { if (!cancelled) setError("Could not load the player."); });
    return () => {
      cancelled = true;
      try { player?.dispose(); } catch { /* ignore */ }
    };
  }, [rec.id]);

  return (
    <div className="rec-modal-overlay" onClick={onClose}>
      <div className="rec-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rec-modal-head">
          <div>
            <div className="rec-modal-title">{rec.hostLabel || rec.hostname || "Session"}</div>
            <div className="rec-modal-sub">
              {rec.username ? `${rec.username} · ` : ""}{fmtWhen(rec.startedAt)}
            </div>
          </div>
          <button className="rec-icon-btn" onClick={onClose} aria-label="Close">
            <I.Close size={18} />
          </button>
        </div>
        {error
          ? <div className="rec-modal-error">{error}</div>
          : <div className="rec-player" ref={containerRef} />}
      </div>
    </div>
  );
}

export function RecordingsRoute() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [playing, setPlaying] = useState<Recording | null>(null);

  const recordings = useQuery({
    queryKey: ["recordings"],
    queryFn: () => apiGet<Recording[]>("/api/recordings"),
  });

  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/recordings/${id}`),
    onSuccess: () => {
      toast.success("Recording deleted");
      qc.invalidateQueries({ queryKey: ["recordings"] });
    },
    onError: () => toast.error("Could not delete recording"),
  });

  const list = recordings.data ?? [];

  return (
    <div className="rec-page">
      <div className="rec-header">
        <button className="rec-back" onClick={() => navigate({ to: "/" })}>
          <I.ChevronLeft size={16} /> Back
        </button>
        <h1>Session recordings</h1>
        <p className="rec-subtitle">
          Replay past terminal sessions. Recordings are stored on your server in
          the open asciicast format.
        </p>
      </div>

      {recordings.isLoading && <div className="rec-empty">Loading…</div>}

      {!recordings.isLoading && list.length === 0 && (
        <div className="rec-empty">
          <I.Film size={32} />
          <p>No recordings yet.</p>
          <p className="rec-empty-hint">
            When session recording is enabled, your terminal sessions appear here.
          </p>
        </div>
      )}

      {list.length > 0 && (
        <div className="rec-list">
          {list.map((r) => (
            <div key={r.id} className="rec-row">
              <div className="rec-row-main" onClick={() => r.status !== "recording" && setPlaying(r)}>
                <div className="rec-row-icon">
                  <I.Film size={18} />
                </div>
                <div className="rec-row-info">
                  <div className="rec-row-title">
                    {r.hostLabel || r.hostname || "Session"}
                    {r.status === "recording" && <span className="rec-live-tag">● recording</span>}
                    {r.status === "interrupted" && <span className="rec-interrupted-tag">interrupted</span>}
                  </div>
                  <div className="rec-row-meta">
                    {r.username ? `${r.username} · ` : ""}
                    {fmtWhen(r.startedAt)} · {fmtDuration(r.durationMs)} · {fmtBytes(r.bytes)}
                  </div>
                </div>
              </div>
              <div className="rec-row-actions">
                {r.status !== "recording" && (
                  <button className="rec-icon-btn" onClick={() => setPlaying(r)} aria-label="Play">
                    <I.Play size={16} />
                  </button>
                )}
                <button
                  className="rec-icon-btn rec-danger"
                  onClick={() => {
                    if (confirm("Delete this recording? This cannot be undone.")) del.mutate(r.id);
                  }}
                  aria-label="Delete"
                >
                  <I.Trash size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {playing && <PlayerModal rec={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}
