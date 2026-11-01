#!/bin/sh
# Start a cloud runner: folders on the volume, git identity and GitHub access from the environment,
# Claude Code's first-run screens answered, then the daemon (it joins the hub by itself).
set -e
mkdir -p "$HOME" "$AGENTMGR_HOME"
git config --global user.name "${GIT_USER_NAME:-AI Agent Manager runner}"
git config --global user.email "${GIT_USER_EMAIL:-runner@agentmanager.invalid}"
git config --global init.defaultBranch main
if [ -n "$GH_TOKEN" ]; then gh auth setup-git >/dev/null 2>&1 || true; fi
[ -f "$HOME/.claude.json" ] || echo '{"hasCompletedOnboarding":true,"theme":"dark"}' > "$HOME/.claude.json"
# The hub reaches agents through this runner's own connection; nothing listens publicly.
exec agentmgr serve
