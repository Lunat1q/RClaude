export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Behind an access proxy (authentik forward-auth, Cloudflare Access) an expired session answers with a cross-site
 * redirect to its login page, which fetch reports as a network error. Reload so the browser follows it; the guard
 * prevents a reload loop when actually offline.
 */
function reloadForLoginRedirect(): void {
  const last = Number(sessionStorage.getItem("rclaude:authReloadAt") || 0);
  if (Date.now() - last < 30_000) return;
  sessionStorage.setItem("rclaude:authReloadAt", String(Date.now()));
  window.location.reload();
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
    });
  } catch (err) {
    reloadForLoginRedirect();
    throw err;
  }
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("rclaude:unauthorized"));
    throw new ApiError(res.status, (data && typeof data === "object" && "error" in data ? String(data.error) : String(data)) || res.statusText);
  }
  return data as T;
}

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk" | "auto";

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: "Ask before tools (default)",
  acceptEdits: "Auto-accept file edits",
  plan: "Plan only (no changes)",
  bypassPermissions: "Bypass all permissions",
  dontAsk: "Deny anything not pre-approved",
  auto: "Auto (classifier decides)",
};

export interface SessionSummary {
  sessionId: string;
  summary: string;
  lastModified: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  createdAt?: number;
  chatStatus: ChatStatus | null;
  terminalIds: string[];
}

export type ChatStatus = "running" | "waiting_permission" | "idle" | "error" | "closed";

export interface PermissionRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  displayName?: string;
  decisionReason?: string;
  canAlwaysAllow: boolean;
}

export interface ChatInfo {
  sessionId: string;
  cwd: string;
  status: ChatStatus;
  permissionMode: PermissionMode;
  model: string | null;
  seq: number;
  pendingPermissions: PermissionRequest[];
  lastResult: { text: string | null; isError: boolean; costUsd: number | null; at: number } | null;
  lastError: string | null;
}

export interface TerminalInfo {
  id: string;
  kind: "claude" | "shell";
  title: string;
  cwd: string;
  claudeSessionId: string | null;
  createdAt: number;
  lastActivityAt: number;
  exited: boolean;
  exitCode: number | null;
  clients: number;
}

/** Raw transcript entry (GET /sessions/:id/messages) or live SDK user/assistant message. */
export interface RawMessage {
  type: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  message?: { role?: string; content?: unknown };
  [k: string]: unknown;
}

export type ChatEvent = { seq: number; at: number } & (
  | { type: "status"; status: ChatStatus }
  | { type: "prompt"; text: string }
  | { type: "sdk"; message: RawMessage }
  | { type: "text_delta"; text: string; parentToolUseId: string | null }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; id: string; behavior: "allow" | "deny" }
  | { type: "error"; message: string }
);

export function shortPath(p: string | undefined | null): string {
  if (!p) return "";
  return p.replace(/^\/home\/[^/]+/, "~");
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}
