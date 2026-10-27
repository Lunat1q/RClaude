import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

/**
 * Host execution over SSH. When RCLAUDE_HOST_SSH is set, terminals and Claude processes
 * run on that machine as the SSH user (a real login session: their PATH, groups, Claude
 * login and settings), while this server only relays I/O.
 */

export const hostMode = config.hostSsh !== "";

const sshDir = path.join(config.dataDir, "ssh");
export const sshKeyPath = path.join(sshDir, "id_ed25519");
const knownHosts = path.join(sshDir, "known_hosts");

/** Path of the wrapper the Agent SDK spawns instead of the claude binary. */
export const hostClaudeWrapper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/host-claude.mjs");

export function ensureSshKey(): void {
  if (!hostMode) return;
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(sshKeyPath)) {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "rclaude-container", "-f", sshKeyPath]);
  }
  console.log(`Host mode: ${config.hostSsh}. Public key (add to the host's authorized_keys):`);
  console.log(fs.readFileSync(`${sshKeyPath}.pub`, "utf8").trim());
}

export function sshArgs(tty: boolean): string[] {
  return [
    "-i", sshKeyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "ServerAliveInterval=30",
    "-o", "LogLevel=ERROR",
    tty ? "-tt" : "-T",
    config.hostSsh,
  ];
}

/** POSIX single-quote escaping for the remote shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Remote command line: cd into `cwd`, then exec `argv` through a login shell so the
 * user's profile (PATH etc.) applies. `env` entries are exported first.
 */
export function remoteCommand(cwd: string, argv: string[], env: Record<string, string> = {}): string {
  const envPart = Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${shq(v)}`)
    .join(" ");
  return `cd ${shq(cwd)} && exec env ${envPart} bash -lc ${shq('exec "$0" "$@"')} ${argv.map(shq).join(" ")}`;
}

/** Runs a short command on the host and returns stdout (throws on non-zero exit). */
export function hostExecSync(cwd: string, argv: string[], timeoutMs = 15_000): string {
  return execFileSync("ssh", [...sshArgs(false), remoteCommand(cwd, argv)], { timeout: timeoutMs, encoding: "utf8" });
}

export function hostExec(cwd: string, argv: string[], timeoutMs = 20_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("ssh", [...sshArgs(false), remoteCommand(cwd, argv)], { timeout: timeoutMs }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err ? err.message : "")) }),
    );
  });
}
