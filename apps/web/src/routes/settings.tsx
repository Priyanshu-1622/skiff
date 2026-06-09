import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/shell";
import { useVault } from "@/lib/vault";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";

type Section = "security" | "import" | "backup" | "about" | "team";

const SECTIONS: Section[] = ["security", "import", "backup", "about", "team"];

function readSectionFromHash(): Section {
  if (typeof window === "undefined") return "security";
  const h = window.location.hash.replace("#", "");
  return (SECTIONS.includes(h as Section) ? h : "security") as Section;
}

export function SettingsRoute() {
  const navigate = useNavigate();
  const { status } = useVault();
  const [section, setSection] = useState<Section>(readSectionFromHash);

  // Listen for hash changes (e.g. if user clicks back/forward)
  useEffect(() => {
    const onHash = () => setSection(readSectionFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Sync section → hash so the URL reflects the current section
  useEffect(() => {
    if (window.location.hash.replace("#", "") !== section) {
      window.history.replaceState(null, "", `#${section}`);
    }
  }, [section]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") navigate({ to: "/" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const nav = [
    { id: "security" as Section, label: "Security", icon: <I.Lock size={14} /> },
    { id: "import"   as Section, label: "Import",   icon: <I.ArrowRight size={14} /> },
    { id: "backup"   as Section, label: "Backup",   icon: <I.Server size={14} /> },
    { id: "about"    as Section, label: "About",    icon: <I.Info size={14} /> },
    // Only offer the team upgrade from a personal vault.
    ...(status?.mode === "personal"
      ? [{ id: "team" as Section, label: "Team", icon: <I.Users size={14} /> }]
      : []),
  ];

  return (
    <div className="app settings">
      {/* Settings header */}
      <header className="settings-header">
        <div className="crumbs">
          <span>Skiff</span>
          <span className="sep">/</span>
          <span className="leaf">Settings</span>
        </div>
        <div className="spacer" />
        <button className="esc" onClick={() => navigate({ to: "/" })}>
          <I.Close size={12} />
          <span>Back</span>
          <span className="k">Esc</span>
        </button>
      </header>

      {/* Settings subnav */}
      <nav className="settings-subnav">
        <div className="group">General</div>
        {nav.map(n => (
          <button
            key={n.id}
            className="subnav-item"
            aria-current={section === n.id ? "true" : undefined}
            onClick={() => setSection(n.id)}
            style={{ background: "none", border: 0, width: "100%", textAlign: "left" }}
          >
            <span className="icon">{n.icon}</span>
            {n.label}
          </button>
        ))}
        <div className="foot">
          <span>v0.2.0</span>
          <span>AGPL-3.0</span>
        </div>
      </nav>

      {/* Content pane */}
      <div className="settings-pane">
        <div className="settings-pane__scroll">
          <div className="settings-pane__inner">
            {section === "security" && <SecuritySection />}
            {section === "import"   && <ImportSection />}
            {section === "backup"   && <BackupSection />}
            {section === "about"    && <AboutSection />}
            {section === "team"     && <TeamUpgradeSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function SecuritySection() {
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [timeout, setTimeout_] = useState("15");

  const changePw = useMutation({
    mutationFn: () => apiPut("/api/settings/password", { currentPassword: currentPw, newPassword: newPw }),
    onSuccess: () => {
      toast.success("Password changed", { description: "All credentials have been re-encrypted." });
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
    },
    onError: (e: any) => toast.error("Couldn't change password", { description: e.message }),
  });

  const timeoutNum = parseInt(timeout, 10);
  const timeoutValid = Number.isFinite(timeoutNum) && timeoutNum >= 1 && timeoutNum <= 1440;

  const saveTimeout = useMutation({
    mutationFn: () => apiPut("/api/settings/idle-timeout", { minutes: timeoutNum }),
    onSuccess: () => toast.success(`Idle timeout set to ${timeoutNum} min`),
    onError: (e: any) => toast.error("Couldn't save timeout", { description: e.message }),
  });

  return (
    <>
      <div className="settings-pane__head">
        <h1 className="settings-pane__h1">Security</h1>
        <p className="settings-pane__sub">Manage your master password and automatic lock behaviour.</p>
      </div>

      <div className="s-section">
        <div className="s-section__head">
          <div className="s-section__title">Master password</div>
        </div>
        <div className="s-section__body">
          <div className="s-row stacked">
            <div>
              <div className="s-row__label">Change password</div>
              <div className="s-row__desc">Re-encrypts all stored credentials with your new password.</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 400 }}>
              <input className="field input" type="password" placeholder="Current password" value={currentPw} onChange={e => setCurrentPw(e.target.value)}
                style={{ background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "7px 10px", color: "var(--fg-0)", font: "400 13px/1 var(--font-sans)", outline: "none" }} />
              <input className="field input" type="password" placeholder="New password" value={newPw} onChange={e => setNewPw(e.target.value)}
                style={{ background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "7px 10px", color: "var(--fg-0)", font: "400 13px/1 var(--font-sans)", outline: "none" }} />
              <input className="field input" type="password" placeholder="Confirm new password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                style={{ background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "7px 10px", color: "var(--fg-0)", font: "400 13px/1 var(--font-sans)", outline: "none" }} />
              <button className="btn btn--primary" style={{ alignSelf: "flex-start" }}
                onClick={() => {
                  if (newPw !== confirmPw) { toast.error("Passwords don't match"); return; }
                  if (newPw.length < 8) { toast.error("Use at least 8 characters"); return; }
                  changePw.mutate();
                }}
                disabled={changePw.isPending || !currentPw || !newPw}
              >
                {changePw.isPending ? "Changing…" : "Change password"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="s-section" style={{ marginTop: 14 }}>
        <div className="s-section__head">
          <div className="s-section__title">Auto-lock</div>
        </div>
        <div className="s-section__body">
          <div className="s-row">
            <div>
              <div className="s-row__label">Idle timeout</div>
              <div className="s-row__desc">Lock the vault automatically after this many minutes of inactivity.</div>
            </div>
            <div className="s-row__control" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="number" min={1} max={1440} value={timeout} onChange={e => setTimeout_(e.target.value)}
                style={{ width: 64, background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "5px 8px", color: "var(--fg-0)", fontFamily: "var(--font-mono)", fontSize: 13, outline: "none", textAlign: "right" }} />
              <span style={{ fontSize: 12, color: "var(--fg-2)" }}>min</span>
              <button className="btn btn--secondary" style={{ height: 28, padding: "0 10px", fontSize: 12 }} disabled={!timeoutValid || saveTimeout.isPending} onClick={() => saveTimeout.mutate()}>Save</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ImportSection() {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<any[]>([]);
  const [parseMsg, setParseMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const parse = async () => {
    try {
      const d = await apiPost<{ hosts: any[] }>("/api/import/parse", { configText: text });
      setPreview(d.hosts);
      setParseMsg(`Found ${d.hosts.length} host${d.hosts.length !== 1 ? "s" : ""}`);
      if (d.hosts.length === 0) {
        toast.warning("No hosts found", { description: "Check that your config has Host entries." });
      }
    } catch (e: any) {
      setParseMsg("");
      toast.error("Couldn't parse config", { description: e.message });
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const d = await apiPost<{ imported: number }>("/api/import/apply", {
        configText: text,
        selectedHosts: preview.map(h => h.alias),
      });
      toast.success(`Imported ${d.imported} host${d.imported !== 1 ? "s" : ""}`, {
        description: "They're in your host list now.",
      });
      setPreview([]); setText(""); setParseMsg("");
    } catch (e: any) {
      toast.error("Import failed", { description: e.message });
    }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="settings-pane__head">
        <h1 className="settings-pane__h1">Import hosts</h1>
        <p className="settings-pane__sub">Paste the contents of your <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>~/.ssh/config</span> below. Skiff will parse it and create hosts for each entry.</p>
      </div>

      <div className="s-section">
        <div className="s-section__head"><div className="s-section__title">SSH config</div></div>
        <div className="s-section__body">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={12}
            placeholder={"Host production\n  HostName 10.0.0.5\n  User deploy\n  Port 22\n\nHost staging\n  HostName staging.example.com\n  User ubuntu"}
            style={{ width: "100%", boxSizing: "border-box", background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 7, padding: "10px 12px", color: "var(--fg-0)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6, outline: "none", resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            <button className="btn btn--primary" onClick={parse} disabled={!text.trim()}>Parse config</button>
            {parseMsg && <span style={{ fontSize: 12, color: "var(--fg-2)" }}>{parseMsg}</span>}
          </div>

          {preview.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ marginBottom: 8, fontSize: 12, color: "var(--fg-1)" }}>Hosts to import:</div>
              <div style={{ border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden" }}>
                {preview.map((h, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 80px", gap: 16, padding: "10px 14px", borderTop: i ? "1px solid var(--border)" : undefined, fontSize: 12, fontFamily: "var(--font-mono)" }}>
                    <span style={{ color: "var(--fg-0)" }}>{h.alias}</span>
                    <span style={{ color: "var(--fg-1)" }}>{h.hostname || h.alias}:{h.port || 22}</span>
                    <span style={{ color: "var(--fg-2)" }}>{h.user || "root"}</span>
                  </div>
                ))}
              </div>
              <button className="btn btn--primary" style={{ marginTop: 10 }} onClick={apply} disabled={busy}>
                {busy ? "Importing…" : `Import all ${preview.length} hosts`}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function BackupSection() {
  const download = async () => {
    try {
      const data = await apiGet("/api/settings/backup");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `skiff-backup-${new Date().toISOString().split("T")[0]}.json`;
      a.click(); URL.revokeObjectURL(url);
      toast.success("Backup downloaded", { description: "Store it somewhere safe — it's encrypted but it's all you've got if you forget your password." });
    } catch (e: any) {
      toast.error("Backup failed", { description: e.message });
    }
  };

  return (
    <>
      <div className="settings-pane__head">
        <h1 className="settings-pane__h1">Backup & Export</h1>
        <p className="settings-pane__sub">Download an encrypted backup of your entire vault. Credentials remain encrypted — only decryptable with your master password.</p>
      </div>
      <div className="s-section">
        <div className="s-section__body" style={{ paddingTop: 14 }}>
          <div className="s-row">
            <div>
              <div className="s-row__label">Download vault backup</div>
              <div className="s-row__desc">Exports hosts, folders, and encrypted credentials as a JSON file.</div>
            </div>
            <div className="s-row__control">
              <button className="btn btn--primary" onClick={download}>Download backup</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function AboutSection() {
  return (
    <>
      <div className="settings-pane__head">
        <h1 className="settings-pane__h1">About Skiff</h1>
        <p className="settings-pane__sub">Self-hosted SSH connection manager. Open-source Termius alternative.</p>
      </div>
      <div className="s-section">
        <div className="s-section__body" style={{ paddingTop: 14 }}>
          {[
            ["Version", "0.2.0"],
            ["License", "AGPL-3.0"],
            ["Stack", "React + Fastify + SQLite"],
            ["Encryption", "AES-256-GCM + argon2id"],
          ].map(([k, v]) => (
            <div key={k} className="s-row">
              <div className="s-row__label">{k}</div>
              <div className="s-row__control" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-1)" }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function TeamUpgradeSection() {
  const navigate = useNavigate();
  const { fetchStatus } = useVault();
  const [currentPassword, setCurrentPassword] = useState("");
  const [adminUsername, setAdminUsername] = useState("");
  const [confirm, setConfirm] = useState(false);

  const upgrade = useMutation({
    mutationFn: () => apiPost("/api/settings/upgrade-team", { currentPassword, adminUsername }),
    onSuccess: async () => {
      toast.success("Upgraded to team mode");
      await fetchStatus();
      navigate({ to: "/admin" });
    },
    onError: (e: any) => toast.error("Upgrade failed", { description: e.message }),
  });

  return (
    <>
      <div className="settings-pane__head">
        <h1 className="settings-pane__h1">Upgrade to Team</h1>
        <p className="settings-pane__sub">Convert this personal vault into a multi-user team vault. Your hosts and credentials are kept exactly as they are.</p>
      </div>

      <div className="s-section">
        <div className="s-section__head">
          <div className="s-section__title">What happens</div>
        </div>
        <div className="s-section__body" style={{ paddingTop: 12, fontSize: 13, color: "var(--fg-1)", lineHeight: 1.6 }}>
          Your current account becomes the first admin. You'll sign in with a username and your existing password from now on. You can then invite team members, who each get their own login, and review an audit log of all activity. This can't be undone, so export a backup first if you want one.
        </div>
      </div>

      <div className="s-section" style={{ marginTop: 14 }}>
        <div className="s-section__head">
          <div className="s-section__title">Create the first admin</div>
        </div>
        <div className="s-section__body" style={{ paddingTop: 12 }}>
          <div className="field" style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--fg-2)", marginBottom: 6 }}>Admin username</label>
            <input
              className="mono"
              value={adminUsername}
              onChange={(e) => setAdminUsername(e.target.value)}
              placeholder="admin"
              spellCheck={false}
              style={{ width: "100%", maxWidth: 280, background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "8px 10px", color: "var(--fg-0)", fontFamily: "var(--font-mono)", fontSize: 13 }}
            />
          </div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--fg-2)", marginBottom: 6 }}>Confirm with your current master password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Current password"
              style={{ width: "100%", maxWidth: 280, background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "8px 10px", color: "var(--fg-0)", fontSize: 13 }}
            />
          </div>

          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, color: "var(--fg-1)", cursor: "pointer", marginBottom: 14, maxWidth: 420 }}>
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} style={{ marginTop: 2 }} />
            <span>I understand this converts the vault to team mode and can't be undone.</span>
          </label>

          <button
            className="btn btn--primary"
            disabled={!adminUsername || !currentPassword || !confirm || upgrade.isPending}
            onClick={() => upgrade.mutate()}
          >
            {upgrade.isPending ? "Upgrading…" : "Upgrade to team mode"}
          </button>
        </div>
      </div>
    </>
  );
}
