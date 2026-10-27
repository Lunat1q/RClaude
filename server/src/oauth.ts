import crypto from "node:crypto";
import express, { type Response, type Router } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { config } from "./config.js";
import { db, sha256, randomToken } from "./db.js";
import { checkCredentials, OAUTH_ACCESS_PREFIX } from "./auth.js";

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 86400_000;
const CODE_TTL_MS = 5 * 60 * 1000;
const SCOPE = "rclaude";

class SqliteClientsStore implements OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = db.prepare("SELECT info FROM oauth_clients WHERE client_id = ?").get(clientId) as { info: string } | undefined;
    return row ? (JSON.parse(row.info) as OAuthClientInformationFull) : undefined;
  }

  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: crypto.randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    db.prepare("INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)").run(
      full.client_id,
      JSON.stringify(full),
      Date.now(),
    );
    return full;
  }
}

function issueTokens(clientId: string, scopes: string[], resource: string | null): OAuthTokens {
  const access = OAUTH_ACCESS_PREFIX + randomToken();
  const refresh = "scr_" + randomToken();
  const now = Date.now();
  const insert = db.prepare(
    "INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(sha256(access), "access", clientId, scopes.join(" "), resource, now + ACCESS_TTL_MS, now);
  insert.run(sha256(refresh), "refresh", clientId, scopes.join(" "), resource, now + REFRESH_TTL_MS, now);
  return {
    access_token: access,
    token_type: "bearer",
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refresh,
    scope: scopes.join(" "),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function renderConsent(res: Response, fields: Record<string, string>, clientName: string, error?: string): void {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RClaude · Authorize</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f5f2; --card:#fff; --fg:#1d1c1a; --muted:#6b6862; --accent:#c96442; --border:#e2dfd8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#191817; --card:#22211f; --fg:#ecebe8; --muted:#a19e97; --border:#3a3835; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; padding:16px; box-sizing:border-box; }
  form { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:28px; width:100%; max-width:360px; }
  h1 { font-size:20px; margin:0 0 6px; } p { color:var(--muted); margin:0 0 20px; }
  label { display:block; font-size:13px; color:var(--muted); margin:12px 0 4px; }
  input[type=text], input[type=password] { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:8px; border:1px solid var(--border); background:transparent; color:inherit; font-size:15px; }
  button { margin-top:20px; width:100%; padding:11px; border:0; border-radius:8px; background:var(--accent); color:#fff; font-weight:600; font-size:15px; cursor:pointer; }
  .err { color:#d9534f; margin-top:12px; font-size:14px; }
</style></head><body>
<form method="post" action="/oauth/consent">
  <h1>Authorize access</h1>
  <p><strong>${escapeHtml(clientName)}</strong> wants full access to your Claude Code sessions on RClaude.</p>
  ${hidden}
  <label for="u">Username</label><input id="u" type="text" name="username" autocomplete="username" required>
  <label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password" required>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
  <button type="submit">Approve</button>
</form></body></html>`);
}

class RClaudeOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new SqliteClientsStore();

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    renderConsent(
      res,
      {
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        state: params.state ?? "",
        resource: params.resource?.href ?? "",
      },
      client.client_name || "An MCP client",
    );
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const row = db
      .prepare("SELECT code_challenge FROM oauth_codes WHERE code_hash = ? AND client_id = ?")
      .get(sha256(code), client.client_id) as { code_challenge: string } | undefined;
    if (!row) throw new Error("Invalid authorization code");
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const hash = sha256(code);
    const row = db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(hash) as
      | { client_id: string; redirect_uri: string; scopes: string; resource: string | null; expires_at: number }
      | undefined;
    db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(hash);
    if (!row || row.client_id !== client.client_id || row.expires_at < Date.now()) throw new Error("Invalid authorization code");
    if (redirectUri && redirectUri !== row.redirect_uri) throw new Error("redirect_uri mismatch");
    return issueTokens(client.client_id, row.scopes.split(" ").filter(Boolean), row.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const hash = sha256(refreshToken);
    const row = db
      .prepare("SELECT client_id, scopes, resource, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
      .get(hash) as { client_id: string; scopes: string; resource: string | null; expires_at: number } | undefined;
    if (!row || row.client_id !== client.client_id || row.expires_at < Date.now()) throw new Error("Invalid refresh token");
    db.prepare("DELETE FROM oauth_tokens WHERE token_hash = ?").run(hash); // rotate
    return issueTokens(client.client_id, row.scopes.split(" ").filter(Boolean), row.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = db
      .prepare("SELECT client_id, scopes, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'")
      .get(sha256(token)) as { client_id: string; scopes: string; expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now()) throw new Error("Invalid token");
    return { token, clientId: row.client_id, scopes: row.scopes.split(" ").filter(Boolean), expiresAt: Math.floor(row.expires_at / 1000) };
  }

  async revokeToken(client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    db.prepare("DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = ?").run(sha256(request.token), client.client_id);
  }
}

export function revokeAllOAuth(): void {
  db.prepare("DELETE FROM oauth_tokens").run();
  db.prepare("DELETE FROM oauth_codes").run();
}

export function listOAuthClients() {
  const rows = db
    .prepare(
      `SELECT c.client_id, c.info, c.created_at,
              (SELECT MAX(t.created_at) FROM oauth_tokens t WHERE t.client_id = c.client_id) AS last_token_at,
              (SELECT COUNT(*) FROM oauth_tokens t WHERE t.client_id = c.client_id AND t.kind = 'refresh') AS active_grants
       FROM oauth_clients c ORDER BY c.created_at DESC`,
    )
    .all() as { client_id: string; info: string; created_at: number; last_token_at: number | null; active_grants: number }[];
  return rows
    .filter((r) => r.active_grants > 0)
    .map((r) => ({
      client_id: r.client_id,
      client_name: (JSON.parse(r.info) as OAuthClientInformationFull).client_name ?? null,
      created_at: r.created_at,
      last_token_at: r.last_token_at,
    }));
}

export function revokeOAuthClient(clientId: string): void {
  db.prepare("DELETE FROM oauth_tokens WHERE client_id = ?").run(clientId);
}

export function oauthRouter(): Router {
  const provider = new RClaudeOAuthProvider();
  const router = express.Router();

  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.publicUrl),
      resourceServerUrl: new URL(`${config.publicUrl}/mcp`),
      scopesSupported: [SCOPE],
      resourceName: "RClaude",
    }),
  );

  router.post("/oauth/consent", express.urlencoded({ extended: false }), async (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    const client = body.client_id ? provider.clientsStore.getClient(body.client_id) : undefined;
    const redirectUri = body.redirect_uri ?? "";
    if (!client || !client.redirect_uris.map(String).includes(redirectUri) || !body.code_challenge) {
      res.status(400).type("text").send("Invalid authorization request.");
      return;
    }
    const fields = {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: body.code_challenge,
      state: body.state ?? "",
      resource: body.resource ?? "",
    };
    const result = await checkCredentials(req, body.username, body.password);
    if (!result.ok) {
      res.status(result.status === 429 ? 429 : 200);
      renderConsent(res, fields, client.client_name || "An MCP client", result.error);
      return;
    }
    const code = randomToken();
    db.prepare(
      "INSERT INTO oauth_codes (code_hash, client_id, code_challenge, redirect_uri, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(sha256(code), client.client_id, fields.code_challenge, redirectUri, SCOPE, fields.resource || null, Date.now() + CODE_TTL_MS);
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (fields.state) target.searchParams.set("state", fields.state);
    res.redirect(302, target.href);
  });

  return router;
}
