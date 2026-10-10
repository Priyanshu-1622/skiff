import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { useCopyState, writeClipboard } from "@/components/MemoryEntryParts";

export interface Snippet { id: string; name: string; command: string; by: string | null }

function SnippetRow({ s, onRun }: { s: Snippet; onRun?: (command: string) => void }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["snippets"] });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(s.name);
  const [command, setCommand] = useState(s.command);
  const [confirming, setConfirming] = useState(false);
  const [copyState, setCopyState] = useCopyState();
  const update = useMutation({
    mutationFn: () => apiPut(`/api/snippets/${s.id}`, { name, command }),
    onSuccess: async () => { await refresh(); setEditing(false); },
  });
  const remove = useMutation({ mutationFn: () => apiDelete(`/api/snippets/${s.id}`), onSuccess: refresh });
  const failure = update.error ?? remove.error;

  if (editing) {
    return (
      <div className="memsnip">
        <input className="memdrawer__search" aria-label="Snippet name" disabled={update.isPending} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        <textarea className="memsnip__cmd-input" aria-label="Snippet command" disabled={update.isPending} value={command} maxLength={4000} onChange={(e) => setCommand(e.target.value)} />
        <div className="memdrawer__actions">
          <button type="button" className="memdrawer__action" disabled={update.isPending || !name.trim() || !command} onClick={() => update.mutate()}>Save</button>
          <button type="button" className="memdrawer__cancel" disabled={update.isPending} onClick={() => { setEditing(false); setName(s.name); setCommand(s.command); }}>Cancel</button>
        </div>
        {failure && <div className="memdrawer__err">{(failure as Error).message}</div>}
      </div>
    );
  }
  return (
    <div className="memsnip">
      <div className="memsnip__name">{s.name}{s.by && <span className="memrow__chip">{s.by}</span>}</div>
      <pre className="memsnip__cmd">{s.command}</pre>
      {!confirming ? (
        <div className="memdrawer__actions">
          {onRun && (
            <button type="button" className="memdrawer__action" disabled={/[\r\n]/.test(s.command)} title={/[\r\n]/.test(s.command) ? "Use Copy to preserve and review this multi-line block" : "Types the command into the terminal — you press Enter"} onClick={() => onRun(s.command)}>Run</button>
          )}
          <button type="button" className="memdrawer__action" onClick={async () => setCopyState(await writeClipboard(s.command))}>
            {copyState === "ok" ? "Copied" : copyState === "fail" ? "Couldn't copy" : "Copy"}
          </button>
          <button type="button" className="memdrawer__action" onClick={() => { setName(s.name); setCommand(s.command); update.reset(); setEditing(true); }}>Edit</button>
          <button type="button" className="memdrawer__forget" onClick={() => setConfirming(true)}>Delete</button>
        </div>
      ) : (
        <div className="memdrawer__confirm">
          <span>Delete this snippet?</span>
          <button type="button" className="memdrawer__forget memdrawer__forget-yes" disabled={remove.isPending} onClick={() => remove.mutate()}>Yes, delete</button>
          <button type="button" className="memdrawer__cancel" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
      {failure && <div className="memdrawer__err">{(failure as Error).message}</div>}
    </div>
  );
}

/** The snippet library. Run types the command into the terminal and never presses Enter. */
export function MemorySnippets({ onRun }: { onRun?: (command: string) => void }) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["snippets"],
    queryFn: () => apiGet<{ snippets: Snippet[] }>("/api/snippets"),
    staleTime: 0,
  });
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const add = useMutation({
    mutationFn: () => apiPost("/api/snippets", { name, command }),
    onSuccess: async () => {
      setName(""); setCommand("");
      await queryClient.invalidateQueries({ queryKey: ["snippets"] });
    },
  });
  return (
    <div className="memsnips">
      <div className="memsnip memsnip--new">
        <input className="memdrawer__search" aria-label="New snippet name" disabled={add.isPending} placeholder="Name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        <textarea className="memsnip__cmd-input" aria-label="New snippet command" disabled={add.isPending} placeholder="Command" value={command} maxLength={4000} onChange={(e) => setCommand(e.target.value)} />
        <div className="memdrawer__actions">
          <button type="button" className="memdrawer__action" disabled={add.isPending || !name.trim() || !command} onClick={() => add.mutate()}>Add snippet</button>
        </div>
        {add.isError && <div className="memdrawer__err">{(add.error as Error).message}</div>}
      </div>
      {list.isLoading && <div className="memdrawer__muted">Loading…</div>}
      {list.isError && <div className="memdrawer__muted">Couldn't load snippets — the vault may have locked.</div>}
      {list.data && list.data.snippets.length === 0 && <div className="memdrawer__muted">No snippets yet. Use “Save as snippet” on a History entry, or add one above.</div>}
      {list.data?.snippets.map((s) => <SnippetRow key={s.id} s={s} onRun={onRun} />)}
    </div>
  );
}
