import { execFile } from "node:child_process";
import express, { type Request, type Response, type NextFunction, type Router } from "express";
import { deleteSession, getSessionMessages, renameSession } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { getSetting, setSetting } from "./db.js";
import {
  checkCredentials,
  clientIp,
  createApiToken,
  createWebSession,
  deleteApiToken,
  destroyAllWebSessions,
  destroyWebSession,
  isAuthenticated,
  isPasswordSet,
  listApiTokens,
  requireAuth,
  safeEqual,
  setPassword,
  validateNewPassword,
  verifyPassword,
} from "./auth.js";
import { listOAuthClients, revokeAllOAuth, revokeOAuthClient } from "./oauth.js";
import { hasValidSsoToken, ssoEnabled } from "./sso.js";
import { chats, PERMISSION_MODES, type ChatSession } from "./chats.js";
import { terminals, type TerminalKind } from "./terminals.js";
import { getSessionSummary, listSessionSummaries, transcriptText } from "./sessions.js";
import { HttpError, listDirs, makeDir, resolveDir } from "./workspace.js";
import { hostExec, hostMode } from "./host.js";

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;

/** Wraps a handler so thrown HttpErrors become JSON responses. */
const h =
  (fn: Handler) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof HttpError) res.status(err.status).json({ error: err.message });
      else next(err);
    }
  };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function param(req: Request, name: string): string {
  return String(req.params[name]);
}

function requireStr(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new HttpError(400, `${name} is required`);
  return v;
}

function intParam(v: unknown, fallback: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : fallback;
}

function liveChat(id: string): ChatSession {
  const s = chats.get(id);
  if (!s) throw new HttpError(404, "Session is not live (no running chat/API process). Send a message to resume it.");
  return s;
}

/** Optionally waits (up to `wait` seconds, max 600) for the session to need attention. */
async function maybeWait(s: ChatSession, wait: unknown) {
  const secs = intParam(wait, 0, 600);
  if (secs > 0) await s.waitForAttention(secs * 1000);
  return s.info();
}

export function apiRouter(): Router {
  const r = express.Router();
  r.use(express.json({ limit: "2mb" }));

  // --- auth (public) -------------------------------------------------------

  r.get(
    "/auth/state",
    h(async (req, res) => {
      let authenticated = isAuthenticated(req);
      // Behind an SSO proxy, a valid SSO token becomes a normal web session, so the login form never shows
      if (!authenticated && isPasswordSet() && (await hasValidSsoToken(req))) {
        createWebSession(res, req.headers["user-agent"]);
        console.log(`SSO sign-in for ${config.username} from ${clientIp(req)}`);
        authenticated = true;
      }
      return {
        setupRequired: !isPasswordSet(),
        authenticated,
        username: config.username,
        logoutUrl: ssoEnabled ? config.ssoLogoutUrl : undefined,
      };
    }),
  );

  r.post(
    "/auth/setup",
    h(async (req, res) => {
      if (isPasswordSet()) throw new HttpError(409, "Password already set");
      const { setupCode, password } = req.body ?? {};
      if (!config.setupCode) throw new HttpError(503, "RCLAUDE_SETUP_CODE is not configured on the server");
      if (typeof setupCode !== "string" || !safeEqual(setupCode.trim(), config.setupCode)) {
        throw new HttpError(403, "Invalid setup code");
      }
      const err = validateNewPassword(password);
      if (err) throw new HttpError(400, err);
      await setPassword(password);
      createWebSession(res, req.headers["user-agent"]);
      return { ok: true };
    }),
  );

  r.post(
    "/auth/login",
    h(async (req, res) => {
      const result = await checkCredentials(req, req.body?.username, req.body?.password);
      if (!result.ok) throw new HttpError(result.status, result.error);
      createWebSession(res, req.headers["user-agent"]);
      return { ok: true };
    }),
  );

  r.post(
    "/auth/logout",
    h((req, res) => {
      destroyWebSession(req, res);
      return { ok: true };
    }),
  );

  // --- everything below requires auth -------------------------------------

  r.use(requireAuth);

  r.post(
    "/auth/password",
    h(async (req, res) => {
      const { current, next, revokeAll } = req.body ?? {};
      if (typeof current !== "string" || !(await verifyPassword(current))) throw new HttpError(403, "Current password is wrong");
      const err = validateNewPassword(next);
      if (err) throw new HttpError(400, err);
      await setPassword(next);
      destroyAllWebSessions();
      if (revokeAll) revokeAllOAuth();
      createWebSession(res, req.headers["user-agent"]);
      return { ok: true };
    }),
  );

  r.get(
    "/info",
    h(() => ({
      username: config.username,
      workspaceDir: config.workspaceDir,
      publicUrl: config.publicUrl,
      mcpUrl: `${config.publicUrl}/mcp`,
      permissionModes: PERMISSION_MODES,
      host: hostMode ? config.hostSsh : null,
    })),
  );

  r.get(
    "/claude/status",
    h(async () => {
      const { ok, stdout, stderr } = hostMode
        ? await hostExec("/", [config.hostClaude, "auth", "status", "--json"])
        : await new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) =>
            execFile(config.claudeBin, ["auth", "status", "--json"], { timeout: 20_000 }, (err, out, errOut) =>
              resolve({ ok: !err, stdout: String(out), stderr: String(errOut || err?.message || "") }),
            ),
          );
      try {
        return { ok, status: JSON.parse(stdout) };
      } catch {
        return { ok: false, output: (stdout || stderr).slice(0, 2000) };
      }
    }),
  );

  // --- settings ------------------------------------------------------------

  r.get(
    "/settings",
    h(() => ({ defaultPermissionMode: getSetting("default_permission_mode") ?? "default" })),
  );

  r.put(
    "/settings",
    h((req) => {
      const mode = req.body?.defaultPermissionMode;
      if (mode !== undefined) {
        if (!PERMISSION_MODES.includes(mode)) throw new HttpError(400, "Invalid permission mode");
        setSetting("default_permission_mode", mode);
      }
      return { defaultPermissionMode: getSetting("default_permission_mode") ?? "default" };
    }),
  );

  // --- API tokens / OAuth grants ----------------------------------------------

  r.get("/tokens", h(() => listApiTokens()));
  r.post(
    "/tokens",
    h((req) => createApiToken(requireStr(req.body?.name, "name").slice(0, 100))),
  );
  r.delete(
    "/tokens/:id",
    h((req) => {
      if (!deleteApiToken(param(req, "id"))) throw new HttpError(404, "Not found");
      return { ok: true };
    }),
  );
  r.get("/oauth-clients", h(() => listOAuthClients()));
  r.delete(
    "/oauth-clients/:id",
    h((req) => {
      revokeOAuthClient(param(req, "id"));
      return { ok: true };
    }),
  );

  // --- filesystem ------------------------------------------------------------

  r.get("/fs/dirs", h((req) => listDirs(str(req.query.path))));
  r.post(
    "/fs/mkdir",
    h((req) => ({ path: makeDir(str(req.body?.parent), requireStr(req.body?.name, "name")) })),
  );

  // --- session history ---------------------------------------------------------

  r.get(
    "/sessions",
    h((req) =>
      listSessionSummaries({
        limit: intParam(req.query.limit, 50, 500),
        offset: intParam(req.query.offset, 0, 100000),
        cwd: str(req.query.cwd),
      }),
    ),
  );

  r.get(
    "/sessions/:id",
    h(async (req) => {
      const s = await getSessionSummary(param(req, "id"));
      if (!s) throw new HttpError(404, "Session not found");
      return { ...s, chat: chats.get(s.sessionId)?.info() ?? null };
    }),
  );

  r.get(
    "/sessions/:id/messages",
    h((req) =>
      getSessionMessages(param(req, "id"), {
        limit: req.query.limit ? intParam(req.query.limit, 200, 5000) : undefined,
        offset: intParam(req.query.offset, 0, 1_000_000),
      }),
    ),
  );

  r.get(
    "/sessions/:id/transcript",
    h(async (req, res) => {
      res.type("text/plain").send(await transcriptText(param(req, "id"), intParam(req.query.last, 50, 5000)));
    }),
  );

  r.patch(
    "/sessions/:id",
    h(async (req) => {
      await renameSession(param(req, "id"), requireStr(req.body?.title, "title").slice(0, 200));
      return { ok: true };
    }),
  );

  r.delete(
    "/sessions/:id",
    h(async (req) => {
      const id = param(req, "id");
      if (chats.get(id) || terminals.hasLiveSession(id)) throw new HttpError(409, "Session is live; close it first");
      await deleteSession(id);
      return { ok: true };
    }),
  );

  // --- chat / API sessions (Agent SDK) -------------------------------------------

  r.get("/chats", h(() => chats.list()));

  r.post(
    "/chats",
    h(async (req) => {
      const b = req.body ?? {};
      const s = chats.start({
        prompt: requireStr(b.prompt, "prompt"),
        cwd: str(b.cwd),
        permissionMode: str(b.permissionMode),
        model: str(b.model),
      });
      return maybeWait(s, b.wait);
    }),
  );

  r.post(
    "/chats/:id/messages",
    h(async (req) => {
      const b = req.body ?? {};
      const s = await chats.send(param(req, "id"), requireStr(b.prompt, "prompt"), {
        permissionMode: str(b.permissionMode),
        model: str(b.model),
      });
      return maybeWait(s, b.wait);
    }),
  );

  r.get(
    "/chats/:id",
    h((req) => maybeWait(liveChat(param(req, "id")), req.query.wait)),
  );

  r.get(
    "/chats/:id/events",
    h((req, res) => {
      const s = liveChat(param(req, "id"));
      const after = intParam(req.query.after, 0, Number.MAX_SAFE_INTEGER);
      if (req.query.format === "json") return s.eventsAfter(after);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      for (const e of s.eventsAfter(after)) send(e);
      const unsubscribe = s.subscribe((e) => {
        send(e);
        if (e.type === "status" && e.status === "closed") res.end();
      });
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
      return undefined;
    }),
  );

  r.post(
    "/chats/:id/interrupt",
    h(async (req) => {
      await liveChat(param(req, "id")).interrupt();
      return { ok: true };
    }),
  );

  r.post(
    "/chats/:id/permissions/:reqId",
    h((req) => {
      const b = req.body ?? {};
      if (b.behavior !== "allow" && b.behavior !== "deny") throw new HttpError(400, "behavior must be allow or deny");
      liveChat(param(req, "id")).respondPermission(param(req, "reqId"), {
        behavior: b.behavior,
        message: str(b.message),
        always: !!b.always,
        updatedInput: b.updatedInput && typeof b.updatedInput === "object" ? b.updatedInput : undefined,
      });
      return { ok: true };
    }),
  );

  r.delete(
    "/chats/:id",
    h((req) => ({ ok: chats.close(param(req, "id")) })),
  );

  // --- terminals (PTY) -------------------------------------------------------------

  r.get("/terminals", h(() => terminals.list()));

  r.post(
    "/terminals",
    h((req) => {
      const b = req.body ?? {};
      const kind: TerminalKind = b.kind === "shell" ? "shell" : "claude";
      const resume = str(b.resume);
      if (resume) {
        if (terminals.hasLiveSession(resume)) throw new HttpError(409, "This session is already open in a terminal");
        chats.releaseForTerminal(resume);
      }
      if (b.permissionMode !== undefined && b.permissionMode !== "" && !PERMISSION_MODES.includes(b.permissionMode)) {
        throw new HttpError(400, "Invalid permission mode");
      }
      return terminals.create({
        kind,
        cwd: resolveDir(str(b.cwd)),
        resume,
        continueLast: !!b.continue,
        permissionMode: str(b.permissionMode),
        model: str(b.model),
        cols: b.cols ? intParam(b.cols, 120, 1000) : undefined,
        rows: b.rows ? intParam(b.rows, 36, 500) : undefined,
      });
    }),
  );

  r.get(
    "/terminals/:id/output",
    h((req, res) => {
      const t = terminals.get(param(req, "id"));
      if (!t) throw new HttpError(404, "Terminal not found");
      res.type("text/plain").send(t.tail(intParam(req.query.chars, 8000, 2_000_000)));
    }),
  );

  r.post(
    "/terminals/:id/input",
    h((req) => {
      const t = terminals.get(param(req, "id"));
      if (!t) throw new HttpError(404, "Terminal not found");
      t.write(requireStr(req.body?.data, "data"));
      return { ok: true };
    }),
  );

  r.delete(
    "/terminals/:id",
    h((req) => {
      if (!terminals.close(param(req, "id"))) throw new HttpError(404, "Terminal not found");
      return { ok: true };
    }),
  );

  r.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return r;
}
