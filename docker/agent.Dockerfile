# The image agents run in when isolated ("Run in a container"): Node, git and common build tools,
# with Claude Code and Codex. Build it with `agentmgr sandbox build` (or Settings → Containers).
# Only the agent's own folder, its git data, brief and uploads are mounted from the host.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep jq python3 make g++ openssh-client less procps \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

# Agents run as the host's user id (files they write stay yours); any user can use this home.
RUN mkdir -p /home/agent && chmod 1777 /home/agent
ENV HOME=/home/agent
WORKDIR /home/agent
