# agentkit: agents you build, download and run

Status: the runtime, the builder (AI Agent Manager's **Built** tab), single executables, the background service, approvals and reporting to AI Agent Manager are in.

An **agentkit agent** is a folder (or one executable made from it) that does one job continuously: triage new
support tickets, keep a dependency report current, answer questions about a codebase, run a
release checklist. It is described by `agent.yaml`, runs its work through an engine's CLI (Claude
Code, Codex, Muse Code or any ACP agent), uses tools through MCP servers, and can be reached by
people (a chat page, an HTTP API), by other agents (A2A, MCP) and by editors (ACP).

## agent.yaml

```yaml
name: ticket-triage                 # lowercase, used for files and URLs
title: Support ticket triage
description: Reads new tickets, labels and routes them, drafts a first reply.
goal: |
  Every new ticket is labelled, routed to the right team and has a drafted first reply
  within 10 minutes, without closing or replying on its own.
instructions: instructions.md       # or inline text: how to do the job, step by step
engine: claude                      # claude | codex | muse | acp:<name>
model: sonnet                       # optional, passed to the engine
workdir: ./work                     # where it works (a repo, a folder); default ./work

tools:                              # MCP servers the engine gets
  jira:
    command: npx
    args: [-y, "@acme/jira-mcp"]
    env: { JIRA_TOKEN: "${JIRA_TOKEN}" }  # "${VAR}" (quoted) comes from the environment, never stored
allow: [Read, Grep, "mcp__jira__*"] # tools it may use without asking (engine names)
approve: ["mcp__jira__transition"]  # tools that need a person's yes (asked in chat / Inbox)
approveTimeout: 30m                 # no answer by then counts as no
report:                             # report to AI Agent Manager (or set AGENTKIT_REPORT_*)
  url: "${AGENTMGR_URL}"
  token: "${AGENTMGR_REPORT_TOKEN}"

triggers:
  - every: 10m                      # interval
  - cron: "0 9 * * 1-5"             # schedule (minute hour day month weekday)
  - webhook: /hooks/ticket          # POST here starts a run with the body as input
  - watch: ./inbox                  # a new or changed file starts a run

loop:
  plan: true                        # think and write a plan before acting
  check: true                       # verify the result against the goal after acting
  maxSteps: 6                       # act/check rounds per run before stopping
  budgetUsd: 0.50                   # per run (when the engine reports cost)

memory: true                        # keep notes between runs (memory.md)

interfaces:
  http: { port: 7700 }              # chat page + API
  a2a: true                         # agent card + tasks over HTTP
  acp: true                         # `<agent> acp` speaks ACP on stdio
  mcp: true                         # `<agent> mcp` exposes it as an MCP tool
```

## A run

1. **Input** arrives: a trigger fires (with its payload), someone chats, an A2A task or an MCP
   call comes in.
2. **Plan** (when `loop.plan`): the engine reads the goal, instructions, memory and input and
   writes a short plan.
3. **Act**: the engine carries out the plan with its tools (MCP), in `workdir`.
4. **Check** (when `loop.check`): the engine is asked whether the goal is met for this input,
   and what's left. If not and steps remain, it acts again on what's left.
5. **Reflect** (when `memory`): one or two lessons for next time are appended to memory.
6. **Result**: the final answer goes back to whoever asked; the run (steps, output, cost,
   duration) is logged in `runs/<id>.jsonl`.

The engine keeps one session per conversation (a chat, an A2A context), so follow-ups continue
it. Runs from triggers start fresh sessions.

## Interfaces

- **HTTP**: `GET /` chat page; `POST /api/chat {message, conversation?}`; `POST /api/runs {input}`;
  `GET /api/runs`, `GET /api/runs/:id`; `GET /api/health`.
- **A2A**: agent card at `GET /.well-known/agent.json`; JSON-RPC at `POST /a2a` with
  `message/send` and `tasks/get`.
- **ACP**: `<agent> acp` runs an ACP agent on stdio (initialize, session/new, session/prompt,
  streamed session/update), so editors (and AI Agent Manager's ACP engine) can drive it.
- **MCP**: `<agent> mcp` runs an MCP server on stdio with one tool, `ask_<name>`, so other
  agents can delegate to it.

## Running

`agentkit run ./ticket-triage` (or, packaged, `./ticket-triage`) starts it in the foreground:
triggers, the HTTP server, the loop. `agentkit run … --once "<input>"` does one run and prints
the result.

In the background: `agentkit service install ./ticket-triage` (packaged: `./ticket-triage service
install`) registers it with launchd (macOS) or systemd (Linux, a user service): it starts at login,
restarts after a crash, and writes to `agent.log` in its folder. It runs through your login shell,
so it finds the engine CLIs and tokens your terminal has. `service status` and `service uninstall`
do the rest. On Linux, `loginctl enable-linger $USER` keeps it running while you're logged out.

## One executable

`agentkit package ./ticket-triage [--platform linux-x64] [-o dist]` makes one file that runs the
agent with no Node or agentkit installed: `ticket-triage-macos-arm64`, `-macos-x64`,
`-linux-x64` or `-linux-arm64` (about 110 MB; Windows isn't supported yet). It is a Node single
executable application: the runtime bundled, the agent's files (`agent.yaml`, instructions,
tests) embedded, injected into the official Node binary for that platform (downloaded once from
nodejs.org, checked against its published checksums, cached in `~/.agentmanager/node-dist`).
Linux executables build on any Mac or Linux machine; macOS ones are signed, so they build on a Mac.

On its first run, the executable unpacks its files to `~/.agentkit/<name>/` (or `AGENTKIT_HOME`),
where its memory and runs live too. Edits there stay until a newer build of the agent replaces the
files it shipped. Everything else works as with the folder: `./ticket-triage` (run),
`--once "<input>"`, `acp`, `mcp`, `check`, `service install`. Its engine's CLI (Claude Code, Codex
or Muse Code) must be installed and signed in where it runs. ACP engines aren't packaged yet.

In AI Agent Manager, a built agent's dialog has **Build executable** (pick the platform) and a
download link for each one built. Editing the agent drops the old executables.

## Approvals

A tool on the `approve` list runs only after a person says yes. The approve list wins over
`allow`: with `allow: ["mcp__jira__*"]` and `approve: ["mcp__jira__transition"]`, every Jira tool
runs freely except transitions, which ask.

With Claude Code as the engine, the agent passes `--permission-prompt-tool` to point Claude at a
small MCP server of its own (the approver). Claude asks the approver before any tool it isn't
allowed outright. The approver hands the question to the running agent over a private local
address, and the agent asks whoever can answer:

- **its chat page**, which shows *Approve …?* with the tool's input and Approve / Deny buttons
  (`GET /api/approvals`, `POST /api/approvals/<id>` with `{"allow": true}`);
- **AI Agent Manager**, when the agent reports there: the request shows up in the **Inbox** and the
  **Built** tab, and the answer goes back with the agent's next check-in (every 2 seconds while
  something waits).

The first answer decides. No answer within `approveTimeout` (default 30m) counts as no, and so does
having no one to ask (no chat page, not reporting). Tools on neither list are refused without
asking. Other engines can't ask mid-run, so for them approval tools aren't available at all. Test
runs in the builder never wait for anyone.

## Reporting to AI Agent Manager

An agent that reports sends AI Agent Manager who it is (name, host, engine, triggers, chat
address), each run (status, source, cost, time, the start of its result) and the approvals it's
waiting on. It checks in every 30 seconds, and right away after a run or a new approval. The
**Built** tab lists these agents under *Reporting in*: online or last seen, idle or working, runs,
failures and total cost, recent runs, and approvals to answer. Runs are counted once; the list is
kept across restarts.

Agents started from the Built tab report automatically. For one running elsewhere (a packaged
executable on a server, a folder on another Mac), **Connect one from elsewhere** shows what to set
in its environment (or its service):

```
AGENTKIT_REPORT_URL=https://192.168.1.20:4718     # AI Agent Manager's remote-access address
AGENTKIT_REPORT_TOKEN=…                           # the report token (made on first use)
AGENTKIT_REPORT_CERT=AB:CD:…                      # its certificate's SHA-256 fingerprint
```

Remote access uses a self-signed certificate, so the agent trusts exactly that certificate (by
its fingerprint) and sends nothing until the fingerprint matches. The connection details are shown
only on the computer AI Agent Manager runs on. The report token lets a program report as an agent
and receive the decisions made for it, and nothing else in AI Agent Manager; keep it like a
password (give each computer the same one, or rotate it by deleting `~/.agentmanager/agentkit-reports.json`).
