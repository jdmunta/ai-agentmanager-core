# Cloud runners: agents that keep working with your laptop closed

A cloud runner is AI Agent Manager running headless on a server, joined to your [hub](distributed.md). It shows up next to your Macs; you start agents on it from the hub, or **Move** an agent there from a Mac and close the laptop. Agents use your own subscriptions (a Claude token, your OpenAI key) and your GitHub token, nothing billed by AI Agent Manager.

## What you need

- A hub on an `https` address (Railway, a VPS behind a TLS proxy, or Tailscale).
- On the hub, a **runner token**: a long random secret that lets machines join by themselves. Set it on the hub's service:

  ```sh
  AGENTMGR_HUB_RUNNER_TOKEN=$(openssl rand -hex 24)   # at least 24 characters
  ```

  (A one-time invite code from `agentmgr hub invite` works too, but it expires in 10 minutes, so a runner that is rebuilt from scratch couldn't join again.)
- A Claude token: run `claude setup-token` on any computer and keep the token. For Codex, an OpenAI API key.
- A GitHub token (`GH_TOKEN`) that can clone, push and open pull requests on your repositories.

## The runner's settings

| Variable | |
| --- | --- |
| `AGENTMGR_HUB_URL` | The hub, e.g. `https://hub.example.com` |
| `AGENTMGR_HUB_CODE` | The hub's runner token (or an invite code) |
| `AGENTMGR_RUNNER_NAME` | Its name on the hub (default: the hostname) |
| `AGENTMGR_HUB_ALLOW` | What the hub may do: `view,control,move` (move lets you send agents to it) |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token` |
| `OPENAI_API_KEY` | For Codex (optional) |
| `GH_TOKEN` | For git and `gh` |
| `GIT_USER_NAME`, `GIT_USER_EMAIL` | The author of its commits |
| `AGENTMGR_HUB_ALLOW_HTTP=1` | Only for a hub on the same private network over plain http (one docker-compose, one VPC) |

It joins the hub by itself on first start and keeps its key on its volume, so restarts and redeploys reconnect without joining again. Everything it keeps (agents, workspaces, Claude and Codex homes) lives on the `/data` volume. Nothing on it listens publicly: the hub reaches it over its own outgoing connection.

## Railway

1. **New service → GitHub repo** (your fork of ai-agentmanager-core).
2. **Settings → Build**: Dockerfile path `docker/runner.Dockerfile`.
3. **Settings → Volumes**: add a volume mounted at `/data`.
4. **Variables**: the table above.
5. Deploy. In the hub, the runner appears under machines within a minute.

## Any server with Docker

```sh
git clone https://github.com/jdmunta/ai-agentmanager-core && cd ai-agentmanager-core
cat > docker/.env <<'VARS'
AGENTMGR_HUB_URL=https://hub.example.com
AGENTMGR_HUB_CODE=<the hub's runner token>
AGENTMGR_RUNNER_NAME=cloud-1
CLAUDE_CODE_OAUTH_TOKEN=<from claude setup-token>
GH_TOKEN=<github token>
VARS
docker compose -f docker/compose.runner.yml --env-file docker/.env up -d
```

Or by hand: `docker build -f docker/runner.Dockerfile -t ai-agentmanager-runner .` then `docker run -d --restart unless-stopped -v runner-data:/data -e … ai-agentmanager-runner`.

## Using it

- **Move an agent there**: on the hub, **Move to… → cloud-1** (or `agentmgr fleet move mini/<agent> --to cloud-1`). Its branch goes through your repository's remote and its conversation through the hub; it carries on where it was. Both machines must allow `move`.
- **Start agents on it**: New agent on the hub, choosing the runner; or give the shared backlog work and let the runner pick it up.
- Answer its prompts and read its terminals from the hub, from any device.
