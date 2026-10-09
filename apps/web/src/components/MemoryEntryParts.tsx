import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiPost } from "@/lib/api";

/** "Copied" / "Couldn't copy" feedback that resets itself. */
export function useCopyState() {
  const [state, set] = useState<"idle" | "ok" | "fail">("idle");
  const setAndReset = (next: "ok" | "fail") => {
    set(next);
    window.setTimeout(() => set("idle"), 1500);
  };
  return [state, setAndReset] as const;
}

export async function writeClipboard(text: string): Promise<"ok" | "fail"> {
  try {
    await navigator.clipboard.writeText(text);
    return "ok";
  } catch {
    return "fail";
  }
}

/** The action row at the bottom of an open entry: any extra actions, then Forget with its confirmation. */
export function EntryFooter({ entryId, children }: { entryId: string; children?: ReactNode }) {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const forget = useMutation({
    mutationFn: () => apiDelete(`/api/memory/entries/${entryId}`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["memory-timeline"] }),
        queryClient.invalidateQueries({ queryKey: ["memory-search"] }),
        queryClient.invalidateQueries({ queryKey: ["memory-page"] }),
      ]);
      // The row is gone by now; drop the cached detail so forgotten text doesn't linger in the browser.
      queryClient.removeQueries({ queryKey: ["memory-entry", entryId] });
    },
  });
  return (
    <div className="memdrawer__footer">
      {!confirming ? (
        <div className="memdrawer__actions">
          {children}
          <button type="button" className="memdrawer__forget" onClick={() => setConfirming(true)}>
            Forget
          </button>
        </div>
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
  );
}

/** "Pin to notes": append this entry to its host's note. */
export function PinAction({ entryId }: { entryId: string }) {
  const queryClient = useQueryClient();
  const pin = useMutation({
    mutationFn: () => apiPost<{ hostId: string }>(`/api/memory/entries/${entryId}/pin`),
    onSuccess: (r) => queryClient.invalidateQueries({ queryKey: ["host-note", r.hostId] }),
  });
  return (
    <button type="button" className="memdrawer__action" disabled={pin.isPending || pin.isSuccess} title="Adds this to the host's notes" onClick={() => pin.mutate()}>
      {pin.isSuccess ? "Pinned" : pin.isError ? "Couldn't pin" : "Pin to notes"}
    </button>
  );
}

/** "Save as snippet": stores the command in the library (rename it from the Snippets tab). */
export function SaveSnippetAction({ command }: { command: string }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () => apiPost("/api/snippets", { name: command.replace(/\s+/g, " ").slice(0, 60), command: command.slice(0, 4000) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["snippets"] }),
  });
  return (
    <button type="button" className="memdrawer__action" disabled={save.isPending || save.isSuccess} onClick={() => save.mutate()}>
      {save.isSuccess ? "Saved to Snippets" : save.isError ? "Couldn't save" : "Save as snippet"}
    </button>
  );
}
