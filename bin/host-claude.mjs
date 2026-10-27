#!/usr/bin/env node
// Stand-in for the `claude` binary used by the Agent SDK in host mode: runs Claude Code on the
// SSH host (RCLAUDE_HOST_SSH) in the session's directory, relaying stdio and exit status.
import { spawn } from "node:child_process";
import path from "node:path";

const host = process.env.RCLAUDE_HOST_SSH;
const dataDir = process.env.RCLAUDE_DATA_DIR;
if (!host || !dataDir) {
  console.error("host-claude: RCLAUDE_HOST_SSH and RCLAUDE_DATA_DIR must be set");
  process.exit(127);
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const cwd = process.env.RCLAUDE_REMOTE_CWD || process.cwd();

// Forward the variables the SDK sets for the CLI, but not this server's config or anything
// that names a local path, socket or process (meaningless on the host).
const skip = new Set([
  "CLAUDE_CONFIG_DIR", "CLAUDE_BIN", "CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
]);
const env = Object.entries(process.env)
  .filter(([k]) => /^(CLAUDE_|ANTHROPIC_|MCP_|OTEL_|DISABLE_|MAX_THINKING_TOKENS$|DEBUG_CLAUDE)/.test(k) && !skip.has(k))
  .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
  .map(([k, v]) => `${k}=${shq(v)}`)
  .join(" ");

const claude = process.env.RCLAUDE_HOST_CLAUDE || "claude";
const remote = `cd ${shq(cwd)} && exec env ${env} bash -lc ${shq('exec "$0" "$@"')} ${[claude, ...process.argv.slice(2)].map(shq).join(" ")}`;
const sshDir = path.join(dataDir, "ssh");

const child = spawn(
  "ssh",
  [
    "-i", path.join(sshDir, "id_ed25519"),
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${path.join(sshDir, "known_hosts")}`,
    "-o", "ServerAliveInterval=30",
    "-o", "LogLevel=ERROR",
    "-T",
    host,
    remote,
  ],
  { stdio: "inherit" },
);

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
