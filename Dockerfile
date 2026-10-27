# --- build ------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# --- runtime ----------------------------------------------------------------
FROM node:24-bookworm-slim

# Tools Claude Code (and you, in the shell) commonly need.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client gnupg tini procps less vim-tiny nano \
      ripgrep jq unzip zip python3 python3-pip python3-venv build-essential \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged "claude" user (uid 1000) whose home and workspace are volumes.
RUN usermod -l claude -d /home/claude -m node \
 && groupmod -n claude node \
 && mkdir -p /home/claude /workspace \
 && chown -R claude:claude /home/claude /workspace

WORKDIR /app
COPY --from=build --chown=claude:claude /app/package.json ./
COPY --from=build --chown=claude:claude /app/node_modules ./node_modules
COPY --from=build --chown=claude:claude /app/dist ./dist
COPY --from=build --chown=claude:claude /app/bin ./bin

# The Agent SDK ships the native Claude Code binary; expose it as `claude` for terminals.
RUN ln -s /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude /usr/local/bin/claude \
 && claude --version

ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/home/claude \
    SHELL=/bin/bash \
    RCLAUDE_DATA_DIR=/home/claude/.rclaude \
    RCLAUDE_WORKSPACE_DIR=/workspace \
    CLAUDE_BIN=/usr/local/bin/claude \
    DISABLE_AUTOUPDATER=1 \
    NODE_NO_WARNINGS=1

USER claude
WORKDIR /workspace
EXPOSE 3000
VOLUME ["/home/claude", "/workspace"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://localhost:3000/healthz || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/dist/server/index.js"]
