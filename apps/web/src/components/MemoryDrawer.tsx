import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet } from "@/lib/api";
import * as I from "@/components/icons";

interface TimelineEntry {
  id: string;
  kind?: "command" | "pause";
  by?: string | null;
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

function PauseRow({ entry }: { entry: TimelineEntry }) {
  const start = new Date(entry.startedAt).toLocaleTimeString();
  const end = entry.ended === "running" || !entry.finishedAt ? "now" : new Date(entry.finishedAt).toLocaleTimeString();
  return (
    <div className="memdrawer__pause">
      <span>❚❚ Memory paused</span>
      <span className="memdrawer__pause-time">{start} – {end}{entry.by ? ` · ${entry.by}` : ""}</span>
    </div>
  );
}

function EntryRow({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === "pause") return <PauseRow entry={entry} />;
  return <CommandRow entry={entry} />;
}

function CommandRow({ entry }: { entry: TimelineEntry }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const forget = useMutation({
    mutationFn: () => apiDelete(`/api/memory/entries/${entry.id}`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["memory-timeline"] }),
        queryClient.invalidateQueries({ queryKey: ["memory-search"] }),
      ]);
      // The row is gone by now; drop the cached detail so forgotten text doesn't linger in the browser.
      queryClient.removeQueries({ queryKey: ["memory-entry", entry.id] });
    },
  });
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
          <div className="memdrawer__footer">
            {!confirming ? (
              <button type="button" className="memdrawer__forget" onClick={() => setConfirming(true)}>
                Forget
              </button>
            ) : (
              <div className="memdrawer__confirm">
                <span>Forget this entry for good?</span>
                <button type="button" className="memdrawer__forget memdrawer__forget-yes" disabled={forget.isPending} onClick={() => forget.mutate()}>
                  Yes, forget
                </button>
                <button type="button" className="memdrawer__cancel" disabled={forget.isPending} onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            )}
            {forget.isError && <div className="memdrawer__err">Couldn't forget it.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

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
