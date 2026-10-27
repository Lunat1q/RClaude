import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Login } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { TerminalView } from "./components/TerminalView";
import { ChatView } from "./components/ChatView";
import { Settings } from "./components/Settings";
import { NewSession } from "./components/NewSession";
import { Home } from "./components/Home";

export type Route =
  | { view: "home" }
  | { view: "new" }
  | { view: "terminal"; id: string }
  | { view: "session"; id: string }
  | { view: "settings" };

function parseHash(): Route {
  const [, view, id] = window.location.hash.replace(/^#/, "").split("/");
  if (view === "t" && id) return { view: "terminal", id };
  if (view === "s" && id) return { view: "session", id };
  if (view === "settings") return { view: "settings" };
  if (view === "new") return { view: "new" };
  return { view: "home" };
}

export function routeHref(r: Route): string {
  switch (r.view) {
    case "terminal":
      return `#/t/${r.id}`;
    case "session":
      return `#/s/${r.id}`;
    case "settings":
      return "#/settings";
    case "new":
      return "#/new";
    default:
      return "#/";
  }
}

export function navigate(r: Route): void {
  window.location.hash = routeHref(r);
}

type AuthState = { setupRequired: boolean; authenticated: boolean; username: string; logoutUrl?: string };

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [route, setRoute] = useState<Route>(parseHash);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadAuth = useCallback(() => {
    api<AuthState>("/auth/state").then(setAuth, () => setAuth({ setupRequired: false, authenticated: false, username: "" }));
  }, []);

  useEffect(() => {
    loadAuth();
    const onHash = () => {
      setRoute(parseHash());
      setDrawerOpen(false);
    };
    // Re-check rather than drop straight to the login form: behind SSO the server can start a new session
    const onUnauthorized = () => loadAuth();
    window.addEventListener("hashchange", onHash);
    window.addEventListener("rclaude:unauthorized", onUnauthorized);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("rclaude:unauthorized", onUnauthorized);
    };
  }, [loadAuth]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  if (!auth) return <div className="splash" />;
  if (!auth.authenticated) return <Login setupRequired={auth.setupRequired} username={auth.username} onDone={loadAuth} />;

  const logout = async () => {
    await api("/auth/logout", { body: {} }).catch(() => {});
    // Behind SSO, also end the SSO session, otherwise the next auth check signs straight back in
    if (auth.logoutUrl) window.location.href = auth.logoutUrl;
    else loadAuth();
  };

  let content;
  switch (route.view) {
    case "terminal":
      content = <TerminalView key={route.id} id={route.id} onChanged={refresh} />;
      break;
    case "session":
      content = <ChatView key={route.id} sessionId={route.id} onChanged={refresh} />;
      break;
    case "settings":
      content = <Settings />;
      break;
    case "new":
      content = <NewSession onCreated={refresh} />;
      break;
    default:
      content = <Home />;
  }

  return (
    <div className={`layout ${drawerOpen ? "drawer-open" : ""}`}>
      <Sidebar route={route} refreshKey={refreshKey} onLogout={logout} onClose={() => setDrawerOpen(false)} />
      <div className="scrim" onClick={() => setDrawerOpen(false)} />
      <main className="main">
        <button className="menu-btn" aria-label="Open menu" onClick={() => setDrawerOpen(true)}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        {content}
      </main>
    </div>
  );
}
