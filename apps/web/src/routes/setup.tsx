import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BareShell } from "@/components/shell";
import { useVault } from "@/lib/vault";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";
import type { VaultMode } from "@skiff/shared";
import "@/styles/team.css";

/**
 * First-run setup. Two steps:
 *   1. Choose mode (personal / team)
 *   2. Set master password (personal) or create first admin (team)
 * Redirects away if a vault already exists.
 */
export function SetupRoute() {
  const navigate = useNavigate();
  const { status, loading, fetchStatus, setup } = useVault();

  const [step, setStep] = useState<"mode" | "credentials">("mode");
  const [mode, setMode] = useState<VaultMode>("personal");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [setupToken, setSetupToken] = useState("");
  const tokenRequired = !!status?.setupTokenRequired;
  const tokenHeaders: Record<string, string> = tokenRequired ? { "x-skiff-setup-token": setupToken.trim() } : {};

  const restoreFromFile = async (file: File) => {
    setError("");
    if (tokenRequired && !setupToken.trim()) { setError("Enter the setup token first"); return; }
    setBusy(true);
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      const res = await fetch("/api/settings/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tokenHeaders },
        body: JSON.stringify(backup),
        credentials: "include",
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error?.message || "Restore failed");
      } else {
        // Personal backups unlock with the original master password; team
        // backups sign in per member. An old team backup comes back as
        // personal with a warning worth reading, so keep it on screen longer.
        const restoredMode = data.data?.mode;
        const message: string = data.data?.message ?? "Backup restored.";
        if (restoredMode === "personal" && message.startsWith("Restored as a personal vault")) {
          toast.warning("Restored with a caveat", { description: message, duration: 20000 });
        } else {
          toast.success("Backup restored", { description: message });
        }
        await fetchStatus();
        navigate({ to: restoredMode === "team" ? "/login" : "/unlock" });
      }
    } catch (e: any) {
      setError(e.message || "Couldn't read that backup file");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (loading) return;
    // Already initialized → don't allow re-setup.
    if (status?.initialized) navigate({ to: "/" });
  }, [loading, status, navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("Use at least 8 characters"); return; }
    if (password !== confirm) { setError("Passwords don't match"); return; }
    if (mode === "team" && !username.trim()) { setError("Choose an admin username"); return; }

    setBusy(true);
    try {
      const token = tokenRequired ? setupToken.trim() : undefined;
      const result = await setup(password, mode === "team" ? { mode, username: username.trim(), setupToken: token } : { mode, setupToken: token });
      if (!result.ok) setError(result.error || "Setup failed");
    } finally {
      setBusy(false);
    }
  };

  if (step === "mode") {
    return (
      <BareShell>
        <div className="tm-stage">
          <div className="tm-setup">
            <div className="tm-wordmark">
              <span className="mark"><I.Skiff size={17} /></span>
              <span className="name">Skiff</span>
              <span className="tag">Setup</span>
            </div>
            <div className="tm-setup__eyebrow">Step 1 of 2 · Choose a mode</div>
            <h1 className="tm-setup__title">How will you use Skiff?</h1>
            <p className="tm-setup__sub">
              This sets how the vault is unlocked and who can access it. A personal vault can be upgraded to a team vault later, but not the other way round.
            </p>

            <div className="tm-modes">
              <ModeCard
                id="personal"
                icon={<I.User size={20} />}
                name="Personal"
                desc="One person, one master password. The whole vault is encrypted to you."
                feats={["Single master password", "Local, offline-first", "Zero setup"]}
                checked={mode === "personal"}
                onChoose={setMode}
              />
              <ModeCard
                id="team"
                icon={<I.Users size={20} />}
                name="Team"
                desc="Multiple people with their own logins share one encrypted vault. Admins manage members and see an audit log."
                feats={["Per-user accounts", "Shared encrypted vault", "Audit log of every action"]}
                checked={mode === "team"}
                onChoose={setMode}
              />
            </div>

            {status?.insecureTransport && (
              <div className="tm-login__error" role="alert" style={{ marginTop: 16 }}>
                <span className="ic"><I.Warn size={13} /></span>
                <span>Setup won't work over plain HTTP from another computer: your browser would discard the login. Open Skiff over HTTPS, or set SKIFF_INSECURE_HTTP=true on a network you trust.</span>
              </div>
            )}

            {tokenRequired && (
              <div className="tm-field" style={{ marginTop: 16 }}>
                <label className="tm-field__label">Setup token</label>
                <div className="tm-input mono">
                  <span className="lead"><I.Key size={13} /></span>
                  <input
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    placeholder="from the server log"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
                <div className="tm-field__hint">
                  <span className="ic"><I.Info size={11} /></span>
                  Proves you run this server. Find it with <code>docker compose logs skiff</code> (or the terminal running Skiff).
                </div>
              </div>
            )}

            <div className="tm-setup__foot">
              <span className="tm-setup__hint">
                <I.Info size={12} />
                {mode === "team" ? "You'll create the first admin account next." : "You'll set your master password next."}
              </span>
              <button
                className="tm-btn-lg tm-btn-lg--primary"
                disabled={tokenRequired && !setupToken.trim()}
                onClick={() => setStep("credentials")}
              >
                Continue <I.ArrowRight size={13} />
              </button>
            </div>

            {error && (
              <div className="tm-login__error" role="alert" style={{ marginTop: 14 }}>
                <span className="ic"><I.Warn size={13} /></span>
                <span>{error}</span>
              </div>
            )}

            <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--border)", textAlign: "center" }}>
              <label style={{ fontSize: 12.5, color: "var(--fg-2)", cursor: busy ? "default" : "pointer" }}>
                Migrating from another machine?{" "}
                <span style={{ color: "var(--accent-500)", fontWeight: 500 }}>
                  {busy ? "Restoring…" : "Restore from a backup file"}
                </span>
                <input
                  type="file"
                  accept="application/json,.json"
                  disabled={busy}
                  style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) restoreFromFile(f); }}
                />
              </label>
            </div>
          </div>
        </div>
      </BareShell>
    );
  }

  // Step 2 — credentials
  return (
    <BareShell>
      <div className="tm-stage">
        <div className="tm-login">
          <div className="tm-login__head">
            <div className="tm-wordmark">
              <span className="mark"><I.Skiff size={17} /></span>
              <span className="name">Skiff</span>
              <span className="tag">Setup</span>
            </div>
            <div className="tm-login__title">
              {mode === "team" ? "Create the first admin" : "Set your master password"}
            </div>
          </div>

          <form className="tm-login__card" onSubmit={submit}>
            {error && (
              <div className="tm-login__error" role="alert">
                <span className="ic"><I.Warn size={13} /></span>
                <span>{error}</span>
              </div>
            )}

            {mode === "team" && (
              <div className="tm-field">
                <label className="tm-field__label">Admin username</label>
                <div className="tm-input mono">
                  <span className="lead"><I.User size={13} /></span>
                  <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" spellCheck={false} autoComplete="off" autoFocus />
                </div>
              </div>
            )}

            <div className="tm-field">
              <label className="tm-field__label">{mode === "team" ? "Password" : "Master password"}</label>
              <div className="tm-input">
                <span className="lead"><I.Lock size={13} /></span>
                <input
                  type={reveal ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  spellCheck={false}
                  autoComplete="new-password"
                  autoFocus={mode === "personal"}
                />
                <button className="eye" type="button" tabIndex={-1} onClick={() => setReveal((r) => !r)}>
                  {reveal ? <I.EyeOff size={14} /> : <I.Eye size={14} />}
                </button>
              </div>
            </div>

            <div className="tm-field">
              <label className="tm-field__label">Confirm password</label>
              <div className="tm-input">
                <span className="lead"><I.Lock size={13} /></span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Re-enter password"
                  spellCheck={false}
                  autoComplete="new-password"
                />
              </div>
            </div>

            <button className="tm-btn-lg tm-btn-lg--primary" type="submit" disabled={busy} style={{ width: "100%", marginTop: 2 }}>
              {busy ? "Creating…" : mode === "team" ? "Create team vault" : "Create vault"}
            </button>

            <div className="tm-login__row">
              <button type="button" className="tm-login__forgot" onClick={() => { setStep("mode"); setError(""); }}>
                ← Back
              </button>
              <span style={{ color: "var(--fg-3)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{mode}</span>
            </div>
          </form>
        </div>
      </div>
    </BareShell>
  );
}

function ModeCard({
  id, icon, name, desc, feats, checked, onChoose,
}: {
  id: VaultMode; icon: JSX.Element; name: string; desc: string;
  feats: string[]; checked: boolean; onChoose: (id: VaultMode) => void;
}) {
  return (
    <div
      className="tm-mode"
      role="radio"
      aria-checked={checked}
      tabIndex={0}
      onClick={() => onChoose(id)}
      onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onChoose(id); } }}
    >
      <div className="tm-mode__top">
        <div className="tm-mode__icon">{icon}</div>
        <div className="tm-mode__radio">{checked && <I.Check size={11} />}</div>
      </div>
      <div className="tm-mode__name">{name}</div>
      <p className="tm-mode__desc">{desc}</p>
      <div className="tm-mode__meta">
        {feats.map((f, i) => (
          <div className="tm-mode__feat" key={i}>
            <span className="ic"><I.Check size={12} /></span>
            <span>{f}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
