import { useEffect, useMemo, useState } from "react";
import { api, shortPath, timeAgo, type SessionSummary, type TerminalInfo } from "../api";
import { routeHref, type Route } from "../App";

const PAGE = 40;

export function Sidebar({
  route,
  refreshKey,
  onLogout,
  onClose,
}: {
  route: Route;
  refreshKey: number;
  onLogout: () => void;
  onClose: () => void;
}) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () => {
      api<TerminalInfo[]>("/terminals").then((t) => alive && setTerminals(t), () => {});
      api<SessionSummary[]>(`/sessions?limit=${limit}`).then((s) => alive && setSessions(s), () => {});
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refreshKey, limit]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return sessions;
    return sessions.filter((s) => `${s.customTitle ?? ""} ${s.summary} ${s.cwd ?? ""}`.toLowerCase().includes(f));
  }, [sessions, filter]);

  const active = (r: Route) => routeHref(r) === routeHref(route);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <a className="brand" href="#/">
          <span className="logo" aria-hidden="true">
            ›_
          </span>
          RClaude
        </a>
        <button className="icon-btn close-drawer" aria-label="Close menu" onClick={onClose}>
          ×
        </button>
      </div>
      <a className="btn primary block new-btn" href="#/new">
        + New session
      </a>

      <div className="sidebar-scroll">
        {terminals.length > 0 && (
          <section>
            <h2>Terminals</h2>
            {terminals.map((t) => (
              <a key={t.id} href={routeHref({ view: "terminal", id: t.id })} className={`item ${active({ view: "terminal", id: t.id }) ? "active" : ""}`}>
                <span className={`dot ${t.exited ? "off" : "on"}`} />
                <span className="item-main">
                  <span className="item-title">
                    {t.kind === "shell" ? "Shell" : t.title}
                    {t.exited && <span className="muted"> · exited</span>}
                  </span>
                  <span className="item-sub">{shortPath(t.cwd)}</span>
                </span>
              </a>
            ))}
          </section>
        )}

        <section>
          <h2>Sessions</h2>
          <input className="filter" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {filtered.map((s) => {
            const live = s.chatStatus && s.chatStatus !== "closed";
            return (
              <a
                key={s.sessionId}
                href={routeHref({ view: "session", id: s.sessionId })}
                className={`item ${active({ view: "session", id: s.sessionId }) ? "active" : ""}`}
              >
                <span
                  className={`dot ${s.chatStatus === "waiting_permission" ? "warn" : live || s.terminalIds.length ? "on" : "off"}`}
                  title={s.chatStatus ?? (s.terminalIds.length ? "open in terminal" : "")}
                />
                <span className="item-main">
                  <span className="item-title">{s.customTitle || s.summary || "(untitled)"}</span>
                  <span className="item-sub">
                    {shortPath(s.cwd)} · {timeAgo(s.lastModified)}
                  </span>
                </span>
              </a>
            );
          })}
          {sessions.length >= limit && (
            <button className="btn ghost block" onClick={() => setLimit((l) => l + PAGE)}>
              Load more
            </button>
          )}
          {sessions.length === 0 && <p className="muted small pad">No sessions yet.</p>}
        </section>
      </div>

      <div className="sidebar-foot">
        <a href="#/settings" className={`item ${active({ view: "settings" }) ? "active" : ""}`}>
          Settings
        </a>
        <button className="item as-btn" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
