export function Home() {
  return (
    <div className="page narrow">
      <h1>Claude Code, anywhere</h1>
      <p className="muted">Pick a session on the left to continue it, or start a new one.</p>
      <div className="cards">
        <a className="card link-card" href="#/new">
          <strong>New session</strong>
          <span className="muted">Start Claude Code in a terminal or in chat mode, in any folder.</span>
        </a>
        <a className="card link-card" href="#/settings">
          <strong>API &amp; MCP</strong>
          <span className="muted">Create API tokens and connect MCP clients.</span>
        </a>
      </div>
      <h2>Two ways to work</h2>
      <ul className="muted">
        <li>
          <strong>Terminal</strong>: the real interactive Claude Code console in your browser. It keeps running when you close the tab, so you
          can reattach from another device.
        </li>
        <li>
          <strong>Chat</strong>: a phone-friendly view built on the Agent SDK, with permission prompts as buttons. It's the same session type
          the API and MCP use.
        </li>
      </ul>
      <p className="muted">Both kinds save to the same history, so a conversation started in one can be resumed in the other.</p>
    </div>
  );
}
