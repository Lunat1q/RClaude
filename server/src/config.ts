import os from "node:os";
import path from "node:path";

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

const home = os.homedir();
const ssoIssuer = env("RCLAUDE_SSO_ISSUER", "");

export const config = {
  port: Number(env("PORT", "3000")),
  /** Public base URL, used as OAuth issuer and in MCP metadata. */
  publicUrl: env("PUBLIC_URL", "http://localhost:3000").replace(/\/+$/, ""),
  /** The single account name. */
  username: env("RCLAUDE_USERNAME", "admin"),
  /** Required to set the initial password (first login). */
  setupCode: process.env.RCLAUDE_SETUP_CODE ?? "",
  dataDir: env("RCLAUDE_DATA_DIR", path.join(home, ".rclaude")),
  /** Root under which sessions may run and directories may be browsed. */
  workspaceDir: env("RCLAUDE_WORKSPACE_DIR", path.join(home, "workspace")),
  claudeBin: env("CLAUDE_BIN", "claude"),
  /**
   * Run Claude and terminals on another machine over SSH (e.g. "user@172.17.0.1" for the
   * Docker host). Empty = run locally inside this container.
   */
  hostSsh: process.env.RCLAUDE_HOST_SSH ?? "",
  /** Command used for Claude on the SSH host (resolved through a login shell). */
  hostClaude: env("RCLAUDE_HOST_CLAUDE", "claude"),
  shell: env("RCLAUDE_SHELL", process.env.SHELL || "/bin/bash"),
  /** Close idle SDK (chat/API) sessions after this many minutes. */
  chatIdleMinutes: Number(env("RCLAUDE_CHAT_IDLE_MINUTES", "30")),
  /** Terminal scrollback kept in memory for re-attaching clients. */
  terminalBufferBytes: Number(env("RCLAUDE_TERMINAL_BUFFER_BYTES", String(2 * 1024 * 1024))),
  webSessionDays: Number(env("RCLAUDE_WEB_SESSION_DAYS", "30")),
  secureCookies: env("PUBLIC_URL", "").startsWith("https://"),
  /**
   * Single sign-on through a forward-auth proxy (e.g. authentik): the OIDC issuer and client ID whose signed ID token
   * the proxy passes in `ssoHeader`, and the one email allowed to sign in as the account. Disabled unless all three are set.
   */
  ssoIssuer: ssoIssuer ? ssoIssuer.replace(/\/+$/, "") + "/" : "",
  ssoClientId: env("RCLAUDE_SSO_CLIENT_ID", ""),
  ssoEmail: env("RCLAUDE_SSO_EMAIL", "").toLowerCase(),
  ssoHeader: env("RCLAUDE_SSO_HEADER", "x-authentik-jwt").toLowerCase(),
  /** Where logout sends the browser so the SSO session ends too (authentik's forward-auth sign-out by default). */
  ssoLogoutUrl: env("RCLAUDE_SSO_LOGOUT_URL", "/outpost.goauthentik.io/sign_out"),
};
