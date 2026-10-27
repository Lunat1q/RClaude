import { useEffect, useState, type FormEvent } from "react";
import { api, PERMISSION_MODE_LABELS, type ChatInfo, type PermissionMode, type TerminalInfo } from "../api";
import { navigate } from "../App";
import { DirPicker } from "./DirPicker";

type Mode = "terminal" | "chat" | "shell";

const LAST_DIR_KEY = "rclaude:lastDir";

function readLastDir(): string {
  try {
    return localStorage.getItem(LAST_DIR_KEY) ?? "";
  } catch {
    return "";
  }
}

export function NewSession({ onCreated }: { onCreated: () => void }) {
  const [mode, setMode] = useState<Mode>("terminal");
  const [cwd, setCwd] = useState(readLastDir);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | "">("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [continueLast, setContinueLast] = useState(false);
  const [defaultMode, setDefaultMode] = useState<PermissionMode>("default");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ defaultPermissionMode: PermissionMode }>("/settings").then((s) => setDefaultMode(s.defaultPermissionMode), () => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      localStorage.setItem(LAST_DIR_KEY, cwd);
    } catch {
      /* storage unavailable */
    }
    try {
      if (mode === "chat") {
        const info = await api<ChatInfo>("/chats", { body: { prompt, cwd, permissionMode: permissionMode || undefined, model: model || undefined } });
        onCreated();
        navigate({ view: "session", id: info.sessionId });
      } else {
        const t = await api<TerminalInfo>("/terminals", {
          body: {
            kind: mode === "shell" ? "shell" : "claude",
            cwd,
            continue: mode === "terminal" && continueLast,
            permissionMode: mode === "terminal" ? permissionMode || undefined : undefined,
            model: mode === "terminal" ? model || undefined : undefined,
          },
        });
        onCreated();
        navigate({ view: "terminal", id: t.id });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form className="page narrow" onSubmit={submit}>
      <h1>New session</h1>
      <div className="segmented" role="tablist">
        {(
          [
            ["terminal", "Claude terminal", "Full interactive console"],
            ["chat", "Chat", "Phone-friendly, Agent SDK"],
            ["shell", "Shell", "Bash on the server"],
          ] as const
        ).map(([m, label, sub]) => (
          <button type="button" key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            <strong>{label}</strong>
            <span>{sub}</span>
          </button>
        ))}
      </div>

      <label className="field-label">Working directory</label>
      <DirPicker value={cwd} onChange={setCwd} />

      {mode !== "shell" && (
        <div className="row2">
          <label>
            Permissions
            <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode | "")}>
              <option value="">{mode === "chat" ? `Server default (${defaultMode})` : "Claude Code default"}</option>
              {Object.entries(PERMISSION_MODE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model
            <input placeholder="default (e.g. opus, sonnet)" value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
        </div>
      )}

      {mode === "terminal" && (
        <label className="check">
          <input type="checkbox" checked={continueLast} onChange={(e) => setContinueLast(e.target.checked)} />
          Continue the most recent conversation in this folder
        </label>
      )}

      {mode === "chat" && (
        <label>
          First message
          <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should Claude do?" required />
        </label>
      )}

      {error && <div className="error">{error}</div>}
      <button className="btn primary" disabled={busy || !cwd}>
        {busy ? "Starting…" : "Start"}
      </button>
    </form>
  );
}
