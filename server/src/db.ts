import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

export const db = new DatabaseSync(path.join(config.dataDir, "rclaude.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS web_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    info TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function purgeExpired(): void {
  const now = Date.now();
  db.prepare("DELETE FROM web_sessions WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(now);
}
