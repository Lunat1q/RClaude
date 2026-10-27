import { useState, type FormEvent } from "react";
import { api } from "../api";

export function Login({ setupRequired, username, onDone }: { setupRequired: boolean; username: string; onDone: () => void }) {
  const [user, setUser] = useState(username);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (setupRequired && password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      if (setupRequired) await api("/auth/setup", { body: { setupCode, password } });
      else await api("/auth/login", { body: { username: user, password } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <div className="brand">
          <span className="logo" aria-hidden="true">
            ›_
          </span>
          RClaude
        </div>
        {setupRequired ? (
          <>
            <h1>Set your password</h1>
            <p className="muted">
              First login for <strong>{username}</strong>. Enter the setup code from the server configuration and choose a password (12+
              characters).
            </p>
            <label>
              Setup code
              <input value={setupCode} onChange={(e) => setSetupCode(e.target.value)} autoComplete="one-time-code" required />
            </label>
            <input type="text" name="username" value={username} autoComplete="username" readOnly hidden />
            <label>
              New password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={12} required />
            </label>
            <label>
              Confirm password
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={12} required />
            </label>
          </>
        ) : (
          <>
            <h1>Sign in</h1>
            <label>
              Username
              <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" autoCapitalize="none" required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
            </label>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <button className="btn primary block" disabled={busy}>
          {busy ? "…" : setupRequired ? "Set password & sign in" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
