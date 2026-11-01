# Changelog

## Unreleased

- **Inbox:** permission menus that newer Claude Code draws as one run of text ("Do you want to proceed? ❯ 1. Yes 2. … 3. No") get their choices again, so they can be answered from the inbox.
- **Cloud runners:** run AI Agent Manager headless on a server so agents keep working with the laptop closed: `docker/runner.Dockerfile` (AI Agent Manager, Claude Code, Codex, git, gh; data on a `/data` volume), `docker/compose.runner.yml`, and a Railway recipe in [docs/cloud-runner.md](docs/cloud-runner.md). It joins the hub by itself from `AGENTMGR_HUB_URL` and `AGENTMGR_HUB_CODE`, with the hub's new reusable **runner token** (`AGENTMGR_HUB_RUNNER_TOKEN`, at least 24 characters, compared in constant time) or an invite, and keeps its link across restarts; `AGENTMGR_HUB_ALLOW` sets what the hub may do. Move agents to it from the hub. `AGENTMGR_HUB_ALLOW_HTTP=1` allows a plain-http hub on a private network.
- **ACP agents:** any agent that speaks ACP (the Agent Client Protocol) is an engine: Gemini CLI, OpenCode, Goose and Qwen Code are offered when installed, and `"acp": { "<name>": { "command": ["…"], "label": "…" } }` in config.json adds others as `acp-<name>`. AI Agent Manager runs its own terminal client (`bin/acp-client.js`) in the agent's terminal: messages, tool calls and the plan as text, permission requests as a menu the inbox answers (Bypass allows them by itself), file writes kept inside the agent's folder, resume with `session/load`, and a session log it reads for usage, PR links, stuck detection and Explain.
- **Agents in containers:** **Run each agent in its own container** in New agents (or `agentmgr add --container`, or by default from Settings): the agent runs in Docker and sees only its own folder (at the same path), its repository's git data, its brief and uploads, not the rest of the computer. Its files are written as you. Sessions, resume, tracking and usage work as on the host; **Open shell** opens inside the container; stopping stops the container. Claude Code (signed in with a token from `claude setup-token`, saved in Settings → Containers or `agentmgr sandbox token`) and Codex (its auth.json, read-only). The image (Node, git, ripgrep, Claude Code, Codex) is built from `docker/agent.Dockerfile` with **Build image** or `agentmgr sandbox build`; `agentmgr sandbox status`. Limits and extras in config.json: `"isolation": { "cpus": 2, "memory": "4g", "network": "…", "mounts": […], "env": […] }`.

## 1.10.0 (2026-10-31)

- **Review scorecard:** an agent's changes scored 0-100 for Intent, Spec (each acceptance criterion met / not met / unverified, with evidence), Tests, Safety, Scope and Plan, with an overall readiness, a recommendation (Ready to approve / Look at these first / Not ready) and **Where to look**: the few hunks a person should read. Facts the app measures cap the model's scores (failing CI, failing checks, code without tests, plan steps ticked, unassessed criteria) and the recommendation follows fixed rules. At the top of Review changes, as a **Scorecard** document, as a badge in Land, in the PR description, and posted on the PR with **Post to PR** (posting again updates the comment). Runs by itself when the agent marks its work done (`"scorecard": { "auto": false }` turns that off); `agentmgr doc <agent> scorecard`.

## 1.9.0 (2026-10-31)

- **Intent, spec and plan:** each task agent now has INTENT.md (the request as given, its Jira summary, attachments and who started it; written by AI Agent Manager), SPEC.md (requirements, acceptance criteria, out of scope; the agent writes it before changing code) and PLAN.md (steps it ticks off), next to its brief. **Intent · Spec · Plan** buttons and the split view's Docs menu show them; Explain, the documents and AI review read the spec and plan; **Push & open PR** puts them in the pull request's description (intent in full, spec and plan folded). `"specs": false` in config.json turns the spec and plan instructions off.
- **Export diagrams:** every drawn diagram has **Copy image** (paste into Slack, a PR comment or a doc), **PNG** and **SVG**; a document with diagrams also downloads as one self-contained **.html**. Diagrams now use SVG text labels so they export as images.
- **Listen:** **🔊 Listen** reads Explain, the documents and the change walkthrough aloud with the browser's own voices (nothing leaves the device; works on phones). The walkthrough is read change by change, showing each as it's read. Pause, stop and speed (0.85× to 1.75×).

## 1.8.0 (2026-10-31)

- **Update from your phone:** **Update to …** and **About → Update and restart** now show over remote access too; the install and restart run on the computer and the page reloads when it's back. It installs only the official release, from where this copy came from.
- **Jira summaries:** an agent created from a Jira link shows the issue's summary as its description (in the list and its header, and as the issue's title under Bugs), fetched in the background from Jira Cloud. Until then, or when it can't be fetched, the words after the link. **Settings → Jira** takes your site, email and API token for private issues (also `JIRA_SITE` / `JIRA_EMAIL` / `JIRA_API_TOKEN`); only `*.atlassian.net` and that site are contacted, and the token goes only to that site. Saving fills in agents already created.
- **Theme:** Auto / Light / Dark in the ☰ menu, remembered in the browser; diagrams redraw in the theme's colors.

## 1.7.0 (2026-10-31)

- **Split view:** **◫ Split** in the terminal bar: the terminal (or a shell, or a browser tab) on the left, and Code, Docs (Diagrams by default, or any other document) or Changes on the right. Resizable and remembered.
- **Review: changes explained one by one:** **Explain changes** in Review changes puts an explanation above each hunk (what, why, risk, what to check) and **◀ / ▶** or **[ / ]** step through them in reading order, skipping hunks that moved since. A notice and **Explain again** when the code changed after.

## 1.6.0 (2026-10-31)

- **Changes explained one by one:** `agentmgr doc <agent> walkthrough` explains each hunk of an agent's changes (what, why, risk, what to check) in the order a reviewer should read them, from the same diff the review screen shows. The review screen and a split view for it come next.
- **Start at login:** a switch in ☰ → Settings installs (or removes) the login service, so the daemon and running agents come back by themselves after a restart, without a terminal command. Getting started lists it until it's on, and `agentmgr ui` mentions it when it's off. Same service as `agentmgr service install` (launchd on macOS, systemd on Linux).
- **Attachments:** **📎 Attach files** in New agents and Ask Agent: pick, drop or paste screenshots, logs and documents. Each agent gets its own copy, listed in its request, in a folder Claude Code and Codex can read without a prompt (a team or race shares one copy). Backlog items keep theirs until they start. CLI: `--file-attach <path>` on `agentmgr add` and `agentmgr ask`.
- **Ask Agent:** **Ask Claude** is now **Ask Agent**, with an Engine choice (Claude Code, Codex, Antigravity, Muse Code) and the engine's notice, if any. `agentmgr ask --engine <engine>`.

## 1.5.0 (2026-10-31)

- **Muse Code engine:** Meta's Muse Code CLI (`muse`) as a fourth engine: `--engine muse` or **Muse Code** in the Engine picker. Session adoption, resume (messages typed once idle), conversation and usage, trust and approval questions in the inbox, a clean stop, and Explain. The picker warns when Muse is in contributor mode. Stuck detection from commands and edits isn't there yet for Muse.
- **Terminals:** reloading the page no longer types the terminal's answers to old color and cursor queries into the program (seen with Muse Code), in agents' terminals and the Terminal. The agent's terminal tab is named after its engine (Codex, Antigravity, Muse Code).
- **One agent or one per line:** New agents asks whether each line starts its own agent (a list of tickets) or the whole text goes to one agent (a long description, kept as written). The button shows how many agents it will create, and the choice is remembered.
- **Diagrams:** a **Diagrams** button beside the documents draws the problem and its solution for a quick grasp, diagrams only: the problem, architecture (changes highlighted), design, data flow with animated arrows, the key interaction and the plan. Drawn from the analysis, design, flow, proposal and plan already written, plus the agent's work and the repo layout. Also `agentmgr doc <agent> diagrams`.
- **Home page:** shows what you can do (agents, teams and races, Inbox, Code, shells and the browser, Terminal, review and Land, Backlog and the assistant, Results, your phone, several machines), each with a button to it, and stays after Getting started is done or hidden. It scrolls when it doesn't fit.
- **Restart from the app's own terminal:** `agentmgr restart` or `agentmgr update` typed in an agent's shell or the Terminal no longer dies halfway (daemon stopped, never started) when the restart closes that terminal; it finishes, and the terminal can be reopened.
- **Remote typing:** over remote access, typing or a paste whose request fails (a network blip) is retried in order instead of dropped, and you're told if it still can't get through.

## 1.4.0 (2026-10-31)

- **Move an agent to another machine:** **Move to…** on the hub (or `agentmgr fleet move <machine>/<agent> --to <machine>`) continues an agent elsewhere with its conversation, branch and uncommitted work. The work goes through the repo's remote on a temporary handoff branch; the conversation goes through the hub in pieces (not stored). Both machines must allow the new `move` permission. A failed move puts everything back; the copy left behind is marked moved and can't be resumed.
- **Code:** a **Code** tab on every agent: the agent's files in a tree, tabs and Monaco (the editor inside VS Code). Save (refused if the agent changed the file meanwhile, unless you overwrite), search the folder, compare with where the agent started, create, rename and delete. Open files pick up the agent's edits. Paths can't leave the agent's folder. Plugins can check changes with the `agent.files` policy.
- **Open in VS Code or Cursor:** opens the agent's folder and file in the editor installed on this computer.
- **Terminal:** a shell on this computer in your home folder, from the top bar, from any signed-in device (phone included). Several at once; they keep running when hidden.
- **Update from the app:** when a new release is out, **Update to …** appears in the top bar (checked twice a day; can be turned off), and one click installs it and restarts; running agents resume. **About → Update and restart** does the same, and so does `agentmgr update`. A clone at a release tag moves to the newest tag (dependencies installed when they changed); an npm install runs `npm install -g`. A clone on a branch or with uncommitted changes is left alone.
- **☰ menu:** the top bar's menu shows who this runs as (your Claude account and organization, and the computer's user) and holds **Settings**, **Clean up**, **Alerts**, **Remote access** and **About**.
- **A limit on open agents:** keep at most N agents open (**Settings**, or `agentmgr cleanup --max-open N`); above it, the ones idle longest are closed and resume when opened. Agents working, waiting for an answer, active in the last 5 minutes, marked Keep or in a running team are never closed for it. Off by default.
- **Drag to move:** drag an agent onto another project in the list to move it there.
- **Home:** clicking **AI Agent Manager** in the top bar goes back to the agent list with nothing open.

## 1.3.1 (2026-10-31)

- **Restart comes back:** `agentmgr restart` waits for the old daemon to exit (it closes every agent first, which takes a while with many), instead of giving up after 20 seconds and reporting success with no daemon left. `serve` started while one is shutting down waits for it instead of exiting, and `shutdown` returns once the daemon has stopped. `/api/health` says `closing` while it shuts down.
- **Pull request status is current:** checking an agent's pull requests while a check is already running (after an update, a stop or a push) waits for it and checks again, instead of returning what that earlier check read, so a pull request ready to merge could still show as needing fixes.

## 1.3.0 (2026-10-31)

- **Review changes:** each agent's changes in one screen: changed files, the diff file by file (new files included), line comments sent to the agent as one message, **Commit all**, and **Push & open PR** with `gh`. `agentmgr changes`, `comment`, `commit`, `pr`.
- **Land tab:** every agent's open pull request by what it needs: ready to merge, needs fixes, behind its base, waiting, drafts, with **Merge**, **Auto-merge**, **Update** (merge the base branch in and push, or ask the agent) and **Ask to fix**. `agentmgr land`.
- **Failing checks and requested changes go back to the agent:** once per commit, at most 3 times per pull request (`landing` in config.json).
- **Pull request status:** checks, review decision and conflicts on each agent's pull requests.
- **Triggers:** labeled GitHub issues start agents (in the repos or owners you list, once per issue), `/agent …` comments on an agent's pull request from the repo's owners, members or collaborators reach the agent, and `POST /api/hooks/agents` with a token starts agents from Jira automation, CI or scripts. No session watches, so no tokens are spent. **Assistant → Triggers…**, `agentmgr triggers`.
- **Linear:** Linear issue links are recognized like Jira's (the agent is named `ENG-42`, one agent per issue for the assistant), and the assistant can watch Linear issues assigned to you.
- **Repo memory:** agents record what they learn about a repository (`agentmgr learn`, allowed without a prompt), and every later agent there starts with it. **Repo memory** on an agent to view and tidy it, `agentmgr memory`.
- **Playbooks:** saved requests with `{{values}}` filled in at run time, run in several projects at once (one agent each), by hand or on a schedule (every hour, day, weekday or week). **Backlog → Playbooks**, **Save as playbook…** in New agents, `agentmgr playbook`.
- **Results:** **Results** in the top bar shows how agents did over a period: PRs opened and merged, merge rate, median time to a first PR and to merge, cost per merged PR, by engine and model, by source and by project. `agentmgr stats`.
- **Spend and budgets:** the same dialog shows today's cost, the last two weeks and the costliest agents. A budget per agent (an alert at 80%, the session closed at 100% until you raise it) and a daily limit that stops new agents from starting. `agentmgr spend`, `agentmgr edit --budget`.
- **Getting started:** with no agent open, a checklist shows what is set up (first agent, Slack alerts, assistant or triggers, phone access, a budget), each with the button that does it, and anything this machine is missing (from `agentmgr doctor`).
- **Refresh** no longer does nothing when a background refresh is already running; it waits and then checks pull requests.

## 1.2.1 (2026-10-30)

- **Edit an agent:** **Edit** on an agent changes its name, its request (and can tell the agent about the change), priority, permission mode and model (from its next launch). `agentmgr edit`.
- **Move an agent to another project:** **✎ Move** next to its project, the Edit dialog, or `agentmgr move <agent> <project>`. Pick any known project, a new project name, or its own repo again. Only where it is listed changes; its code stays in its own repo and branch.

## 1.2.0 (2026-10-30)

- **Assistant:** an always-on session that works on your behalf. Every few minutes it checks Jira (new assignments, comments and mentions), GitHub (review requests, failing checks on your PRs) and Slack with its own tools, and starts agents for new work, or passes the news to the agent already on it. The daemon enforces a daily cap, a cap on its running agents and one agent per Jira key; agents it starts are marked **by assistant**, and Slack alerts can announce them. **Assistant** in the top bar, or `agentmgr assistant`.
- **Project names** in the agent list are larger and bold, so they stand out from the agents under them.

## 1.1.0 (2026-10-30)

- **Teams:** give one problem to a team of agents in roles. An analyst writes the analysis and critics challenge it until they agree; an implementer builds it, a tester tests it, and a reviewer approves it or sends it back to the implementer. They hand off through files with a verdict line, which you can read in the team view. The team asks you only at the end (open a PR, keep the branch, or send it back) or when they can't agree within the round limits. **+ New agents → Team**, or `agentmgr team start`.
- **One lead session by default:** a team is one agent whose Claude Code sub-agents play the roles, so your list shows one agent instead of five. **Separate agents** (one per role, any engine) is still available: the form's "How the team runs", or `--separate`.
- **The lead decides:** it runs a whole request without asking you between steps, records its decisions in the handoff files, and stops only when the reviewer approves or it needs something only you can give. Sub-agents return their work as text and the lead saves it (Claude Code doesn't let sub-agents write report files).
- **The lead stays:** after a request is done, ask the lead for more in its terminal (or **New request** in the team view, `agentmgr team ask`), and it runs the same team flow again as the next quest. Earlier quests stay in the team view.
- **Gap rounds:** the reviewer also checks the work against the whole request and lists what isn't built yet. When good work still has gaps, the team shows them to you and asks: **Run a gap round** (`agentmgr team fix-gaps`) builds them in another round, from analysis to review. To let it run some rounds without asking: **Gap rounds without asking** in the form, `--gap-rounds`, `teams.gapRounds`. The form also sets the analysis and build round limits.
- **Clean up old agents:** close agents with no activity for a while (14 days by default) and delete ones that stayed closed long after that (14 more days), with their worktrees. Pick the strategy in **Clean up** (top bar) or `agentmgr cleanup --strategy`: close then delete automatically, close automatically and delete when you say (the default), manual, or off. Agents marked **Keep**, working agents, members of a running team, and agents with an open pull request or work found only in their worktree are left alone.
- **Only recent agents:** **Created in the last N days** above the agent list hides older agents (the open one stays). The list says how many it hides, with **Show all**. Remembered in this browser.
- **Agent counts per project:** each project in the list shows how many agents it has ("2 of 5 agents" while some are hidden), and how many are running.
- **Jira names:** an agent whose request starts with a Jira link is named after the issue (`OPS-7`), not the link.
- **Teams on a new project:** with no repository or folder, a team starts a new project: a folder with a git repository and an empty first commit, so it still gets its own branch. At the end, merge the branch into the local `main`, publish to a new private GitHub repository with a pull request, or keep the branch.

## 1.0.2 (2026-10-28)

- **Resize and expand:** drag the edge of the agent list, or the line between the brief and the terminal; double-click a line to reset it. **Expand** (Ctrl+Shift+E) fills the window with the terminal, shell or browser tab, and **Full screen** fills the screen.
- **Active agents first:** agents that did real work or got your input in the last day sort to the top, and projects with active agents come before idle ones. Idle agents are dimmed and show how long they've been idle. A restart that resumes an agent doesn't count as activity.
- **`agentmgr doctor`:** checks Node.js, Claude Code and its sign-in, git, `gh`, the data folder, the daemon's port and Chrome, and says how to fix what's missing.
- **Clearer first run:** when Claude Code (or another engine) isn't installed or isn't on the daemon's PATH, the agent says so and how to fix it, instead of `spawn claude ENOENT`. Running from a git checkout without `npm install` says to run it, instead of `Cannot find package`.
- **AI judge:** no longer reads Claude Code's status bar ("accept edits on", "shift+tab to cycle", "update available") as a question, which raised false "waiting on you" items.
- **Install as an app:** Chrome and Edge can install AI Agent Manager as an app (the install icon in the address bar), so it opens in its own window with a Dock or taskbar icon.

## 1.0.1 (2026-10-26)

- **Name:** the product is now called **AI Agent Manager**, matching the `ai-agentmanager` package. The command is still `agentmgr`.
- **About:** the version next to the title opens an About box with the release date, author, license, links and this daemon's details; **Check for updates** asks npm for the newest version. `agentmgr about` (`--check`) in a terminal.
- **Dependencies:** DOMPurify 3.4.17, body-parser 2.4.0, Mermaid 12.

## 1.0.0 (2026-10-25)

- **License:** Apache-2.0 (was MIT).
- **Remote access is off until you turn it on** (`agentmgr remote on`). Installs that had it on keep it on.
- **AI judge visibility:** the bottom of the Inbox shows today's calls with **Turn off** / **Turn on**; also `agentmgr judge [on|off]`.
- **Hub:** `agentmgr hub serve` also listens on this Mac's Tailscale address, and **Add machine** gives a join command other machines can reach (or says why they can't).
- **Linux:** a clear message when Chrome's sandbox can't start; `browserNoSandbox` to run without it.
- **Upgrades:** the state file is versioned, backed up at startup, migrated with a backup, and never overwritten by an older version.
- **Plugins:** policies that can refuse actions, audit listeners, extra API routes and engines on the daemon; sign-in methods, request policies and audit on the hub ([docs/plugins.md](docs/plugins.md)).
- **Packaging:** `npm i -g ai-agentmanager` (the command is `agentmgr`), `agentmgr --version`.
- **Installer:** the site's `install.sh` puts the program in `~/.local/share/agentmanager` and never touches `~/.agentmanager`, where your agents and workspaces live. It used to replace that folder.
- **Start at login:** `agentmgr service install` keeps `AGENTMGR_PLUGINS` and `AGENTMGR_HUB_PLUGINS`.
- **UI:** long agent names stay on one line, with the buttons below.
- **Project:** CI on macOS and Linux, SECURITY.md, CONTRIBUTING.md, code of conduct, architecture notes.

## 0.5.0 (2026-10-23)

- **AI judge:** rules decide when to look, a fast model decides what is going on: stuck agents (with a specific nudge), idle screens no rule matched, whether "done" work meets the intent, colliding changes, backlog order and splits, and which alerts interrupt you. Learns from your reactions.
- **CLI sign-in links:** `railway login`, `gh auth login --web` and similar open where the callback reaches the waiting CLI, from any device.
- **Live browser tabs:** a real Chrome on the machine, streamed into the tab, with typing, scrolling, popups as tabs, the phone keyboard, sharp frames on retina screens and one-way sound.
- **Continue terminal sessions:** import Claude Code sessions started with a plain `claude` and continue them as agents.

## 0.4.0 (2026-10-21)

- **Engines:** Codex CLI and Antigravity CLI next to Claude Code, behind one adapter.
- **Browser tabs:** open any address next to an agent's terminals, relayed over HTTPS to signed-in remote devices.
- **Human vs AI** review with a second-model critique; optional plan review before an agent implements.
- **Hub sign-in links:** open a machine's own page signed in, with a one-time ticket.

## 0.3.0 (2026-10-18)

- **Hub:** one place for agents on several machines: fleet view, control, a shared backlog that starts work where there's room, Google sign-in.

## 0.2.0 (2026-10-18)

- **Decision inbox, conflict radar, stuck detection, checkpoints and forks, races.**

## 0.1.x (2026-10-03 to 2026-10-09)

- First release: one background agent per intent, CLI, daemon and web UI, worktrees per agent, briefs, results, phone access, multiple shells and file attachments, swipe to scroll on phones.
