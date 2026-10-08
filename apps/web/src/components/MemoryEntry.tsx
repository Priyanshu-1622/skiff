import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet } from "@/lib/api";
import * as I from "@/components/icons";

export interface TimelineEntry {
  id: string;
  kind?: "command" | "pause";
  by?: string | null;
  hostId?: string | null;
  userId?: string | null;
  username?: string | null;
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

/** One remembered command (or a pause gap), shared by the History drawer and the Memory page. */
export function MemoryEntryRow({ entry, hostLabel, showUser }: { entry: TimelineEntry; hostLabel?: string; showUser?: boolean }) {
  if (entry.kind === "pause") return <PauseRow entry={entry} />;
  return <CommandRow entry={entry} hostLabel={hostLabel} showUser={showUser} />;
}

function CommandRow({ entry, hostLabel, showUser }: { entry: TimelineEntry; hostLabel?: string; showUser?: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const forget = useMutation({
    mutationFn: () => apiDelete(`/api/memory/entries/${entry.id}`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["memory-timeline"] }),
        queryClient.invalidateQueries({ queryKey: ["memory-search"] }),
        queryClient.invalidateQueries({ queryKey: ["memory-page"] }),
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
        {hostLabel && <span className="memrow__chip memrow__host">{hostLabel}</span>}
        {showUser && entry.username && <span className="memrow__chip">{entry.username}</span>}
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
