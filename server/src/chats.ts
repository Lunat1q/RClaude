import crypto from "node:crypto";
import fs from "node:fs";
import {
  query,
  getSessionInfo,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { getSetting } from "./db.js";
import { terminals } from "./terminals.js";
import { hostClaudeWrapper, hostMode } from "./host.js";
import { HttpError, resolveDir } from "./workspace.js";

export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];

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
  createdAt: number;
}

export type ChatEvent = { seq: number; at: number } & (
  | { type: "status"; status: ChatStatus }
  | { type: "prompt"; text: string }
  | { type: "sdk"; message: SDKMessage }
  | { type: "text_delta"; text: string; parentToolUseId: string | null }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; id: string; behavior: "allow" | "deny" }
  | { type: "error"; message: string }
);

type EventPayload = ChatEvent extends infer E ? (E extends ChatEvent ? Omit<E, "seq" | "at"> : never) : never;

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
  startedAt: number;
  lastActivityAt: number;
}

/** Async queue of user messages fed to the SDK in streaming-input mode. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(text: string): void {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    };
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.items.push(msg);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

const MAX_EVENTS = 3000;

export class ChatSession {
  status: ChatStatus = "idle";
  seq = 0;
  readonly startedAt = Date.now();
  lastActivityAt = Date.now();
  lastResult: ChatInfo["lastResult"] = null;
  lastError: string | null = null;
  private events: ChatEvent[] = [];
  private readonly listeners = new Set<(e: ChatEvent) => void>();
  private readonly pending = new Map<
    string,
    { request: PermissionRequest; resolve: (r: PermissionResult) => void; suggestions?: PermissionUpdate[] }
  >();
  private readonly queue = new PromptQueue();
  private readonly q: Query;
  private readonly stateWaiters = new Set<() => void>();

  constructor(
    public sessionId: string,
    readonly cwd: string,
    readonly permissionMode: PermissionMode,
    readonly model: string | null,
    resume: boolean,
    private readonly onClosed: (s: ChatSession) => void,
  ) {
    this.q = query({
      prompt: this.queue,
      options: {
        cwd,
        ...(resume ? { resume: sessionId } : { sessionId }),
        permissionMode,
        allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
        canUseTool: (toolName, input, opts) => this.askPermission(toolName, input, opts),
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        ...(model ? { model } : {}),
        ...(hostMode
          ? {
              // Claude runs on the host over SSH; the wrapper cds into the real directory there.
              pathToClaudeCodeExecutable: hostClaudeWrapper,
              cwd: fs.existsSync(cwd) ? cwd : config.dataDir,
              env: { ...process.env, RCLAUDE_REMOTE_CWD: cwd, RCLAUDE_HOST_CLAUDE: config.hostClaude },
            }
          : config.claudeBin.startsWith("/")
            ? { pathToClaudeCodeExecutable: config.claudeBin }
            : {}),
        stderr: (data) => {
          const line = data.trim();
          if (line) console.error(`[chat ${this.sessionId.slice(0, 8)}] ${line}`);
        },
      },
    });
    void this.pump();
  }

  private emit(payload: EventPayload): void {
    const event = { ...payload, seq: ++this.seq, at: Date.now() } as ChatEvent;
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const l of this.listeners) l(event);
  }

  private setStatus(status: ChatStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.lastActivityAt = Date.now();
    this.emit({ type: "status", status });
    for (const w of this.stateWaiters) w();
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q) {
        this.lastActivityAt = Date.now();
        if (msg.type === "stream_event") {
          const ev = msg.event;
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            this.emit({ type: "text_delta", text: ev.delta.text, parentToolUseId: msg.parent_tool_use_id });
          }
          continue;
        }
        if (msg.type === "system" && msg.subtype === "init" && msg.session_id !== this.sessionId) {
          const old = this.sessionId;
          this.sessionId = msg.session_id;
          chats.rekey(old, this);
        }
        this.emit({ type: "sdk", message: msg });
        if (msg.type === "result") {
          this.lastResult = {
            text: msg.subtype === "success" ? msg.result : null,
            isError: msg.is_error,
            costUsd: msg.total_cost_usd ?? null,
            at: Date.now(),
          };
          if (this.pending.size === 0) this.setStatus(msg.is_error ? "error" : "idle");
        }
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", message: this.lastError });
    } finally {
      for (const [id, p] of this.pending) {
        p.resolve({ behavior: "deny", message: "Session closed" });
        this.pending.delete(id);
      }
      this.setStatus("closed");
      this.listeners.clear();
      this.onClosed(this);
    }
  }

  private askPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: Parameters<NonNullable<import("@anthropic-ai/claude-agent-sdk").Options["canUseTool"]>>[2],
  ): Promise<PermissionResult> {
    const request: PermissionRequest = {
      id: opts.toolUseID || crypto.randomUUID(),
      toolName,
      input,
      title: opts.title,
      description: opts.description,
      displayName: opts.displayName,
      decisionReason: opts.decisionReason,
      canAlwaysAllow: !opts.suppressAlwaysAllowRule && !!opts.suggestions?.length,
      createdAt: Date.now(),
    };
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(request.id, { request, resolve, suggestions: opts.suggestions });
      opts.signal.addEventListener("abort", () => {
        if (this.pending.delete(request.id)) {
          resolve({ behavior: "deny", message: "Aborted" });
          this.emit({ type: "permission_resolved", id: request.id, behavior: "deny" });
          if (this.pending.size === 0 && this.status === "waiting_permission") this.setStatus("running");
        }
      });
      this.emit({ type: "permission_request", request });
      this.setStatus("waiting_permission");
    });
  }

  respondPermission(
    id: string,
    decision: { behavior: "allow" | "deny"; message?: string; always?: boolean; updatedInput?: Record<string, unknown> },
  ): void {
    const p = this.pending.get(id);
    if (!p) throw new HttpError(404, "No such pending permission request");
    this.pending.delete(id);
    if (decision.behavior === "allow") {
      p.resolve({
        behavior: "allow",
        updatedInput: decision.updatedInput ?? p.request.input,
        ...(decision.always && p.suggestions ? { updatedPermissions: p.suggestions } : {}),
      });
    } else {
      p.resolve({ behavior: "deny", message: decision.message || "The user denied this action." });
    }
    this.emit({ type: "permission_resolved", id, behavior: decision.behavior });
    if (this.pending.size === 0) this.setStatus("running");
  }

  send(text: string): void {
    if (this.status === "closed") throw new HttpError(409, "Session is closed");
    this.queue.push(text);
    this.emit({ type: "prompt", text });
    this.setStatus("running");
  }

  async interrupt(): Promise<void> {
    if (this.status === "running" || this.status === "waiting_permission") await this.q.interrupt();
  }

  close(): void {
    this.queue.close();
    this.q.close();
  }

  eventsAfter(seq: number): ChatEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }

  subscribe(listener: (e: ChatEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Resolves when the session needs attention (idle, error, closed, permission) or after timeoutMs. */
  waitForAttention(timeoutMs: number): Promise<void> {
    const settled = () => this.status !== "running";
    if (settled()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.stateWaiters.delete(check);
        resolve();
      };
      const check = () => settled() && done();
      const timer = setTimeout(done, timeoutMs);
      this.stateWaiters.add(check);
    });
  }

  info(): ChatInfo {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      status: this.status,
      permissionMode: this.permissionMode,
      model: this.model,
      seq: this.seq,
      pendingPermissions: [...this.pending.values()].map((p) => p.request),
      lastResult: this.lastResult,
      lastError: this.lastError,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
    };
  }
}

export interface StartChatOptions {
  prompt: string;
  cwd?: string;
  permissionMode?: string;
  model?: string;
}

function parseMode(mode: string | undefined): PermissionMode {
  const m = mode || getSetting("default_permission_mode") || "default";
  if (!PERMISSION_MODES.includes(m as PermissionMode)) throw new HttpError(400, `Invalid permission mode: ${m}`);
  return m as PermissionMode;
}

class ChatManager {
  private readonly sessions = new Map<string, ChatSession>();

  constructor() {
    setInterval(() => this.reapIdle(), 60_000).unref();
  }

  private create(sessionId: string, cwd: string, mode: PermissionMode, model: string | null, resume: boolean): ChatSession {
    const s = new ChatSession(sessionId, cwd, mode, model, resume, (closed) => {
      if (this.sessions.get(closed.sessionId) === closed) this.sessions.delete(closed.sessionId);
    });
    this.sessions.set(sessionId, s);
    return s;
  }

  rekey(oldId: string, s: ChatSession): void {
    if (this.sessions.get(oldId) === s) this.sessions.delete(oldId);
    this.sessions.set(s.sessionId, s);
  }

  start(opts: StartChatOptions): ChatSession {
    const cwd = resolveDir(opts.cwd);
    const s = this.create(crypto.randomUUID(), cwd, parseMode(opts.permissionMode), opts.model || null, false);
    s.send(opts.prompt);
    return s;
  }

  /** Sends a prompt to a session, resuming it from disk if it isn't live. */
  async send(sessionId: string, prompt: string, opts: { permissionMode?: string; model?: string } = {}): Promise<ChatSession> {
    let s = this.sessions.get(sessionId);
    if (!s) {
      if (terminals.hasLiveSession(sessionId)) {
        throw new HttpError(409, "This session is open in a running terminal. Close the terminal first or use it there.");
      }
      const info = await getSessionInfo(sessionId);
      if (!info) throw new HttpError(404, "Session not found");
      const cwd = resolveDir(info.cwd ?? undefined);
      s = this.create(sessionId, cwd, parseMode(opts.permissionMode), opts.model || null, true);
    }
    s.send(prompt);
    return s;
  }

  get(sessionId: string): ChatSession | undefined {
    return this.sessions.get(sessionId);
  }

  list(): ChatInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  /** Closes a live chat if it's idle; throws if it's mid-turn. Used before resuming in a terminal. */
  releaseForTerminal(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.status === "running" || s.status === "waiting_permission") {
      throw new HttpError(409, "This session is busy in chat/API mode. Interrupt it first.");
    }
    s.close();
    this.sessions.delete(sessionId);
  }

  close(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.close();
    this.sessions.delete(sessionId);
    return true;
  }

  private reapIdle(): void {
    const cutoff = Date.now() - config.chatIdleMinutes * 60_000;
    for (const s of this.sessions.values()) {
      if ((s.status === "idle" || s.status === "error") && s.listenerCount === 0 && s.lastActivityAt < cutoff) {
        this.close(s.sessionId);
      }
    }
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}

export const chats = new ChatManager();
