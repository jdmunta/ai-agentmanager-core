# agentkit: agents you build, download and run

Status: phase 1 (the runtime) in progress. Builder, single-executable packaging and monitoring follow.

An **agentkit agent** is a folder (later, one executable) that does one job continuously: triage new
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
the result. Background: a launchd/systemd service (`agentkit service install`), Docker, or a
cloud runner.
