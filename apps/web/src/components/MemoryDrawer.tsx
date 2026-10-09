import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { groupByDay } from "@skiff/shared";
import { apiGet } from "@/lib/api";
import { getStored, setStored } from "@/lib/safe-storage";
import * as I from "@/components/icons";
import { MemoryEntryRow as EntryRow, type TimelineEntry } from "@/components/MemoryEntry";
import { MemoryNotes } from "@/components/MemoryNotes";
import { MemorySnippets } from "@/components/MemorySnippets";

type Tab = "history" | "notes" | "snippets";

const WIDTH_KEY = "skiff.memdrawer.width";
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 360;
const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));

function readWidth(): number {
  const n = Number(getStored(WIDTH_KEY));
  return Number.isFinite(n) && n > 0 ? clampWidth(n) : DEFAULT_WIDTH;
}

export function MemoryDrawer({ hostId, open, onClose, onRunAgain }: {
  hostId: string; open: boolean; onClose: () => void; onRunAgain?: (command: string) => void;
}) {
  const [width, setWidth] = useState(readWidth);
  const widthRef = useRef(width);
  widthRef.current = width;
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setWidth(clampWidth(window.innerWidth - ev.clientX));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setStored(WIDTH_KEY, String(widthRef.current));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const [tab, setTab] = useState<Tab>("history");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [includeOutput, setIncludeOutput] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const searching = debounced !== "";

  const timeline = useQuery({
    queryKey: ["memory-timeline", hostId],
    queryFn: () => apiGet<{ entries: TimelineEntry[] }>(`/api/memory/hosts/${hostId}/timeline`),
    enabled: open && !searching && tab === "history",
    refetchInterval: open && !searching && tab === "history" ? 5000 : false,
    staleTime: 0, // History must be current whenever it is opened, not the app-wide 30 s
  });
  const results = useQuery({
    queryKey: ["memory-search", hostId, debounced, includeOutput],
    queryFn: () => {
      const params = new URLSearchParams({ q: debounced, hostId });
      if (includeOutput) params.set("output", "1");
      return apiGet<{ entries: TimelineEntry[] }>(`/api/memory/search?${params.toString()}`);
    },
    enabled: open && searching && tab === "history",
    staleTime: 0,
  });

  if (!open) return null;

  return (
    <div className="memdrawer" style={{ width }}>
      <div className="memdrawer__resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize history" />
      <div className="memdrawer__header">
        <I.Clock size={13} />
        <span>History</span>
        <div className="memdrawer__spacer" />
        <button type="button" className="memdrawer__close" onClick={onClose} aria-label="Close history">
          <I.Close size={12} />
        </button>
      </div>
      <div className="memdrawer__tabs" role="tablist">
        {([["history", "History"], ["notes", "Notes"], ["snippets", "Snippets"]] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={"memdrawer__tab" + (tab === id ? " memdrawer__tab--on" : "")} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "notes" && <div className="memdrawer__list"><MemoryNotes hostId={hostId} /></div>}
      {tab === "snippets" && <div className="memdrawer__list"><MemorySnippets onRun={onRunAgain} /></div>}
      {tab === "history" && <div className="memdrawer__searchbar">
        <input
          className="memdrawer__search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search this host"
          aria-label="Search history"
        />
        <label className="memdrawer__opt">
          <input type="checkbox" checked={includeOutput} onChange={(e) => setIncludeOutput(e.target.checked)} />
          Search output too
        </label>
      </div>}
      {tab === "history" && <div className="memdrawer__list">
        {searching ? (
          <>
            {results.isLoading && <div className="memdrawer__muted">Searching…</div>}
            {results.isError && <div className="memdrawer__muted">Couldn't search — the vault may have locked.</div>}
            {results.data && results.data.entries.length === 0 && <div className="memdrawer__muted">No matches.</div>}
            {results.data?.entries.map((e) => <EntryRow key={e.id} entry={e} onRunAgain={onRunAgain} />)}
          </>
        ) : (
          <>
            {timeline.isLoading && <div className="memdrawer__muted">Loading…</div>}
            {timeline.isError && <div className="memdrawer__muted">Couldn't load history — the vault may have locked.</div>}
            {timeline.data && timeline.data.entries.length === 0 && (
              <div className="memdrawer__muted">No commands recorded yet.</div>
            )}
            {timeline.data && groupByDay(timeline.data.entries).map((g) => (
              <div key={g.label}>
                <div className="memdrawer__day">{g.label}</div>
                {g.items.map((e) => <EntryRow key={e.id} entry={e} onRunAgain={onRunAgain} />)}
              </div>
            ))}
          </>
        )}
      </div>}
    </div>
  );
}
