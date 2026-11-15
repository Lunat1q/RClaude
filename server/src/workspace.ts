import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { hostExecSync, hostMode } from "./host.js";

try {
  fs.mkdirSync(config.workspaceDir, { recursive: true });
} catch {
  /* may live only on the SSH host */
}

function existsLocally(dir: string): fs.Stats | null {
  try {
    return fs.statSync(dir);
  } catch {
    return null;
  }
}

/**
 * Resolves a user-supplied directory (absolute, or relative to the workspace root) and
 * checks that it exists. In host mode, paths not mounted into this container are checked
 * on the host. Sessions may run anywhere the user can read; the workspace root is only the default.
 */
export function resolveDir(input: string | undefined | null): string {
  const raw = (input ?? "").trim();
  const dir = raw === "" ? config.workspaceDir : path.resolve(config.workspaceDir, raw);
  const stat = existsLocally(dir);
  if (stat) {
    if (!stat.isDirectory()) throw new HttpError(400, `Not a directory: ${dir}`);
    return dir;
  }
  if (hostMode) {
    try {
      hostExecSync("/", ["test", "-d", dir]);
      return dir;
    } catch {
      /* fall through */
    }
  }
  throw new HttpError(400, `Directory does not exist: ${dir}`);
}

export function listDirs(input: string | undefined | null): { path: string; parent: string | null; dirs: string[] } {
  const dir = resolveDir(input);
  let dirs: string[];
  if (existsLocally(dir)) {
    dirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } else {
    const out = hostExecSync(dir, ["find", ".", "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-not", "-name", ".*", "-printf", "%f\\n"]);
    dirs = out.split("\n").filter(Boolean);
  }
  dirs.sort((a, b) => a.localeCompare(b));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, dirs };
}

export function makeDir(parent: string | undefined | null, name: string): string {
  if (!/^[\w.@+-][\w .@+-]*$/.test(name) || name === "." || name === "..") throw new HttpError(400, "Invalid folder name");
  const base = resolveDir(parent);
  const dir = path.join(base, name);
  if (existsLocally(base)) fs.mkdirSync(dir, { recursive: false });
  else hostExecSync(base, ["mkdir", "--", name]);
  return dir;
}

/**
 * Saves an uploaded file as `<dir>/<folder>/<name>` (folder is relative, created if missing; "" = dir itself).
 * Never overwrites an existing file. Returns the absolute path.
 */
export function saveUpload(dir: string | undefined | null, folder: string, name: string, data: Buffer): string {
  const base = resolveDir(dir);
  const sub = folder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (sub.split("/").some((p) => (p === "" ? sub !== "" : p === "." || p === ".." || !/^[\w.@+ -]+$/.test(p)))) {
    throw new HttpError(400, "Invalid folder");
  }
  const file = path.basename(name.replace(/\\/g, "/")).replace(/[^\w.@+ ()-]/g, "_").replace(/^\.+/, "");
  if (!file) throw new HttpError(400, "Invalid file name");
  const target = path.join(base, sub, file);
  if (existsLocally(base)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(target, data, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, `File already exists: ${target}`);
      throw e;
    }
  } else {
    try {
      hostExecSync(base, ["sh", "-c", 'mkdir -p -- "$1" && set -C && cat > "$1/$2"', "sh", sub || ".", file], 120_000, data);
    } catch {
      throw new HttpError(409, `Could not write ${target} (already exists?)`);
    }
  }
  return target;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
