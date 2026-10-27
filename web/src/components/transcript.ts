import type { RawMessage } from "../api";

export type Entry =
  | { kind: "raw"; msg: RawMessage }
  | { kind: "prompt"; text: string; key: string }
  | { kind: "error"; text: string; key: string };

export type Block =
  | { kind: "user"; key: string; text: string; meta: boolean }
  | { kind: "assistant"; key: string; text: string }
  | { kind: "tool"; key: string; id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean; done: boolean }
  | { kind: "result"; key: string; isError: boolean; text: string | null; costUsd?: number; durationMs?: number; subtype: string }
  | { kind: "error"; key: string; text: string };

type ContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((b: ContentBlock) => (b.type === "text" ? (b.text ?? "") : `[${b.type}]`)).join("\n");
  return "";
}

const META_RE = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr)/;

/** Turns transcript entries + live SDK messages into display blocks, pairing tool calls with results. */
export function buildBlocks(entries: Entry[]): Block[] {
  const blocks: Block[] = [];
  const tools = new Map<string, Extract<Block, { kind: "tool" }>>();

  entries.forEach((e, i) => {
    if (e.kind === "prompt") {
      blocks.push({ kind: "user", key: e.key, text: e.text, meta: false });
      return;
    }
    if (e.kind === "error") {
      blocks.push({ kind: "error", key: e.key, text: e.text });
      return;
    }
    const m = e.msg;
    const key = m.uuid ?? `m${i}`;
    if (m.parent_tool_use_id) return; // subagent internals
    if (m.type === "result") {
      blocks.push({
        kind: "result",
        key,
        isError: Boolean(m.is_error),
        text: typeof m.result === "string" ? m.result : null,
        costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined,
        durationMs: typeof m.duration_ms === "number" ? m.duration_ms : undefined,
        subtype: String(m.subtype ?? ""),
      });
      return;
    }
    if (m.type !== "user" && m.type !== "assistant") return;
    const content = m.message?.content;
    if (typeof content === "string") {
      if (m.type === "user") blocks.push({ kind: "user", key, text: content, meta: META_RE.test(content) });
      else blocks.push({ kind: "assistant", key, text: content });
      return;
    }
    if (!Array.isArray(content)) return;
    (content as ContentBlock[]).forEach((b, j) => {
      const bkey = `${key}:${j}`;
      if (b.type === "text" && b.text) {
        if (m.type === "user") blocks.push({ kind: "user", key: bkey, text: b.text, meta: META_RE.test(b.text) });
        else blocks.push({ kind: "assistant", key: bkey, text: b.text });
      } else if (b.type === "tool_use" && b.id) {
        const t: Extract<Block, { kind: "tool" }> = { kind: "tool", key: bkey, id: b.id, name: b.name ?? "tool", input: b.input ?? {}, done: false };
        tools.set(b.id, t);
        blocks.push(t);
      } else if (b.type === "tool_result" && b.tool_use_id) {
        const t = tools.get(b.tool_use_id);
        if (t) {
          t.result = resultText(b.content);
          t.isError = !!b.is_error;
          t.done = true;
        }
      }
    });
  });
  return blocks;
}

/** One-line summary of a tool call's input. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "Bash":
      return s("command");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return s("file_path") || s("notebook_path");
    case "Glob":
    case "Grep":
      return s("pattern") + (s("path") ? `  in ${s("path")}` : "");
    case "WebFetch":
      return s("url");
    case "WebSearch":
      return s("query");
    case "Task":
    case "Agent":
      return s("description");
    case "TodoWrite":
      return "update todo list";
    default: {
      const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
      return first ?? "";
    }
  }
}
