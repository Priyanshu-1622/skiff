import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/shell";
import { useVault } from "@/lib/vault";
import { useTheme } from "@/lib/theme";
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";

export function DashboardRoute() {
  const navigate = useNavigate();
  const { status, loading, fetchStatus, lock } = useVault();
  const { theme, toggle } = useTheme();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editHost, setEditHost] = useState<any | null>(null);
  const [showAddFolder, setShowAddFolder] = useState(false);
  const [folderToDelete, setFolderToDelete] = useState<{ id: string; name: string } | null>(null);
  const [hostToDelete, setHostToDelete] = useState<any | null>(null);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (!loading && status && !status.unlocked) {
      navigate({ to: status.mode === "team" ? "/login" : "/unlock" });
    }
  }, [loading, status, navigate]);

  // Re-render every minute so timeAgo values stay fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Focus the search bar when "/" is pressed
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>(".topbar__search input");
        input?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
      setHostToDelete(null);
      toast.success("Host deleted");
    },
    onError: (error: any) => {
      toast.error("Couldn't delete that host", { description: error?.message });
      setHostToDelete(null);
    },
  });

  const createFolder = useMutation({
    mutationFn: (name: string) => apiPost("/api/folders", { name, parentId: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      setShowAddFolder(false);
      toast.success("Folder created");
    },
    onError: (error: any) => {
      toast.error("Couldn't create the folder", { description: error?.message });
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
      toast.success("Folder deleted");
    },
    onError: (error: any) => {
      toast.error("Couldn't delete the folder", { description: error?.message });
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
      toast.error("That didn't save", { description: error?.message });
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

  const connectToHost = (hostId: string) => {
    navigate({ to: "/terminal/$hostId", params: { hostId } });
  };

  return (
    <AppShell
      topbar={{ searchValue: search, onSearchChange: setSearch, username: "Vault" }}
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
        isTeamAdmin: status?.mode === "team" && !!status.user?.isAdmin,
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

      {/* Search empty state */}
      {hostList.length === 0 && search && !hosts.isLoading ? (
        <div className="main__body">
          <div className="empty">
            <div className="empty__glyph" style={{ opacity: 0.5 }}>
              <I.Search size={28} />
            </div>
            <div className="empty__head">
              <h1 className="empty__h1">No matches</h1>
              <p className="empty__sub">
                Nothing matches <code style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-0)", background: "var(--bg-2)", padding: "1px 6px", borderRadius: 3 }}>{search}</code> in {activeFolder === "__starred" ? "favorites" : activeFolder ? "this folder" : "your hosts"}.
              </p>
            </div>
            <div className="empty__actions">
              <button className="btn btn--secondary" onClick={() => setSearch("")}>
                Clear search
              </button>
            </div>
          </div>
        </div>
      ) : hostList.length === 0 && !hosts.isLoading ? (
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
                className="list__row list__row--clickable"
                tabIndex={0}
                role="button"
                onClick={() => connectToHost(host.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    connectToHost(host.id);
                  }
                }}
                title="Click to connect"
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
                <div className="launch-cell" onClick={(e) => e.stopPropagation()}>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="row-action"
                      onClick={(e) => { e.stopPropagation(); setEditHost(host); }}
                      title="Edit host"
                      aria-label="Edit"
                    >
                      <I.Settings size={12} />
                    </button>
                    <button
                      type="button"
                      className="row-action danger"
                      onClick={(e) => { e.stopPropagation(); setHostToDelete(host); }}
                      title="Delete host"
                      aria-label="Delete"
                    >
                      <I.Close size={12} />
                    </button>
                    <button
                      className="launch-btn idle"
                      onClick={(e) => { e.stopPropagation(); connectToHost(host.id); }}
                    >
                      <I.Terminal size={12} />
                      Connect
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showAdd && (
        <HostDialog
          mode="create"
          folderId={activeFolder && activeFolder !== "__starred" ? activeFolder : null}
          folders={folderList}
          onClose={(saved) => {
            setShowAdd(false);
            if (saved) {
              queryClient.invalidateQueries({ queryKey: ["hosts"] });
              toast.success("Host added");
            }
          }}
        />
      )}

      {editHost && (
        <HostDialog
          mode="edit"
          host={editHost}
          folders={folderList}
          onClose={(saved) => {
            setEditHost(null);
            if (saved) {
              queryClient.invalidateQueries({ queryKey: ["hosts"] });
              toast.success("Host updated");
            }
          }}
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

      {hostToDelete && (
        <DeleteHostDialog
          host={hostToDelete}
          onConfirm={() => deleteHost.mutate(hostToDelete.id)}
          onCancel={() => setHostToDelete(null)}
          busy={deleteHost.isPending}
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

function DeleteHostDialog({
  host,
  onConfirm,
  onCancel,
  busy,
}: {
  host: any;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="dialog" style={{ width: 440 }}>
        <div className="dialog__header">
          <h2>Delete host</h2>
          <button type="button" className="dialog__close" onClick={onCancel}><I.Close size={14} /></button>
        </div>
        <div className="dialog__body">
          <p style={{ margin: 0, lineHeight: 1.5 }}>
            Delete <strong>{host.label}</strong>?
          </p>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--fg-2)", lineHeight: 1.5, fontFamily: "var(--font-mono)" }}>
            {host.username}@{host.hostname}:{host.port}
          </p>
          <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--fg-2)", lineHeight: 1.5 }}>
            The credential will be deleted too. This action cannot be undone.
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
            {busy ? "Deleting…" : "Delete host"}
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

// Combined create+edit dialog with input validation
function HostDialog({
  mode,
  host: existing,
  folderId,
  folders,
  onClose,
}: {
  mode: "create" | "edit";
  host?: any;
  folderId?: string | null;
  folders: any[];
  onClose: (saved: boolean) => void;
}) {
  const [label, setLabel] = useState(existing?.label ?? "");
  const [hostname, setHostname] = useState(existing?.hostname ?? "");
  const [port, setPort] = useState(String(existing?.port ?? 22));
  const [username, setUsername] = useState(existing?.username ?? "");
  const [folderIdState, setFolderIdState] = useState<string | null>(existing?.folder_id ?? folderId ?? null);
  const [authMethod, setAuthMethod] = useState<"password" | "key">(existing?.auth_method ?? "password");
  const [credValue, setCredValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Hostname validation: non-empty, reasonable chars
  const validate = () => {
    const errs: Record<string, string> = {};
    const hn = hostname.trim();
    if (!hn) errs.hostname = "Hostname is required";
    else if (!/^[a-zA-Z0-9._\-:]+$/.test(hn)) errs.hostname = "Hostname has invalid characters";
    else if (hn.length > 253) errs.hostname = "Hostname is too long";
    const portNum = parseInt(port);
    if (!portNum || portNum < 1 || portNum > 65535) errs.port = "Port must be 1-65535";
    const un = username.trim();
    if (!un) errs.username = "Username is required";
    else if (!/^[a-zA-Z0-9._\-]+$/.test(un)) errs.username = "Username has invalid characters";
    return errs;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const payload: any = {
        label: label.trim() || hostname.trim(),
        hostname: hostname.trim(),
        port: parseInt(port),
        username: username.trim(),
        folderId: folderIdState,
        authMethod,
        tags: existing?.tags ?? [],
        starred: existing?.starred ?? false,
      };
      if (credValue) {
        payload.credential = { kind: authMethod, value: credValue };
      }
      if (mode === "create") {
        await apiPost("/api/hosts", payload);
      } else {
        await apiPut(`/api/hosts/${existing.id}`, payload);
      }
      onClose(true);
    } catch (err: any) {
      setErrors({ form: err.message || "Failed to save" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(false); }}>
      <div className="dialog">
        <div className="dialog__header">
          <h2>{mode === "create" ? "Add host" : "Edit host"}</h2>
          <button type="button" className="dialog__close" onClick={() => onClose(false)}><I.Close size={14} /></button>
        </div>
        <form onSubmit={handleSubmit} className="dialog__body">
          <div className="field">
            <label>Label (optional)</label>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Production Web 1" />
          </div>
          <div className="field">
            <label>Hostname *</label>
            <input
              value={hostname}
              onChange={e => { setHostname(e.target.value); if (errors.hostname) setErrors({ ...errors, hostname: "" }); }}
              placeholder="10.0.0.5 or web.example.com"
              required
              className="mono"
              aria-invalid={!!errors.hostname}
            />
            {errors.hostname && <div className="field-error">{errors.hostname}</div>}
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div className="field" style={{ width: 90 }}>
              <label>Port</label>
              <input
                value={port}
                onChange={e => { setPort(e.target.value); if (errors.port) setErrors({ ...errors, port: "" }); }}
                type="number"
                min={1}
                max={65535}
                className="mono"
                aria-invalid={!!errors.port}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Username *</label>
              <input
                value={username}
                onChange={e => { setUsername(e.target.value); if (errors.username) setErrors({ ...errors, username: "" }); }}
                placeholder="deploy"
                required
                className="mono"
                aria-invalid={!!errors.username}
              />
            </div>
          </div>
          {errors.port && <div className="field-error">{errors.port}</div>}
          {errors.username && <div className="field-error">{errors.username}</div>}

          {folders.length > 0 && (
            <div className="field">
              <label>Folder</label>
              <select
                value={folderIdState ?? ""}
                onChange={(e) => setFolderIdState(e.target.value || null)}
                style={{
                  background: "var(--bg-2)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: 6,
                  padding: "7px 10px",
                  color: "var(--fg-0)",
                  font: "400 13px/1.4 var(--font-sans)",
                  outline: "none",
                }}
              >
                <option value="">(none)</option>
                {folders.map((f: any) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="field">
            <label>Authentication</label>
            <div className="seg-control">
              <button type="button" className={authMethod === "password" ? "active" : ""} onClick={() => setAuthMethod("password")}>Password</button>
              <button type="button" className={authMethod === "key" ? "active" : ""} onClick={() => setAuthMethod("key")}>Private Key</button>
            </div>
          </div>
          <div className="field">
            <label>
              {mode === "edit" ? "New credential (optional — leave blank to keep existing)" : "Credential"}
            </label>
            {authMethod === "password"
              ? <input
                  type="password"
                  value={credValue}
                  onChange={e => setCredValue(e.target.value)}
                  placeholder={mode === "edit" ? "Leave blank to keep current password" : "SSH password (optional, store later)"}
                  autoComplete="new-password"
                />
              : <textarea
                  value={credValue}
                  onChange={e => setCredValue(e.target.value)}
                  placeholder={mode === "edit" ? "Leave blank to keep current key" : "-----BEGIN OPENSSH PRIVATE KEY-----\n..."}
                  rows={6}
                  className="mono"
                  style={{ resize: "vertical" }}
                />
            }
          </div>
          {errors.form && <div className="field-error">{errors.form}</div>}
          <div className="dialog__footer">
            <button type="button" className="btn btn--secondary" onClick={() => onClose(false)}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={busy || !hostname || !username}>
              {busy ? "Saving…" : (mode === "edit" ? "Save changes" : "Save host")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
