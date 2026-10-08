import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import * as I from "@/components/icons";
import { MemoryEntryRow as EntryRow, type TimelineEntry } from "@/components/MemoryEntry";

export function MemoryDrawer({ hostId, open, onClose }: { hostId: string; open: boolean; onClose: () => void }) {
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
    enabled: open && !searching,
    refetchInterval: open && !searching ? 5000 : false,
    staleTime: 0, // History must be current whenever it is opened, not the app-wide 30 s
  });
  const results = useQuery({
    queryKey: ["memory-search", hostId, debounced, includeOutput],
    queryFn: () => {
      const params = new URLSearchParams({ q: debounced, hostId });
      if (includeOutput) params.set("output", "1");
      return apiGet<{ entries: TimelineEntry[] }>(`/api/memory/search?${params.toString()}`);
    },
    enabled: open && searching,
    staleTime: 0,
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
      <div className="memdrawer__searchbar">
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
      </div>
      <div className="memdrawer__list">
        {searching ? (
          <>
            {results.isLoading && <div className="memdrawer__muted">Searching…</div>}
            {results.isError && <div className="memdrawer__muted">Couldn't search — the vault may have locked.</div>}
            {results.data && results.data.entries.length === 0 && <div className="memdrawer__muted">No matches.</div>}
            {results.data?.entries.map((e) => <EntryRow key={e.id} entry={e} />)}
          </>
        ) : (
          <>
            {timeline.isLoading && <div className="memdrawer__muted">Loading…</div>}
            {timeline.isError && <div className="memdrawer__muted">Couldn't load history — the vault may have locked.</div>}
            {timeline.data && timeline.data.entries.length === 0 && (
              <div className="memdrawer__muted">No commands recorded yet.</div>
            )}
            {timeline.data?.entries.map((e) => <EntryRow key={e.id} entry={e} />)}
          </>
        )}
      </div>
    </div>
  );
}
