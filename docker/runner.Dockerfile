# A cloud runner: AI Agent Manager running headless on a server, joined to your hub, so agents keep
# working with your laptop closed. Build from the repository root:
#   docker build -f docker/runner.Dockerfile -t ai-agentmanager-runner .
# Run with a volume on /data and the environment in docs/cloud-runner.md (hub address and code,
# Claude token, GitHub token). Move agents to it from the hub.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep jq python3 make g++ openssh-client less procps \
  && rm -rf /var/lib/apt/lists/*
# GitHub CLI (pull requests, checks).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

WORKDIR /opt/agentmanager
COPY package.json package-lock.json ./
# The install runs scripts/fix-pty.js (node-pty's helper permissions).
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY public ./public
COPY docker ./docker
RUN ln -s /opt/agentmanager/bin/agentmgr.js /usr/local/bin/agentmgr

# Everything that has to survive a redeploy lives on the /data volume.
ENV HOME=/data/home AGENTMGR_HOME=/data/agentmanager AGENTMGR_REMOTE=0 NODE_ENV=production
VOLUME /data
ENTRYPOINT ["/opt/agentmanager/docker/runner-entrypoint.sh"]
