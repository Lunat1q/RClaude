import { useEffect, useState, type FormEvent } from "react";
import { api, PERMISSION_MODE_LABELS, timeAgo, type PermissionMode, type TerminalInfo } from "../api";
import { navigate } from "../App";

interface Info {
  username: string;
  workspaceDir: string;
  publicUrl: string;
  mcpUrl: string;
}
interface Token {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
}
interface OAuthClient {
  client_id: string;
  client_name: string | null;
  created_at: number;
  last_token_at: number | null;
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function ClaudeStatus() {
  const [status, setStatus] = useState<{ ok: boolean; status?: Record<string, unknown>; output?: string } | null>(null);
  const load = () => {
    setStatus(null);
    api<typeof status>("/claude/status").then(setStatus, (e) => setStatus({ ok: false, output: e.message }));
  };
  useEffect(load, []);

  const login = async () => {
    const t = await api<TerminalInfo>("/terminals", { body: { kind: "shell" } });
    navigate({ view: "terminal", id: t.id });
  };

  const s = status?.status;
  const loggedIn = s && (s.loggedIn === true || s.logged_in === true);
  return (
    <section className="card">
      <h2>Claude account</h2>
      {!status && <p className="muted">Checking…</p>}
      {status && (
        <>
          <p>
            Status: <strong>{loggedIn ? "signed in" : status.ok ? "see details" : "not signed in"}</strong>
          </p>
          <details>
            <summary className="muted small">Details</summary>
            <pre>{s ? JSON.stringify(s, null, 2) : status.output}</pre>
          </details>
        </>
      )}
      <p className="muted small">
        To sign in, open a shell and run <code>claude auth login</code>, open the link it prints, then paste the code back. You can also set{" "}
        <code>CLAUDE_CODE_OAUTH_TOKEN</code> (from <code>claude setup-token</code>) or <code>ANTHROPIC_API_KEY</code> in the server environment.
      </p>
      <div className="row-actions">
        <button className="btn" onClick={login}>
          Open shell
        </button>
        <button className="btn ghost" onClick={load}>
          Refresh
        </button>
      </div>
    </section>
  );
}

export function Settings() {
  const [info, setInfo] = useState<Info | null>(null);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [tokens, setTokens] = useState<Token[]>([]);
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const [newTokenName, setNewTokenName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "", revokeAll: false });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = () => {
    api<Info>("/info").then(setInfo, () => {});
    api<{ defaultPermissionMode: PermissionMode }>("/settings").then((s) => setMode(s.defaultPermissionMode), () => {});
    api<Token[]>("/tokens").then(setTokens, () => {});
    api<OAuthClient[]>("/oauth-clients").then(setClients, () => {});
  };
  useEffect(load, []);

  const flash = (m: string) => {
    setMsg(m);
    setError("");
    setTimeout(() => setMsg(""), 2500);
  };
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const saveMode = async (m: PermissionMode) => {
    setMode(m);
    await api("/settings", { method: "PUT", body: { defaultPermissionMode: m } }).then(() => flash("Saved"), fail);
  };

  const createToken = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const t = await api<{ token: string }>("/tokens", { body: { name: newTokenName.trim() } });
      setCreated(t.token);
      setNewTokenName("");
      load();
    } catch (err) {
      fail(err);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.next !== pw.confirm) return setError("New passwords don't match.");
    try {
      await api("/auth/password", { body: { current: pw.current, next: pw.next, revokeAll: pw.revokeAll } });
      setPw({ current: "", next: "", confirm: "", revokeAll: false });
      flash("Password changed. Other browser sessions were signed out.");
      load();
    } catch (err) {
      fail(err);
    }
  };

  const cliCmd = info ? `claude mcp add --transport http rclaude ${info.mcpUrl} --header "Authorization: Bearer <API token>"` : "";

  return (
    <div className="page">
      <h1>Settings</h1>
      {msg && <div className="ok-msg">{msg}</div>}
      {error && <div className="error">{error}</div>}

      <div className="settings-grid">
        <ClaudeStatus />

        <section className="card">
          <h2>Chat / API defaults</h2>
          <label>
            Default permission mode for chat, API and MCP sessions
            <select value={mode} onChange={(e) => saveMode(e.target.value as PermissionMode)}>
              {Object.entries(PERMISSION_MODE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">
            In "ask" mode, tool calls wait for approval in the chat view, or through the API / <code>respond_permission</code> MCP tool.
          </p>
          {info && (
            <p className="muted small">
              Workspace root: <code>{info.workspaceDir}</code>
            </p>
          )}
        </section>

        <section className="card wide">
          <h2>MCP access</h2>
          {info && (
            <>
              <p>
                Server URL: <code>{info.mcpUrl}</code> <Copy text={info.mcpUrl} />
              </p>
              <p className="muted small">
                <strong>claude.ai / Claude apps:</strong> add a custom connector with this URL. It signs in through OAuth with your RClaude
                password.
              </p>
              <p className="muted small">
                <strong>Claude Code or other clients:</strong> use an API token as a bearer header:
              </p>
              <pre className="cmd">
                {cliCmd} <Copy text={cliCmd} />
              </pre>
            </>
          )}
          <h3>Connected OAuth clients</h3>
          {clients.length === 0 && <p className="muted small">None.</p>}
          {clients.map((c) => (
            <div key={c.client_id} className="list-row">
              <span>
                <strong>{c.client_name || c.client_id}</strong>
                <span className="muted small"> · authorized {c.last_token_at ? timeAgo(c.last_token_at) : "—"}</span>
              </span>
              <button className="btn small danger" onClick={() => api(`/oauth-clients/${c.client_id}`, { method: "DELETE" }).then(load, fail)}>
                Revoke
              </button>
            </div>
          ))}
        </section>

        <section className="card wide">
          <h2>API tokens</h2>
          <p className="muted small">
            Bearer tokens for the REST API (<code>/api/…</code>) and MCP. Send as <code>Authorization: Bearer rck_…</code>.
          </p>
          {created && (
            <div className="token-created">
              <p>
                <strong>Copy your new token now.</strong> It won't be shown again.
              </p>
              <pre>
                {created} <Copy text={created} />
              </pre>
              <button className="btn small ghost" onClick={() => setCreated(null)}>
                Done
              </button>
            </div>
          )}
          <form className="inline-form" onSubmit={createToken}>
            <input placeholder="Token name (e.g. laptop CLI)" value={newTokenName} onChange={(e) => setNewTokenName(e.target.value)} required />
            <button className="btn primary">Create token</button>
          </form>
          {tokens.map((t) => (
            <div key={t.id} className="list-row">
              <span>
                <strong>{t.name}</strong> <code className="muted">{t.prefix}…</code>
                <span className="muted small">
                  {" "}
                  · created {timeAgo(t.created_at)} · {t.last_used_at ? `used ${timeAgo(t.last_used_at)}` : "never used"}
                </span>
              </span>
              <button
                className="btn small danger"
                onClick={() => confirm(`Delete token "${t.name}"?`) && api(`/tokens/${t.id}`, { method: "DELETE" }).then(load, fail)}
              >
                Delete
              </button>
            </div>
          ))}
        </section>

        <section className="card">
          <h2>Change password</h2>
          <form onSubmit={changePassword}>
            <input type="text" name="username" value={info?.username ?? ""} autoComplete="username" readOnly hidden />
            <label>
              Current password
              <input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
            </label>
            <label>
              New password
              <input type="password" autoComplete="new-password" minLength={12} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
            </label>
            <label>
              Confirm new password
              <input type="password" autoComplete="new-password" minLength={12} value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
            </label>
            <label className="check">
              <input type="checkbox" checked={pw.revokeAll} onChange={(e) => setPw({ ...pw, revokeAll: e.target.checked })} />
              Also revoke all OAuth (MCP connector) grants
            </label>
            <button className="btn primary">Change password</button>
          </form>
        </section>
      </div>
    </div>
  );
}
