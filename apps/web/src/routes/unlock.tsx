import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BareShell } from "@/components/shell";
import { useVault } from "@/lib/vault";
import * as I from "@/components/icons";
import "@/styles/unlock.css";

export function UnlockRoute() {
  const navigate = useNavigate();
  const { status, loading, fetchStatus, setup, unlock } = useVault();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (loading) return;
    // No status means the server couldn't be reached — that says nothing
    // about whether a vault exists, so don't send anyone to first-run setup.
    if (!status) return;
    if (!status.initialized) { navigate({ to: "/setup" }); return; }
    if (status.unlocked) { navigate({ to: "/" }); return; }
    // Team vaults log in by username on a separate screen.
    if (status.mode === "team") navigate({ to: "/login" });
  }, [loading, status, navigate]);

  const isSetup = !!status && !status.initialized;

  const triggerShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 400);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!password) return;
    if (isSetup && password.length < 8) {
      setError("Use at least 8 characters");
      triggerShake();
      return;
    }
    if (isSetup && password !== confirm) {
      setError("Passwords don't match");
      triggerShake();
      return;
    }
    setBusy(true);
    try {
      if (isSetup) {
        const result = await setup(password);
        if (!result.ok) { setError(result.error || "Setup failed"); triggerShake(); }
      } else {
        const result = await unlock(password);
        if (!result.ok) { setError(result.error || "Incorrect password"); triggerShake(); }
      }
    } finally { setBusy(false); }
  };

  if (loading) {
    return (
      <BareShell>
        <div className="unlock-stage">
          <div className="unlock-card">
            <div style={{ display: "grid", placeItems: "center", padding: 20 }}>
              <div style={{ width: 20, height: 20, border: "2px solid var(--accent-500)", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            </div>
          </div>
        </div>
      </BareShell>
    );
  }

  if (!status) {
    return (
      <BareShell>
        <div className="unlock-stage">
          <div className="unlock-card" style={{ textAlign: "center" }}>
            <p className="unlock-sub" style={{ marginBottom: 16 }}>Can't reach the Skiff server. Is it running?</p>
            <button type="button" className="unlock-btn" onClick={() => fetchStatus()}>Try again</button>
          </div>
        </div>
      </BareShell>
    );
  }

  return (
    <BareShell>
      <div className="unlock-stage">
        <div className="unlock-card">
          {/* Head */}
          <div className="unlock-card__head">
            <div className="unlock-mark"><I.Skiff size={22} /></div>
            <div className="unlock-wordmark">
              <span className="name">Skiff</span>
              <span className="tag">{isSetup ? "setup" : "v0.3"}</span>
            </div>
            <p className="unlock-sub">
              {isSetup
                ? "Choose a strong master password. It encrypts all your SSH credentials."
                : "Enter your master password to access your hosts."}
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            {status?.insecureTransport && (
              <div className="unlock-meta error" style={{ marginBottom: 12, alignItems: "flex-start", lineHeight: 1.45 }}>
                <div className="dot" />
                <span>Signing in won't work over plain HTTP from another computer. Open Skiff over HTTPS, or set SKIFF_INSECURE_HTTP=true on a network you trust.</span>
              </div>
            )}

            {/* Password field */}
            <div className="unlock-field">
              <div className={`unlock-input${error ? " error" : ""}${shake ? " shake" : ""}`}>
                <span className="lead"><I.Lock size={13} /></span>
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  autoComplete={isSetup ? "new-password" : "current-password"}
                  placeholder={isSetup ? "Master password" : "Password"}
                  disabled={busy}
                />
                <button type="button" className="eye" onClick={() => setShowPw(!showPw)} tabIndex={-1}>
                  {showPw ? <I.EyeOff size={13} /> : <I.Eye size={13} />}
                </button>
              </div>
            </div>

            {/* Confirm field (setup only) */}
            {isSetup && (
              <div className="unlock-field">
                <div className="unlock-input">
                  <span className="lead"><I.Lock size={13} /></span>
                  <input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    placeholder="Confirm password"
                    disabled={busy}
                  />
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="unlock-meta error">
                <div className="dot" />
                <span className="strong">{error}</span>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              className="unlock-btn"
              disabled={busy || !password}
            >
              {busy ? "Working…" : isSetup ? "Create vault" : "Unlock"}
              {!busy && <span className="kbd">↵</span>}
            </button>
          </form>

          {/* Footer */}
          <div className="unlock-foot">
            <span className="lock">
              <I.Lock size={10} />
              AES-256-GCM · argon2id
            </span>
            <span>Self-hosted</span>
          </div>
        </div>
      </div>
    </BareShell>
  );
}
