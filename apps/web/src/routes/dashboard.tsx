import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/shell";
import { useVault } from "@/lib/vault";
import { useTheme } from "@/lib/theme";
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api";
import * as I from "@/components/icons";

export function DashboardRoute() {
  const navigate = useNavigate();
  const { status, loading, fetchStatus, lock } = useVault();
  const { theme, toggle } = useTheme();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showAddFolder, setShowAddFolder] = useState(false);
  const [folderToDelete, setFolderToDelete] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => { fetchStatus(); }, []);
  useEffect(() => {
    if (!loading && status && !status.unlocked) navigate({ to: "/unlock" });
  }, [loading, status]);

  const hosts = useQuery({
    queryKey: ["hosts", activeFolder, search],
    queryFn: () => {
      const p = new URLSearchParams();
      if (activeFolder && activeFolder !== "__starred") p.set("folderId", activeFolder);
      if (activeFolder === "__starred") p.set("starred", "true");
      if (search) p.set("search", search);
      return apiGet<any[]>(`/api/hosts?${p}`);
    },
    enabled: !!status?.unlocked,
  });

  const folders = useQuery({
    queryKey: ["folders"],
    queryFn: () => apiGet<any[]>("/api/folders"),
    enabled: !!status?.unlocked,
  });

  const deleteHost = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/hosts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["hosts"] }),
  });

  const createFolder = useMutation({
    mutationFn: (name: string) => apiPost("/api/folders", { name, parentId: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      setShowAddFolder(false);
    },
    onError: (error: any) => {
      alert(`Failed to create folder: ${error.message || "Unknown error"}`);
    },
  });

  const deleteFolder = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/folders/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
      setFolderToDelete(null);
      if (activeFolder && !["__starred", null].includes(activeFolder as any)) {
        setActiveFolder(null);
      }
    },
    onError: (error: any) => {
      alert(`Failed to delete folder: ${error.message || "Unknown error"}`);
      setFolderToDelete(null);
    },
  });

  const toggleStar = useMutation({
    mutationFn: (host: any) => apiPut(`/api/hosts/${host.id}`, {
      label: host.label,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      folderId: host.folder_id,
      authMethod: host.auth_method,
      tags: host.tags ?? [],
      starred: !host.starred,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["hosts"] }),
    onError: (error: any) => {
      console.error("Failed to toggle star:", error);
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
    },
  });

  const hostList = hosts.data ?? [];
  const folderList = folders.data ?? [];
  const sidebarFolders = folderList.map((f: any) => ({
    id: f.id, name: f.name,
    count: hostList.filter((h: any) => h.folder_id === f.id).length,
  }));

  if (loading) return (
    <div style={{ display: "grid", placeItems: "center", height: "100vh", background: "var(--bg-0)", color: "var(--fg-2)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
      Connecting to Skiff…
    </div>
  );

  // API unreachable
  if (!status) return (
    <div style={{ display: "grid", placeItems: "center", height: "100vh", background: "var(--bg-0)", color: "var(--fg-1)", gap: 16, textAlign: "center" }}>
      <div>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚠</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)" }}>Cannot reach Skiff API</div>
        <div style={{ fontSize: 13, color: "var(--fg-2)", marginTop: 6 }}>Make sure the API server is running on port 8080</div>
        <button className="btn btn--primary" style={{ marginTop: 16 }} onClick={() => fetchStatus()}>Retry</button>
      </div>
    </div>
  );

  return (
    <AppShell
      topbar={{ searchValue: search, onSearchChange: setSearch, username: "admin" }}
      sidebar={{
        totalHosts: (hosts.data ?? []).length,
        favoritesCount: (hosts.data ?? []).filter((h: any) => h.starred).length,
        folders: sidebarFolders,
        activeFolderId: activeFolder,
        onSelectFolder: setActiveFolder,
        onAddFolder: () => setShowAddFolder(true),
        onDeleteFolder: (id: string) => {
          const folder = folderList.find((f: any) => f.id === id);
          if (folder) setFolderToDelete({ id: folder.id, name: folder.name });
        },
        vault: status ? { unlocked: status.unlocked, idleMinutes: status.idleTimeoutMinutes } : undefined,
        onVaultClick: lock,
      }}
    >
      {/* Main toolbar */}
      <div className="toolbar">
        <div className="toolbar__breadcrumb">
          <span className="leaf">
            {activeFolder === "__starred" ? "Favorites"
              : activeFolder ? folderList.find((f: any) => f.id === activeFolder)?.name ?? "Folder"
              : "All hosts"}
          </span>
          <span className="count">{hostList.length}</span>
        </div>
        <div className="spacer" />
        <button type="button" className="topbar__btn" onClick={toggle} title="Toggle theme">
          {theme === "dark" ? <I.Sun size={14} /> : <I.Moon size={14} />}
        </button>
        <button type="button" className="btn btn--primary" onClick={() => setShowAdd(true)}>
          <I.Plus size={12} />
          Add host
        </button>
      </div>

      {/* Host list or empty state */}
      {hostList.length === 0 && !hosts.isLoading ? (
        <div className="main__body">
          <div className="empty">
            <div className="empty__glyph">
              <div className="traffic">
                <span /><span /><span />
              </div>
              <div className="line">
                <span className="prompt">$</span>
                <span className="cursor" />
              </div>
            </div>
            <div className="empty__head">
              <h1 className="empty__h1">No hosts yet</h1>
              <p className="empty__sub">Import your existing SSH config or add hosts manually to get started.</p>
            </div>
            <div className="empty__actions">
              <button className="btn btn--primary" onClick={() => { navigate({ to: "/settings" }); setTimeout(() => window.location.hash = "import", 10); }}>
                <I.ArrowRight size={14} />
                Import from ~/.ssh/config
              </button>
              <button className="btn btn--secondary" onClick={() => setShowAdd(true)}>
                <I.Plus size={14} />
                Add host manually
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="list">
          <div className="list__head">
            <div />
            <button className="sort">Label</button>
            <span>Address</span>
            <span>Tags</span>
            <span className="right">Last used</span>
            <span />
          </div>
          <div className="list__body">
            {hostList.map((host: any) => (
              <div
                key={host.id}
                className="list__row"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") navigate({ to: "/terminal/$hostId", params: { hostId: host.id } }); }}
              >
                <div className="dot-cell idle"><div className="dot" /></div>
                <div className="label-cell">
                  <span className="name">{host.label}</span>
                  <span
                  className="star"
                  style={{ cursor: "pointer", color: host.starred ? "oklch(0.80 0.14 80)" : "var(--fg-3)", display: "inline-flex" }}
                  onClick={(e) => { e.stopPropagation(); toggleStar.mutate(host); }}
                  title={host.starred ? "Remove from favorites" : "Add to favorites"}
                >
                  <I.Star size={11} />
                </span>
                </div>
                <div className="addr">
                  <span className="user">{host.username}</span>
                  <span className="at">@</span>
                  <span className="host">{host.hostname}</span>
                  <span className="colon">:</span>
                  <span className="port">{host.port}</span>
                </div>
                <div className="tags">
                  {(host.tags ?? []).map((t: string) => (
                    <span key={t} className="tag">{t}</span>
                  ))}
                </div>
                <div className={`last ${host.last_connected_at ? "now" : "never"}`}>
                  {host.last_connected_at ? timeAgo(host.last_connected_at) : "never"}
                </div>
                <div className="launch-cell">
                  <button
                    className="launch-btn idle"
                    onClick={() => navigate({ to: "/terminal/$hostId", params: { hostId: host.id } })}
                  >
                    <I.Terminal size={12} />
                    Connect
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showAdd && (
        <AddHostDialog
          onClose={() => { setShowAdd(false); queryClient.invalidateQueries({ queryKey: ["hosts"] }); }}
          folderId={activeFolder && activeFolder !== "__starred" ? activeFolder : null}
        />
      )}

      {showAddFolder && (
        <AddFolderDialog
          onClose={() => setShowAddFolder(false)}
          onSubmit={(name) => createFolder.mutate(name)}
          busy={createFolder.isPending}
        />
      )}

      {folderToDelete && (
        <DeleteFolderDialog
          folder={folderToDelete}
          onConfirm={() => deleteFolder.mutate(folderToDelete.id)}
          onCancel={() => setFolderToDelete(null)}
          busy={deleteFolder.isPending}
        />
      )}
    </AppShell>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function DeleteFolderDialog({
  folder,
  onConfirm,
  onCancel,
  busy,
}: {
  folder: { id: string; name: string };
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="dialog" style={{ width: 440 }}>
        <div className="dialog__header">
          <h2>Delete folder</h2>
          <button type="button" className="dialog__close" onClick={onCancel}><I.Close size={14} /></button>
        </div>
        <div className="dialog__body">
          <p style={{ margin: 0, lineHeight: 1.5 }}>
            Delete <strong>{folder.name}</strong>?
          </p>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--fg-2)", lineHeight: 1.5 }}>
            Hosts inside this folder will be moved to "All hosts". This action cannot be undone.
          </p>
        </div>
        <div className="dialog__footer">
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete folder"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddFolderDialog({ onClose, onSubmit, busy }: { onClose: () => void; onSubmit: (name: string) => void; busy: boolean }) {
  const [name, setName] = useState("");
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" style={{ width: 380 }}>
        <div className="dialog__header">
          <h2>New folder</h2>
          <button type="button" className="dialog__close" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <form onSubmit={handleSubmit} className="dialog__body">
          <div className="field">
            <label>Folder name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production"
              autoFocus
              required
            />
          </div>
          <div className="dialog__footer">
            <button type="button" className="btn btn--secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create folder"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AddHostDialog({ onClose, folderId }: { onClose: () => void; folderId: string | null }) {
  const [label, setLabel] = useState("");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authMethod, setAuthMethod] = useState<"password" | "key">("password");
  const [credValue, setCredValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await apiPost("/api/hosts", {
        label: label || hostname,
        hostname, port: parseInt(port) || 22, username,
        folderId, authMethod,
        credential: credValue ? { kind: authMethod, value: credValue } : undefined,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog">
        <div className="dialog__header">
          <h2>Add host</h2>
          <button className="dialog__close" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <form onSubmit={handleSubmit} className="dialog__body">
          <div className="field"><label>Label (optional)</label>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Production Web 1" />
          </div>
          <div className="field"><label>Hostname *</label>
            <input value={hostname} onChange={e => setHostname(e.target.value)} placeholder="10.0.0.5 or web.example.com" required className="mono" />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div className="field" style={{ width: 90 }}><label>Port</label>
              <input value={port} onChange={e => setPort(e.target.value)} type="number" className="mono" />
            </div>
            <div className="field" style={{ flex: 1 }}><label>Username *</label>
              <input value={username} onChange={e => setUsername(e.target.value)} placeholder="deploy" required className="mono" />
            </div>
          </div>
          <div className="field"><label>Authentication</label>
            <div className="seg-control">
              <button type="button" className={authMethod === "password" ? "active" : ""} onClick={() => setAuthMethod("password")}>Password</button>
              <button type="button" className={authMethod === "key" ? "active" : ""} onClick={() => setAuthMethod("key")}>Private Key</button>
            </div>
          </div>
          <div className="field">
            {authMethod === "password"
              ? <input type="password" value={credValue} onChange={e => setCredValue(e.target.value)} placeholder="SSH password (optional, store later)" />
              : <textarea value={credValue} onChange={e => setCredValue(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..." rows={6} className="mono" style={{ resize: "vertical" }} />
            }
          </div>
          {error && <div className="field-error">{error}</div>}
          <div className="dialog__footer">
            <button type="button" className="btn btn--secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={busy || !hostname || !username}>
              {busy ? "Saving…" : "Save host"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
