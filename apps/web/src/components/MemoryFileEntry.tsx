import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import * as I from "@/components/icons";
import { EntryFooter, PinAction, useCopyState, writeClipboard } from "@/components/MemoryEntryParts";
import type { TimelineEntry } from "@/components/MemoryEntry";

interface FileDetail {
  diff: string;
  diffPruned: boolean;
  hasOld: boolean;
  hasNew: boolean;
  note: string | null;
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return (
    <pre className="memfile__diff" aria-label="Changes">
      {lines.map((line, i) => {
        const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
        return <span key={i} className={`memfile__line memfile__line--${kind}`}>{line || " "}{"\n"}</span>;
      })}
    </pre>
  );
}

/** The full text of the stored new version, fetched only when asked for. */
function FileVersionModal({ entryId, path, onClose }: { entryId: string; path: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["memory-file", entryId, "new"],
    queryFn: () => apiGet<{ content: string }>(`/api/memory/entries/${entryId}/file?version=new`),
    gcTime: 0, // don't keep a whole file's text cached once the window closes
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="memfile__backdrop" onClick={onClose}>
      <div className="memfile__modal" role="dialog" aria-label={`Full file ${path}`} onClick={(e) => e.stopPropagation()}>
        <div className="memfile__modal-head">
          <span className="memfile__modal-path">{path}</span>
          <button type="button" className="memdrawer__action" onClick={onClose}>Close</button>
        </div>
        {q.isLoading && <div className="memdrawer__muted">Loading…</div>}
        {q.isError && <div className="memdrawer__muted">Couldn't load this version.</div>}
        {q.data && <pre className="memfile__full">{q.data.content || "(empty file)"}</pre>}
      </div>
    </div>
  );
}

/** One file a remembered command changed: path and counts in the row, the diff when opened. */
export function FileRow({ entry, hostLabel, showUser }: { entry: TimelineEntry; hostLabel?: string; showUser?: boolean }) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [copyState, setCopyState] = useCopyState();
  const detail = useQuery({
    queryKey: ["memory-entry", entry.id],
    queryFn: () => apiGet<FileDetail>(`/api/memory/entries/${entry.id}`),
    enabled: open,
  });
  const copyOld = async () => {
    try {
      const { content } = await apiGet<{ content: string }>(`/api/memory/entries/${entry.id}/file?version=old`);
      setCopyState(await writeClipboard(content));
    } catch {
      setCopyState("fail");
    }
  };
  const summary = entry.note
    ? <span className="memrow__chip memrow__warn">{entry.note}</span>
    : <span className="memfile__counts"><span className="memfile__plus">+{entry.added ?? 0}</span> <span className="memfile__minus">−{entry.removed ?? 0}</span></span>;
  return (
    <div className="memdrawer__row memfile">
      <button type="button" className="memdrawer__row-head" onClick={() => setOpen((o) => !o)}>
        <I.Chevron size={10} style={{ transform: open ? "rotate(90deg)" : undefined }} />
        <span className="memdrawer__time">{new Date(entry.startedAt).toLocaleTimeString()}</span>
        {hostLabel && <span className="memrow__chip memrow__host">{hostLabel}</span>}
        {showUser && entry.username && <span className="memrow__chip">{entry.username}</span>}
        <span className="memdrawer__cmd"><span aria-hidden="true">{entry.flags?.includes("snapshot") ? "⟳ " : "✎ "}</span>{entry.command}</span>
        {entry.flags?.includes("outside") && <span className="memrow__chip memrow__warn" title="Changed on the server without a command Skiff remembered">outside</span>}
        {entry.change && entry.change !== "modified" && !entry.note && <span className="memrow__chip">{entry.change}</span>}
        {entry.flags?.includes("assumed-home") && (
          <span className="memrow__chip memrow__warn" title="No working directory was known, so this path is relative to your home folder">path assumed</span>
        )}
        <span className="memdrawer__status">{summary}</span>
      </button>
      {open && (
        <div className="memdrawer__body">
          {detail.isLoading && <div className="memdrawer__muted">Loading…</div>}
          {detail.isError && <div className="memdrawer__muted">Couldn't load this entry.</div>}
          {entry.flags?.includes("outside") && (
            <div className="memdrawer__meta">Changed outside Skiff — on the server, without a command Skiff remembered.</div>
          )}
          {detail.data && (
            detail.data.note
              ? <div className="memdrawer__muted">{detail.data.note}. Skiff noticed a command touch this file but doesn't keep its content.</div>
              : detail.data.diffPruned && !detail.data.diff
                ? <div className="memdrawer__muted">The changes were removed by your retention setting.</div>
                : <DiffView diff={detail.data.diff} />
          )}
          <EntryFooter entryId={entry.id}>
            {detail.data?.hasNew && (
              <button type="button" className="memdrawer__action" onClick={() => setShowFull(true)}>View full file</button>
            )}
            {detail.data?.hasOld && (
              <button type="button" className="memdrawer__action" onClick={copyOld}>
                {copyState === "ok" ? "Copied" : copyState === "fail" ? "Couldn't copy" : "Copy old version"}
              </button>
            )}
            <PinAction entryId={entry.id} />
          </EntryFooter>
          {showFull && <FileVersionModal entryId={entry.id} path={entry.command} onClose={() => setShowFull(false)} />}
        </div>
      )}
    </div>
  );
}
