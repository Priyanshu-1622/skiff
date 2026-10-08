import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { apiGet } from "@/lib/api";
import { useVault } from "@/lib/vault";
import { MemoryEntryRow, type TimelineEntry } from "@/components/MemoryEntry";
import * as I from "@/components/icons";
import "@/styles/memory.css";

type Range = "any" | "today" | "7d" | "30d";
const RANGES: { id: Range; label: string }[] = [
  { id: "any", label: "Any time" },
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
];
const PAGE = 50;

function sinceFor(range: Range): string | undefined {
  if (range === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }
  if (range === "7d") return new Date(Date.now() - 7 * 86_400_000).toISOString();
  if (range === "30d") return new Date(Date.now() - 30 * 86_400_000).toISOString();
  return undefined;
}

interface Cursor { before: string; beforeId: string }

export function MemoryRoute() {
  const navigate = useNavigate();
  const { status, fetchStatus } = useVault();
  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  const isTeamAdmin = status?.mode === "team" && !!status.user?.isAdmin;

  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [hostId, setHostId] = useState("");
  const [range, setRange] = useState<Range>("any");
  const [failedOnly, setFailedOnly] = useState(false);
  const [includeOutput, setIncludeOutput] = useState(false);
  const [person, setPerson] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const hosts = useQuery({ queryKey: ["memory-hosts"], queryFn: () => apiGet<any[]>("/api/hosts") });
  const people = useQuery({
    queryKey: ["memory-people"],
    queryFn: () => apiGet<{ id: string; username: string }[]>("/api/team/users"),
    enabled: isTeamAdmin,
  });
  const hostLabels = useMemo(
    () => new Map((hosts.data ?? []).map((h) => [h.id as string, (h.label || h.hostname) as string])),
    [hosts.data],
  );

  const results = useInfiniteQuery({
    queryKey: ["memory-page", debounced, hostId, range, failedOnly, includeOutput, person],
    initialPageParam: null as Cursor | null,
    staleTime: 0,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ q: debounced, limit: String(PAGE) });
      if (!debounced) p.set("browse", "1");
      if (hostId) p.set("hosts", hostId);
      if (failedOnly) p.set("failed", "1");
      const since = sinceFor(range);
      if (since) p.set("since", since);
      if (includeOutput) p.set("output", "1");
      if (person) p.set("user", person);
      if (pageParam) { p.set("before", pageParam.before); p.set("beforeId", pageParam.beforeId); }
      return apiGet<{ entries: TimelineEntry[] }>(`/api/memory/search?${p.toString()}`);
    },
    getNextPageParam: (last) => {
      const tail = last.entries[last.entries.length - 1];
      if (last.entries.length < PAGE || !tail) return undefined;
      return { before: tail.startedAt, beforeId: tail.id };
    },
  });
  const entries = results.data?.pages.flatMap((pg) => pg.entries) ?? [];
  const filtered = debounced !== "" || hostId !== "" || range !== "any" || failedOnly || person !== "";

  return (
    <div className="mempage">
      <div className="mempage__header">
        <button type="button" className="mempage__back" onClick={() => navigate({ to: "/" })}>
          <I.ChevronLeft size={16} /> Back
        </button>
        <h1>Memory</h1>
        <p className="mempage__subtitle">Everything Skiff remembered running on your servers. Search it, or filter by host and time.</p>
      </div>

      {status?.memoryEnabled === false && (
        <div className="mempage__banner">Memory is off — new commands aren't being saved. Turn it on in Settings.</div>
      )}

      <div className="mempage__controls">
        <input
          className="mempage__search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search commands…"
          aria-label="Search memory"
        />
        <div className="mempage__filters">
          <select className="mempage__select" aria-label="Host" value={hostId} onChange={(e) => setHostId(e.target.value)}>
            <option value="">All hosts</option>
            {(hosts.data ?? []).map((h) => <option key={h.id} value={h.id}>{h.label || h.hostname}</option>)}
          </select>
          {isTeamAdmin && (
            <select className="mempage__select" aria-label="Person" value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="">Anyone</option>
              {(people.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
            </select>
          )}
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={"mempage__chip" + (range === r.id ? " mempage__chip--on" : "")}
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
          <button
            type="button"
            className={"mempage__chip" + (failedOnly ? " mempage__chip--on" : "")}
            aria-pressed={failedOnly}
            title="Needs shell integration, so Skiff knows exit codes"
            onClick={() => setFailedOnly((v) => !v)}
          >
            Failed only
          </button>
          <button
            type="button"
            className={"mempage__chip" + (includeOutput ? " mempage__chip--on" : "")}
            aria-pressed={includeOutput}
            onClick={() => setIncludeOutput((v) => !v)}
          >
            Search output too
          </button>
        </div>
      </div>

      <div className="mempage__list">
        {results.isLoading && <div className="mempage__muted">Loading…</div>}
        {results.isError && <div className="mempage__muted">Couldn't load memory — the vault may have locked.</div>}
        {results.data && entries.length === 0 && (
          <div className="mempage__muted">
            {filtered ? "No matches." : "Nothing remembered yet. Commands you run over SSH show up here."}
          </div>
        )}
        {entries.map((e) => (
          <MemoryEntryRow
            key={e.id}
            entry={e}
            hostLabel={e.hostId ? hostLabels.get(e.hostId) : undefined}
            showUser={isTeamAdmin}
          />
        ))}
        {results.hasNextPage && (
          <button type="button" className="mempage__more" disabled={results.isFetchingNextPage} onClick={() => results.fetchNextPage()}>
            {results.isFetchingNextPage ? "Loading…" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
}
