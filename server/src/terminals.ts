import crypto from "node:crypto";
import * as pty from "node-pty";
import type { WebSocket } from "ws";
import { config } from "./config.js";
import { hostMode, remoteCommand, sshArgs } from "./host.js";

export type TerminalKind = "claude" | "shell";

export interface CreateTerminalOptions {
  kind: TerminalKind;
  cwd: string;
  /** Resume this Claude session ID (claude kind only). */
  resume?: string;
  /** Continue the most recent session in cwd (claude kind only). */
  continueLast?: boolean;
  permissionMode?: string;
  model?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalInfo {
  id: string;
  kind: TerminalKind;
  title: string;
  cwd: string;
  claudeSessionId: string | null;
  createdAt: number;
  lastActivityAt: number;
  exited: boolean;
  exitCode: number | null;
  clients: number;
}

type ServerMessage =
  | { type: "output"; data: string }
  | { type: "replay"; data: string }
  | { type: "exit"; code: number | null }
  | { type: "info"; terminal: TerminalInfo };

class Terminal {
  readonly id = crypto.randomUUID();
  readonly createdAt = Date.now();
  lastActivityAt = Date.now();
  exited = false;
  exitCode: number | null = null;
  private chunks: string[] = [];
  private bufferedBytes = 0;
  private readonly clients = new Set<WebSocket>();
  private readonly proc: pty.IPty;

  constructor(
    readonly kind: TerminalKind,
    readonly cwd: string,
    localCwd: string,
    readonly claudeSessionId: string | null,
    readonly title: string,
    file: string,
    args: string[],
    cols: number,
    rows: number,
    private readonly onExit: (t: Terminal) => void,
  ) {
    this.proc = pty.spawn(file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: localCwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
    });
    this.proc.onData((data) => {
      this.lastActivityAt = Date.now();
      this.append(data);
      this.broadcast({ type: "output", data });
    });
    this.proc.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.broadcast({ type: "exit", code: exitCode });
      this.onExit(this);
    });
  }

  private append(data: string): void {
    this.chunks.push(data);
    this.bufferedBytes += data.length;
    while (this.bufferedBytes > config.terminalBufferBytes && this.chunks.length > 1) {
      this.bufferedBytes -= this.chunks.shift()!.length;
    }
  }

  private broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(payload);
  }

  info(): TerminalInfo {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      cwd: this.cwd,
      claudeSessionId: this.claudeSessionId,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      exited: this.exited,
      exitCode: this.exitCode,
      clients: this.clients.size,
    };
  }

  attach(ws: WebSocket): void {
    this.clients.add(ws);
    ws.send(JSON.stringify({ type: "info", terminal: this.info() } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: "replay", data: this.chunks.join("") } satisfies ServerMessage));
    if (this.exited) ws.send(JSON.stringify({ type: "exit", code: this.exitCode } satisfies ServerMessage));
    ws.on("message", (raw) => {
      let msg: { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (this.exited) return;
      if (msg.type === "input" && typeof msg.data === "string") this.write(msg.data);
      else if (msg.type === "resize") this.resize(Number(msg.cols), Number(msg.rows));
    });
    ws.on("close", () => this.clients.delete(ws));
  }

  write(data: string): void {
    if (!this.exited) {
      this.lastActivityAt = Date.now();
      this.proc.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (this.exited || !Number.isInteger(cols) || !Number.isInteger(rows)) return;
    if (cols < 2 || rows < 2 || cols > 1000 || rows > 500) return;
    this.proc.resize(cols, rows);
  }

  /** Plain-text tail of the output with ANSI escapes stripped (for API/MCP reads). */
  tail(maxChars: number): string {
    const text = this.chunks
      .join("")
      // TUIs draw spaces as cursor-forward moves; keep them as spaces.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[(\d*)C/g, (_m, n: string) => " ".repeat(Math.min(Number(n || 1), 500)))
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g, "")
      .replace(/\r(?!\n)/g, "\n");
    return text.slice(-maxChars);
  }

  kill(): void {
    if (!this.exited) this.proc.kill();
    for (const ws of this.clients) ws.close(1000, "terminal closed");
    this.clients.clear();
  }
}

class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();

  create(opts: CreateTerminalOptions): TerminalInfo {
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 36;
    let file: string;
    let args: string[];
    let claudeSessionId: string | null = null;
    let title: string;
    if (opts.kind === "shell") {
      file = hostMode ? "bash" : config.shell;
      args = ["-l"];
      title = "Shell";
    } else {
      file = hostMode ? config.hostClaude : config.claudeBin;
      args = [];
      if (opts.resume) {
        claudeSessionId = opts.resume;
        args.push("--resume", opts.resume);
        title = "Claude (resumed)";
      } else if (opts.continueLast) {
        args.push("--continue");
        title = "Claude (continued)";
      } else {
        claudeSessionId = crypto.randomUUID();
        args.push("--session-id", claudeSessionId);
        title = "Claude";
      }
      if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
      if (opts.model) args.push("--model", opts.model);
    }
    let localCwd = opts.cwd;
    if (hostMode) {
      // Run on the host: ssh with a TTY, the command executed through the user's login shell.
      args = [...sshArgs(true), remoteCommand(opts.cwd, [file, ...args], { COLORTERM: "truecolor" })];
      file = "ssh";
      localCwd = config.dataDir;
    }
    const t = new Terminal(opts.kind, opts.cwd, localCwd, claudeSessionId, title, file, args, cols, rows, () => {});
    this.terminals.set(t.id, t);
    return t.info();
  }

  get(id: string): Terminal | undefined {
    return this.terminals.get(id);
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((t) => t.info()).sort((a, b) => b.createdAt - a.createdAt);
  }

  close(id: string): boolean {
    const t = this.terminals.get(id);
    if (!t) return false;
    t.kill();
    this.terminals.delete(id);
    return true;
  }

  /** True if a running terminal is attached to this Claude session. */
  hasLiveSession(sessionId: string): boolean {
    for (const t of this.terminals.values()) if (!t.exited && t.claudeSessionId === sessionId) return true;
    return false;
  }

  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }
}

export const terminals = new TerminalManager();
