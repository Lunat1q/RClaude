import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { db, getSetting, setSetting, sha256, randomToken } from "./db.js";

export const SESSION_COOKIE = "rclaude_session";
export const API_TOKEN_PREFIX = "rck_";
export const OAUTH_ACCESS_PREFIX = "rco_";

// ---------------------------------------------------------------------------
// Password (scrypt)

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export function isPasswordSet(): boolean {
  return getSetting("password_hash") !== undefined;
}

export async function setPassword(password: string): Promise<void> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  setSetting("password_hash", `scrypt$${salt.toString("base64")}$${key.toString("base64")}`);
}

export async function verifyPassword(password: string): Promise<boolean> {
  const stored = getSetting("password_hash");
  if (!stored) return false;
  const [, saltB64, keyB64] = stored.split("$");
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"));
  return crypto.timingSafeEqual(expected, actual);
}

export function validateNewPassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 12) return "Password must be at least 12 characters.";
  if (password.length > 512) return "Password is too long.";
  return null;
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// Brute-force protection: per-IP exponential lockout plus a global ceiling.

const perIp = new Map<string, { fails: number; lockedUntil: number }>();
let globalFails: number[] = [];
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_MAX_FAILS = 30;

export function clientIp(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  return req.ip ?? "unknown";
}

/** Returns milliseconds to wait, or 0 if an attempt is allowed. */
export function loginBlockedFor(ip: string): number {
  const now = Date.now();
  globalFails = globalFails.filter((t) => now - t < GLOBAL_WINDOW_MS);
  const entry = perIp.get(ip);
  const ipWait = entry && entry.lockedUntil > now ? entry.lockedUntil - now : 0;
  // Over the global ceiling, allow at most one attempt per minute overall.
  const globalWait =
    globalFails.length >= GLOBAL_MAX_FAILS ? Math.max(0, globalFails[globalFails.length - 1] + 60_000 - now) : 0;
  return Math.max(ipWait, globalWait);
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  globalFails.push(now);
  const entry = perIp.get(ip) ?? { fails: 0, lockedUntil: 0 };
  entry.fails += 1;
  if (entry.fails >= 5) entry.lockedUntil = now + Math.min(2 ** (entry.fails - 5) * 30_000, 60 * 60 * 1000);
  perIp.set(ip, entry);
}

export function recordLoginSuccess(ip: string): void {
  perIp.delete(ip);
}

/** Checks credentials with rate limiting; used by the web login and the OAuth consent page. */
export async function checkCredentials(
  req: Request,
  username: unknown,
  password: unknown,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const ip = clientIp(req);
  const wait = loginBlockedFor(ip);
  if (wait > 0) return { ok: false, status: 429, error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` };
  if (!isPasswordSet()) return { ok: false, status: 409, error: "Password not set yet." };
  const valid =
    typeof username === "string" &&
    typeof password === "string" &&
    // Always run scrypt so timing doesn't reveal whether the username matched.
    (await verifyPassword(password)) &&
    safeEqual(username, config.username);
  if (!valid) {
    recordLoginFailure(ip);
    return { ok: false, status: 401, error: "Invalid username or password." };
  }
  recordLoginSuccess(ip);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Web sessions (cookie)

export function createWebSession(res: Response, userAgent: string | undefined): void {
  const token = randomToken();
  const now = Date.now();
  const expires = now + config.webSessionDays * 86400_000;
  db.prepare("INSERT INTO web_sessions (token_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)").run(
    sha256(token),
    now,
    expires,
    userAgent?.slice(0, 300) ?? null,
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "strict",
    expires: new Date(expires),
    path: "/",
  });
}

export function destroyWebSession(req: Request, res: Response): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string") db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(sha256(token));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function destroyAllWebSessions(): void {
  db.prepare("DELETE FROM web_sessions").run();
}

export function hasValidWebSession(cookieToken: unknown): boolean {
  if (typeof cookieToken !== "string" || !cookieToken) return false;
  const row = db.prepare("SELECT expires_at FROM web_sessions WHERE token_hash = ?").get(sha256(cookieToken)) as
    | { expires_at: number }
    | undefined;
  return !!row && row.expires_at > Date.now();
}

// ---------------------------------------------------------------------------
// API tokens (long-lived bearer tokens created in the UI)

export function createApiToken(name: string): { id: string; token: string } {
  const id = crypto.randomUUID();
  const token = API_TOKEN_PREFIX + randomToken();
  db.prepare("INSERT INTO api_tokens (id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    name,
    sha256(token),
    token.slice(0, 10),
    Date.now(),
  );
  return { id, token };
}

export function listApiTokens() {
  return db.prepare("SELECT id, name, prefix, created_at, last_used_at FROM api_tokens ORDER BY created_at DESC").all();
}

export function deleteApiToken(id: string): boolean {
  return db.prepare("DELETE FROM api_tokens WHERE id = ?").run(id).changes > 0;
}

function verifyApiToken(token: string): boolean {
  const hash = sha256(token);
  const row = db.prepare("SELECT id FROM api_tokens WHERE token_hash = ?").get(hash) as { id: string } | undefined;
  if (!row) return false;
  db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return true;
}

function verifyOAuthAccessToken(token: string): boolean {
  const row = db
    .prepare("SELECT expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'")
    .get(sha256(token)) as { expires_at: number } | undefined;
  return !!row && row.expires_at > Date.now();
}

export function verifyBearer(token: string): boolean {
  if (token.startsWith(API_TOKEN_PREFIX)) return verifyApiToken(token);
  if (token.startsWith(OAUTH_ACCESS_PREFIX)) return verifyOAuthAccessToken(token);
  return false;
}

function bearerFrom(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1]?.trim();
}

export function isAuthenticated(req: Request): boolean {
  const bearer = bearerFrom(req);
  if (bearer) return verifyBearer(bearer);
  return hasValidWebSession(req.cookies?.[SESSION_COOKIE]);
}

/** Cookie session or bearer token (API token / OAuth access token). */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: "Unauthorized" });
}

/** Bearer only; on failure points MCP clients to OAuth discovery. */
export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const bearer = bearerFrom(req);
  if (bearer && verifyBearer(bearer)) return next();
  res.setHeader(
    "WWW-Authenticate",
    `Bearer error="invalid_token", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`,
  );
  res.status(401).json({ error: "invalid_token", error_description: "Missing or invalid bearer token" });
}
