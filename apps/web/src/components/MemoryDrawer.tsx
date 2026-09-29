import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import * as I from "@/components/icons";

interface TimelineEntry {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  command: string;
  cwd: string | null;
  exitCode: number | null;
  confidence: string | null;
  flags: string[];
  ended: "exited" | "running";
}

interface EntryDetail extends TimelineEntry {
  output: string;
  outputBytes: number;
  outputPruned: boolean;
}

function statusLabel(entry: TimelineEntry): string {
  if (entry.ended === "running") return "…";
  if (entry.exitCode === null) return "";
  return entry.exitCode === 0 ? "✓" : `✗ ${entry.exitCode}`;
}

function EntryRow({ entry }: { entry: TimelineEntry }) {
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: ["memory-entry", entry.id],
    queryFn: () => apiGet<EntryDetail>(`/api/memory/entries/${entry.id}`),
    enabled: open,
  });

  return (
    <div className="memdrawer__row">
      <button type="button" className="memdrawer__row-head" onClick={() => setOpen((o) => !o)}>
        <I.Chevron size={10} style={{ transform: open ? "rotate(90deg)" : undefined }} />
        <span className="memdrawer__time">{new Date(entry.startedAt).toLocaleTimeString()}</span>
        <span className="memdrawer__cmd">{entry.command}</span>
        <span className="memdrawer__status">{statusLabel(entry)}</span>
      </button>
      {open && (
        <div className="memdrawer__body">
          {detail.isLoading && <div className="memdrawer__muted">Loading…</div>}
          {detail.isError && <div className="memdrawer__muted">Couldn't load this entry.</div>}
          {detail.data && (
            <>
              {detail.data.cwd && <div className="memdrawer__meta">{detail.data.cwd}</div>}
              <pre className="memdrawer__output">{detail.data.output || "(no output)"}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function MemoryDrawer({ hostId, open, onClose }: { hostId: string; open: boolean; onClose: () => void }) {
  const timeline = useQuery({
    queryKey: ["memory-timeline", hostId],
    queryFn: () => apiGet<{ entries: TimelineEntry[] }>(`/api/memory/hosts/${hostId}/timeline`),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });

  if (!open) return null;

  return (
    <div className="memdrawer">
      <div className="memdrawer__header">
        <I.Clock size={13} />
        <span>History</span>
        <div className="memdrawer__spacer" />
        <button type="button" className="memdrawer__close" onClick={onClose} aria-label="Close history">
          <I.Close size={12} />
        </button>
      </div>
      <div className="memdrawer__list">
        {timeline.isLoading && <div className="memdrawer__muted">Loading…</div>}
        {timeline.isError && <div className="memdrawer__muted">Couldn't load history — the vault may have locked.</div>}
        {timeline.data && timeline.data.entries.length === 0 && (
          <div className="memdrawer__muted">No commands recorded yet.</div>
        )}
        {timeline.data?.entries.map((e) => <EntryRow key={e.id} entry={e} />)}
      </div>
    </div>
  );
}
