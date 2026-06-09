import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import Popover from "@/components/Popover";
import { apiGet, apiPost } from "@/lib/api";
import { useVault } from "@/lib/vault";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";
import type { TeamMember, AuditEntry } from "@skiff/shared";
import "@/styles/team.css";

/** Calls `onEscape` when the Escape key is pressed, while mounted. */
function useEscape(onEscape: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onEscape(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape]);
}

/**
 * Admin shell — reuses the settings chrome. Only the two sections the
 * backend supports are shown (members, audit). Roles/sessions/service
 * accounts are intentionally omitted until the backend supports them.
 */
const ADMIN_NAV: Array<{ id: AdminSection; label: string; icon: JSX.Element }> = [
  { id: "members", label: "Team members", icon: <I.Users size={14} /> },
  { id: "audit", label: "Audit log", icon: <I.Clock size={14} /> },
];

type AdminSection = "members" | "audit";

function AdminShell({
  active, title, onNavigate, children,
}: {
  active: AdminSection; title: string;
  onNavigate: (s: AdminSection) => void;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const { status } = useVault();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // If a menu or modal is open, let it handle Esc itself — don't also
      // navigate away from the admin screen on the same keypress.
      if (document.querySelector(".tm-menu, .tm-modal-overlay")) return;
      navigate({ to: "/" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
  return (
    <div className="app settings">
      <div className="settings-header">
        <div className="crumbs">
          <I.Shield size={13} />
          <span className="crumb">Admin</span>
          <span className="sep">/</span>
          <span className="leaf">{title}</span>
        </div>
        <span className="spacer" />
        <button className="esc" onClick={() => navigate({ to: "/" })}>Close <span className="k">Esc</span></button>
      </div>

      <aside className="settings-subnav" aria-label="Admin sections">
        <div className="group">Admin</div>
        {ADMIN_NAV.map((s) => (
          <button
            key={s.id}
            className="subnav-item"
            aria-current={s.id === active || undefined}
            onClick={() => onNavigate(s.id)}
          >
            <span className="icon">{s.icon}</span>
            <span>{s.label}</span>
          </button>
        ))}
        <div className="foot">
          <span>signed in · {status?.user?.username ?? ""}</span>
          <span><I.Shield size={11} style={{ verticalAlign: -1 }} /></span>
        </div>
      </aside>

      <div className="settings-pane">
        <div className="settings-pane__scroll">
          <div className="settings-pane__inner" style={{ maxWidth: 860 }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

// ── Members ─────────────────────────────────────────────────

function MembersPane() {
  const qc = useQueryClient();
  const { status } = useVault();
  const meId = status?.user?.id;
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [resetFor, setResetFor] = useState<TeamMember | null>(null);

  const members = useQuery({
    queryKey: ["team-users"],
    queryFn: () => apiGet<TeamMember[]>("/api/team/users"),
  });

  const setDisabled = useMutation({
    mutationFn: (v: { id: string; disabled: boolean }) =>
      apiPost(`/api/team/users/${v.id}/disabled`, { disabled: v.disabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team-users"] }),
    onError: (e: any) => toast.error("Couldn't update member", { description: e.message }),
  });

  const list = members.data ?? [];
  const active = list.filter((u) => !u.disabled).length;
  const admins = list.filter((u) => u.isAdmin).length;

  return (
    <>
      <div className="tm-pane-head">
        <div>
          <h1 className="tm-pane-head__h1">Team members</h1>
          <p className="tm-pane-head__sub">
            People with access to this workspace's shared vault. Admins can add members, reset passwords, and review the audit log.
          </p>
        </div>
        <span className="spacer" />
        <button className="tm-btn-lg tm-btn-lg--primary" style={{ height: 34 }} onClick={() => setShowAdd(true)}>
          <I.Plus size={14} /> Add user
        </button>
      </div>

      <div className="tm-stats">
        <div className="tm-stat"><span className="v">{list.length}</span><span className="k">members</span></div>
        <div className="tm-stat"><span className="v">{active}</span><span className="k">active</span></div>
        <div className="tm-stat"><span className="v">{admins}</span><span className="k">admins</span></div>
      </div>

      <div className="tm-table">
        <div className="tm-uhead">
          <span>Member</span>
          <span>Status</span>
          <span>Created</span>
          <span className="right" />
        </div>

        {members.isLoading && <div className="tm-empty">Loading members…</div>}
        {list.map((u) => (
          <div className={"tm-urow" + (u.disabled ? " disabled" : "")} key={u.id} style={{ position: "relative" }}>
            <div className="tm-user">
              <div className={"tm-avatar" + (u.disabled ? " disabled" : "")}>{initials(u.displayName || u.username)}</div>
              <div className="tm-user__meta">
                <div className="tm-user__name">
                  <span className="dn">{u.displayName || u.username}</span>
                  {u.isAdmin && <span className="tm-badge admin"><span className="ic"><I.Shield size={9} /></span>Admin</span>}
                  {u.id === meId && <span className="tm-badge you">You</span>}
                </div>
                <span className="tm-user__handle">@{u.username}</span>
              </div>
            </div>

            <div>
              {u.disabled
                ? <span className="tm-pill disabled"><span className="dot" />Disabled</span>
                : <span className="tm-pill active"><span className="dot" />Active</span>}
            </div>

            <div className="tm-cell-mono">{u.createdAt.slice(0, 10)}</div>

            <div className="tm-row-actions">
              <button
                className="tm-icon-btn"
                aria-label={`Actions for ${u.username}`}
                ref={(el) => { menuButtonRefs.current[u.id] = el; }}
                onClick={() => setMenuFor(menuFor === u.id ? null : u.id)}
              >
                <I.Dots size={15} />
              </button>
            </div>

            <Popover anchor={menuButtonRefs.current[u.id] ?? null} open={menuFor === u.id} onClose={() => setMenuFor(null)} className="tm-menu">
              <div className="tm-menu__item" role="menuitem" tabIndex={0} onClick={() => { setResetFor(u); setMenuFor(null); }}>
                <span className="ic"><I.Key size={13} /></span>Reset password
              </div>
              {u.id !== meId && (
                <>
                  <div className="tm-menu__sep" />
                  <div className="tm-menu__item danger" role="menuitem" tabIndex={0} onClick={() => { setDisabled.mutate({ id: u.id, disabled: !u.disabled }); setMenuFor(null); }}>
                    <span className="ic"><I.Power size={13} /></span>
                    {u.disabled ? "Enable account" : "Disable account"}
                  </div>
                </>
              )}
            </Popover>
          </div>
        ))}
      </div>

      {showAdd && <AddUserModal onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); qc.invalidateQueries({ queryKey: ["team-users"] }); }} />}
      {resetFor && <ResetPasswordModal member={resetFor} onClose={() => setResetFor(null)} />}
    </>
  );
}

// ── Add user modal ──────────────────────────────────────────

function genTempPassword(): string {
  const words = ["falcon", "otter", "cedar", "harbor", "ember", "quartz", "willow", "raven"];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(1000 + Math.random() * 9000);
  return `temp-${w}-${n}`;
}

function PwField({ value, onChange, onRegen }: { value: string; onChange: (v: string) => void; onRegen: () => void }) {
  const [reveal, setReveal] = useState(true);
  return (
    <div className="tm-pw">
      <span className="lead"><I.Key size={13} /></span>
      <input type={reveal ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      <button className="mini" title="Regenerate" tabIndex={-1} type="button" onClick={onRegen}><I.Refresh size={13} /></button>
      <button className="mini" title="Copy" tabIndex={-1} type="button" onClick={() => navigator.clipboard?.writeText(value)}><I.Copy size={13} /></button>
      <button className="mini" title={reveal ? "Hide" : "Show"} tabIndex={-1} type="button" onClick={() => setReveal((r) => !r)}>
        {reveal ? <I.EyeOff size={13} /> : <I.Eye size={13} />}
      </button>
    </div>
  );
}

function AddUserModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [tempPassword, setTempPassword] = useState(genTempPassword());
  const [isAdmin, setIsAdmin] = useState(false);

  const create = useMutation({
    mutationFn: () => apiPost("/api/team/users", {
      username, displayName: displayName || undefined, tempPassword, isAdmin,
    }),
    onSuccess: () => { toast.success(`Added @${username}`); onDone(); },
    onError: (e: any) => toast.error("Couldn't add user", { description: e.message }),
  });

  return (
    <div className="tm-modal-overlay" onClick={onClose}>
      <div className="tm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tm-modal__head">
          <div className="ic-seal"><I.User size={16} /></div>
          <div style={{ flex: 1 }}>
            <h2 className="tm-modal__title">Add user</h2>
            <p className="tm-modal__sub">Create an account for this workspace. Share the temporary password with them securely.</p>
          </div>
          <button className="tm-modal__close" aria-label="Close" onClick={onClose}><I.Close size={14} /></button>
        </div>

        <div className="tm-modal__body">
          <div className="tm-field">
            <label className="tm-field__label">Username</label>
            <div className="tm-input mono">
              <span className="lead"><I.User size={13} /></span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="jordan" spellCheck={false} autoComplete="off" autoFocus />
            </div>
            <div className="tm-field__hint"><span className="ic"><I.Info size={11} /></span>Letters, numbers, . _ - only. Used to sign in.</div>
          </div>

          <div className="tm-field">
            <label className="tm-field__label">Display name <span style={{ color: "var(--fg-3)", fontFamily: "var(--font-mono)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.08em" }}>Optional</span></label>
            <div className="tm-input">
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Jordan Kim" spellCheck={false} />
            </div>
          </div>

          <div className="tm-field">
            <label className="tm-field__label">Temporary password</label>
            <PwField value={tempPassword} onChange={setTempPassword} onRegen={() => setTempPassword(genTempPassword())} />
            <div className="tm-field__hint"><span className="ic"><I.Info size={11} /></span>Share over a secure channel. Minimum 8 characters.</div>
          </div>

          <div className="tm-check-row" onClick={() => setIsAdmin((a) => !a)}>
            <span className={"tm-check" + (isAdmin ? " on" : "")}>{isAdmin && <I.Check size={10} />}</span>
            <div className="tm-check-row__text">
              <div className="t">Make admin</div>
              <div className="d">Admins can manage members, reset passwords, and view the audit log. Grant sparingly.</div>
            </div>
          </div>
        </div>

        <div className="tm-modal__foot">
          <span className="left"><I.Lock size={11} /> Credentials are vault-encrypted</span>
          <button className="btn-sm btn-sm--ghost" onClick={onClose}>Cancel</button>
          <button className="btn-sm btn-sm--primary" disabled={!username || tempPassword.length < 8 || create.isPending} onClick={() => create.mutate()}>
            <I.Plus size={12} />{create.isPending ? "Adding…" : "Add user"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Reset password modal ────────────────────────────────────

function ResetPasswordModal({ member, onClose }: { member: TeamMember; onClose: () => void }) {
  useEscape(onClose);
  const [tempPassword, setTempPassword] = useState(genTempPassword());

  const reset = useMutation({
    mutationFn: () => apiPost("/api/team/users/reprovision", { userId: member.id, tempPassword }),
    onSuccess: () => { toast.success(`Password reset for @${member.username}`); onClose(); },
    onError: (e: any) => toast.error("Couldn't reset password", { description: e.message }),
  });

  return (
    <div className="tm-modal-overlay" onClick={onClose}>
      <div className="tm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tm-modal__head">
          <div className="ic-seal"><I.Key size={16} /></div>
          <div style={{ flex: 1 }}>
            <h2 className="tm-modal__title">Reset password</h2>
            <p className="tm-modal__sub">Issue a new temporary password for this member.</p>
          </div>
          <button className="tm-modal__close" aria-label="Close" onClick={onClose}><I.Close size={14} /></button>
        </div>

        <div className="tm-modal__body">
          <div className="tm-identity">
            <div className="tm-avatar">{initials(member.displayName || member.username)}</div>
            <div className="meta">
              <span className="dn">{member.displayName || member.username}</span>
              <span className="handle">@{member.username}</span>
            </div>
            <span className="spacer" style={{ flex: 1 }} />
            {member.isAdmin && <span className="tm-badge admin"><span className="ic"><I.Shield size={9} /></span>Admin</span>}
          </div>

          <div className="tm-field">
            <label className="tm-field__label">New temporary password</label>
            <PwField value={tempPassword} onChange={setTempPassword} onRegen={() => setTempPassword(genTempPassword())} />
            <div className="tm-field__hint"><span className="ic"><I.Info size={11} /></span>Share over a secure channel. Minimum 8 characters.</div>
          </div>

          <div className="tm-warn">
            <span className="ic"><I.Warn size={14} /></span>
            <div>
              <strong>This signs {member.displayName || member.username} out everywhere.</strong> All active sessions and terminals for this account are closed immediately.
            </div>
          </div>
        </div>

        <div className="tm-modal__foot">
          <span className="left"><I.Clock size={11} /> Logged in audit</span>
          <button className="btn-sm btn-sm--ghost" onClick={onClose}>Cancel</button>
          <button className="btn-sm btn-sm--primary" disabled={tempPassword.length < 8 || reset.isPending} onClick={() => reset.mutate()}>
            <I.Key size={12} />{reset.isPending ? "Resetting…" : "Reset password"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Audit log ───────────────────────────────────────────────

const ACTION_CATEGORY: Record<string, string> = {
  login: "auth", logout: "auth", "login.failed": "fail",
  "host.create": "create", "user.create": "create", "folder.create": "create",
  "host.connect": "connect",
  "host.update": "update", "user.reprovision": "update", "vault.setup": "update",
  "user.enable": "update",
  "host.delete": "delete", "user.disable": "delete", "folder.delete": "delete",
};

function describeDetail(e: AuditEntry): string {
  if (!e.detail) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(e.detail)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}: ${String(v)}`);
  }
  return parts.join(" · ");
}

function AuditPane() {
  const audit = useQuery({
    queryKey: ["team-audit"],
    queryFn: () => apiGet<AuditEntry[]>("/api/team/audit?limit=100"),
  });
  const rows = audit.data ?? [];

  return (
    <>
      <div className="tm-pane-head">
        <div>
          <h1 className="tm-pane-head__h1">Audit log</h1>
          <p className="tm-pane-head__sub">Every privileged action taken in this workspace, newest first.</p>
        </div>
      </div>

      <div className="tm-audit">
        <div className="tm-ahead">
          <span>Timestamp</span>
          <span>User</span>
          <span>Action</span>
          <span>Detail</span>
        </div>

        {audit.isLoading && <div className="tm-empty">Loading…</div>}
        {!audit.isLoading && rows.length === 0 && <div className="tm-empty">No events yet.</div>}

        {rows.map((r) => {
          const cat = ACTION_CATEGORY[r.action] ?? "update";
          const ts = r.at.replace("T", " ").slice(0, 19);
          return (
            <div className="tm-arow" key={r.id}>
              <span className="tm-ats">
                <span className="date">{ts.slice(0, 10)}</span> <span className="time">{ts.slice(11)}</span>
              </span>
              <span className="tm-auser">
                <span className="av">{r.username ? r.username.slice(0, 2).toUpperCase() : <I.Settings size={11} />}</span>
                <span className="handle">{r.username ? "@" + r.username : "system"}</span>
              </span>
              <span>
                <span className="tm-action"><span className={`cat ${cat}`} />{r.action}</span>
              </span>
              <span className="tm-adetail">
                {describeDetail(r)}
                {r.ip && <span className="muted"> · {r.ip}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Route entry ─────────────────────────────────────────────

export function TeamAdminRoute() {
  const navigate = useNavigate();
  const { status, loading } = useVault();
  const [section, setSection] = useState<AdminSection>("members");

  // Guard: must be a signed-in team admin.
  if (!loading && (!status?.unlocked || status.mode !== "team" || !status.user?.isAdmin)) {
    navigate({ to: "/" });
    return null;
  }

  return (
    <AdminShell
      active={section}
      title={section === "members" ? "Team members" : "Audit log"}
      onNavigate={setSection}
    >
      {section === "members" ? <MembersPane /> : <AuditPane />}
    </AdminShell>
  );
}
