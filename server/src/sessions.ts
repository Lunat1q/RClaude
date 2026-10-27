import { listSessions, getSessionInfo, getSessionMessages, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { chats, type ChatStatus } from "./chats.js";
import { terminals } from "./terminals.js";

export interface SessionSummary extends SDKSessionInfo {
  /** Live SDK (chat/API) process status, if one is running for this session. */
  chatStatus: ChatStatus | null;
  /** IDs of running terminals attached to this session. */
  terminalIds: string[];
}

function decorate(info: SDKSessionInfo): SessionSummary {
  return {
    ...info,
    chatStatus: chats.get(info.sessionId)?.status ?? null,
    terminalIds: terminals
      .list()
      .filter((t) => !t.exited && t.claudeSessionId === info.sessionId)
      .map((t) => t.id),
  };
}

export async function listSessionSummaries(opts: { limit?: number; offset?: number; cwd?: string }): Promise<SessionSummary[]> {
  const list = await listSessions({ limit: opts.limit ?? 50, offset: opts.offset ?? 0, dir: opts.cwd || undefined });
  return list.map(decorate);
}

export async function getSessionSummary(sessionId: string): Promise<SessionSummary | undefined> {
  const info = await getSessionInfo(sessionId);
  return info ? decorate(info) : undefined;
}

type Block = { type: string; text?: string; name?: string; input?: unknown; content?: unknown; tool_use_id?: string; is_error?: boolean };

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more chars]` : s;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: Block) => (b.type === "text" ? (b.text ?? "") : `[${b.type}]`)).join("\n");
  return "";
}

/** Condensed plain-text transcript, for MCP clients and quick API reads. */
export async function transcriptText(sessionId: string, lastN: number, maxToolChars = 1500): Promise<string> {
  const messages = await getSessionMessages(sessionId);
  const lines: string[] = [];
  for (const m of messages.slice(-lastN)) {
    const msg = m.message as { role?: string; content?: unknown } | undefined;
    if (!msg) continue;
    const role = m.type === "assistant" ? "ASSISTANT" : m.type === "user" ? "USER" : "SYSTEM";
    if (typeof msg.content === "string") {
      lines.push(`${role}: ${msg.content}`);
      continue;
    }
    for (const b of (Array.isArray(msg.content) ? msg.content : []) as Block[]) {
      if (b.type === "text" && b.text) lines.push(`${role}: ${b.text}`);
      else if (b.type === "tool_use") lines.push(`TOOL CALL ${b.name}: ${clip(JSON.stringify(b.input), maxToolChars)}`);
      else if (b.type === "tool_result")
        lines.push(`TOOL RESULT${b.is_error ? " (error)" : ""}: ${clip(blockText(b.content), maxToolChars)}`);
    }
  }
  return lines.join("\n\n");
}
