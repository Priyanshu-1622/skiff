import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BareShell } from "@/components/shell";
import { useVault } from "@/lib/vault";
import * as I from "@/components/icons";
import "@/styles/team.css";

/**
 * Team login screen. Shown when the vault is in team mode and the user
 * isn't signed in. Wired to POST /api/team/login via the vault store.
 */
export function TeamLoginRoute() {
  const navigate = useNavigate();
  const { status, loading, fetchStatus, teamLogin } = useVault();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (!loading && status?.unlocked) navigate({ to: "/" });
    // If this isn't a team vault, the login screen doesn't apply.
    if (!loading && status && status.mode !== "team") navigate({ to: "/unlock" });
  }, [loading, status, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!username || !password) return;
    setBusy(true);
    try {
      const result = await teamLogin(username, password);
      if (!result.ok) setError(result.error || "Invalid credentials");
    } finally {
      setBusy(false);
    }
  };

  return (
    <BareShell>
      <div className="tm-stage">
        <div className="tm-login">
          <div className="tm-login__head">
            <div className="tm-wordmark">
              <span className="mark"><I.Skiff size={17} /></span>
              <span className="name">Skiff</span>
            </div>
            <div className="tm-login__title">Sign in to your team</div>
          </div>

          <form className="tm-login__card" onSubmit={handleSubmit}>
            {error && (
              <div className="tm-login__error" role="alert">
                <span className="ic"><I.Warn size={13} /></span>
                <span>{error}</span>
              </div>
            )}

            <div className="tm-field">
              <label className="tm-field__label">Username</label>
              <div className={`tm-input mono ${error ? "error" : ""}`}>
                <span className="lead"><I.User size={13} /></span>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="username"
                  spellCheck={false}
                  autoComplete="username"
                  autoFocus
                />
              </div>
            </div>

            <div className="tm-field">
              <label className="tm-field__label">Password</label>
              <div className={`tm-input ${error ? "error" : ""}`}>
                <span className="lead"><I.Lock size={13} /></span>
                <input
                  type={reveal ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  spellCheck={false}
                  autoComplete="current-password"
                />
                <button className="eye" type="button" tabIndex={-1} aria-label="Toggle password" onClick={() => setReveal((r) => !r)}>
                  {reveal ? <I.EyeOff size={14} /> : <I.Eye size={14} />}
                </button>
              </div>
            </div>

            <button className="tm-btn-lg tm-btn-lg--primary" type="submit" disabled={busy} style={{ width: "100%", marginTop: 2 }}>
              <I.LogIn size={14} />
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div className="tm-login__foot">
            Locked out? Ask a workspace admin to reset your password.
          </div>
        </div>
      </div>
    </BareShell>
  );
}
