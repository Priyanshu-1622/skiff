import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiGet, apiPut } from "@/lib/api";

interface Note { text: string; version: number; updatedAt: string | null; updatedBy: string | null }

/** The host's living note: one shared document, saved explicitly, never overwritten silently. */
export function MemoryNotes({ hostId }: { hostId: string }) {
  const queryClient = useQueryClient();
  const note = useQuery({
    queryKey: ["host-note", hostId],
    queryFn: () => apiGet<Note>(`/api/hosts/${hostId}/notes`),
    staleTime: 0,
  });
  const [draft, setDraft] = useState("");
  const [baseVersion, setBaseVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Follow the server until the user starts typing (a pin from History shows up here).
  useEffect(() => {
    if (note.data && !dirty) {
      setDraft(note.data.text);
      setBaseVersion(note.data.version);
    }
  }, [note.data, dirty]);

  const save = useMutation({
    mutationFn: (args: { text: string; baseVersion: number }) => apiPut<Note>(`/api/hosts/${hostId}/notes`, args),
    onSuccess: (saved) => {
      queryClient.setQueryData(["host-note", hostId], saved);
      setDraft(saved.text);
      setBaseVersion(saved.version);
      setDirty(false);
      setConflict(null);
      setError(null);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.httpStatus === 409 && e.extra) {
        setConflict(e.extra as Note);
        setError(null);
      } else {
        setError(e instanceof Error ? e.message : "Couldn't save the note");
      }
    },
  });

  if (note.isLoading) return <div className="memdrawer__muted">Loading…</div>;
  if (note.isError || !note.data) return <div className="memdrawer__muted">Couldn't load the note — the vault may have locked.</div>;
  return (
    <div className="memnotes">
      <textarea
        className="memnotes__text"
        aria-label="Host notes"
        placeholder="Anything worth remembering about this host — how to restart things, who owns it, gotchas. Use “Pin to notes” on a History entry to add a command here."
        value={draft}
        disabled={save.isPending}
        maxLength={100000}
        onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
      />
      {conflict && (
        <div className="memnotes__conflict" role="alert">
          <div>Someone else changed this note{conflict.updatedBy ? ` (${conflict.updatedBy})` : ""} while you were editing.</div>
          <div className="memdrawer__actions">
            <button type="button" className="memdrawer__action" disabled={save.isPending} onClick={() => { setDraft(conflict.text); setBaseVersion(conflict.version); setDirty(false); setConflict(null); queryClient.setQueryData(["host-note", hostId], conflict); }}>
              Use their version
            </button>
            <button type="button" className="memdrawer__action" disabled={save.isPending} onClick={() => save.mutate({ text: draft, baseVersion: conflict.version })}>
              Overwrite with mine
            </button>
          </div>
        </div>
      )}
      {error && <div className="memdrawer__err">{error}</div>}
      <div className="memnotes__bar">
        <span className="memdrawer__muted memnotes__meta">
          {note.data.updatedAt ? `Last edited${note.data.updatedBy ? ` by ${note.data.updatedBy}` : ""} · ${new Date(note.data.updatedAt).toLocaleString()}` : "Not written yet"}
        </span>
        <button type="button" className="memdrawer__action" disabled={!dirty || save.isPending} onClick={() => save.mutate({ text: draft, baseVersion })}>
          {save.isPending ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </div>
    </div>
  );
}
