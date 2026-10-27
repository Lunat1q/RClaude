import express, { type Router } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearer } from "./auth.js";
import { chats, PERMISSION_MODES, type ChatInfo } from "./chats.js";
import { terminals } from "./terminals.js";
import { listSessionSummaries, getSessionSummary, transcriptText } from "./sessions.js";
import { HttpError, listDirs } from "./workspace.js";

const DEFAULT_WAIT = 50;
const MAX_WAIT = 300;

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

/** Shape returned after start/send/wait: what an MCP client needs to decide its next call. */
function summarize(info: ChatInfo) {
  const done = info.status === "idle" || info.status === "error" || info.status === "closed";
  return {
    session_id: info.sessionId,
    status: info.status,
    cwd: info.cwd,
    permission_mode: info.permissionMode,
    pending_permissions: info.pendingPermissions.map((p) => ({
      request_id: p.id,
      tool: p.toolName,
      title: p.title ?? null,
      input: p.input,
    })),
    result: done ? (info.lastResult?.text ?? null) : null,
    result_is_error: done ? (info.lastResult?.isError ?? null) : null,
    error: info.lastError,
    hint:
      info.status === "running"
        ? "Still working. Call wait_for_session to keep waiting."
        : info.status === "waiting_permission"
          ? "Blocked on a permission request. Call respond_permission."
          : "Turn finished. Call send_message to continue the conversation.",
  };
}

const waitSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT)
  .optional()
  .describe(`Seconds to wait for the turn to finish before returning (default ${DEFAULT_WAIT}, max ${MAX_WAIT}).`);

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "rclaude", version: "1.0.0" },
    {
      instructions:
        "Remote Claude Code. Each session is a Claude Code conversation running on the RClaude server with full tool access " +
        "(files, shell) in its working directory. Start with start_session, then use send_message to continue. Long turns " +
        "return status 'running': call wait_for_session until it is 'idle'. If status is 'waiting_permission', call " +
        "respond_permission. Use list_sessions to find earlier conversations; send_message resumes any of them.",
    },
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List sessions",
      description: "List Claude Code sessions (most recent first) with title, working directory and live status.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Max sessions (default 20)."),
        cwd: z.string().optional().describe("Only sessions for this project directory."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, cwd }) => {
      try {
        const list = await listSessionSummaries({ limit: limit ?? 20, cwd });
        return text(
          list.map((s) => ({
            session_id: s.sessionId,
            title: s.customTitle || s.summary,
            cwd: s.cwd ?? null,
            last_modified: new Date(s.lastModified).toISOString(),
            live_chat_status: s.chatStatus,
            open_in_terminal: s.terminalIds.length > 0,
          })),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "start_session",
    {
      title: "Start session",
      description: "Start a new Claude Code session with a first prompt. Waits for the turn to finish (up to wait_seconds).",
      inputSchema: {
        prompt: z.string().min(1).describe("The task or message for Claude Code."),
        cwd: z.string().optional().describe("Working directory: absolute, or relative to the workspace root. Default: workspace root."),
        permission_mode: z
          .enum(PERMISSION_MODES as [string, ...string[]])
          .optional()
          .describe("Tool permission mode. Default: the server setting (usually 'default', which asks via respond_permission)."),
        model: z.string().optional().describe("Model alias or ID (e.g. 'opus', 'sonnet'). Default: Claude Code default."),
        wait_seconds: waitSchema,
      },
    },
    async ({ prompt, cwd, permission_mode, model, wait_seconds }) => {
      try {
        const s = chats.start({ prompt, cwd, permissionMode: permission_mode, model });
        await s.waitForAttention((wait_seconds ?? DEFAULT_WAIT) * 1000);
        return text(summarize(s.info()));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description:
        "Send a follow-up message to a session (resumes it if it isn't running). Waits for the turn to finish (up to wait_seconds).",
      inputSchema: {
        session_id: z.string().describe("Session ID from start_session or list_sessions."),
        prompt: z.string().min(1),
        permission_mode: z
          .enum(PERMISSION_MODES as [string, ...string[]])
          .optional()
          .describe("Only used when the session has to be resumed."),
        wait_seconds: waitSchema,
      },
    },
    async ({ session_id, prompt, permission_mode, wait_seconds }) => {
      try {
        const s = await chats.send(session_id, prompt, { permissionMode: permission_mode });
        await s.waitForAttention((wait_seconds ?? DEFAULT_WAIT) * 1000);
        return text(summarize(s.info()));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "wait_for_session",
    {
      title: "Wait for session",
      description: "Wait for a running session's turn to finish or need a permission decision, then return its status and result.",
      inputSchema: { session_id: z.string(), wait_seconds: waitSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ session_id, wait_seconds }) => {
      try {
        const s = chats.get(session_id);
        if (!s) {
          const info = await getSessionSummary(session_id);
          if (!info) throw new HttpError(404, "Session not found");
          return text({ session_id, status: "not_running", hint: "Not running. Use send_message to continue it." });
        }
        await s.waitForAttention((wait_seconds ?? DEFAULT_WAIT) * 1000);
        return text(summarize(s.info()));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_transcript",
    {
      title: "Get transcript",
      description: "Read the conversation of a session as condensed text (user/assistant messages, tool calls and results).",
      inputSchema: {
        session_id: z.string(),
        last_n: z.number().int().min(1).max(1000).optional().describe("Number of most recent messages (default 30)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ session_id, last_n }) => {
      try {
        const t = await transcriptText(session_id, last_n ?? 30);
        return text(t || "(empty transcript)");
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "respond_permission",
    {
      title: "Respond to permission request",
      description:
        "Allow or deny a pending tool permission request of a session. For AskUserQuestion requests, pass answers keyed by question text.",
      inputSchema: {
        session_id: z.string(),
        request_id: z.string(),
        decision: z.enum(["allow", "deny"]),
        message: z.string().optional().describe("Reason shown to Claude when denying."),
        always: z.boolean().optional().describe("Also allow similar calls for the rest of the session."),
        answers: z.record(z.string(), z.string()).optional().describe("AskUserQuestion answers: { question text: chosen label }."),
        wait_seconds: waitSchema,
      },
    },
    async ({ session_id, request_id, decision, message, always, answers, wait_seconds }) => {
      try {
        const s = chats.get(session_id);
        if (!s) throw new HttpError(404, "Session is not running");
        const pending = s.info().pendingPermissions.find((p) => p.id === request_id);
        s.respondPermission(request_id, {
          behavior: decision,
          message,
          always,
          updatedInput: answers && pending ? { ...pending.input, answers } : undefined,
        });
        await s.waitForAttention((wait_seconds ?? DEFAULT_WAIT) * 1000);
        return text(summarize(s.info()));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "interrupt_session",
    {
      title: "Interrupt session",
      description: "Interrupt the current turn of a running session.",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => {
      try {
        const s = chats.get(session_id);
        if (!s) throw new HttpError(404, "Session is not running");
        await s.interrupt();
        return text({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_directories",
    {
      title: "List directories",
      description: "List subdirectories on the server (to choose a working directory). Relative paths resolve against the workspace root.",
      inputSchema: { path: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      try {
        return text(listDirs(path));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_terminals",
    {
      title: "List terminals",
      description: "List interactive terminals open in the web UI.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(terminals.list()),
  );

  return server;
}

export function mcpRouter(): Router {
  const r = express.Router();
  // Stateless Streamable HTTP: a fresh server+transport per request; session state lives in the managers.
  r.post("/mcp", requireBearer, express.json({ limit: "4mb" }), async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP error", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  const notAllowed = (_req: express.Request, res: express.Response) =>
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  r.get("/mcp", requireBearer, notAllowed);
  r.delete("/mcp", requireBearer, notAllowed);
  return r;
}
