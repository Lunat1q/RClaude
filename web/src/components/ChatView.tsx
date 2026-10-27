import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  api,
  ApiError,
  PERMISSION_MODE_LABELS,
  shortPath,
  type ChatEvent,
  type ChatInfo,
  type PermissionMode,
  type PermissionRequest,
  type RawMessage,
  type SessionSummary,
  type TerminalInfo,
} from "../api";
import { navigate } from "../App";
import { Markdown } from "./Markdown";
import { PermissionCard, type PermissionDecision } from "./PermissionCard";
import { buildBlocks, toolSummary, type Block, type Entry } from "./transcript";

const coarsePointer = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

function ToolBlock({ b }: { b: Extract<Block, { kind: "tool" }> }) {
  const summary = toolSummary(b.name, b.input);
  return (
    <details className={`tool ${b.isError ? "tool-error" : ""}`}>
      <summary>
        <span className={`tool-dot ${b.done ? (b.isError ? "err" : "ok") : "run"}`} />
        <strong>{b.name}</strong> <span className="tool-sum">{summary}</span>
      </summary>
      <pre className="tool-input">{JSON.stringify(b.input, null, 2)}</pre>
      {b.result !== undefined && <pre className="tool-result">{b.result.length > 20000 ? `${b.result.slice(0, 20000)}\n… (truncated)` : b.result}</pre>}
    </details>
  );
}

export function ChatView({ sessionId, onChanged }: { sessionId: string; onChanged: () => void }) {
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [chat, setChat] = useState<ChatInfo | null>(null);
  const [pending, setPending] = useState<PermissionRequest[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [resumeMode, setResumeMode] = useState<PermissionMode | "">("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const seenRef = useRef(new Set<string>());
  const promptTextsRef = useRef(new Set<string>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const handleEvent = useCallback(
    (e: ChatEvent) => {
      switch (e.type) {
        case "status":
          setChat((c) => (c ? { ...c, status: e.status } : c));
          if (e.status !== "running") setStreaming("");
          if (e.status === "closed") {
            esRef.current?.close();
            esRef.current = null;
            setChat(null);
          }
          if (e.status === "idle" || e.status === "closed") onChanged();
          break;
        case "prompt":
          if (promptTextsRef.current.has(e.text)) {
            promptTextsRef.current.delete(e.text);
            break;
          }
          setEntries((x) => [...x, { kind: "prompt", text: e.text, key: `p${e.seq}` }]);
          break;
        case "text_delta":
          if (!e.parentToolUseId) setStreaming((s) => s + e.text);
          break;
        case "sdk": {
          const m = e.message;
          if (m.type === "assistant") setStreaming("");
          if (m.type !== "assistant" && m.type !== "user" && m.type !== "result") break;
          if (m.uuid) {
            if (seenRef.current.has(m.uuid)) break;
            seenRef.current.add(m.uuid);
          }
          setEntries((x) => [...x, { kind: "raw", msg: m }]);
          break;
        }
        case "permission_request":
          setPending((p) => (p.some((r) => r.id === e.request.id) ? p : [...p, e.request]));
          break;
        case "permission_resolved":
          setPending((p) => p.filter((r) => r.id !== e.id));
          break;
        case "error":
          setEntries((x) => [...x, { kind: "error", text: e.message, key: `e${e.seq}` }]);
          break;
      }
    },
    [onChanged],
  );

  const subscribe = useCallback(
    (after: number) => {
      esRef.current?.close();
      const es = new EventSource(`/api/chats/${sessionId}/events?after=${after}`);
      es.onmessage = (ev) => handleEvent(JSON.parse(ev.data) as ChatEvent);
      es.onerror = () => {
        // EventSource reconnects by itself; if the chat is gone, stop.
        api<ChatInfo>(`/chats/${sessionId}`).catch(() => {
          es.close();
          if (esRef.current === es) esRef.current = null;
          setChat(null);
        });
      };
      esRef.current = es;
    },
    [sessionId, handleEvent],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [sum, live, msgs] = await Promise.all([
        api<SessionSummary>(`/sessions/${sessionId}`).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))),
        api<ChatInfo>(`/chats/${sessionId}`).catch(() => null),
        api<RawMessage[]>(`/sessions/${sessionId}/messages`).catch(() => [] as RawMessage[]),
      ]);
      if (cancelled) return;
      if (!sum && !live) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setSummary(sum);
      seenRef.current = new Set(msgs.map((m) => m.uuid).filter(Boolean) as string[]);
      // Prompts already persisted in the transcript must not be repeated from the live event buffer.
      promptTextsRef.current = new Set(
        msgs.filter((m) => m.type === "user" && typeof m.message?.content === "string").map((m) => m.message!.content as string),
      );
      setEntries(msgs.map((msg) => ({ kind: "raw", msg })));
      setChat(live);
      setPending(live?.pendingPermissions ?? []);
      if (live) subscribe(0);
      setLoading(false);
    })().catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    });
    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
    };
  }, [sessionId, subscribe]);

  const blocks = useMemo(() => buildBlocks(entries), [entries]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [blocks, streaming, pending]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setError("");
    try {
      const wasLive = !!esRef.current;
      const info = await api<ChatInfo>(`/chats/${sessionId}/messages`, {
        body: { prompt: text, permissionMode: chat ? undefined : resumeMode || undefined },
      });
      setInput("");
      stickRef.current = true;
      setChat(info);
      if (!wasLive) subscribe(0);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !coarsePointer && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const respond = async (req: PermissionRequest, d: PermissionDecision) => {
    try {
      await api(`/chats/${sessionId}/permissions/${encodeURIComponent(req.id)}`, { body: d });
      setPending((p) => p.filter((r) => r.id !== req.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const interrupt = () => api(`/chats/${sessionId}/interrupt`, { body: {} }).catch((e) => setError(e.message));

  const openInTerminal = async () => {
    try {
      const t = await api<TerminalInfo>("/terminals", { body: { kind: "claude", resume: sessionId, cwd: summary?.cwd ?? chat?.cwd } });
      onChanged();
      navigate({ view: "terminal", id: t.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const rename = async () => {
    const title = prompt("Session title", summary?.customTitle || summary?.summary || "");
    if (!title) return;
    await api(`/sessions/${sessionId}`, { method: "PATCH", body: { title } }).catch((e) => setError(e.message));
    setSummary((s) => (s ? { ...s, customTitle: title } : s));
    onChanged();
  };

  const remove = async () => {
    if (!confirm("Delete this session's history permanently?")) return;
    try {
      await api(`/sessions/${sessionId}`, { method: "DELETE" });
      onChanged();
      navigate({ view: "home" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stopProcess = async () => {
    await api(`/chats/${sessionId}`, { method: "DELETE" }).catch(() => {});
    esRef.current?.close();
    esRef.current = null;
    setChat(null);
    onChanged();
  };

  if (notFound) {
    return (
      <div className="page narrow">
        <h1>Session not found</h1>
        <a className="btn" href="#/new">
          New session
        </a>
      </div>
    );
  }

  const busy = chat?.status === "running" || chat?.status === "waiting_permission";
  const terminalIds = summary?.terminalIds ?? [];
  const title = summary?.customTitle || summary?.summary || "New session";

  return (
    <div className="chat-page">
      <header className="view-head">
        <div className="view-title">
          <strong title={title}>{title}</strong>
          <span className="muted small">
            {shortPath(summary?.cwd ?? chat?.cwd)}
            {chat && <span className={`badge status-${chat.status}`}>{chat.status.replace("_", " ")}</span>}
            {summary?.gitBranch && <span className="badge">⎇ {summary.gitBranch}</span>}
          </span>
        </div>
        <div className="view-actions">
          {terminalIds.length > 0 ? (
            <a className="btn small" href={`#/t/${terminalIds[0]}`}>
              Open terminal
            </a>
          ) : (
            <button className="btn small" onClick={openInTerminal} disabled={busy}>
              Resume in terminal
            </button>
          )}
          <details className="menu">
            <summary className="btn small ghost">⋯</summary>
            <div className="menu-pop">
              <button onClick={rename}>Rename</button>
              {chat && <button onClick={stopProcess}>Stop background process</button>}
              <button onClick={() => navigator.clipboard?.writeText(sessionId)}>Copy session ID</button>
              <button className="danger" onClick={remove}>
                Delete history
              </button>
            </div>
          </details>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-inner">
          {loading && <div className="muted pad">Loading…</div>}
          {blocks.map((b) => {
            switch (b.kind) {
              case "user":
                return b.meta ? (
                  <div key={b.key} className="msg meta">
                    <pre>{b.text}</pre>
                  </div>
                ) : (
                  <div key={b.key} className="msg user">
                    <div className="bubble">{b.text}</div>
                  </div>
                );
              case "assistant":
                return (
                  <div key={b.key} className="msg assistant">
                    <Markdown text={b.text} />
                  </div>
                );
              case "tool":
                return <ToolBlock key={b.key} b={b} />;
              case "result":
                return (
                  <div key={b.key} className={`result-line ${b.isError ? "err" : ""}`}>
                    {b.isError ? `Turn ended: ${b.subtype}` : "Done"}
                    {b.durationMs !== undefined && ` · ${(b.durationMs / 1000).toFixed(1)}s`}
                    {b.costUsd !== undefined && ` · $${b.costUsd.toFixed(4)}`}
                  </div>
                );
              case "error":
                return (
                  <div key={b.key} className="error">
                    {b.text}
                  </div>
                );
            }
          })}
          {streaming && (
            <div className="msg assistant streaming">
              <Markdown text={streaming} />
            </div>
          )}
          {chat?.status === "running" && !streaming && pending.length === 0 && <div className="thinking">Working…</div>}
          {pending.map((r) => (
            <PermissionCard key={r.id} req={r} onRespond={(d) => respond(r, d)} />
          ))}
        </div>
      </div>

      <div className="chat-input">
        {error && <div className="error">{error}</div>}
        {terminalIds.length > 0 ? (
          <div className="muted small pad">
            This session is open in a terminal. <a href={`#/t/${terminalIds[0]}`}>Continue there</a>, or close the terminal to chat here.
          </div>
        ) : (
          <>
            {!chat && (
              <div className="resume-opts">
                <span className="muted small">Resume with</span>
                <select value={resumeMode} onChange={(e) => setResumeMode(e.target.value as PermissionMode | "")}>
                  <option value="">server default permissions</option>
                  {Object.entries(PERMISSION_MODE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="input-row">
              <textarea
                rows={Math.min(8, Math.max(1, input.split("\n").length))}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={busy ? "Queue a follow-up…" : chat ? "Reply…" : "Continue this conversation…"}
              />
              {busy && (
                <button className="btn danger" onClick={interrupt} title="Interrupt">
                  ■
                </button>
              )}
              <button className="btn primary" onClick={send} disabled={!input.trim()}>
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
