import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { purgeExpired } from "./db.js";
import { hasValidWebSession, isPasswordSet, SESSION_COOKIE, verifyBearer } from "./auth.js";
import { oauthRouter } from "./oauth.js";
import { apiRouter } from "./api.js";
import { mcpRouter } from "./mcp.js";
import { terminals } from "./terminals.js";
import { chats } from "./chats.js";
import { ensureSshKey } from "./host.js";

const app = express();
app.set("trust proxy", "loopback, linklocal, uniquelocal");
app.disable("x-powered-by");
app.use(cookieParser());
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use(oauthRouter());
app.use(mcpRouter());
app.use("/api", apiRouter());

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
if (fs.existsSync(webDir)) {
  app.use(
    express.static(webDir, {
      index: false,
      setHeaders: (res, file) => {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );
  app.get(/^\/(?!api\/|ws\/|mcp$).*/, (_req, res) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(webDir, "index.html"));
  });
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
});

const server = http.createServer(app);

// --- terminal WebSockets: /ws/terminals/:id ---------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (they still need credentials)
  try {
    const o = new URL(origin);
    return o.origin === new URL(config.publicUrl).origin || o.host === req.headers.host;
  } catch {
    return false;
  }
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = /^\/ws\/terminals\/([\w-]+)$/.exec(url.pathname);
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
  const authed = bearer ? verifyBearer(bearer) : hasValidWebSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  const terminal = match ? terminals.get(match[1]) : undefined;
  if (!match || !authed || !originAllowed(req) || !terminal) {
    socket.write(`HTTP/1.1 ${!authed ? "401 Unauthorized" : "404 Not Found"}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => terminal.attach(ws));
});

ensureSshKey();

setInterval(purgeExpired, 60 * 60 * 1000).unref();

server.listen(config.port, () => {
  console.log(`RClaude listening on :${config.port} (public URL ${config.publicUrl})`);
  console.log(`Workspace: ${config.workspaceDir}  Data: ${config.dataDir}`);
  if (!isPasswordSet()) {
    console.log(
      config.setupCode
        ? "No password set yet: open the web UI and use the setup code from RCLAUDE_SETUP_CODE."
        : "WARNING: no password set and RCLAUDE_SETUP_CODE is empty; set it to enable first-time setup.",
    );
  }
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  chats.closeAll();
  terminals.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
