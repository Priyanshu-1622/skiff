import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import * as I from "@/components/icons";
import { EntryFooter, PinAction, SaveSnippetAction, useCopyState, writeClipboard } from "@/components/MemoryEntryParts";
import { FileRow } from "@/components/MemoryFileEntry";

export interface TimelineEntry {
  id: string;
  kind?: "command" | "pause" | "file";
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
  /** File changes only (`command` then holds the path). */
  change?: "created" | "modified" | "deleted";
  added?: number;
  removed?: number;
  note?: string | null;
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
export function MemoryEntryRow({ entry, hostLabel, showUser, onRunAgain }: {
  entry: TimelineEntry; hostLabel?: string; showUser?: boolean; onRunAgain?: (command: string) => void;
}) {
  if (entry.kind === "pause") return <PauseRow entry={entry} />;
  if (entry.kind === "file") return <FileRow entry={entry} hostLabel={hostLabel} showUser={showUser} />;
  return <CommandRow entry={entry} hostLabel={hostLabel} showUser={showUser} onRunAgain={onRunAgain} />;
}

function CommandRow({ entry, hostLabel, showUser, onRunAgain }: {
  entry: TimelineEntry; hostLabel?: string; showUser?: boolean; onRunAgain?: (command: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useCopyState();
  const copy = async () => setCopyState(await writeClipboard(entry.command));
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
        {entry.flags?.includes("fullscreen") && <span className="memrow__chip memrow__warn">full-screen · not captured</span>}
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
          <EntryFooter entryId={entry.id}>
            {onRunAgain && (
              <button type="button" className="memdrawer__action" title="Types the command into the terminal — you press Enter" onClick={() => onRunAgain(entry.command)}>
                Run again
              </button>
            )}
            <button type="button" className="memdrawer__action" onClick={copy}>
              {copyState === "ok" ? "Copied" : copyState === "fail" ? "Couldn't copy" : "Copy"}
            </button>
            <SaveSnippetAction command={entry.command} />
            <PinAction entryId={entry.id} />
          </EntryFooter>
        </div>
      )}
    </div>
  );
}
