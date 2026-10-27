import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { api, shortPath, type TerminalInfo } from "../api";
import { navigate } from "../App";

const KEYS: [string, string][] = [
  ["Esc", "\x1b"],
  ["Tab", "\t"],
  ["⇧Tab", "\x1b[Z"],
  ["^C", "\x03"],
  ["↑", "\x1b[A"],
  ["↓", "\x1b[B"],
  ["←", "\x1b[D"],
  ["→", "\x1b[C"],
  ["⏎", "\r"],
  ["^D", "\x04"],
  ["^L", "\x0c"],
];

export function TerminalView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [state, setState] = useState<"connecting" | "open" | "closed" | "gone">("connecting");
  const [compose, setCompose] = useState("");

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: window.innerWidth < 600 ? 12 : 14,
      scrollback: 10000,
      allowProposedApi: true,
      theme: { background: "#1a1918", foreground: "#e8e6e1", cursor: "#d97757", selectionBackground: "#5a4a40" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current!);
    termRef.current = term;

    let disposed = false;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const send = (msg: object) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const doFit = () => {
      try {
        fit.fit();
        send({ type: "resize", cols: term.cols, rows: term.rows });
      } catch {
        /* not visible yet */
      }
    };

    const connect = () => {
      setState("connecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws/terminals/${id}`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setState("open");
        doFit();
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "output") term.write(msg.data);
        else if (msg.type === "replay") {
          term.reset();
          term.write(msg.data);
        } else if (msg.type === "info") setInfo(msg.terminal);
        else if (msg.type === "exit") {
          setInfo((i) => (i ? { ...i, exited: true, exitCode: msg.code } : i));
          term.write(`\r\n\x1b[2m[process exited${msg.code != null ? ` with code ${msg.code}` : ""}]\x1b[0m\r\n`);
          onChanged();
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        // The terminal may have been closed elsewhere; check before reconnecting.
        api<TerminalInfo[]>("/terminals").then(
          (list) => {
            if (disposed) return;
            if (!list.some((t) => t.id === id)) {
              setState("gone");
              return;
            }
            setState("closed");
            retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
          },
          () => {
            setState("closed");
            retryTimer = setTimeout(connect, 5000);
          },
        );
      };
    };

    term.onData((data) => send({ type: "input", data }));
    const ro = new ResizeObserver(() => doFit());
    ro.observe(hostRef.current!);
    connect();
    term.focus();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      ro.disconnect();
      wsRef.current?.close();
      term.dispose();
    };
  }, [id, onChanged]);

  const sendInput = (data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    termRef.current?.focus();
  };

  const close = async () => {
    if (info && !info.exited && !confirm("Kill this terminal process?")) return;
    await api(`/terminals/${id}`, { method: "DELETE" }).catch(() => {});
    onChanged();
    navigate(info?.claudeSessionId ? { view: "session", id: info.claudeSessionId } : { view: "home" });
  };

  if (state === "gone") {
    return (
      <div className="page narrow">
        <h1>Terminal closed</h1>
        <p className="muted">This terminal no longer exists. The server may have restarted.</p>
        <a className="btn" href="#/new">
          New session
        </a>
      </div>
    );
  }

  return (
    <div className="term-page">
      <header className="view-head">
        <div className="view-title">
          <strong>{info?.kind === "shell" ? "Shell" : (info?.title ?? "Terminal")}</strong>
          <span className="muted small">
            {shortPath(info?.cwd)} {state !== "open" && <span className="badge">{state}</span>}
            {info?.exited && <span className="badge">exited</span>}
          </span>
        </div>
        <div className="view-actions">
          {info?.claudeSessionId && (
            <a className="btn small ghost" href={`#/s/${info.claudeSessionId}`}>
              History
            </a>
          )}
          <button className="btn small danger" onClick={close}>
            {info?.exited ? "Close" : "Kill"}
          </button>
        </div>
      </header>
      <div className="term-host" ref={hostRef} />
      <div className="keybar">
        {KEYS.map(([label, seq]) => (
          <button key={label} onMouseDown={(e) => e.preventDefault()} onClick={() => sendInput(seq)}>
            {label}
          </button>
        ))}
      </div>
      <form
        className="compose"
        onSubmit={(e) => {
          e.preventDefault();
          // Bracketed paste keeps multi-line text as one prompt in Claude Code.
          const text = compose.includes("\n") ? `\x1b[200~${compose}\x1b[201~` : compose;
          sendInput(text);
          setTimeout(() => sendInput("\r"), 50);
          setCompose("");
        }}
      >
        <input placeholder="Type here and press Enter to send to the terminal…" value={compose} onChange={(e) => setCompose(e.target.value)} />
        <button className="btn small primary">Send</button>
      </form>
    </div>
  );
}
