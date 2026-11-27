# AI Agent Manager

Run one background [Claude Code](https://claude.com/claude-code) agent per intent, and keep track of them from a web UI or the `agentmgr` CLI.

![Agents grouped by project, with an agent's brief: results, problem, solution, a flow diagram and checks](docs/images/agents.jpg)

![The conflict radar: two agents changed the same lines of README.md; the AI judge rates it a collision and suggests which lands first](docs/images/conflict-radar.jpg)

- **Intents in, agents out.** Give a list, one per line (say, a ticket each), and each becomes its own `claude` process. Or pick **One agent for all of it** and a long description goes to a single agent as written.
- **Issue links.** A request that starts with a Jira link is named after the issue (`ABC-123`) and described by its summary, fetched from Jira Cloud (public issues as they are; your company's site after **Settings → Jira**: site, email and API token, kept on this computer and sent only to that site). Without access, the words after the link describe it.
- **Repo or folder.** Give a git URL (cloned once, then each agent gets its own worktree and branch) or a local folder.
  - **Fast clones.** URLs are cloned as partial clones (`--filter=blob:none`): history now, file contents only for what's checked out.
  - **Progress.** Clone and checkout progress shows in the UI and `agentmgr ls`.
  - **Cancel and retry.** Deleting an agent during setup cancels the clone. A failed or interrupted setup can be retried.
  - **Big repo you already have?** `-d <your clone> -w` gives each agent its own worktree of it in seconds.
  - **Plan while it clones.** A planning session lets you talk the task through with Claude while the clone runs. The same session then moves into the repo with the whole conversation.
- **Background terminals.** Agents run inside the daemon's PTYs. Open any agent's live terminal in the browser (**Open terminal**) or in your shell (`agentmgr attach`). Closing the view leaves the agent running.
- **Session IDs are kept.** Each agent is started with a known `--session-id`. **Close session** stops the process but keeps the ID, and bringing it back runs `claude --resume <id>`. **New session** adds another ID to the agent's history; earlier ones stay resumable.
- **Tracking.** For each agent you see its session ID, working folder, repo, branch, head commit, uncommitted changes, PRs and bugs.
- **Results.** The end result at a glance: ✅ done, 🟡 partial, ⛔ blocked or 🔄 in progress, with what was delivered and what's blocking it.
- **Brief per agent.** Each agent keeps a living brief that the UI shows next to its terminal:
  - **Problem**, **Solution**, a **design / flow diagram** (Mermaid) and **Checks** (passed / failed / running / pending);
  - when the intent links a Jira issue, **References** with its **PRD** and **Tech Spec** links and the points that matter.
- **Projects.** The sidebar is a tree, project → agents, so you see how many projects are in flight and how many parallel sessions each has.
- **Project shortcuts.** Each project gets a short name, such as `cc` for cloud-console. Use it instead of the repo URL: `agentmgr add @cc "…"`, `agentmgr ls cc`, `@cc` in the UI filter.
- **Backlog.** Queue asks as work orders. Agents pick them up one by one, up to N in parallel per project, until each is done. You accept or reopen each one.
- **Updates for the people who asked.** When an agent finishes or opens a pull request, a short Slack message, a short email and the details they point to are written for you to read, change and send.
- **Alerts, in Slack and on the phone.** A Slack message, a notification on the phone, or both, when an agent needs input, finishes a backlog item, or fails.
- **Priority.** Mark agents P0–P3. P0 and P1 are highlighted, and lists sort by priority.
- **Share for review.** One click writes an **Analysis**, **Design**, **Flow** or **Proposal** document from the agent's work, a human time **Estimate** for planning, or the change's **Documentation** with an OpenAPI spec of any API changes. Copy it as Markdown, download it, or print it to PDF with diagrams.
- **Plan.** A project's commitment dates (code complete, release candidate, GA) with a checklist of what is still open for each, reminders as they come near, and an at-risk or late flag. A **decision log** gathered from plan reviews, your answers and design docs. A **tech debt radar** from git history and the code. What is open can be handed to an agent.
- **Your day.** Connect your calendar and Today lays the day out around your meetings: the free time between them with what needs you placed in it, and what each meeting is about.
- **Debug.** Say what to debug (a failure, instability at max scale, slowness under load) in the **Debug** tab beside an agent's session. The agent investigates there and writes a report next to it: animated diagrams of the code path and the data flow with where it breaks, findings with evidence, likely causes and recommended fixes. It changes no code until you press **Apply fixes**.
- **Usage.** How much of each engine's plan limits is used and left (Claude Code's 5-hour session and week, Codex's), and when they reset: a chip by the connection light, an alert near a limit, an option to hold new work at a percent, and one click to start new agents on another engine.
- **Reverse engineer.** Name a target (an app's folder, a binary, a website) and what you want to understand, in the **Reverse** tab beside an agent's session: the agent investigates with [REA](https://github.com/morluto/rea)'s tools and keeps a report with animated diagrams of how it works, the evidence, what could not be determined, and a plan to build your own version.
- **Security audit.** **🛡 Security audit** in an agent's detail (or the **Security** tab of the split, or `agentmgr audit`) has the agent audit the code in its session: it maps where untrusted input comes in, follows it through the code, runs the project's own dependency audit, and checks every finding a second time before listing it. The report beside the session has the attack surface as an animated diagram, findings by severity with evidence and a fix, what was checked and found sound, and what was not covered. It changes no code until you press **Fix findings**. It finds what a careful reader finds; it does not replace a penetration test.
- **Skills.** **Skills…** in the menu (or `agentmgr skills`) lists the Agent Skills Claude Code has here, yours and each project's, with which agents used them. Add more from a git repository (`anthropics/skills`, or any https address): you see what it offers first, with each skill's scripts flagged, then pick. A skill added here remembers its repository and commit, so **Check** says when a newer version is there and **Update** brings it; one you edited says so.
- **Board.** **Board** in the top bar (or `B`, `#board`): every agent as a card in the column for where its work stands: starting, working, needs you, waiting, in review, done, closed. Cards move by themselves; drag one onto **Closed** to close its session, or from Closed onto **Waiting** to resume it.
- **Lanes.** Every agent gets a range of ports and a name ending no other agent has, in its environment and its instructions, so dev servers and test databases of agents working side by side don't collide. **OS** shows what each open session listens on (`agentmgr lanes`).
- **Review rounds before a pull request.** When an agent says it is done, critics on other models of the engine it runs on read its changes in the background and report what is wrong or missing. Their findings go to the agent's session, it fixes them, and they look again: until they approve or the rounds run out. Approved changes are committed, pushed and opened as a pull request that says what was found and fixed, so the bugs are met here and not by the pull request's reviewers. See [Review rounds](#review-rounds-before-a-pull-request).
- **Local models.** Models served on this computer by Ollama, LM Studio, llama.cpp or MLX are found by themselves, and an agent can run on one, with the Codex CLI, OpenCode or Claude Code as the harness: no plan, no limits, nothing leaves the machine (`agentmgr models`).
- **Lean output.** A switch in **Usage** (off by default; `agentmgr usage --lean on`): long command output (test runs, installs, builds) is trimmed before the agent reads it, so a plan's limits last longer. Colours and progress redraws go, runs of near-identical lines are folded, and of a long middle only the lines that look like errors or warnings stay; the start and end are kept, and the whole output is saved to a file the agent can read. Claude Code only, for sessions started after you switch it on. Usage shows how much was trimmed.
- **Runbooks for support.** A runbook for the support team written from a release ticket, every ticket of an epic, or a project's code changes in a time frame: what changed, what customers may see, how to check it, troubleshooting, rollback, when to escalate, and what to confirm with engineering.
- **Decide.** Help with the decisions, not only the tasks: a plan to review or an agent's question arrives with its options, the one recommended, why, and the risk; calls you keep making become standing decisions that are handled for you and reported; the backlog is ranked by impact; a date at risk is laid out as choices; and past decisions are looked back on.
- **OS.** The computer the agents run on and how loaded it is right now: processor, load average, memory, swap and disks with the last ten minutes, what each open agent session takes, and the busiest processes.
- **AI News.** The frontier labs' latest releases in one list, newest first: Claude Platform, Claude Code, the OpenAI API and the Gemini API from their release notes, and the other top labs from a daily web search. Each is summarized in a sentence or two, with its links.
- **MCP servers and tools.** See every MCP server Claude Code has in a folder (yours, the project's, claude.ai connectors and plugins) with its tools, sign in to the ones that need it, and run any tool directly, through Claude Code, or in an agent's session.
- **Human vs AI.** It splits the open questions about the work into the top 5 that need your judgment and the ones a model can answer from the evidence. It answers those, then a second model double-checks every answer.
- **Review changes.** Each agent's diff file by file, line comments sent back to the agent as one message, then **Commit all** and **Push & open PR**, without leaving the page.
- **Standup.** Each weekday at 9:00 (or whenever you press **Standup**, or `p`), each agent with news since the last one is read aloud in a sentence or two, each in its own voice: what it did, what it's on, what it needs from you. Agents that need you go first and quiet ones are left out. It stops on an agent that needs you, with its questions beside it to answer by tap, or by voice when **Answer by voice** is on (what you say is read back, then sent when you say "send"). The wording comes from one short tool-less model call, plain wording if that fails. A Slack alert says when it's ready (Alerts). Change the time, weekends and wording in the player, or in config.json: `"standup": { "at": "09:00", "weekends": false, "ai": true, "notify": true }`. Speech is your browser's own; voice answers may be sent to your browser's maker to be turned into text.
- **Map.** A project's folders as tiles sized by their files, with each agent as a badge on the folders it is changing (filled) or reading right now (ring), refreshed every few seconds (**Map** at the top, `m`, or `#map`). A red line joins two agents that changed the same file: they will conflict when merged. A dashed line runs from an agent reading a file to the agent that already changed it, which is the warning before they collide. Each pair is also spelled out above the map. Reading comes from the last half hour of each agent's session; changes from the conflict radar.
- **Design layers.** Map's **Design** view draws a project's code as nested boxes, from the outside in. The **System** layer shows the top-level parts, where the program starts (**start**) and what it talks to (PostgreSQL, Redis, AWS, HTTP APIs and so on, from the packages it imports). Click a box to go one layer in, down to a file's functions and classes; the crumbs go back out. Arrows are the imports between boxes, thicker for more, with callers drawn above what they use. Pick an agent under **Changes of** (or **More → Where its changes sit** on its page) and the boxes it changed are filled. The boxes with code that imports what it changed, but that it did not change itself, get a yellow edge, and the arrows into its change turn yellow: that is where a missed problem shows up. In a busy layer only those are shown (**Show all** for the rest). In a file, **Open the code** and each function open it in the agent's Code tab at that line. It is read from the agent's folder each time its code changes; no model is called for it. **Describe with AI** asks a model once about the layer shown: one tool-less call with the names of its files and folders, what they define and the imports between them (not the code). It writes a sentence on what the layer is and a line on what each box does, and puts a folder with more than 12 entries into 3 to 9 named groups (Entry points, Storage…), each a box to go into, with the arrows between groups. What it wrote is kept for the project, for everyone looking, and marked when files have been added or removed since (**Describe again**). It uses the same engine and model as Explain; `"design": { "ai": false }` in config.json turns it off. Imports are traced for JavaScript and TypeScript, Python, Go (with each `go.mod`), Java and Kotlin; other languages show as boxes by folder. Dependencies, builds and generated code are left out, and a layer shows its 30 biggest boxes. Also `GET /api/layers?project=<key>&agent=<id>&at=<folder or file>` (`focus=1` for where the agent's changes are).
  - **Jump in at a box.** A box's **⋯** (in a file, **Ask or debug**) asks an agent of the project about it, or starts **Debug** in its session there. The question goes with what the box holds, what it uses and what uses it.
  - **Change the design.** Draw what the code should become, and an agent makes it so. Drag from one box to another, or tap one and then the other, for "this should use that". Tap an arrow to cut it. **Move into** puts a file or folder in another folder, and **New part** adds a box. **Write the request** turns the drawing into numbered points, with the files and imports each one touches. You read and edit the request, pick the agent, and nothing is sent until you press **Send**. Afterwards the layer shows the request with each point ✓ once the agent's code does it. With that agent's code shown, the arrows that came since are green and the ones that went are dashed. **Put away** hides it. Also `POST /api/layers/request` (`preview: true` for the text), `POST /api/layers/ask`.
- **Logical view.** Map's **Logical** view draws a project as components and the links between them that imports don't show:
  - **Links found in the code:** a web page or CLI calling the server's HTTP routes (each URL path written in the code matched to the routes, with a router's mount like `app.use('/api', …)`), live streams (WebSocket, server-sent events), programs it runs (git, gh, docker…), hosts it calls, services it uses (PostgreSQL, Redis… from its packages), and files read and written. Routes are found for Express-style servers, Flask and FastAPI, and Go's net/http, gin, echo and chi. Tests are left out.
  - **Rows:** what calls a server or starts the program on top, the servers next, the rest, then the outside systems. Blue arrows are HTTP and live streams, grey are code imports, purple dashed go to the outside. Only the main links are drawn: HTTP, outside systems and each component's biggest code links (three, or two with more than 8 components) (**Show all** for the rest).
  - **Find components with AI:** one tool-less model call with the names of the files, what they define and the links found (not the code). It groups the files into 4 to 12 named components by what they do, from any folder, and names the data each link carries and which way it moves. Links the model adds that the code doesn't show are dotted and marked guessed. What it found is kept for the project, and marked when files were added or removed since (**Find again**). Before that, the components are the top-level folders.
  - **Tap a box** for what it does, the files and folders in it (each opens in the Design view) and its links; **tap an arrow** for the data, the routes called and where in the code. **Changes of** lights up the components an agent changed.
  - Also `GET /api/logical?project=<key>&agent=<id>`, `POST /api/logical/describe`.
- **Watch.** Every running agent's session side by side on one page, live (**Watch** at the top, or `#watch`), so you follow them all without clicking from one to the next. Tiles keep a fixed order; one waiting on you gets a red border and is counted at the top. Click a tile and type to answer it there; its name opens the agent. Show running agents, only those waiting on you or only those working, one project's, or a fixed number per row; **Fit** sizes the tiles so all of them (up to 12) are on screen, keeping the newest lines in view. Tiles show each session at its own size and never resize it.
- **Three columns.** On a wide window the views sit in a column at the left, grouped (Work, Review, Plan, Insights, This computer), beside the agent list and the agent's page. The button left of the logo puts them back in the top bar (with **More**), and each device remembers which; on a narrower window or a phone they are in the top bar. Wherever this README says "in the top bar", the view is in that column too. A view picked there opens in the pane at the right, beside the agent list, instead of over the page (Map too); picking an agent, another view, its Close or Escape puts it away, and its expand button (`f`) widens it over the list. The three buttons left of the logo hide or show each column (the views, the agent list, the page): hidden views go to the top bar, the list and the page can't both be hidden, and picking an agent or a view shows the page again. An agent's page keeps its main actions in its bar (Open terminal, Close session, Open shell, Review changes, Timeline, Edit); the rest (New session, Open in Claude desktop, Debug, Security audit, Reverse engineer, MCP tools, Fork, Refresh, Keep, Delete) are under its **More**.
- **Go to.** `Ctrl+K` or `⌘K` (or **⌕ Go to** in the top bar) opens one box that finds a view, a list, a menu item or an agent by name; agents that wait for you come first. On a phone it saves looking through the More menu.
- **Keyboard shortcuts.** Press **?** for the list. `j`/`k` move through the agents, `Enter` opens the terminal, `r` reviews changes, `s` resumes, `Shift+X` closes the session, `e` edits; `n` new agents, `a` Ask Agent, `/` filter, `w` Watch, `m` Map, `p` the standup, `i` the Jira summary, `d` Designs, `1`-`5` the side tabs. Single keys work when you're not typing in a field or a terminal. From inside a terminal, `Ctrl+Shift+↓`/`↑` switch to the next or previous agent's terminal and `Ctrl+Shift+L` leaves it.
- **Landing.** A **Land** tab with every agent's open pull request: ready to merge, needs fixes, behind, waiting. Failing checks and requested changes go back to the agent automatically (a few times at most), and so does every new review comment while the PR is open; **Update**, **Ask to fix** and **Merge** in one click.
- **Triggers.** A label on a GitHub issue starts an agent for it, `/agent …` comments on an agent's pull request reach the agent, and a webhook starts agents from Jira automation or CI. No model watches, so no tokens are spent waiting.
- **Repo memory.** What one agent learns about a repo (how to run its tests, a gotcha) is recorded in one line and given to every later agent there.
- **Playbooks.** Saved requests with `{{values}}`, run in several projects at once (one agent each), by hand or every hour, day, weekday or week.
- **Results.** Merge rate, time to a first PR and to merge, and cost per merged PR, by engine and model, by source and by project.
- **Budgets.** What agents cost today and lately, a budget per agent (an alert at 80%, closed at 100%) and a daily limit for all of them.
- **Plan review.** Optionally, the agent writes an implementation plan and waits for your approval before changing anything.
- **Insights.** Why, What, How and Now for any agent, three memorable points each.
- **Explain.** One click gives a plain-language explanation of the intent and the insight behind the problem and solution. It comes from a separate tool-less Claude call, so the agent isn't interrupted.
- **From your phone.** Turn on remote access (`agentmgr remote on`) for HTTPS access on your local network at a plain `https://<ip>:<port>`. Sign in with a QR code, and answer Claude's prompts with a key bar and reply box. Nothing to install.
- **Never loses state.** `agentmgr flush` (also every 30 s and on shutdown) saves session IDs, terminal scrollback and usage. `agentmgr restart` brings everything back.
- **Follows your conventions.** Before changing anything, agents review `CLAUDE.md` / `AGENTS.md`, skills, hooks and settings (repo and `~/.claude`), and follow them.
- **Tokens and cost.** Input, output and cache tokens are tracked per session, subagents included, alongside the cost Claude Code reports.
- **No trust prompt.** Folders agents run in are pre-trusted, so Claude's "trust this folder" prompt doesn't block them.
- **Survives restarts and reboots.** Agents that were running when the daemon stopped (restart, crash or reboot) are resumed with the same session IDs when it starts again. For that after a reboot, turn on **Start at login** in ☰ → Settings (or run `agentmgr service install`); without it, the daemon starts only when you run `agentmgr`.
- **Shells next to each agent.** **Open shell** gives a terminal in the agent's folder for running commands by hand. **+ Shell** opens as many more as you need, each in its own tab.
- **Browser tabs.** **+ Browser** opens a page as this machine sees it, in a tab next to the agent's terminals. That can be the agent's dev server on `localhost:5173`, a site on its network or VPN, or any address. Local addresses the agent prints are offered as suggestions. It works from your phone or laptop too (see below).
- **Live browser.** Browser tabs run a real Chrome on this machine and stream it into the tab: you see its screen and your clicks, scrolling, typing and paste go back to it, from the laptop or the phone. Because the page runs here, `localhost` is this machine, sites that refuse to be framed load normally, and popups (a sign-in window) open as tabs of their own and come back when they close. Chrome (or Chromium, Brave, Edge; `browserBin` in config.json picks one) runs headless with its own profile in `~/.agentmanager/browser-profile`, so sign-ins are remembered; it starts on the first view and stops after 15 minutes with nobody watching. Downloads go to `~/Downloads/agentmanager`. A site that still refuses it as a bot may accept `"browserHeadless": false`, which runs Chrome with a real window on this machine's screen. On Linux where Chrome's sandbox can't start (containers, Ubuntu 23.10+ user-namespace restrictions) the tab says so; `"browserNoSandbox": true` runs it without the sandbox, at your own risk. **Lite** on the bar switches a tab to the frame mode (the page loads in your own browser; quicker for a dev server).
- **CLI sign-in links.** When a terminal prints a sign-in link that returns to a port on this machine (`railway login`, `gh auth login --web`, `gcloud auth login`...), a bar above the terminal offers **Open sign-in**: the link opens in a live browser tab here, so the provider's redirect to `http://127.0.0.1:PORT/callback` reaches the waiting CLI by itself, from any device. It opens on its own if you just typed the command. Without a live browser, it opens a window on your device; from another device you then paste the address you land on (`127.0.0.1:PORT/callback…`) into the bar and AI Agent Manager delivers it to the CLI, only on the port the link named.
- **Attach files and screenshots.** Drop files on the terminal, paste a screenshot, or use **📎 Attach**. The file is saved on the daemon's machine and its path is pasted into the terminal, which is how Claude Code picks up images and files.
- **Your layout.** Drag the edge of the agent list, or the line between the brief and the terminal, to resize them; double-click a line to reset it. **Expand** (Ctrl+Shift+E) fills the window with the terminal, shell or browser tab; **Full screen** fills the screen. Agents active in the last day sort to the top; idle ones are dimmed.
- **As an app.** In Chrome or Edge, click the install icon in the address bar (or ⋮ → Cast, save and share → Install page as app). AI Agent Manager then opens in its own window with its own Dock or taskbar icon, and the daemon keeps running as before.
- **About.** The version next to the title opens the About box: release date, author, license, links, and how this daemon runs (data folder, port, Node.js, which `claude`). **Check for updates** asks npm for the newest version. In a terminal: `agentmgr about` (`--check` for updates).
- **General sessions.** **Ask Agent** starts a session with no repo, folder or intent, for questions, on Claude Code or any other engine you have (Codex, Antigravity, Muse Code). It is tracked and resumable like any other agent.
- **Drop to start.** Drag tickets, requirements and designs onto the page: a frame says **Drop to start a new agent**, and New agents opens filled in. A Jira, GitHub or Linear issue link becomes the request (the agent is named after the issue and tracks it); a link to a document (Google Docs, Confluence, Notion, a PDF) is listed under it as **Requirements** and a design link (Figma, Miro, an image) as **Design**; a repository link fills the repository; text becomes the request; files are attached. Several tickets give one agent each. The box at the top of the form takes the same drops and says what was added; nothing starts until you press the button. Without a mouse, **Paste what you copied** reads links from the clipboard and **Choose files** opens the picker.
- **Attachments.** **📎 Attach files** in New agents and Ask Agent (or drop files on the dialog, or paste a screenshot into the text box) adds a screenshot, a log or a document to the request. Each agent gets its own copy in `~/.agentmanager/uploads/<agent>/`, listed in its request, and Claude Code and Codex can read that folder without asking. From the CLI: `agentmgr add … --file-attach error.log` and `agentmgr ask … --file-attach shot.png`.

New in 0.2, for running many agents at once:

- **Decision inbox.** One **Inbox** tab for everything waiting on you, across agents: prompts that need an answer (answer them with one click), questions agents ask without stopping, agents that seem stuck, and overlapping changes. Answers are typed into the agent's session for you.
- **Conflict radar.** Agents in the same repo that change the same files are flagged while they work, not at merge time, with "same lines" called out and a suggested merge order. **Tell both** lets each agent know.
- **Stuck detection.** Spots an agent going in circles (the same failure again and again, undoing its own edits, a long stretch with no file changed) and offers a ready-made nudge to send.
- **AI judge.** Rules only decide *when* to look; a fast model decides *what is going on*: whether a stuck-looking agent is really stuck (and a nudge specific to its problem), what an idle agent is asking when no known prompt matched, whether "done" work actually meets the intent, whether two agents' work will collide, what the backlog should start next, and which alerts are worth interrupting you for. It learns from how you react.
- **Checkpoints and forks.** The code (uncommitted work included) and the conversation are saved at the end of every turn. **Fork** starts a new agent from now or from any checkpoint, in its own worktree, to try another direction without losing the first.
- **Teams.** Give one problem to a team of agents in roles: an analyst writes the analysis, critics challenge it until they agree, then an implementer builds it, a tester tests it and a reviewer approves it or sends it back. You step in at the end, or when they can't agree.
- **Races.** Send one intent to several agents with different models or approaches. Compare their outcome, checks, size of change, cost and a test command run in each worktree, read their diffs side by side, then pick a winner and delete the rest.

## When to use it

Claude Code on its own, including its built-in ways to run work in parallel, is enough for one repo in one sitting. AI Agent Manager is for when that stops being enough:

- **Many sessions across several repos,** running for hours, where you lose track of which one is waiting on you.
- **Agents that must survive** a closed terminal, a restart or a reboot, and pick up where they left off.
- **Several agents in one repo,** each on its own worktree and branch, with a warning when two touch the same code.
- **Keeping up without reading transcripts:** a brief per agent (result, problem, fix, checks) and one inbox for every prompt and question.
- **From anywhere:** your phone, another computer, or several machines through the hub.

**Trying it costs little.** It runs the same `claude` you already use, with your plan and your repo's `CLAUDE.md` and skills. Sessions you started with `claude` in a terminal or in the Claude desktop app can be continued in it (**Import** above the agent list), and you can go back any time: to a plain terminal with `claude --resume`, or to the desktop app with **Open in Claude desktop**.

## Install

Runs on macOS and Linux; on Windows, use WSL2. Requires Node 20+, `git`, and the `claude` CLI, signed in (run `claude` once). Optional: `gh` (authenticated) for PR discovery by branch and PR state, Chrome (or Chromium, Brave, Edge) for live browser tabs, and Codex (`npm i -g @openai/codex`) as a second engine.

**Stable release (recommended).** Releases are tagged (`v1.0.0`, `v1.0.1`, …) and listed on the [Releases](https://github.com/jdmunta/ai-agentmanager-core/releases) page, with changes in [CHANGELOG.md](CHANGELOG.md).

```sh
npm install -g ai-agentmanager          # the latest release
npm install -g ai-agentmanager@1.11.1    # or a specific one
```

Or from the repository, at a release tag:

```sh
git clone --branch v1.11.1 --depth 1 https://github.com/jdmunta/ai-agentmanager-core.git
cd ai-agentmanager-core
npm install
npm link            # optional: puts `agentmgr` on your PATH
```

**Development version (`main`).** New features land on `main` first, before they're released, so it can be less stable.

```sh
git clone https://github.com/jdmunta/ai-agentmanager-core.git
cd ai-agentmanager-core
npm install
npm link
```

**Updating.** `agentmgr update` installs the newest release and restarts onto it; running agents pause briefly and resume. In the app, **Update to …** appears in the top bar when a release is out (checked twice a day; turn it off in **☰ → Settings** or with `agentmgr update --auto-check off`), and **About → Update and restart** does the same. Either one opens a window that asks first, then shows each step as it happens: the install (how long it has taken, how many packages npm has fetched and its last line), the restart, and the page's reload. If the install fails, the error stays on screen with the command to run by hand, and nothing is restarted. Both work from a signed-in phone too: the install and restart run on the computer, and the page reloads when it's back. A clone at a release tag (or one you `npm link`ed) moves to the newest tag; a clone on a branch or with uncommitted changes is left alone. By hand, use the command for how you installed, then `agentmgr restart`:

| Installed with | Update |
| --- | --- |
| npm | `npm install -g ai-agentmanager@latest` |
| A clone at a release tag | `git fetch --tags && git checkout v1.11.1 && npm install` (the tag you want) |
| A clone of `main` | `git pull && npm install` |

**Check your setup.** `agentmgr doctor` checks Node.js, Claude Code and its sign-in, git, `gh`, the data folder, the daemon's port and Chrome, and says how to fix anything missing.

## Quick start on a new computer

**A computer that runs agents.** After installing:

```sh
agentmgr ui                  # starts the daemon, opens http://127.0.0.1:4717
agentmgr service install     # optional: start the daemon at login, and bring agents back after a reboot
agentmgr remote on           # optional: open it from your phone (prints the address and QR code)
```

To update later: `git pull && npm install && agentmgr restart`. Running agents come back with the same sessions.

**Adding it to a hub.** If you already run a hub (see [Several machines: the hub](#several-machines-the-hub)), get a code where the hub runs, then join from the new computer:

```sh
agentmgr hub invite                                    # on the hub's machine (or anywhere with AGENTMGR_HUB_TOKEN set)
agentmgr join https://<hub-address> <CODE> --name laptop
agentmgr hub status                                    # connected, and what the hub may do
```

A new machine shares `view` only. To let the hub answer, control, start agents or open terminals, set `"hub": { "allow": [...] }` in `~/.agentmanager/config.json` and run `agentmgr restart` (permissions are in the hub section).

**A computer that runs the hub.** Pick a Mac that stays on (it can also run agents), on Tailscale so other machines reach it privately:

```sh
nohup agentmgr hub serve >> ~/.agentmanager/hub.log 2>&1 &
grep 'sign in' ~/.agentmanager/hub.log       # first start prints the sign-in link; later: agentmgr hub token
```

The hub listens on port 4720, on this Mac and on its Tailscale address (`--host` picks one address instead). Sign in with that link; **Add machine** gives a join command with the Tailscale address, so it works from the other Macs. Its state (token, machines) is kept in `~/.agentmanager/hub/`, so a restart keeps everything joined. To run the hub on Railway instead, see "On Railway" in the hub section.

## Use

```sh
agentmgr ui                                   # start the daemon and open http://127.0.0.1:4717
agentmgr service install                      # start the daemon at login (launchd / systemd --user)
agentmgr doctor                               # check Node.js, Claude Code, git, gh, the port; says how to fix

agentmgr add "Fix the flaky login test" -d ~/src/app
agentmgr add -r https://github.com/org/repo.git \
  "Add pagination to /users" "Investigate ABC-12345 and open a fix PR"
agentmgr add -f intents.txt -r git@github.com:org/repo.git -p acceptEdits
agentmgr add --plan -a -r https://github.com/org/big-repo.git "Fix ABC-123"   # plan with Claude while it clones
agentmgr add -d ~/src/big-repo -w -b release-1 "Backport the fix"          # worktree of your clone, branched from release-1

agentmgr ls [cc]                              # status, branch, PR/bug counts, session (optionally one project)
agentmgr add @cc "Fix the flaky test"         # use a project shortcut instead of -r / -d
agentmgr project ls | add | rename | base | rm  # manage project shortcuts
agentmgr show <agent>                         # everything tracked for one agent
agentmgr attach <agent>                       # live terminal here; Ctrl-] detaches (resumes a closed agent)
agentmgr shell <agent> [-n 2]                 # a shell in the agent's folder (-n picks another one); Ctrl-] detaches
agentmgr brief <agent>                        # print the agent's brief (Markdown)
agentmgr priority <agent> P0                  # P0 urgent, P1 high, P2 normal (default), P3 low
agentmgr doc <agent> proposal -o p.md         # analysis | design | flow | proposal | estimate | documentation
agentmgr doc <agent> all --background         # write them all (and Human vs AI) in the background
agentmgr insights <agent>                     # Why / What / How / Now, three points each
agentmgr explain <agent>                      # full briefing: ask, status, plan, solution, conclusions, needs
agentmgr remote on | off | status | rotate    # phone / remote access (see below)
agentmgr backlog add "ask" -r <repo> [-p 1]   # queue work; also: ls, start, accept, reopen, move, limit, pause
agentmgr notify slack --webhook <url>         # Slack alerts; also: test, status, on, off, event <name> on|off
agentmgr announce <agent>                     # what to tell the people who asked: a Slack message, an email and the details (--post, --link <url>; no agent: the settings)
agentmgr notify phone                         # the same alerts as notifications on the phone (ntfy app); --off stops them
agentmgr debug <agent> "what goes wrong"       # debug with an agent; no question prints its report; --fix applies the fixes
agentmgr reverse <agent> -t /path/to/app "how does search work"  # reverse engineer with an agent and REA; no question prints the report; --build builds your own
agentmgr dates <project> --cc 2026-12-01 --rc 2026-12-10 --ga 2026-12-20   # commitment dates; no dates: where each stands
agentmgr decisions [project] [--md]           # the decision log; --add "<question>" --decision "<what>" adds one
agentmgr debt <project> --scan                # the tech debt radar: files that change often and are hard to read
agentmgr audit <agent> --start                # security audit in its session (a scope in words, --fix "1 and 3"; no arguments: the report)
agentmgr skills                               # Claude Code's skills here (look <repo>, add <repo> <names...>, check|update|rm <id>)
agentmgr lanes                                # every agent's own ports and name ending (--off, --port off, --base, --size)
agentmgr rounds [agent]                       # review rounds before a pull request: the settings, or an agent's rounds (--start, --again, --open, --stop)
agentmgr screen                               # this computer's screen in the page, from the phone too: on or off (--on, --off), who is viewing
agentmgr awake [off|working|always]           # keep this computer from going to sleep by itself: always, or while an agent works
agentmgr models                               # models served on this computer (Ollama, LM Studio, llama.cpp, MLX), for --engine local
agentmgr usage                                # each engine's plan limits: used, left, resets (--now, --lean on, --warn 80, --hold 95, --default codex)
agentmgr runbook --ticket REL-42              # a support runbook from a release ticket (or --epic KEY, or --since 2026-10-01 -p <project>; -o file.md)
agentmgr decide                               # what waits for your decision, with its recommendation (--do <n>, --handled, --standing, --autonomy p=level, --priority, --risk)
agentmgr os                                   # this computer and its load: processor, memory, disks, what each open session takes (--json)
agentmgr news                                 # the frontier labs' latest releases, summarized (--refresh, --lab, --days)
agentmgr inbox                                # prompts, questions, stuck agents and overlaps waiting on you
agentmgr answer <agent> <question-id> "…"     # answer a question from the inbox
agentmgr tell <agent> "…"                     # send a message into the session (when it's idle)
agentmgr fork <agent> [-c 3] [-m "…"]         # new agent from now (or checkpoint 3), its own worktree
agentmgr checkpoints <agent>                  # snapshots saved at the end of each turn
agentmgr team start "problem" [-r <repo> | -d <folder>] [-c 2] [--separate] [-t "npm test"] [--role-model reviewer=opus]
agentmgr team show [team] | ask <team> "…" | finalize <team> [--merge | --publish | --keep] | send-back <team> "…" | continue <team> ["note"] | skip <team> | stop <team>
agentmgr race start "intent" -v opus -v "sonnet|keep it small" -r <repo> -t "npm test"
agentmgr race show [race] | test <race> | pick <race> <agent> [--cleanup]
agentmgr flush                                # save session IDs, scrollback, usage and state now
agentmgr restart                              # flush, stop and start the daemon; agents resume
agentmgr plan <agent>                         # plan with Claude while the workspace is still being prepared
agentmgr handoff <agent>                      # move a planning session into its ready workspace now
agentmgr ask ["question"]                     # general session with no repo or folder
agentmgr stop <agent> | --all                 # close the session, keep its ID
agentmgr start <agent> [--fresh | -s <session>]
agentmgr sessions <agent>                     # every session ID this agent has used
agentmgr link <agent> --pr <url> --bug ABC-123
agentmgr rm <agent> [--delete-workspace]
agentmgr shutdown
agentmgr service status | uninstall
```

`<agent>` can be the ID, a unique ID prefix, or the name. Every command starts the daemon if it isn't already running.

### Statuses

| Status | Meaning |
| --- | --- |
| `preparing` | Cloning or checking out the worktree (with progress) |
| `planning` | A planning session is running while the workspace is prepared |
| `working` | Claude is producing output |
| `waiting` | Claude is idle, waiting for its next instruction |
| `needs input` | A trust or permission prompt is blocking the agent. Open its terminal to answer. |
| `stopped` | Closed by you or by a daemon restart. Resumable. |
| `exited` | Claude exited on its own (for example `/exit`). Resumable. |
| `error` | Workspace setup or launch failed. See the error message. If setup failed, **Retry setup** (or `agentmgr start <agent>`) runs it again. Setup interrupted by a daemon restart is retried automatically. |

Agent folders are pre-trusted (see below), so new agents don't stop at Claude's "trust this folder" prompt.

## Sharing one big repo between agents

Every agent gets **its own worktree and its own branch** (`agent/<name>-<id>`) of one shared clone. Git history is stored once, and each agent only adds its checked-out files, so a new agent on a repo that's already there starts in seconds.

- **Repo URL** (`-r <url>`): the first agent clones it into `~/.agentmanager/repos/`. Later agents with the same URL reuse that clone after a quick fetch.
- **A clone you already have** (`-d <folder> -w`, or the folder field with the worktree box ticked, which is the UI default): agents get worktrees of your clone. Your own checkout and branch are never touched.

**Where branches start.** By default each agent branches from the repo's **default branch, freshly fetched** (`origin/HEAD`, usually `origin/main`). That holds even if your clone is checked out on another branch or is behind. To start somewhere else, use `--base <ref>` (or the **Base branch** field):

- a branch name such as `release-1`, which uses `origin/release-1` when the remote has it;
- a tag or a SHA;
- `HEAD` for the folder's current checkout.

**Other details:**

- **Offline.** If the fetch fails (offline, no access), the refs already present are used.
- **No upstream.** Agent branches are created without an upstream, so Claude's first `git push -u origin <branch>` sets the right one. They never accidentally track `origin/main`.
- **Where it shows.** The agent shows **Branched from** with the ref and commit it started at.

## Continue sessions started in a terminal or the Claude desktop app

**Import** (next to **Save now** in the agent list) lists the Claude Code sessions you started yourself on this machine, from the last 7, 30 or 90 days: with `claude` in a terminal, in the Claude desktop app's Code tab (marked **Claude desktop**, with its title there), or in an editor. They're grouped by folder, with title, first and last ask, branch, size and last activity. Headless runs (`claude -p`, the SDK, built agents) and AI Agent Manager's own agents are left out. Each one you pick becomes an agent in the same folder that continues the same conversation (`--resume`), with the brief, inbox, PRs and usage tracked from then on.

A session still open in a terminal or the desktop app is marked **open in a terminal** / **open in the desktop app** (a running `claude` names it) or **maybe open** (a `claude` runs in that folder and the session was active minutes ago). Two places writing one conversation would mix it up, so those continue as a **copy** under a new session ID and the terminal keeps the original. For the same reason, an agent that follows a `/clear` to a new session never picks up a headless run or a session a terminal has open in its folder.

### Open an agent in the Claude desktop app

**Open in Claude desktop** on a Claude agent (or `agentmgr desktop <agent>`) continues its conversation in the Claude desktop app, using Claude Code's own hand-off (`claude --desktop --resume`). Its session here closes first, and until you resume it here, messages for it (yours, Autopilot's, Landing's) wait instead of starting a second copy. **Resume** picks up what was said in the desktop app, since it's the same session; close it in the desktop app first. Needs macOS or Windows and Claude Code signed in with a Claude subscription; when Claude Code refuses, the reason is shown. Agents in a container, and agents moved to another machine, can't be opened there.

With Remote Control on (`"remoteControlAtStartup": true` in `~/.claude/settings.json`), running agents also show in the Claude apps while they run, as live sessions.

## Restarts and reboots

Every agent records whether you want it running:

- Starting or resuming it means **running**.
- **Close session** / `agentmgr stop`, or Claude exiting on its own (`/exit`), means **stopped**.
- A daemon restart, a crash or a reboot changes nothing.

When the daemon starts, it resumes every agent you left running with `claude --resume <session-id>`. Set `"autoResume": false` in the config to turn that off.

To have that happen after a reboot, install the login service once:

```sh
agentmgr service install     # macOS: ~/Library/LaunchAgents/com.agentmgr.daemon.plist
agentmgr service status
```

- **Environment.** The service runs the daemon through your login and interactive shell (`$SHELL -l -i`), so agents see the same environment as your terminal, including tokens exported in `~/.zshrc` such as `GITHUB_TOKEN`.
- **Restarts.** launchd restarts the daemon if it crashes, but not after `agentmgr shutdown`.
- **Linux.** It installs a systemd user unit instead. Run `loginctl enable-linger $USER` if it should start at boot before you log in.

## Where things come from

| Field | Source |
| --- | --- |
| Session ID | Assigned by agentmgr (`--session-id`). If Claude switches sessions mid-run (`/clear`), the new transcript in the agent's folder is adopted. |
| Folder / repo / branch | The workspace agentmgr prepared, plus `git` in that folder |
| PRs | `pr-link` records in the session transcript (PRs Claude created), `gh pr list --head <branch>`, PR URLs mentioned in the conversation, and links you add |
| Bugs | Refs in the intent and the conversation (Jira links with `/browse/KEY-1`, `?selectedIssue=KEY-1` or `/issues/KEY-1`; GitHub issue URLs), custom `bugPatterns`, and links you add |
| Title / cost | `ai-title` and `cost-state` records in the transcript |

Removing a detected link dismisses it, so it doesn't come back on the next scan.

## Planning while a repo clones

Cloning a big repo can take a while. Tick **Plan with Claude while the repo clones** (the default in the UI), or use `add --plan`. For an agent that is already cloning, click **Plan while it clones** or run `agentmgr plan <agent>`.

1. **Planning.** Claude runs in `~/.agentmanager/planning` with the agent's own session ID. It is told the repo isn't there yet and to clarify the task with you: ask questions, gather requirements, agree on a plan. It doesn't edit files.
2. **Handoff.** When the workspace is ready, the session's transcript is copied into the repo folder and the same session resumes there (`claude --resume <id>`). Claude gets the message "The repository is ready … continue with the plan we agreed on" and has the whole planning conversation. The session ID doesn't change.
3. **Timing.** It moves by itself once the workspace is ready and Claude has been idle for `handoffIdleSec`, with no click needed. If you have the terminal open, it also waits until you haven't typed for 15 seconds, so it never cuts you off mid-sentence. **Continue in repo** (or `agentmgr handoff <agent>`) moves it right away.

If setup fails while you're planning, the planning session keeps running and **Retry setup** tries again.

## The brief

Every task agent is told, on each launch, to keep a short brief in `~/.agentmanager/briefs/<id>/BRIEF.md`. The file is outside the repository, so it never gets committed. The sections are:

| Section | Contents |
| --- | --- |
| `## Problem` | What's wrong or needed, and why |
| `## Solution` | The approach and key changes, kept current |
| `## Diagram` | One ` ```mermaid ` block: flow, sequence or architecture |
| `## Checks` | `- [ ]` pending, `- [~]` running, `- [x]` passed, `- [!]` failed, with the command or evidence |
| `## Results` | `Outcome: in progress \| partial \| done \| blocked`, then `- Delivered: …` (PRs, commits, files, docs, answers) and `- Blocked by: … (needs: who/what)` |
| `## References` | Only when the intent links Jira issues. The agent looks them up with its own Jira / Atlassian tools (no credentials in agentmgr) and lists the **PRD** and **Tech Spec** fields as links with highlights, plus other design docs. Empty fields are listed as "none". |

How it behaves:

- **Display.** The UI shows the brief as a panel with a rendered diagram, check icons and highlighted PRD / Tech Spec links. The agent list shows check counts and PRD / Tech Spec chips. `agentmgr show` summarizes it, and `agentmgr brief <agent>` prints it.
- **Updates.** Changes show up within a second while the agent runs.
- **Planning.** Planning sessions start the brief too, so Problem, the proposed Solution and the References can be filled in before the clone finishes.
- **Permissions.** Claude gets `--add-dir` access plus `Write` / `Edit` permission rules for its brief folder only, so writing the brief never stops at a permission prompt. Everything else keeps your normal permission mode.
- **Safety.** Markdown is sanitized (DOMPurify) and diagrams render with Mermaid's `strict` security level.
- **Conventions.** With `reviewConventions` on (the default), agents are also told to read `CLAUDE.md` / `AGENTS.md`, the relevant skills (`.claude/skills`, `~/.claude/skills`), hooks and permissions (`.claude/settings*.json`, `~/.claude/settings.json`), and project commands and agents before working. They record what applies as the first check.
- **Off switch.** Set `"brief": false` or `"reviewConventions": false` to turn these off. Neither applies to general sessions.
- **Existing agents.** Agents started before this version pick it up on their next resume.

## Priority

Every agent has a priority, **P0** (urgent) to **P3** (low). **P2** is the default.

- **Look.** P0 shows a solid red chip and a red bar on the agent. P1 shows a red outline chip, and P3 a muted chip. P2 shows nothing, to keep the list calm.
- **Ordering.** In the **By project** order, agents within a project sort by priority, then needs-input, then running. Projects holding a P0 or P1 agent move to the top and show the chip in their header.
- **Order.** The list starts with the agents created or used most recently on top: one list, each agent with its project. A new agent starts at the top; after that, you or it working in it moves it up (typing, its conversation, its brief); a restart alone doesn't. Above the list, switch to **Running first** (running agents on top, most recently used first, then the rest), **Newest first** (by creation date, the newest on top), **By priority** (P0 first and P3 last, each agent with its priority shown; within a priority, the same as the default) or **By project** (the grouping described here). Next to it, pick a project to see only its agents. Each browser remembers both choices.
- **Setting it.** Use the selector next to the agent's name, the New agents dialog, `add --priority P1`, or `agentmgr priority <agent> P0`.
- **Backlog.** Items use the same P0–P3 scale and pass it on to their agents.
- **Slack.** Alerts are tagged `[P0]` / `[P1]`.

## Share for review: Analysis, Design, Flow, Proposal, Human vs AI

The Brief panel's **Share for review** buttons, or `agentmgr doc <agent> <kind>`, write a stakeholder document from the agent's live context: its ask, conversation and actions, repository changes and brief.

| Document | Sections |
| --- | --- |
| **Analysis** | Summary, context, findings, root cause, constraints and assumptions, options considered, open questions |
| **Design** | Summary, goals and non-goals, architecture (with a diagram), components and changes, interfaces and data, trade-offs, risks, testing and rollout |
| **Flow** | Summary, end-to-end flowchart with a step-by-step walk-through, key interactions as a sequence diagram, failure and edge cases |
| **Proposal** | Summary, problem, recommendation, scope, plan, effort and dependencies, risks, decisions needed |
| **Human vs AI** | Your top 5 decisions, each with why it needs you, the stakes, options and what the work suggests, plus a box for your answer. Up to 5 questions the AI answers, each with its confidence, evidence and how to check it. A second model's verdict on each. |
| **Estimate** | Human time estimate for planning: summary with a range and confidence, a task breakdown with optimistic, likely, pessimistic and expected hours, a suggested split into tickets, roles and skills, assumptions, risks and unknowns |
| **Documentation** | Summary, what's new or changed, how to use it, configuration, upgrade and operations notes, docs to add or update, and API changes with an OpenAPI 3.0 spec of the changed endpoints |
| **Diagrams** | Diagrams only, for a quick grasp: the problem, the architecture (with what changes highlighted), the design, the data flow (animated) and the key interaction, plus the plan. Drawn from the documents already written and the agent's work. Optional: **Write all** leaves it out. |

Each drawn diagram has **Copy image** (paste it into Slack, a PR comment or a doc), **PNG** and **SVG**, and a document with diagrams also downloads as one **.html** file. **🔊 Listen** reads Explain, documents and the change walkthrough aloud with the browser's own voices; the walkthrough is read change by change, showing each as it goes.

**Human vs AI.** This review takes two separate read-only calls.
1. **The split.** The agent's engine splits the open questions. *For you to decide* covers judgment calls such as intent, priorities, risk appetite and trade-offs. *Answered by AI* covers reasoning and evaluation: correctness, edge cases, test coverage and what's left.
2. **The second opinion.** Another model reviews that split against the same context. It marks each AI answer *agrees*, *partly* or *disagrees*, with a correction where needed. It marks each of your questions *keep*, *AI could answer* or *reword*, and lists questions both lists missed.

The second model is another installed engine by default (Codex or Antigravity for a Claude agent), because a different provider tends to catch different mistakes. Without one, it's Claude with a different model. Set `"critique": { "engine": "codex", "model": "…" }` in config.json to choose.

Type your answers in the viewer, or tap an option to fill one in. **Send my answers to the agent** passes them on, together with any AI conclusions the second model doubted, so the agent re-checks those.

**Estimate.** A human time estimate for planning: how long one experienced developer who knows the codebase would take to do the ticket by hand, without an AI agent. It's split into tasks of a day or less (understanding, design, each part of the implementation, tests, docs, review, QA, release), each with optimistic, likely and pessimistic hours and the expected (PERT) figure, and a total. Larger work also gets a suggested split into tickets that can ship on their own, with their dependencies. Then come the roles needed, the assumptions, and the risks that could move the number. It's sized from the ticket, the brief and the changes so far.

**Documentation.** The docs for the change: what's new, how to use it, configuration, upgrade and operations notes, and which docs in the repository to add or update. It's written from the actual diff. When the change touches an HTTP API, it adds a table of the changed endpoints and an OpenAPI 3.0 spec covering only those endpoints. **Download OpenAPI** saves the spec as a .yaml file for Swagger, Postman or your API portal.

**How they're written.** Documents name the real files, tickets and docs, separate facts from proposals, and say "To be confirmed" where the context doesn't. They're written for reviewers: no mention of the agent or its tools.

**Sharing.** Each document opens in a viewer:

- **Copy Markdown** pastes cleanly into Confluence, Google Docs, Slack or a PR.
- **Download .md** saves the file.
- **Print / PDF** opens a print-ready page with the Mermaid diagrams rendered. Use your browser's *Save as PDF*.

**In the background.**

- **Starting.** While a document is being written, **Continue in background** closes the viewer, and the writing carries on in the daemon. **Write all in background** starts every document that doesn't exist yet. You get a notification with an **Open** button as each one is ready.
- **CLI.** `agentmgr doc <agent> <kind|all> --background` returns at once. `agentmgr doc <agent> <kind> --cached` prints the result later.
- **Queueing.** At most `summaryConcurrency` (2) of these one-off Claude calls run at once, Explain and Insights included. The rest queue.

**Behaviour.** Documents are kept per agent and marked out of date when the brief changes. They come from the same separate, tool-less Claude call as Explain, so the agent isn't interrupted. On the phone link, the print page needs sign-in like everything else.

## Updates for the people who asked

The people who asked for the work rarely watch it. **Update** (with the documents in the Brief panel, or `agentmgr announce <agent>`) writes what to tell them, from the agent's live context:

- **Slack:** at most five short lines: what it is about and where it stands, what was done, what is left or needed from the reader.
- **Email:** a subject and a short body saying the same, addressed to whoever asked when the work says who that is.
- **Details:** the full write-up both point to: what was asked, what was done, the status, what is left, decisions and risks, and the links. It is a document like the others: **Copy Markdown**, **Print / PDF**, **Listen**.

**They are drafts.** You read them and change them in place, then:

- **Copy** either one, or **Post to Slack**, which asks once more before it posts, since a channel is full of people. It posts to a webhook for updates (`agentmgr announce --webhook <url>`, set on the computer itself) or, without one, to where the Slack alerts go.
- **Open in mail** opens the email in the mail program of the device in your hand, filled in, for you to send from your own address.
- **Link to the details:** paste where they can be read (a Google Doc, Confluence, the pull request), or **Publish to Google Drive** makes a Google Doc of them through the Drive connector of your Claude account. The link goes under both messages as `Details: …`.

Nothing is sent to anyone by itself, and the messages never mention the agent: they are written as from the person responsible for the work.

**Written by themselves.** When an agent finishes (its brief says done) or opens a pull request, the update is written in the background, an **Update to send** card appears in the inbox, and the alert says so (the *update ready* alert). **Read and send** opens it; **Not needed** sets it aside. Only what happens while AI Agent Manager runs counts: agents already finished when it starts are not announced. Each one is a separate, tool-less model call on the agent's engine, like the other documents. `agentmgr announce --auto off` (or `"announce": { "auto": false }` in config.json) turns that off; **Update** on an agent still writes one when you ask.

## Plan review

Tick **Review the implementation plan first** in New agent (or the backlog), or press **Review its plan first** on a running agent. The agent investigates, writes `PLAN.md` (goal, approach, steps, files, tests, risks) next to its brief, and stops. It doesn't edit, commit or run anything that changes the repo until you approve.

- **Where it shows.** The plan appears in the inbox as **Plan review** and in the Brief panel, with a notification.
- **Approve and implement** sends it ahead, optionally with notes.
- **Request changes** sends your notes back. The agent revises the plan and waits again.
- **Skip review** stops waiting.
- **After approval**, edits to the plan count as progress updates and don't ask again. A restarted agent is told its plan was approved.
- **Default.** Set `"planReview": true` in config.json to turn it on for every new agent.

## Acceptance: agree on what done means

An agent can finish a correct change to the wrong target. Acceptance settles the target first: a short list of points you would check when the work is done, agreed between you and the agent, and then checked one by one.

- **Ask for it.** Tick **Agree on what done means first** in New agent (or the backlog), or start with `agentmgr add --acceptance`. The agent reads the code, writes three to six points under "Acceptance criteria" in its `SPEC.md`, and stops. It changes nothing in the repository until you agree.
- **Where it shows.** In the inbox as **Done means**, with the points, a notification, and a row in the agent's Brief panel.
- **Change points** opens them to reword, remove or add your own. **Agree and start** sends the agent ahead with the list as you left it; **Agree as written** takes the agent's list. **Skip** stops waiting and keeps nothing.
- **From then on the points are yours.** They are kept by the app, not in a file the agent can edit, and an agent's own calls to agree or skip are refused. The agent is told them word for word, a restarted agent is told them again, and the agreement is in the decision log (Plan, Decisions).
- **Checked one by one.** The [review scorecard](#review-changes) reports each agreed point as **Met**, **Not met** or **Not verified**, with the evidence, in your wording and your order. A point the model does not answer counts as not verified. One point not met makes the work **Not ready**, so autopilot sends it back and does not ship it.
- **Without asking first.** Every agent with a spec has **What done means** in its Brief panel: the points it wrote for itself. Change them and agree at any time, also after the work is done; a running agent is told to check its work against them, and work already scored is scored again (for a running agent, when it next says it is done).
- **With plan review.** The points come first, then the plan.
- **Default.** Set `"acceptance": true` in config.json to ask for it on every new agent.

```bash
agentmgr add "Add a CSV export" --repo <url> --acceptance
agentmgr acceptance add-a-csv-export                  # the points, and what was found for each
agentmgr acceptance add-a-csv-export --agree          # as the agent wrote them
agentmgr acceptance add-a-csv-export --set "2=The first row is the header" --remove 3 --add "Dates are ISO 8601"
agentmgr acceptance add-a-csv-export --check          # score the work against them now
agentmgr acceptance add-a-csv-export --skip
```

Changing points with `--set`, `--remove` or `--add` agrees on the result. The command exits with 1 when an agreed point is not met.

**Limits.** Met, not met and not verified are a model's reading of the changes, not a test run by the app; the evidence it names is there to check. The agent waiting is an instruction it follows, as with plan review, not a lock on the repository. At most 12 points of 300 characters.

## Without you: how far an agent goes on its own

Each agent has a level for how far it goes before it needs you. Choose it in New agent (**Without you**), on a running agent (**Run without me…** in its Brief panel), with `agentmgr add --autonomy <level>`, or set the default for new agents in Settings.

| Level | What happens without you |
| --- | --- |
| **Ask me** (`ask`, the default) | Nothing: questions, stuck findings and follow-ups wait in the inbox, as before. |
| **Agree, then run** (`run`) | You [agree on what done means](#acceptance-agree-on-what-done-means) first. After that the middle is handled for you (below). |
| **Run to pull request** (`pr`) | The same, and its pull request is opened when the [review rounds](#review-rounds-before-a-pull-request) approve the work, also when "Open the pull request when the critics approve" is turned off. Review rounds themselves have to be on (the default). |
| **Run to merge** (`merge`) | The same, and the pull request is merged when its checks pass and everything else says ready (below). |

**What is handled for you, from "Agree, then run" up:**

- **A question it asks without stopping, or a plan waiting for review**, is decided by [Decide](#decide) at its "Most things; ask when unsure" level, whatever the project's own level is: carried out when the recommendation is at least 70% sure and easy to undo. Its recommendation now also knows the agreed points, your ground rules and the repository's lessons.
- **A question it stopped on in its terminal** (read from its screen by the AI judge) is answered from what is already decided: your request, the agreed points, your ground rules, the repository's lessons and your earlier answers, or the agent's own default when it is a routine detail that is cheap to change. The agent is told the answer came from the app while you were away, and to note it as an assumption.
- **A question it shows as a menu** (Claude Code's own question menu) is answered the same way, by picking one of its options with its key. A menu where several options can be ticked, and one where none of the options is right, is left for you.
- **A stuck agent** gets the judge's nudge when the judge is at least 70% sure, three times at most.
- **A quiet, unfinished agent** is told to carry on, twice at most, unless it is blocked on you.
- **At "Run to merge"**, its pull request is merged when the checks pass, the review rounds (when they ran) approved it, the scorecard says "Ready to approve", no high-risk path is touched, and the agent's own confidence is not low. Otherwise it is held, and the inbox says why. (A backlog item is shipped by [autopilot](#autopilot) at the item's level.)

**You see all of it.** An answer given for you is in the inbox as **Done for you**, with the question, the answer, what it was based on and how sure the model was: **OK**, or **Change answer…** to give your own, which the agent is told to apply. The agent's **Without you** dialog lists everything that was answered, sent, decided, merged or left for you, and `agentmgr autonomy <agent>` prints it.

**Never done for you:**

- A permission prompt is never answered by a model (your [approval rules](#decision-inbox) still apply). This is checked by the app, not left to the model: a prompt the screen reader took for a question is left for you without asking one.
- While what done means, or a plan, waits for your agreement, nothing is answered or nudged for you.
- A choice your request says to ask you about: the answering model is told to leave it for you (in the trial it did, each time).
- A question about deleting or overwriting, rewriting history, publishing, deploying or merging, credentials, money or licences, personal data, messages to other people, or the scope of the task is left for you whatever a model would say.
- An agent cannot set or raise its own level, and cannot change your ground rules: its own calls are refused.

**The models.** What is decided in your place runs on a list of models, best first: `fable`, then `opus`, then `sonnet`. The first one answers; when a call on it fails (the model is not on your plan, a limit, a timeout), the next one is used, and the one that failed is skipped for 15 minutes. Change the list in Settings or with `agentmgr autonomy --models opus,sonnet`. The AI judge's other calls (reading a screen, alerts) stay on its own fast model.

```bash
agentmgr add "Add a CSV export" --repo <url> --autonomy pr
agentmgr autonomy                         # the default level, the models, today's calls
agentmgr autonomy --default run --models fable,opus,sonnet
agentmgr autonomy add-a-csv-export        # its level and what was done for you
agentmgr autonomy add-a-csv-export merge  # set its level
agentmgr autonomy add-a-csv-export --change 3fa2c1d0="Use Postgres"
```

In config.json: `"autonomy": { "level": "ask", "models": ["fable", "opus", "sonnet"], "answers": true, "nudges": true, "followUps": true, "minConfidence": 0.7, "minBuildConfidence": 70, "maxAnswers": 12, "maxNudges": 3, "maxFollowUps": 2, "dailyCalls": 80 }`.

**Limits.** It needs the AI judge on (it reads the screen and finds stuck agents) and Decide on (for questions and plans). An answer is a model's reading of what you decided before, and can be wrong: that is why each one is shown to you. The level does not change the permission mode, so in the default mode an agent stops at each permission prompt (running a command, reading outside the project) and waits for you. New agent says so and offers Permission mode **Auto**, where Claude Code approves what it judges safe; `agentmgr add --autonomy run -p auto` does the same. Each answer, nudge and judgment is a model call on your own plan.

## Ground rules: your own rules for every agent

**Settings → Ground rules** (or `agentmgr ground-rules`) holds your own rules for how agents work: one per line, for every agent, in every repository and on every engine. "Ask before adding a dependency." "Never force-push or rewrite history." "Say what you did not do."

- **Next to memory, not instead of it.** [Repo memory](#repo-memory) is what agents learned in one repository, and [Standards](#standards-what-every-change-in-a-repository-has-to-meet) are lessons per repository. Ground rules are yours and apply everywhere; agents are told they come before what the memory suggests.
- **How agents get them.** With their instructions at every start. They are told to stop and say which rule is in the way when a task cannot be done without breaking one. Tick **Also tell the agents running now** (or `--tell`) to send a change to the sessions that are open.
- **Only you set them.** An agent's own calls to change them are refused. They are in `~/.agentmanager/ground-rules.md`, which you can also edit by hand.
- **Used when deciding for you.** Answers given for an agent that runs [without you](#without-you-how-far-an-agent-goes-on-its-own), and Decide's recommendations for it, are given the rules.

```bash
agentmgr ground-rules                                   # show them
agentmgr ground-rules --add "Ask before adding a dependency" --tell
agentmgr ground-rules --remove 2
```

At most 40 rules of 400 characters. A rule is an instruction the agent follows, not a lock: the review scorecard does not check ground rules (it checks a repository's lessons).

## Confidence: how sure the agent is of what it built

Every agent now ends its Results with its own confidence: `Confidence: 85% - what it verified, and the one thing it is least sure about`. It is asked to count only what it ran and saw working, and to lower the number for anything it did not do. The Brief panel shows it beside the results (high from 85%, medium from 65%, low under that), next to the review scorecard, which is the separate check by another model. At "Run to merge" and on autopilot's Merge level, work whose agent is under 70% sure of it is not merged without you.

The number is the agent's own statement, not a measurement.

## Proof: what it ran, and what it did not do

"All checks pass" in a brief is the agent's word. With proof, you can check it.

- **What it ran.** Next to its brief the agent keeps `PROOF.md`: for each check it ticked, and each agreed point of [what done means](#acceptance-agree-on-what-done-means), the exact command, its exit code and the last lines of real output. A check it made by reading says so.
- **What it did not do.** Under Results the agent lists each thing the request asked or implied that it skipped, stubbed, left untested or only assumed, as **Not done**, or says there is nothing. A finished agent that has not said is shown as such.
- **Where you see it.** The agent's Results show **Not done** and a **Proof** row ("3 recorded runs, 1 by reading"). **Open** lists each check with its command and output. `agentmgr proof <agent>` prints the same.
- **Run it again.** **Run these again here** (or `agentmgr proof <agent> --run`) runs the recorded commands in the agent's folder, one after the other, and marks each **Same result** or **Different result** by its exit code. The command exits with 1 when one differs. If the agent changes its proof afterwards, the earlier run no longer counts.
- **What it feeds.** The review scorecard and the review when an agent finishes are given the proof as the agent's own record, and what the app saw when it ran the commands. A command that gave a different result caps the scorecard's tests score at 40. At "Run to merge" and on autopilot, a merge is left to you when the agent lists something as not done, or a recorded command gave a different result.

**What is not run again:** a command that changes things: deleting or moving files, committing or pushing, installing or publishing, deploying, reaching the network, writing to a file, or running as administrator. It is listed as "Not run again" with the reason. At most 12 commands are run, each for two minutes at most.

**Limits.** The record is written by the agent: until you run the commands again, it is still its word, now in a form you can check. Running them again happens on your computer with your rights and without the agent's permission prompts, which is why only you can ask for it (an agent's own call is refused) and why the commands are shown first; the list of what is not run is a filter on the command's text, not a sandbox, so read the commands. The same exit code does not prove the same output (durations and dates differ between runs; the page says when the last recorded line was not printed). An agent in a container cannot be run again from here. `"proof": false` in `config.json` stops asking agents for it.

## Pre-mortem: how could this go wrong?

Before it changes anything, each agent writes **Risks** in its brief: the 3 to 5 most likely ways this task could go wrong or be done wrongly, specific to the task. When it finishes it marks each one:

| Mark | Meaning |
| --- | --- |
| **Avoided** | with how it knows (the test or command) |
| **Happened** | with what, and what it did about it |
| **Not checked** | it named the risk and did not look |

- **Where you see it.** In the agent's Results, as **Risks it named before starting** ("3 avoided, 1 not checked"). The list is open when one happened or was not checked.
- **Why it helps.** The list is written before the work, so it is not shaped by what was built. It tells a reviewer where to look first, and a risk left "not checked" is a place nobody looked.
- **What it feeds.** The review scorecard is given the list and asked to check the ones not marked avoided against the changes. Risks that happened are noted under safety, ones not checked under tests.
- **Off:** `"premortem": false` in config.json.

**Limit.** The marks are the agent's word. "Avoided" with a command is as good as that command; [Proof](#proof-what-it-ran-and-what-it-did-not-do) lets you run it again.

## Self-review: the first-principles checklist

Before it calls its work done or partial, each agent adds **Self-review** to its brief. It answers the same nine questions every time, in the same order, each with its evidence (the command and what it showed, the test, the file and line):

| Principle | The question |
| --- | --- |
| **Asked** | It does all that was asked, and what done means is met |
| **Scope** | Nothing beyond what was asked: the smallest change that does it |
| **Works** | Seen working: run, not only read |
| **Tests** | A test fails if this breaks |
| **Edges** | Empty, wrong, large and failing inputs are handled |
| **Ripple** | What uses the changed code still works |
| **Safe** | No secret, unchecked input or wider access added |
| **Undo** | It can be undone without losing data |
| **Conventions** | The skills and project rules that apply were followed, and one found wrong or out of date is named |

Each answer is **Holds**, **No**, **Not applicable** or **Not checked**. A "holds" with no evidence counts as not checked.

- **Verified, not just said.** The app sets each answer against facts it measured itself and marks it **Backed** or **Contradicted**, with the reason:
  - **Asked:** what it lists as not done, a partial outcome, what done means point by point (a point not met contradicts it; a point with no recorded run leaves it unbacked), the scorecard.
  - **Scope:** the [scope fence](#scope-fence).
  - **Works:** its own failed checks, its recorded proof and whether it gave the same result when run again, CI.
  - **Tests:** [Test the tests](#test-the-tests-would-they-notice-a-mistake), and the quality bar's "tests changed with the code" (or code changed with no test file).
  - **Safe:** the quality bar's scan of the added lines for keys and tokens, when the bar has it.
  - **Ripple:** CI on its pull request, and Night watch.
  - **Conventions:** the skills its session used, and whether the app found any of them [out of date with the code](#skills-kept-up). A "holds" that does not name a used skill the app found out of date is contradicted.
  - Edges and Undo are its word only.
- **Written before its latest changes.** The work is fingerprinted when the agent writes its answers. If it changes the code afterwards, the list says so: the answers may speak for an earlier version.
- **Where you see it.** In the agent's Results, as **Self-review** ("6 hold, 1 no · the app backs 3, contradicts 1"). It is open when an answer is No, not checked, contradicted, or written before its latest changes, and those are the ones to read first. A "holds" the facts contradict is also named under **To review** in Glance. Agents are also asked to put the list in their pull request's description. `agentmgr self-review <agent>` prints it as Markdown and exits with 1 when something is No, contradicted, or missing.
- **Ask it to fix these.** One tap sends the agent just the answers that say No and the ones the facts contradict, asking it to fix them and answer again (`agentmgr self-review <agent> --send`). Only you can send it.
- **What it feeds.** Read first counts a No, and more so a "holds" the facts contradict. An agent started before 1.73 was never asked for a self-review, so a missing one is not counted against it; one started before 1.74 was not asked about Conventions.
- **Off:** `"selfReview": false` in config.json.

## Skills kept up

Skills are what agents know how to do in a project. They go stale when the code moves on, and the procedures agents work out are lost unless someone writes them down.

- **Proposed by the agent.** When it finishes, an agent that worked out a procedure of several steps the next agent will need (running a kind of test, a release step, a migration) writes it under **Skill proposal** in its brief: a name, when to use it, and the steps it ran. One that found a skill wrong proposes the corrected version, with what changed. It never writes the skill itself.
- **You decide.** The proposal is a card in the inbox, **Skill proposal**, with the steps to read. **Add skill** writes `.claude/skills/<name>/SKILL.md` in its project (a file in the repository, to commit) or in yours; **Dismiss** puts it away. One with the same name is kept unless you tick **Replace**. Only you can add one, not an agent. Also `agentmgr skills accept <agent> [--to personal]` and `agentmgr skills dismiss <agent>`.
- **Out of date with the code.** Each skill is read for what it names: an npm script, a make target, a file or folder. One that is no longer in the project is listed under the skill in **Skills**, and the skill gets a card in the inbox, **Skill out of date**. No model is asked. Also `agentmgr skills drift`. To keep false alarms out:
  - A path counts only when its first folder is in the project (or it starts with `./`), so branches, URLs and packages are not taken for files. Your own skills are only checked against their own folder.
  - A file the skill says to make ("write the summary to `docs/summary.md`", `> out.txt`, `mkdir -p`) is not expected to be there, and neither is one git ignores (a build's output).
  - A command is checked where it runs: `cd web && npm run dev` and `npm --prefix web run dev` against `web/package.json`, `make -C web serve` against `web/Makefile`. Workspace commands (`-w`, `--filter`) and Makefiles with targets from patterns, variables or included files are not checked.
- **Renamed or deleted.** Git says what happened to a missing file: "renamed to tools/check.sh" or "deleted from the project", with the commit. **Fix renamed paths** on the card (or `agentmgr skills fix <id>`) puts renamed ones right in the skill.
- **Ask an agent.** For the rest, **Ask an agent…** on a project skill's card opens a new task: find what works now and propose the corrected skill. You add it as above.
- **Told at the start.** An agent starting in a project is told which of its skills are out of date and what is wrong in each, and asked to propose a corrected one if it uses it.
- **Looked at before you add it.** A proposed skill with what looks like a key or token is not added until that is out. The card also says what it names that is not in the project, and which skill it replaces. One the same as the skill already there is not offered.
- **A newer version upstream.** Once a day the app looks at each repository skills were added from (one fetch each) and says which have a newer version. **Check all** in Skills, or `agentmgr skills check-all`, looks now.
- **Not used lately.** A skill no agent has used in a month says so: its description may not say when to use it.
- **In the self-review.** **Conventions** asks the agent whether it followed the skills that apply, and to name one it found wrong. The app checks the answer against the skills its session used.
- **Dismiss** on an out-of-date skill puts it away until what is found changes.
- **A brief not written.** An agent asked for a brief that stops without one, or says it is done without its self-review, is reminded once after a quiet minute. Not when its last words were a question for you.
- **Off:** `"skillProposals": false`, `"skillDrift": { "enabled": false }` (or `"upstream": false` for no daily look), and `"briefReminder": false`.

**Limit.** A "Backed" answer means the facts the app has agree with it, not that the work is right. Edges and Undo are only the agent's word, and so is Safe without the quality bar.

### Skill policy, history and pull requests

For a team, skills are shared instructions that every agent follows, so changes to them are controlled like code.

- **Changes as pull requests.** With `"skillPolicy": { "projectChanges": "pr" }`, every change to a project's skills is a pull request: adding a proposed skill, fixing renamed paths, installing, updating, removing. The app makes the change on its own branch (`skills/<what>-<id>`) from the project's default branch on `origin`, in a temporary worktree, pushes it and opens the pull request with `gh`. Your checkout is never touched. The skill shows **pull request open** until the change is merged and pulled. Buttons say **Open pull request** instead of **Add skill**.
- **Where changes may go.** `"places": ["project"]` allows changes to projects' skills only, not to people's own (`~/.claude/skills`); `["personal"]` the reverse. A place that allows no changes shows as **read-only**.
- **Where skills come from.** `"sources": ["github.com/acme/"]` allows installing and updating only from those addresses; `false` allows none.
- **Which projects' agents propose skills.** `"proposals": ["web", "api"]` (project shortcuts), or `false` for none.
- **Agents can't change skills.** Adding, installing, updating, fixing, removing and dismissing are refused (403) when an agent asks; only the person can.
- **History.** Every change is recorded: what, which skill, in place or by pull request (with its address), the agent that proposed it, and who made it (the git name and email here, and the device). **History** in Skills, `agentmgr skills history`, or `GET /api/skills/history`. The last 1,000 changes are kept.
- **Plugins.** A plugin can refuse any change (`skill.add`, `skill.install`, `skill.update`, `skill.remove`, `skill.fix`) and hears each one (`skill.added`, …), to forward to an audit log. `config.json` is the person's own file; an organization enforces its policy with a plugin. See [docs/plugins.md](docs/plugins.md).
- `agentmgr skills policy` shows the policy in effect.

## Test the tests: would they notice a mistake?

Proof shows the tests ran and passed. It does not show they could have failed. Tests written by the same agent as the code can pass while checking very little.

**Test the tests** answers that by measuring. The app takes the lines the agent changed and breaks them one at a time in a small way, runs the tests, and puts the line back:

| Kind of break | Example |
| --- | --- |
| Equal and not equal swapped | `===` becomes `!==` |
| A comparison turned around | `<=` becomes `>` |
| And / or swapped | `&&` becomes `\|\|` |
| True / false swapped | `true` becomes `false` |
| Plus / minus swapped | `total + fee` becomes `total - fee` |
| A number moved by one | `10` becomes `11` |

A break the tests fail on is **Caught**. A break they still pass on is **Not noticed**: that line can be wrong and no test will say so.

- **Where.** In the agent's **Proof** dialog, under **Test the tests**: **Break the code and run the tests**. Or `agentmgr test-tests <agent> --run`. The Results then show **Tests tested**, for example "5 of 6 breaks caught".
- **Which tests.** The passing commands the agent recorded in its proof, or the command you type (`-c "npm test"`).
- **Which lines.** Up to 8 (`--max`), spread over the changed source lines and over the kinds of break. Test files, comments, text inside strings, imports and logging lines are left alone.
- **Tell the agent.** **Tell the agent** (or `--send`) sends it the lines whose breaks went unnoticed and asks for tests that fail when they are wrong, or a reason why none should.
- **What it feeds.** The review scorecard is given the result. When no break was caught, its tests score is at most 35; when more than half went unnoticed, at most 55. A run made before the latest changes is not counted.
- **Exit code.** `agentmgr test-tests` exits with 1 when a break went unnoticed or the tests fail as they are.

**How the folder is kept safe.** The tests are run first with nothing changed; if they fail, nothing is broken. One line of one file is different at a time, and it is put back before the next. The line is written down before it is changed, so a daemon that stops halfway puts it back when it starts again. A run does not start while the agent is working, messages to the agent wait until the run is over, and typing to the agent stops the run. After the run the app compares the folder's changes with those before it and says so if they differ.

**Limits.**

- It runs on your computer with your rights, without the agent's permission prompts, and changes the agent's files for a moment. For that reason only you can ask for it; an agent's own call is refused.
- "Not noticed" is a pointer, not a verdict. Some breaks change nothing a test could see (a number in a timeout, two versions that behave the same). Read the line before asking for a test.
- "Caught" includes a break that stops the code from loading at all, which any test would notice. A high count shows the changed lines are exercised; it does not show every behaviour is checked.
- The breaks are made on the text of a line, not on a parsed program. They cover JavaScript, TypeScript, Python, Go, Ruby, Java, Kotlin, Rust, C, C++, C#, PHP, Swift and Scala.
- Each run of the tests may take 5 minutes at most, and a whole run 15 (`"testTheTests"` in config.json: `max`, `timeoutMs`, `budgetMs`). An agent in a container is not covered.

## Production signal: incidents from your monitoring tool

Quality judges merged work by what GitHub shows. An incident in production says more: users met it. Any monitoring tool, a script, or you can report one, and it is linked to the merged pull request it belongs to:

```sh
agentmgr quality incident "NaN totals at checkout" --files src/total.js:12 --id DD-9 --url https://monitor.example/DD-9
curl -X POST -H 'x-agentmgr: 1' -H 'content-type: application/json' http://127.0.0.1:<port>/api/quality/incident \
  -d '{"title":"NaN totals at checkout","commit":"feedbeef","id":"DD-9","source":"datadog"}'
```

- **How it is matched.** The pull request it names (`--pr`); else the one that merged as the commit it was seen on (`--commit`: a release is often a commit); else, of the pull requests merged in the watch days before it, the latest that changed a file in its stack trace (`--files`).
- **What it changes.** That pull request shows **Incident in production** in Quality, with the link and how it was matched. It counts as one that did not hold up in Quality's totals, the [track record](#track-record-was-the-confidence-right) and the [weekly summary](#weekly-summary-the-weeks-work-and-achievements-for-management), and it can become a lesson in [Standards](#standards-what-every-change-in-a-repository-has-to-meet). What you mark yourself still wins.
- **Reported twice.** The same `--id` is counted once. A wrong match can be taken off (`POST /api/quality/incident/drop` with the pull request and the id).
- **Who reports it.** You or your tools; an agent's own call is refused.

**Limits.** There is no built-in connector to a particular tool: point your tool's webhook, or a small script, at the route above. The daemon listens on this computer, so a tool in the cloud needs a script that forwards to it. Matching by files picks the latest pull request that touched them, which can be the wrong one when several did.

## Track record: was the confidence right?

An agent writes "Confidence: 85%" and the scorecard says "Ready to approve". The track record shows how much those were worth.

[Quality](#quality-what-happened-after-the-merge) already watches each merged pull request for some days: held up, or reverted, fixed afterwards, failed its checks. As a pull request merges, the app now also keeps what was said about it:

- the agent's own confidence,
- the review scorecard's recommendation,
- whether its tests were tested, and whether every break was caught,
- the engine and model,
- how far the agent ran without you.

**Quality → Track record**, or `agentmgr quality record`, compares the two once a pull request is settled:

| Table | Reads like |
| --- | --- |
| The agent's own confidence | "90 to 100%: 6 of 10 held up (60%), said 92% on average: said more than held up" |
| The review scorecard | "Ready to approve: 9 of 10 held up" |
| Tests tested | "every break caught: 6 of 6 held up" |
| Model | "claude · opus: 11 of 13 held up" |
| Without you | "Run to pull request: 4 of 5 held up" |

A row with fewer than 5 settled pull requests says "too few to say". "Said more than held up" means the average confidence was at least 15 points above the share that held.

### Delegation map: what to hand over next

The track record also sorts work by kind, read from the words of each request: features, bug fixes, tests, documentation, upgrades and migrations, refactoring, investigation. For each kind it shows how it held up and how much of it ran without you.

| Advice | When |
| --- | --- |
| **Hand over more** | At least 5 settled pull requests, 9 in 10 held up, and most of it still asked you |
| **Keep close** | At least 5 settled, and under 7 in 10 held up |

The kind that held up best among the "hand over more" ones is named as the next to hand over: set its projects' level, or start that kind of work with "Agree, then run".

**Limits.** It sees only work given to agents, not what you do by hand. The kind is read from words with fixed rules, so a request can land in the wrong kind; work it cannot place counts as a feature. Pull requests merged before this version are sorted by their title.

### Model fit: which model held up as well for less

The track record also compares models. For each engine and model it shows how many settled pieces it did, the share that held up, the average review scorecard and the cost per piece against the most used model's (a ratio, not money).

It suggests a model when another one held up within 5 points of the most used one, at three quarters of its cost or less, with at least 5 settled pull requests behind both: "sonnet held up as well as opus (100% against 90%) at 0.4 times the cost: worth trying for more of the work." The cost is what the AI work cost as each pull request merged, kept only for this comparison. Pull requests merged before this version have no cost kept and are not counted in it.

### Earned autonomy: the level a project's record supports

The last table lists each project with the level of [Without you](#without-you-how-far-an-agent-goes-on-its-own) its new agents get, and what the record supports:

- **Up one step** after at least 5 settled pull requests, 9 in 10 held up, and none of the last 5 a problem. "Run to merge" needs 10, with 95% held up and all of the last 10.
- **Down one step** when one of the last 3 did not hold up.
- Otherwise, keep it.

It is a suggestion. The level changes only when you press **Set** or run `agentmgr autonomy --project <name> --default <level>`; an agent's own call is refused. A project's level applies to its new agents when none is named; agents that run now keep theirs. `--default default` takes the project's own level away again.

**Limits.** The record counts merged pull requests only: work that was thrown away before a merge is not in it. "Fixed afterwards" is Quality's guess from titles and files, so mark the ones it gets wrong there. A pull request merged before this version has what is said about its agent now, not as it merged. A project is matched by its name. Small numbers say little, which is why the app waits for 5.

## Insights

**Insights** in the Brief panel, or `agentmgr insights <agent>`, shows the agent's work as four quick cards built from its ask and live context, followed by three cards for the decision in it:

| Card | Answers |
| --- | --- |
| 🎯 **Why** | Why it matters: the motivation, the need, or the root cause |
| 📦 **What** | What is being done or delivered: scope and outcome |
| 🛠 **How** | The approach, the key mechanism, the main changes |
| 📍 **Now** | Where it stands and the next step, including anything waiting on you |

Each card has at most **three points of about 12 words each**, so they're easy to remember and repeat. Insights uses the same context and the same separate, tool-less Claude call as Explain, so the agent isn't interrupted. Use Insights for a quick glance and Explain for the full briefing.

### The decision side: value, kind of idea, and paths

Below the four cards, Insights adds three more, for the part of a design that is a decision:

| Card | Answers |
| --- | --- |
| ⚖️ **Value: now and later** | What the work is worth as soon as it ships, what it is worth over time, what waiting costs, and which of the two should drive the design |
| 💡 **Kind of idea** | Just a task, worth a white paper, or possibly patentable; what is new, and what to do next |
| 🧭 **Paths, preferred first** | The 2 to 4 real ways to go, ranked, each with its value now and later, cost, risk, and when it is the right pick |

**Now against later.** "Now" is what someone gains as soon as it ships. "Later" is what it makes possible, saves or avoids over time, counted lower the less sure it is. Each is rated high, medium or low with a one-line reason.

**How the paths are ranked.**

1. The most value for its cost comes first.
2. Between close ones, the one that is easier to undo.
3. A path worth more later than now comes first only when waiting costs little, or when the cheaper path would close that door.

The first path is marked **Preferred**, with the reason it wins. The others stay listed with the condition under which each becomes the right pick, so the ranking can change when your situation does.

**Kind of idea.**

| Kind | Means | Next |
| --- | --- | --- |
| Just a task | Ordinary work done in a known way. Most work. | Build it |
| Worth a white paper | The approach or the result would teach others something | Write it up, and for whom |
| Possibly patentable | A specific technical mechanism that seems new, not an obvious step, and useful. An idea, a goal or a business rule alone is not. | Keep it unpublished and talk to a patent attorney before sharing |

When unsure between two kinds, the lower one is given.

**While the agent designs.** Agents weigh the same things before they build. When a task has more than one reasonable way, the agent lists them in its brief under **Options**, preferred first, in the same form, and builds the first unless you say otherwise. Its Results show them as **Paths it weighed**. If part of its design seems new, it says so in one line and keeps it inside the repository; whether that is worth a paper or a patent is yours to decide. A task with one reasonable way has no Options section. `"valueLens": false` in config.json turns this off for agents.

### Kept private: possibly patentable work is not sent out

Publishing before filing can cost the right to a patent. So when part of an agent's work is read as possibly new, the app keeps it private until you say otherwise.

**What makes it private:**

- the agent says part of its design is new (the "New:" line under Options in its brief),
- Insights reads it as possibly patentable,
- or you mark it: **keep this work private** under Insights, or `agentmgr private <agent> --keep`.

**What is held**, each with the reason and how to lift it:

| Held | Where it would have gone |
| --- | --- |
| Publishing its documents | Google Drive |
| Publishing an update, or posting it | Google Drive, Slack |
| Posting the scorecard | A comment on the pull request |
| Opening the pull request | GitHub, also when the agent runs without you or on autopilot |
| A merge without you | Left to you |

The agent is told as well: nothing published outside the repository, no pull request, and its design doc stays a file.

**Noticed without asking.** When an agent finishes, Insights is made by itself, so the kind of idea is read for every finished task (`"insights": { "auto": false }` in config.json turns that off; it is one more model call per finished agent). Work read as possibly patentable, or flagged by the agent, then waits in your inbox as **Possibly patentable** with two buttons: **Keep it private** and **Allow sharing**. `agentmgr inbox` lists it too. Until you decide, it is kept private.

**Lifting it** is yours alone: **Allow sharing** in the agent's Results, or `agentmgr private <agent> --allow`. An agent's own call is refused. `--reset` goes back to what the agent and Insights say. A white paper is not held.

**Limits.** This guards what the app sends. It does not stop an agent from running a command in its terminal that publishes something; the agent is instructed not to, and its permission prompts still apply. Work already pushed or published before it was marked stays where it is. It is a caution based on a first read, not a finding that anything is patentable: talk to a patent attorney.

**Limits.** The ratings are a model's judgement from the agent's request and session, not a calculation with your numbers. The kind of idea is a first read: no search for prior art is made, and it is not legal advice. Publishing before filing can cost the right to a patent, so treat "possibly patentable" as a reason to ask an attorney before you share, not as a finding.


## Review changes

**Review changes** on an agent opens its changes against where its branch started (the merge base with the branch it came from), new files included:

- **Files and diff.** The changed files on the left with lines added and removed, and the diff file by file on the right. Click a file header to fold it; very large files start folded.
- **Line comments.** Click **+** next to a line (or its line number) to comment on it, and add an overall comment if you like. **Send to agent** types them into the agent as one message, each with its file, line and the code it is about, and asks it to address them. Comments not sent yet are kept in this browser.
- **Review scorecard.** **📊 Score changes** (it also runs by itself when the agent marks its work done) scores the changes 0-100 for **Intent**, **Spec** (each acceptance criterion met, not met or unverified, with evidence), **Tests**, **Safety**, **Scope** and **Plan**, and gives an overall readiness with a recommendation: *Ready to approve*, *Look at these first* or *Not ready*, plus **Where to look**, the few hunks worth a person's time. What the app measures caps the model: failing CI or checks, code changed without tests, plan steps not ticked, criteria not assessed. **Post to PR** puts it on the pull request as a comment (again: updates it), and Push & open PR includes it in the description. It also shows as a badge in Land. Turn the automatic run off with `"scorecard": { "auto": false }`.
- **Improve before you review.** The score shows before you open anything: 📊 on the agent's row, in its Results, and on backlog items in review. **✨ Improve** (in Results, the scorecard, Review changes, backlog items in review and the inbox, or `agentmgr improve <agent>`) sends the agent its own scorecard: the scores under 80 (lowest first, with why), the acceptance criteria not met or not verified, and where a reviewer would look. A backlog item in review is reopened with it. The agent shows *↻ Improving from 75*. When it next marks its brief done, the changes are scored again, also with the automatic run off, and the score shows how far it moved (*82 ↑7*).
- **Explain changes** explains each change one by one: a title, what it changes, why (from the request and the conversation), the risk and what to check, in the order a reviewer should read them. Each explanation sits above its hunk, and **◀ / ▶** (or **[** and **]**) step through them, opening folded files on the way. When the agent changes the code afterwards, the page says so and **Explain again** brings it up to date. From the CLI: `agentmgr doc <agent> walkthrough`.
- **Commit all** commits everything in the worktree, new files included, with your git name and email.
- **Intent, spec and plan.** Each agent keeps INTENT.md (what was asked, written by AI Agent Manager), SPEC.md (requirements and acceptance criteria, written by the agent before it changes code) and PLAN.md (steps, ticked off as it goes) next to its brief. Open them with **Intent · Spec · Plan** or in the split view's Docs; Explain, the documents and AI review read them too. `"specs": false` in config.json stops asking agents for the spec and plan.
- **Design doc.** Once its plan is settled (approved, with plan review on), each task agent writes DESIGN.md next to its brief and publishes it, without waiting for you, as a **claude.ai Artifact** with the diagrams drawn (its Artifact tool). The link goes in its brief's References as **Design page**. It's short on purpose, about 300-700 words: a summary, the architecture, the design, the data flow and the decisions and risks, with at most three small diagrams and nothing repeated from the spec, plan or brief. When the work is done, the agent brings it up to date and republishes the Artifact at the same link. If the tool is missing, the agent notes it and carries on. Open it with **Design doc** next to Intent · Spec · Plan; it also goes, folded, into the pull request description. It's on by default: untick **Design doc** on the new-agent form (`agentmgr add --no-design-doc`) for small fixes, or set `"designDoc": false` in config.json.
- **Demo page** (off unless ticked; `agentmgr add --demo-page`, or `"demoPage": true`). Once the change works, the agent makes DEMO.html: one self-contained page showing what changed with realistic sample data and the outputs it actually got. That means runnable examples for a library or CLI, the changed screen rebuilt with sample data or screenshots for a UI, and before and after for a fix. It's published as a claude.ai Artifact (**Demo page** in the brief) and opens here with **Demo page ↗**, sandboxed so it can't reach AI Agent Manager or load anything from elsewhere.
- **Micro benchmarks** (off unless ticked; `agentmgr add --benchmarks`, or `"benchmarks": true`). Once the change works, the agent times the functions it changed with sample inputs at a few sizes, on the base commit and on its change, back to back, and writes BENCHMARK.md: what was measured and how to rerun it, a before | after | change table, the machine, and a line on any slowdown over 5%. It uses the repo's own benchmark setup when there is one; otherwise the scripts stay next to the brief, uncommitted. Open it with **Benchmark**; it's also folded into the pull request description and published to Google Drive with the rest.
- **Publish to Google Drive.** One click (or `agentmgr publish <agent>`) puts all of an agent's documents in a Google Drive folder named after it, one Google Doc each: the brief, intent, spec, plan, design doc and any documents written for it (analysis, design, flow, proposal, diagrams and so on). It goes through the Google Drive connector of your Claude account, so AI Agent Manager holds no Google credentials. The call can use only the Drive tools that create and trash files. **Google Drive ↗** opens the folder. Publishing again puts the latest versions in the same folder and moves the earlier ones to the trash, because the connector can't edit a doc's content. Mermaid diagrams stay as code in the Google Docs, with a pointer to where they're drawn.
- **Push & open PR** pushes the branch and opens a pull request with `gh`, against the branch the agent started from (title from your text, or from the commits; **Draft** if you like). Its description carries the intent, and the spec and plan in folded sections. With a pull request already open, it pushes to it. The pull request is linked to the agent.

The same from the API: `GET /api/agents/:id/changes`, `POST …/changes/comments`, `…/changes/commit`, `…/changes/pr`. Plugins can refuse a commit or a pull request (`agent.commit`, `agent.pr`).

## Review rounds: before a pull request

A pull request's reviewers, people or GitHub Copilot, should not be the ones who find the bugs. So an agent's changes are reviewed before there is a pull request, by models other than the one that wrote them, as many times as it takes.

1. **The agent says it is done** (its brief turns to done). Review rounds start by themselves, in the background.
2. **Critics read the diff.** Two by default, each on a different model of the engine the agent runs on, and not the model it runs on when that is known: a Claude Code agent on opus is read by sonnet and haiku, one on its default model by opus and sonnet. No other provider is needed. Each gets the diff, the task, the spec and the brief, and reports defects in the changed code: wrong results and missed cases, error handling, behavior that callers relied on, security, tests that are missing, and what the task asked for that isn't there. Every finding has a severity, the line, and the input that goes wrong. Two critics on one defect make one finding.
3. **The findings go to the agent's session** as one message. It fixes each one, or says in its brief why a finding is wrong, runs the tests and says done again.
4. **The critics look again**: at what they raised, and at the new diff. This repeats until no blocker or major finding is open, or the rounds run out (4 by default, 5 at most).
5. **Approved:** the changes are committed, pushed and opened as a pull request. Its description starts with *Reviewed before opening*: the round it was approved in, by whom, and what was found and dealt with. The AI review and the scorecard are made once, of the changes that go out.
6. **Not approved in time:** nothing is opened. It waits in your inbox with what is still open, and you choose: **Another round**, **Open the pull request anyway** (its description lists what is open), or leave it.

Minor findings and nits are passed to the agent but do not hold the pull request; what is left of them is listed in its description.

The agent's detail shows the rounds as they go: the round, each critic's verdict, and every finding with whether it is dealt with. **Review rounds** there starts them by hand, also with the switch off. From the command line: `agentmgr rounds <agent>` (`--start`, `--again`, `--open`, `--stop`).

- **The switch** is at the top of the inbox, and in ☰ → Settings → Review and judging with the number of rounds and critics; or `agentmgr rounds --on|--off`. It is on by default.
- **Rounds and critics:** `agentmgr rounds --rounds 5 --critics 3`. A critic that fails in a round is replaced by the next model.
- **Other providers, if you have them.** A different provider catches different mistakes. To use one, name the critics yourself in config.json: `"preReview": { "models": [{ "engine": "codex" }, { "engine": "claude", "model": "opus" }] }`. They come first, and an engine that isn't installed is left out.
- **Engines other than Claude Code.** The app knows Claude Code's model names. For another engine, say which of its models review: `"engines": { "codex": { "reviewModels": ["…", "…"] } }`. Without that, one critic reads each round, on the model the engine is set up with. An agent on a local model or an ACP agent is read by the engine that writes its summaries (Claude Code); with none installed, it has no review rounds.
- **Leave the pull request to you:** `agentmgr rounds --pr off`. The rounds still run; you open it from the agent.
- **What it costs.** Each round is one call per critic, on your own plans, and takes about a minute. A change the critics pass at once costs two calls; one that needs every round costs eight.
- **Who it is for.** Task agents with changes of their own. Not reviewers of others' pull requests, bug hunts and their fixes, teams (they have a reviewer) or races. Backlog work on autopilot is reviewed in rounds first; autopilot opens its pull request after they approve, and holds the item when they don't.
- Agents are told at launch to leave the pull request to the review. One that opens it anyway is still reviewed, and pushes its fixes to it.

Critics judge the diff they are sent: a very large change is cut to fit and they say so. They can be wrong both ways. A finding the agent shows to be mistaken is closed by the critics in the next round; a bug no critic sees still reaches the pull request.

## Landing pull requests

The **Land** tab lists every agent's open pull request by what it needs to get merged, ready ones first:

- **Ready to merge**: checks pass and GitHub says it can merge. **Merge** merges it with `gh` (squash by default) and deletes the branch on GitHub.
- **Needs fixes**: failing checks, changes requested, or conflicts. **Ask to fix** sends them to the agent.
- **Behind its base**: **Update** merges the branch it targets into the agent's branch and pushes, when the agent is idle and its work is committed. Otherwise, or when the merge conflicts (it is undone), the agent is asked to do it.
- **Waiting** for checks or a review, and **Drafts**. **Auto-merge** turns on GitHub's auto-merge, so it merges once it may.

Each agent's pull requests show the same tags (checks, review, conflicts). Pull requests are checked every couple of minutes for running agents, and every few minutes for closed agents with a PR still open.

**Failures go back to the agent by themselves.** When checks fail on an agent's pull request, the agent is told which ones and how to read their logs; when a reviewer requests changes, it is told to read and address the review. Each commit is reported once, and at most 3 times per pull request, so an agent can't loop on a broken main.

**Review comments go back to the agent too, for as long as the pull request is open.** Each time the pull request is checked, new comments, reviews and line comments are sent to its agent in one message, which wakes a closed agent. The agent makes the changes (or says why not), pushes, and replies on the pull request, answering line comments in their own threads. Only comments from the repo's owners, members and collaborators count, plus review bots' comments on the code (Copilot, for one); approvals, resolved threads, `/agent` commands and the agent's own replies are left out. Comments from before an agent's last turn aren't sent again. The Land tab shows how many were sent.

Change these at the bottom of the Land tab, with `agentmgr land set` (`--fix-comments off`), or in config.json:

```json
"landing": { "fixChecks": true, "fixReviews": true, "fixComments": true, "maxFixes": 3, "mergeMethod": "squash", "deleteBranch": true }
```

From a terminal: `agentmgr land` lists them, `agentmgr land update|fix|merge <agent>` (`--auto` for auto-merge). With `agentmgr changes`, `comment`, `commit` and `pr` you can review and open the pull request too. Plugins can refuse a merge (`agent.merge`).

## Results

The **Results** card is the first thing in the Brief panel, and `agentmgr show` lists it too. It shows:

- **The outcome:** ✅ Done, 🟡 Partial, ⛔ Blocked or 🔄 In progress.
- **Blockers first, in red.**
- **What was delivered.**

It combines what the agent wrote under `## Results` with what AI Agent Manager tracks itself:

- PRs (with their state).
- Failing checks.
- An unanswered prompt.
- A setup error.
- The brief's `Status:` line.

So agents that haven't written Results yet still get one. Blocked and done agents show ⛔ / ✅ in the agent list, and the **blocked** Slack alert (on by default) fires when an agent reports it's blocked.

## Timeline

**Timeline** on an agent's page, or `agentmgr timeline <agent>`, shows its work from its start to now as a thread of dated milestones, oldest first:

- **Started:** the request, with its branch and where it branched from.
- **Ask done:** each ask that changed something, dated when the agent's turn on it ended. Under it: the files it edited, the commits it made while on it, and its last word on it. The first one is the request itself.
- **Asks with no changes:** questions and replies in a row, folded into one line you can open.
- **Pull request opened, merged or closed**, with its link.
- **Finished:** its brief said done.
- **Now · Working on:** the ask it is on, while it works.

It is built from records: the session transcripts (Claude Code), the commits on its branch and its pull requests. No model is called. For agents on other engines it shows the commits, a day at a time, and the pull requests. **Copy as Markdown** (or the command's output) is ready for a status update or a pull request description; `--json` gives the data, as does `GET /api/agents/<id>/timeline` (`?format=md` for Markdown).

## Explain

**Explain** in the Brief panel, or `agentmgr explain <agent>`, briefs you on what the agent is doing, built from its live context.

**Context it reads:**

- **The conversation:** your requests and the agent's own replies.
- **Its actions:** commands run, files edited, questions asked, skills and subagents used, Jira and Drive calls.
- **The repository:** commits and changes since its base branch.
- **Live status:** working, waiting on you, or blocked.
- **The brief.**

**What it writes:**

| Section | Contents |
| --- | --- |
| The ask | What was requested, including later changes of direction |
| Where it stands | Phase (planning / investigating / implementing / testing / done / blocked), what it's doing now, whether it's waiting on you |
| Planned work | Checklist with ✅ done, 🔄 in progress, ⏳ next |
| Solution | The approach and the concrete changes so far (files, commits, PRs) |
| Conclusions so far | Findings, decisions, results |
| Needs from you | Questions or decisions it's waiting on, risks, blockers |

**How it runs:**

- **Separate call.** `claude -p --tools "" --strict-mcp-config --no-session-persistence`, with no tools and no MCP servers. It never runs inside the agent's session, so the agent isn't interrupted and its context doesn't grow.
- **Large sessions.** They are condensed to the first request plus the most recent activity, about 24k characters.
- **Stale flag.** The result is stored with the agent and marked out of date when the brief changes.
- **Model.** Set `"explainModel"` to pick one.

## Projects

The sidebar groups agents into projects, shown as a tree:

- **How agents are grouped.**
  - By repo: a URL and a local clone of the same repo land together.
  - Otherwise by folder.
  - General sessions under *General*, scratch work under *Other*.
  - Set your own name with `--project` or the ✎ next to *Project* in the agent's Workspace card.
- **Counts.** Each project shows running/total agents and how many need input.
- **Shortcuts.** Every project gets a **shortcut**, shown as a badge in the tree.
  - **Assignment:** from the name's initials (`cloud-console` → `cc`, `ai-gateway` → `ag`) or its first letters (`agentmanager` → `age`), with a number added when two would clash. Click the badge, or run `agentmgr project rename cc cbc`, to change it.
  - **Where it works:**
    - `agentmgr add @cc "…"` or `--project cc` uses the project's repo or clone and its default base branch. A local clone always gets a new worktree.
    - `agentmgr ls cc` lists that project.
    - Type `@cc` in the UI filter to show just it.
    - The New agents **Project** field suggests your shortcuts.
    - `backlog add --project cc` queues work for it.
  - **Ahead of time:** register a project before it has agents with `agentmgr project add cc -r <url> [-b main]`. Set a default base branch with `agentmgr project base cc release-1`.
- **Ordering.** Projects needing you sort first. Collapsed projects stay collapsed.
- **CLI.** `agentmgr ls` groups by project too.

### Editing and moving agents

**Edit** on an agent changes its name, its request, priority, permission mode and model. Changing the request updates what AI Agent Manager records (and tracks any new Jira links); tick **Also tell the agent** to send it to the session as well. Permission mode and model apply from its next launch.

To list an agent under another project, drag it onto that project in the list, or use **✎ Move** next to its project (or the Edit dialog) and pick a known project, a new project name, or **Its own repo or folder** to move it back. Only the grouping changes: its code stays in its own worktree and branch.

```bash
agentmgr edit 3fa2b1 --name login-timeout --priority P1 --intent "Fix the login timeout on slow networks" --tell
agentmgr move 3fa2b1 @billing        # "" moves it back to its own project
```

## Backlog

Queue asks instead of starting them. Use **+ Add** in the Backlog tab, **Queue in backlog** in the New agents dialog, or `agentmgr backlog add`. Each item is one ask, plus where to do it (repo or folder, base branch, project) and a priority from P1 (high) to P3 (low).

**How items flow:**

1. **Queued → active.** Items are picked up by priority, then queue order. Up to `backlogParallel` (2) items per project run at once, and `backlogMaxActive` (4) overall. Change a project's limit with "*N at a time* ✎" or `agentmgr backlog limit <project> <n>`. Each item gets its own agent, worktree and branch.
2. **Active → review.** When the agent sets its brief's first line to `Status: done` (its checks pass), the item moves to **review** and frees its slot for the next one. An agent that exits or that you close also sends its item to review. Setup errors make it **blocked** (Retry restarts it).
3. **Review → done.** **Accept** marks it done. **Reopen** types your note into the same agent session and puts the item back to work.

**Other controls:**

- **Pause / Resume** stops or restarts picking up new items. Active ones continue.
- **Start now** starts an item regardless of limits.
- **Reorder** with ▲▼, or `backlog move`. Click **P1–P3** to change priority.
- Deleting an agent cancels its item.

The backlog is saved with the rest of the state.

### Autopilot

Autopilot takes a project's finished items the rest of the way when the [review scorecard](#review-changes) says the work is ready. Set it per project with **🛫** in the project's row in the Backlog tab, or `agentmgr backlog autopilot <project> off|pr|merge`. It is off by default.

- **Off:** items wait in review for **Accept** or **Reopen**, as above.
- **Open PRs:** when an item reaches review, its changes are scored (again, if they changed since the last score). If the scorecard says *Ready to approve*, autopilot commits what's left (the item's title as the message), pushes and opens the pull request, with the scorecard in its description.
- **Merge:** also merges that pull request once its checks pass and GitHub allows it. A branch that fell behind is brought up to date first, and failing checks go back to the agent through [Landing](#landing-pull-requests).

What it does with work that isn't ready:

- **Not ready, for a concrete reason** (failing CI, acceptance criteria not met, barely verified): the item goes back to the same agent with its scorecard, as [**✨ Improve**](#review-changes) sends it: the low scores with why, the criteria not met, where a reviewer would look. This happens three times at most (`"autopilot": { "rounds": 3 }`); after that it waits for you.
- **Look at these first, a failed step, or a closed pull request:** autopilot stops and it waits for you in the **Inbox** ("Autopilot held"), saying why. You can **Review changes**, **Ship it** (go ahead anyway), or **Send back** with a note.

**Ship at a score.** Next to the level, choose when it ships: **when ready** (the scorecard says *Ready to approve*), or **at 80+**, **85+**, **90+** or **95+** (`agentmgr backlog autopilot <project> merge --target 85`; `--target none` goes back to when ready; a default for all projects goes in config.json as `"autopilot": { "target": 85 }`). With a score set, work that isn't there yet, *Look at these first* included, goes back to its agent to improve, and is scored again when the agent is done. It ships once the scorecard says ready and rates it at least the target. It waits for you when the tries are used up, or earlier when a try raised the score by less than 3 points, since more of the same won't get there. The item shows the scores so far (*scores 72 → 81 → 87*).

An item whose pull request merges is done. Each item shows where autopilot stands ("pull request open #12", "waiting for checks to merge", "sent back to the agent"). **Ship it** is also on every item in review, so you can ship one by hand with autopilot off. Plugins can still refuse the commit, the pull request or the merge (`agent.commit`, `agent.pr`, `agent.merge`).

### Goals

A goal is a work order for an outcome, not a task: *"This week: users can sign in with SSO on web, and the API paginates /orders, both with tests."* **+ Goal** at the top of the Backlog tab (or `agentmgr goal add "…" -p web,api`) takes the outcome, when it's due (**today**, **this week** or **no deadline**) and the projects it spans.

1. **Planned.** A model breaks the outcome into tasks, one agent each, each in one of the goal's projects, at most 12. With **Show me the plan before agents start** (`--review`) you see the plan first, untick what you don't want and **Start**; otherwise it starts right away.
2. **Worked.** The tasks go to the backlog, tagged with the goal. The backlog's limits start the agents, and where a project's [autopilot](#autopilot) is on, finished work is opened as a pull request (and merged) by itself.
3. **Checked.** When every task is finished, the model compares the outcome with what each task delivered (its brief's results and pull requests). Whatever is still missing is queued as new tasks, for up to 2 more rounds; then the goal is done.

Each goal's card shows how far it got and keeps three lists current:

- **Completed:** finished tasks, with their pull requests.
- **Pending:** tasks queued, being worked on, or with autopilot.
- **Follow-ups:** what needs you, with the reason. That covers blocked tasks, work autopilot held, work waiting for your review (autopilot off), and agents that need input, asked a question, seem stuck or went quiet.

**Copy summary** (`agentmgr goal show <id>`) gives the same as Markdown for a stand-up or status update. A goal past its due date shows as overdue, with **Carry over to tomorrow / next week**. **Stop** cancels its queued tasks; agents already working go on as ordinary backlog items. `agentmgr goal ls | approve | replan | extend | stop | rm`.

## Playbooks

Saved requests you run again: **Backlog → Playbooks**, **Save as playbook…** in New agents, or `agentmgr playbook`. A playbook is a request, the projects to run it in (one agent each), and optionally a model, permission mode, priority and schedule:

- **Values at run time.** Write `{{name}}` in the request for something you fill in when it runs: "Upgrade `{{package}}` to the latest version, fix what breaks and open a pull request". **Run now** asks for each value; `agentmgr playbook run Upgrade --var package=react`.
- **Several projects at once.** "Bump the Node version" in every repo starts one agent per project.
- **On a schedule.** Every hour, day, weekday or week at a time you pick ("every weekday at 9:00, triage yesterday's flaky tests"). A scheduled playbook needs a default for each `{{value}}`. A run missed while the daemon was off runs once when it is back. Budgets and the daily limit apply.

Agents started by a playbook are marked **▶ <playbook>**, and the playbook lists the agents of its last run.

**Requests you keep making become playbooks.** AI Agent Manager remembers the requests you type for new agents and backlog items (the last 500, in `~/.agentmanager/asks.json`). Requests started by playbooks, triggers or the assistant aren't counted. When 3 read alike, the Inbox offers **Make it a playbook?** with the examples. "Alike" means the same words once numbers, quoted names, URLs, issue keys and filler words are set aside.

- **Save as playbook…** opens the playbook editor prefilled. The words the requests share become the request, and the part that changes becomes `{{what}}`: "Upgrade react to the latest version" and "Upgrade vite to the latest version" become "Upgrade `{{what}}` to the latest version". The projects they ran in become the playbook's projects.
- **Not now** stops offering that one.
- A request that is already a playbook isn't offered.
- Change the count with `"repeats": { "suggestAfter": 3 }`, or turn it off with `"repeats": { "enabled": false }`.

```sh
agentmgr playbook add "Flaky tests" "Find yesterday's flaky tests in CI and fix or quarantine them" --projects web,api --every weekday --at 09:00
agentmgr playbook ls
```

## Repo memory

Agents in the same repository share what they learn. When an agent finds out something non-obvious that would save the next one time (how to build or run the tests, a gotcha, where something lives, a convention that isn't written down), it records one line with `agentmgr learn "…"`, which it may run without asking. Every agent that starts in that repo afterwards gets the list with its instructions. Each line says which agent added it and when, and the same thing isn't added twice.

**Repo memory → View and edit** on an agent's Workspace card shows the file to tidy (keep it short and true; it is capped at 16 KB), and `agentmgr memory <agent>` prints it. The files live in `~/.agentmanager/memory/`, one per repository. Turn it off with `"memory": false` in config.json.

## Decision inbox

The **Inbox** tab (and `agentmgr inbox`) lists what needs you, across all agents:

| Kind | What it is | How you answer |
| --- | --- | --- |
| Needs input | A permission prompt or question menu is open in the agent's terminal; for Claude Code, the card shows the command or file it asks about | Click a choice (1, 2, 3, Esc); no need to open the terminal. Several agents waiting on the same command: **Yes to all** |
| Always allow? | You allowed the same command 3 times in a repo | **Always allow** (agents there stop asking) or **Not now** |
| Waiting on you | The AI judge read an idle screen and saw a question (or an error) no rule recognized | Click a choice or type an answer; **Not waiting** if it misread |
| Question | The agent asked something without stopping | Click an option or type an answer |
| AI review | The agent said it was done and the judge checked the work against the intent and brief | **Send back to finish** (types the missing items in) or **Looks good** |
| Stuck? | The agent seems to be going in circles | Send the suggested nudge (edit it first if you like) or dismiss |
| Overlap | It changes the same files as another agent | Tell one or both agents; see the suggested merge order |
| Follow up | An agent used in the last 3 days has been quiet for 2 hours and isn't finished: still open, or its session ended by itself or was closed by the session cap or clean up | Send the suggested nudge (edit it first), **Resume** a closed one, or **Close session**; **Later** (4 hours) or **Not needed** (until it's used again) |
| Close session? | It's done (its brief says so, or its pull request merged), quiet for 2 hours, and its session is still open | **Close session** (it resumes when you open it), **Later** or **Not needed** |

**One at a time.** On a phone the inbox opens as one card filling the screen, with its buttons under your thumb; answered, the next takes its place. Swipe left for the next card and right for the one before, or use **‹ ›**. **Show all** brings the list back and **One at a time** turns it on anywhere; the choice is kept in that browser.

Follow-up reminders skip agents that are working or already waiting on you for something else, and agents you closed yourself. Change the timing in config.json: `"reminders": { "quietHours": 2, "recentDays": 3, "laterHours": 4 }`, or turn them off with `"enabled": false`. From the command line: `agentmgr remind <agent> later|dismiss`.

**Limits.** When an engine stops at a usage limit ("5-hour limit reached ∙ resets 3pm", Codex's "You've hit your usage limit… try again at 3:05 PM", an exhausted quota) or a busy or failing service (429, 529 overloaded, 5xx), the agent shows **Limit** in the inbox with the message and when it resets. It is told to continue by itself a minute after the reset (a busy service: after 5 minutes), at most three times an hour; `"limits": { "autoResume": false }` in config.json turns that off. **Continue now** does it at once, and **Continue on Codex** (or any other installed engine; `agentmgr continue-on <agent> <engine>`) carries the work on: a new agent in the same folder and branch, started with the request, the brief and the end of the conversation (a conversation can't move between engines). The new agent owns the folder from then on; the old one is closed, and deleting it leaves the folder.

**Fewer questions: approval rules.** Each yes you give a permission prompt counts toward the command, per repo (`npm test`, `pytest`, `git status`; an MCP tool; fetching from a site). After 3, the inbox offers to always allow it there. An allowed rule goes to every agent in that repo when it starts (Claude Code's `--allowedTools`), and answers its prompts that are already open, so you aren't asked again. Rules are never offered for commands that chain, redirect or substitute (`&&`, `|`, `>`, `$(…)`), or that delete, escalate, publish or reach the network (`rm`, `sudo`, `git push`, `npm publish`, `curl`…). Settings → Approval rules (or `agentmgr rules`) lists them with how many prompts each answered; **Remove** to be asked again. Stored in `~/.agentmanager/rules.json`; In config.json, `"rules": { "auto": false }` stops rules answering open prompts and `"rules": { "suggestAfter": 5 }` changes the count. Once a rule is allowed in 2 repos, the inbox offers it for every repo. A few commands that only look (`ls`, `pwd`, `wc`, `git status`, `git diff`, `git log`, `git show`, `git blame`, `git rev-parse`) never ask in any repo; `"rules": { "readOnly": false }` turns that off. Claude Code and Codex agents learn rules (Codex from the command its prompt shows).

**Questions without stopping.** Task agents are told to write questions that don't block all their work to `QUESTIONS.md` next to their brief, with options and the default they'll assume meanwhile, and then keep going:

```markdown
## Postgres or SQLite for the cache?
Options: Postgres | SQLite
Default: SQLite
The data set is small.
```

**How answers reach the agent.** Answers, nudges and overlap warnings go into a per-agent queue. Each message is typed into the session as if you sent it, once the agent is idle: not mid-turn, and with no prompt open. A closed agent is resumed first. `agentmgr tell <agent> "…"` uses the same queue.

## Conflict radar

For each agent with its own branch, AI Agent Manager works out which files and line ranges its branch changed since it branched, including uncommitted and new files. Agents working in the same repository (the same shared clone or source folder) that touch the same file are flagged:

- **same lines**: both edit the same region, within a few lines (likely a merge conflict). Only judged when both branched from the same commit.
- **same file**: both edit the file, in different places.

The suggested merge order puts an agent whose PR is merged or open first; otherwise the smaller change lands first, so the other has less to rebase. An agent's overlaps are behind **⚔ Overlaps** in its detail (with how many), in a panel of their own; the Inbox lists each on the agent that should rebase. **Tell** sends an agent a short note naming the other agent, the files and the order. Attempts in one race, and a fork and its source, are expected to overlap, so they aren't flagged.

## Stuck detection

From the transcript, while an agent runs:

| Finding | Rule (defaults) |
| --- | --- |
| Same failure N× in a row | One command failing with the same output 3 times running |
| Undoing its own edits | 2 edits that put back what an earlier edit removed, or 10 edits to one file, within 45 minutes |
| N min without changing a file | 25+ actions over 20+ minutes since the last edit, while still active |

Each finding comes with a suggested nudge. Sending it also dismisses the finding; a dismissed finding comes back only if the agent gets stuck again. Tune the thresholds with `"stuck": { "repeatFailures": 3, "thrashReverts": 2, "thrashEdits": 10, "driftMinutes": 20, "driftActions": 25 }` in `config.json`.

With the AI judge on (the default), these rules are only the first look; see below.

## AI judge

Fixed rules are cheap but miss context: three identical failures can be a converging debug loop, a long stretch of reading can be a big codebase, and a question in plain words matches no pattern. So the rules now decide **when** to look, and a model decides **what is going on**. Each judgment is one separate, tool-less call (the agent is not interrupted) that returns a verdict, a confidence and its reasons, shown with a 🤖 tag.

| Judgment | Triggered when | The model decides |
| --- | --- | --- |
| Stuck | A stuck rule fires, or a looser version of it (half the failures, fewer edits, half the time) | Whether the agent is really stuck. A rule's finding shows until the judge clears it; a looser candidate shows only when the judge confirms it. The judge's diagnosis and nudge replace the canned ones. |
| Waiting on you | An agent has been idle for 20 s and no known prompt matched its screen | Whether it is asking something (inbox item with the question and its choices), finished, broken, or just idle |
| AI review | The brief turns to `Status: done`, the screen judge reads "finished", or **Review with AI** | Whether the work meets the intent and brief: complete, partial or not done, with what is met, missing and risky. A backlog item moves to review when the agent says it finished even if it forgot the brief. |
| Collisions | Two agents in one repo change the same file (the conflict radar's rule) or files in the same folder | Whether their work really collides, textually or in meaning (the same API, schema or behavior changed in incompatible ways from different files), which should land first and one line of advice for each. A same-file overlap in different places is dropped when the judge says it is harmless; a collision the rule can't see is added. **Not a clash** hides a pair. |
| Backlog order | Queued items and a free slot | Within a priority (which always wins): what others depend on goes first, an item that waits for another open item or would collide with work in progress is held (🤖 Waits for …), and an item that bundles several tasks gets a split suggestion (**Split into N** / **Keep whole**). |
| Alerts | A stuck, overlap, idle, blocked or review alert is about to go to Slack | Now, in the next digest (one message every 60 minutes), or not at all. Prompts, questions and errors always go out at once. |

**It learns from you.** Dismissing a finding, sending or editing a nudge, saying **Not waiting**, answering, sending work back or accepting it, telling agents about a collision or saying **Not a clash**, and splitting or keeping an item whole are recorded (the last 60, in `~/.agentmanager/judge.json`) and shown to the judge as recent examples, so it calibrates to how you work: dismiss a kind of call often and it becomes more conservative about it.

**Cost and fallbacks.** By default the judge uses Claude's fast model (`haiku`); a call takes a few seconds. Each screen is judged once, each stuck finding at most every 15 minutes, each pair of agents when their changed files move (at most every 30 minutes), the backlog order when the queue changes, a review only when the work changed, at most 2 calls at a time and 300 a day. Calls run on your own Claude (or Codex) plan. When the judge is off, over budget, or a call fails, you get the rule-based result as before. The bottom of the **Inbox** shows today's calls with **Turn off** / **Turn on**, and so does `agentmgr judge [on|off]`. Configure it in `config.json`:

```json
"judge": { "enabled": true, "engine": "claude", "model": "haiku", "dailyCalls": 300, "concurrency": 2, "idleSec": 20, "digestMin": 60 }
```

`engine` can be any installed engine that makes one-shot calls (for example `codex`); `"enabled": false` brings back the purely rule-based behavior.

## Checkpoints and forks

At the end of each turn, AI Agent Manager snapshots the agent's working tree as a commit under `refs/agentmgr/<agent>/<n>`. This doesn't touch the agent's branch, index or files. It records how far the conversation had got alongside. The last 40 are kept (`maxCheckpoints`); deleting the agent removes them.

**Fork** (or `agentmgr fork <agent> [-c n]`) creates a new agent:

- **Code:** a new worktree and branch at the same commit, with the same uncommitted changes as the source had at that point.
- **Conversation:** a copy of the transcript up to that point, under the fork's own session ID. The fork resumes it, so it knows everything the source knew.
- **Direction:** an optional first message, such as "try a different approach: …".

The source agent keeps running untouched.

## Teams

**+ New agents → Team** (or `agentmgr team start`) gives one problem to a team. By default the team is **one lead session**: one agent in your list, with one terminal, whose sub-agents (Claude Code's `--agents`) play the roles. The lead runs the steps and delegates each one to the right sub-agent. **Separate agents** (`--separate`) gives each role an agent of its own instead, with its own terminal, model and engine (for example a reviewer on Codex), and AI Agent Manager hands the work from one to the next.

```
 Analyze ──► Discuss ──► Implement ──► Test ──► Review ──► you: PR, keep, or send back
 analyst     critics      implementer   tester   reviewer
             agree / changes / questions  ▲  fail   │ changes
             (up to 3 rounds)             └─────────┴─ (up to 3 rounds)
```

- **Analyst** studies the problem and the code and writes the analysis: findings, approach, files, risks, how to test. It doesn't change code.
- **Critics** (0–2, default 1) challenge the analysis, marking points *must*, *should* or *question*. The analyst answers every point, changing the analysis or saying why not, until the critics agree.
- **Implementer** builds the agreed analysis and commits on the team's branch.
- **Tester** runs the tests and tries the change; it may add tests, but failures go back to the implementer.
- **Reviewer** reviews the diff against the analysis and the test report, and approves it or sends it back. It also checks coverage: what the request asks for that isn't built yet goes in its review's **Gaps** section, with a `coverage: complete` or `coverage: partial` line.

**Gap rounds.** A big request rarely gets built in one pass. When the reviewer approves good work but lists gaps, the team stops and shows you the gaps. **Run a gap round** (`agentmgr team fix-gaps <team> ["note"]`) starts the next quest (`quest-2/`, …), from a new analysis, for just what is missing, on the same branch; or take the work as it is. You can run a gap round after merging too. Each round shows up under **Earlier requests**. To let the team run some gap rounds without asking, set **Gap rounds without asking** in the form (`--gap-rounds 2`); it asks you once those are used up.

Either way, the roles hand off through Markdown files in the team's folder (`~/.agentmanager/teams/<id>/`: `analysis-1.md`, `critique-1-1.md`, `test-1.md`, `review-1.md`, …), each ending with a `verdict:` line. AI Agent Manager reads each verdict to show where the team stands, and you can read every handoff in the team view. With separate agents it also tells the next agent what to read. The team works in one worktree and branch.

**You step in only at the end:** when the reviewer approves, the team shows up in your inbox. **Open a pull request** (the implementer pushes and opens it), **Keep the branch**, or **Send back** with what to change (it goes through test and review again).

**The lead stays.** When a quest ends, the lead keeps its session. Ask it for more work in its terminal (or in the team view's **New request**, or `agentmgr team ask <team> "…"`), and it runs that request through the team as the next quest, on the same branch, with its own folder (`quest-2/`, …) and its own stop for you at the end. A question about the work just gets an answer. Earlier quests and their handoffs stay in the team view.

**A new project, with no repository yet:** leave the repository and folder empty (or give a folder that doesn't exist yet). The team creates the folder (under `~/.agentmanager/projects/` by default; `teams.newProjectsDir` in config.json), starts a git repository with an empty first commit on `main`, and works on its own branch. At the end you choose **Merge into main** (a fast-forward of the local `main`), **Publish to GitHub** (the implementer creates a private repository with `gh`, pushes, and opens a pull request), or **Keep the branch**. If the analyst and the critics don't agree within 3 rounds, or the tester and reviewer still send the work back after 3, the team stops and asks you: one more round (with a note), or move on.

**Cost:** a team is up to six sessions on one problem, so expect several times the tokens of a single agent. Pick the model per role, for example a stronger model for the analyst and the reviewer: `analyst=opus reviewer=opus` in the form, or `--role-model` on the command line. Defaults go in config.json under `teams`: `critics`, `maxRounds`, `maxLoops`, `gapRounds`, `models`, `engines` (a critic or reviewer on another engine sees different things).

## Races

**+ New agents → Race variants** (or `agentmgr race start`) creates one agent per variant. Each runs in its own worktree. A variant is a model, an approach, or both: `opus`, `sonnet | keep the change minimal`, `| use a cache`. **Compare** opens the scoreboard:

- **Status and outcome**, from each agent's brief, plus its checks
- **Change**: files and lines added and removed, with the smallest marked
- **Tests**: the race's test command, run in every attempt's worktree two at a time (15-minute limit each). **Runs** beside the command (or `agentmgr race test <race> --runs 3`) runs it up to five times in each attempt; an attempt that passes some runs and fails others shows as **flaky**
- **Cost and time**
- **Diff**: each attempt's full changes against where it started

**Pick** marks the winner and can close and delete the other attempts, worktrees included.

### Repeat runs: flaky or broken

One test run can pass or fail by chance, so the app's own test runs can be repeated on the same code. This holds for a race's tests and for the **Eval** of an agent on a Jira issue (the tests the app runs again itself when the agent says it is done).

- **Once (the default)**: a run that passes is believed. A run that fails is run once more, which tells a flaky test (failed, then passed) from a broken one (failed twice). A run that timed out is not repeated.
- **More than once**: set **Runs** (2 to 5) beside the test command, in the race or in the Eval; for the Eval it is kept for the project. Every run is made, whatever the first says.
- **Flaky** means it passed some runs and failed others. In the Eval that counts for part of the tests' weight, is listed as pending, and keeps the confidence under 100%, so nothing is merged on it automatically. The output shown is a failed run's.

Repeating costs test time, not AI usage.

## Alerts: Slack and the phone

Alerts go to Slack, to the phone as notifications, or to both.

**On the phone**, through [ntfy](https://ntfy.sh), an open-source notification service with an app for iPhone and Android:

```sh
agentmgr notify phone     # makes a topic nobody can guess and prints it
```

1. Install the **ntfy** app on the phone.
2. In it: **+ → Subscribe to topic**, and enter the topic that was printed.
3. `agentmgr notify test` sends one to try it.

A notification's title is the agent, and a tap opens it (at your phone address when remote access is on). Prompts, questions, errors and blocked agents arrive as high priority. It needs no Slack and works on any network, since the phone does not have to reach this computer to be told.

- **What leaves this computer.** The alert's text goes through ntfy.sh, a public service, and whoever knows the topic can read what is sent to it, so keep the topic to yourself. Turn off **include the intent text** to send less. `agentmgr notify phone --server https://ntfy.example.com` uses a server of your own, with `--token` if it needs one.
- **Why not the browser's own notifications?** A phone only allows those from a site whose certificate it trusts, and remote access uses a self-signed one.
- `agentmgr notify phone --off` stops them.

**Three ways to connect Slack:**

- **Workflow Builder.** Needs no app install, and can message you directly.
  1. In Slack, open *Workflows* (or *Automations*) and create a new workflow that starts **From a webhook**.
  2. Add **one variable**: name `text`, type *Text*.
  3. Add a step, **Send a message to a person** (yourself) or **…to a channel**, and insert the `text` variable as the message.
  4. Publish it and copy the web request URL (`https://hooks.slack.com/triggers/…`).
- **Incoming webhook.** Create an app at api.slack.com/apps → *Incoming Webhooks* → *Add New Webhook*, then pick a channel. Your workspace may require admin approval.
- **Bot token and channel.** If you already have a Slack app.

Then:

```sh
agentmgr notify slack --webhook https://hooks.slack.com/triggers/…   # Workflow Builder webhook
agentmgr notify slack --webhook https://hooks.slack.com/services/…   # or an app's incoming webhook
agentmgr notify slack --token xoxb-… --channel '#agents'            # or a bot token + channel
agentmgr notify test
```

Or use **Alerts** in the header (on this computer only), which has the phone's topic too. Settings, including the webhook or token, are stored in `~/.agentmanager/notify.json` (mode 0600) and masked in the UI and API.

| Alert | Default | When |
| --- | --- | --- |
| needs input | on | A trust or permission prompt or a question menu is still unanswered after 60 s |
| review | on | A backlog item finished and is ready for your review |
| error | on | Workspace setup or launch failed |
| waiting | off | The agent finished its turn and has been idle 2 min |
| blocked | on | The agent reports it is blocked (brief status or Results outcome) |
| stuck | on | The agent seems to be going in circles (see Stuck detection) |
| conflict | on | It changes the same files as another agent in the same repo (sent once per pair) |
| question | on | It asked a question in the decision inbox |

**Message behaviour:**

- **Once per episode.** Each alert is sent once, and again only after the condition clears and comes back.
- **Skipped while watching.** Alerts are skipped while you have that agent's terminal open.
- **Contents.** Messages include the agent, project, the intent (optional) and a link. The link uses your phone address when remote access is on.

## Phone and remote access

Remote access is **off until you turn it on**, because it opens this machine's terminals to your network (behind a sign-in). Each daemon listens on its local port + 1 (4717 → 4718). Installs from before 1.0, where it was on by default, keep it on.

```sh
agentmgr remote on        # turn it on
agentmgr remote status    # prints https://<this-mac-ip>:4718/ and the sign-in QR code
agentmgr remote off       # turn it off
```

Or use **Remote access** in the header of the UI on this computer.

**Connecting a phone:**

1. **Scan the QR code** with the phone camera. It opens the address and signs the phone in. The token rides in the `#fragment`, so it never reaches the server's logs, and the page removes it from the address bar.
2. **Accept the certificate warning** on the first visit. The certificate is self-signed and generated with macOS's built-in `/usr/bin/openssl`. Check the SHA-256 fingerprint shown by `agentmgr remote status`, then use *Show Details → visit this website* in Safari or *Advanced → Proceed* in Chrome.
3. **Use it.** On the phone, the terminal goes full screen with a key bar (Esc, Tab, ⇧Tab, arrows, Enter, ^C, 1–4 for Claude's menus) and a reply box. Agents that need input sort to the top, and the page title shows how many are waiting.

**Reachability.** Nothing extra is installed and no relay or tunnel is used, so the phone must be able to reach this computer directly:

- **Same network.** Use the same Wi-Fi, or join this computer to the phone's Personal Hotspot. Office Wi-Fi often blocks device-to-device traffic.
- **Corporate VPN.** A full-tunnel VPN usually routes even local-network traffic into the tunnel, so other devices can't reach the Mac while it's connected. If the phone can't load the page, disconnect the VPN (where policy allows) or use the hotspot.
- **Public IP.** A public address only works if your network forwards the port, which home routers can do and corporate networks won't. Ask IT before exposing it.

**Security.**

- **Separate listener.** Remote access is a second listener on HTTPS, all interfaces, with the local port + 1 by default. The local `127.0.0.1:4717` listener is unchanged. `AGENTMGR_REMOTE=1` (or `0`) in the environment sets the default for a daemon when you haven't chosen either way.
- **What needs sign-in.** Every API call except sign-in needs a device session (HttpOnly, Secure, SameSite=Strict cookie, 30 days, sliding). Only this machine's own addresses are accepted as `Host`, and cross-site origins are refused. Failed sign-ins are rate limited.
- **Local only.** Turning remote access on or off, the token and devices, and shutting down can only be done from this computer.
- **Devices.** `agentmgr remote rotate` (or **New access token**) signs every device out. Devices are listed with their address and last-seen time and can be signed out one by one.
- **Firewall.** If the macOS firewall is off, the port is open to your whole network while remote access is on. Turn it off when you don't need it.
- **Streaming.** The phone UI streams with Server-Sent Events plus plain HTTPS requests. iOS Safari doesn't apply an accepted self-signed certificate to WebSockets.

## Screen: this computer's desktop, from the phone too

A pop-up that waits for an answer, another program you want to watch: **Screen** in the top bar shows this computer's whole screen in the page, and your clicks, taps and typing go back to it. It works on the computer itself and on any device signed in through remote access.

It does not capture the screen itself. The computer's own screen sharing does, and AI Agent Manager relays that connection to signed-in pages and draws it with [noVNC](https://novnc.com):

1. On the Mac: **System Settings → General → Sharing → Screen Sharing**, on. (On Linux: any VNC server listening on port 5900 of `127.0.0.1`.)
2. On the computer itself: **Screen → Turn on** (or `agentmgr screen --on`).
3. From any signed-in device: **Screen → Connect**, and sign in with your Mac user name and password when the Mac asks. They go to the Mac's screen sharing and are not kept.

On a phone, the bar has a **Type here** field for the keyboard, and **Esc**, **Tab** and **⏎**. **−** and **+** zoom in up to 400% (the button between them goes back to **Fit**); zoomed in, **Move** lets a drag move around the screen instead of clicking in it. **Pad** turns the screen into a trackpad, for targets a fingertip covers: drag anywhere to move a pointer (a slow finger moves it finely) and tap to click where it is. Two fingers scroll or, tapped, right-click; hold a finger still, then drag, to drag. Zoomed in, the screen follows the pointer. The sign-in has **Show the password**, for a password typed on a phone. **Keys…** sends shortcuts and keys a phone's keyboard does not have: ⌘Space, ⌘Tab, copy, paste, undo, close, quit, force quit, the arrows and delete. With a keyboard, `Shift+S` opens Screen and `Shift+T` the Terminal on this computer.

A Mac with **Remote Management** on (instead of plain Screen Sharing) lets in only the users listed under **Sharing → Remote Management → ⓘ**, and refuses anyone else as if the password were wrong. The Screen dialog says so when this computer's user is not listed, with the command that adds it.

**Clip** is the computer's clipboard, as text. Type or paste into its box and **Send and paste** puts it on the computer's clipboard and pastes it where the cursor is there (a password, a link, a one-time code); **Send** only puts it there. **Fetch** brings back what was copied on the computer (**Keys… → copy** first) and, where the browser allows, puts it on this device's clipboard too. The daemon reads and sets the clipboard itself (`pbcopy` and `pbpaste` on a Mac; `wl-copy` or `xclip` on Linux), because a Mac's screen sharing shares it only with Apple's own viewer. It works only while screen access is on.

**Files** (in the Screen bar, the Terminal bar and the ☰ menu: **Files on this computer…**) shows this computer's folders, starting in Downloads. **Send files here…** puts files from the device in your hand (photos too, up to 250 MB each) into the folder shown, never over a file that is there: a second `photo.jpg` becomes `photo (2).jpg`. Tap a folder to open it and a file to fetch it to the device. It reaches what the terminal on this computer reaches, and is allowed wherever that is.

**Keep this computer awake**, in the Screen dialog before you connect (or `agentmgr awake always`): a sleeping computer shows nothing, runs no agents and cannot be reached from the phone. **Always** keeps it from going to sleep by itself for as long as AI Agent Manager runs; **While an agent works** only then, and for five minutes after. It uses `caffeinate` on a Mac and `systemd-inhibit` on Linux. The display may still sleep and lock, and closing a laptop's lid still puts it to sleep.

- **Whoever uses it controls the whole computer,** not only the agents. So it is off until you turn it on, it can be turned on only on the computer itself (not from a signed-in device), and the computer's screen sharing still asks for its own sign-in every time.
- **Who is looking:** while another device views the screen, the **Screen** button shows a dot, and its tooltip and `agentmgr screen` name the device and its address. **Turn off** ends every view at once.
- **Only this computer.** The relay connects to `127.0.0.1` and nothing else; `agentmgr screen --port <n>` picks another port there.
- **Limits:** a locked screen shows the lock screen, a sleeping computer shows nothing, and a company-managed Mac may have Screen Sharing disabled by policy. Up to 4 views at a time.

## Engines: Claude Code, Codex, Antigravity and Muse Code

Agents run Claude Code by default. With OpenAI's Codex CLI installed (`npm i -g @openai/codex`, signed in), an agent can run Codex instead: `agentmgr add --engine codex …`, or the **Engine** picker in New agent (shown once a second engine is installed). Everything else works the same way: worktrees, the brief and questions, the inbox (Codex's approval menus included), token usage, stuck detection, PR tracking, Explain, the backlog and the hub. Codex records no cost, and planning while a repo clones and forks are Claude-only for now. Set `"engine": "codex"` in config.json to make it the default; `engines.codex.bin` points at another binary. On the hub, each machine reports the engines it has (`engine:codex`), so shared backlog work can ask for one. See [docs/engines.md](docs/engines.md).

Google's **Antigravity CLI** (`agy`, signed in with your Google account) works the same way: `--engine antigravity`. It replaced Gemini CLI for personal Google accounts in June 2026. AI Agent Manager adopts the conversation agy starts, resumes it with `--conversation`, reads token usage, commands and file writes from its transcript, shows its permission menus (commands, file changes, access outside the folder) in the inbox, pre-trusts agent folders in agy's settings, and runs Explain in agy's print mode. agy asks before writing the brief too, unless the agent runs in `acceptEdits` mode. `engines.antigravity.bin` points at another binary.

Meta's **Muse Code** (`muse`, installed with `curl -fsSL https://dev.meta.ai/install.sh | bash` and signed in with `muse login`) works the same way: `--engine muse`. AI Agent Manager adopts the session Muse starts, resumes it with `muse resume` (a message for a resumed session is typed once Muse is idle), trusts the agent's folder for each run with `--trust-workspace` instead of saving it, reads the conversation and token usage from Muse's session log, shows its trust and approval questions in the inbox, stops it cleanly with SIGTERM, and runs Explain with `muse exec` in the read-only profile. Commands and edits aren't read from its log yet, so stuck detection has less to go on for Muse agents. When Muse runs in contributor mode (an account without a plan), the engine picker says so: Meta may use your code and conversations to improve its products. `engines.muse.bin` points at another binary, and `engines.muse.args` adds arguments to every run.

## Local models: Ollama, LM Studio, llama.cpp, MLX

An agent can run on a model served on this computer instead of a provider's: no plan, no limits, and nothing leaves the machine. AI Agent Manager finds the model servers running here by asking their usual addresses, and runs the model in a harness you choose, pointed at the local server:

| Harness | Engine | Notes |
|---|---|---|
| **Codex CLI** (open source; `npm i -g @openai/codex`, no sign-in needed for this) | `local-codex` | A small first message, so it suits small contexts. It is told that its commands need no approval, since open models otherwise ask at every step. With `gpt-oss:20b` on Ollama its file edits often fail (the model writes a tool call Ollama can't read, and the turn stops): use OpenCode or Claude Code for that model. |
| **OpenCode** (open source; `npm i -g opencode-ai`) | `local-opencode` | The default: in our trials an open model finished a task on it more often than on Codex. Made for many providers. Runs over ACP, so the app reads less from it (no token counts). |
| **Claude Code** | `local-claude` | Everything the app does for Claude Code agents, but Anthropic doesn't support Claude Code on other models: expect rough edges. The server has to speak Anthropic's API, which Ollama does. |

`--engine local` is the harness set with `agentmgr models --harness codex|opencode|claude`, or else the first installed of OpenCode, Codex and Claude Code.

- **What is found.** Ollama (port 11434), LM Studio (1234), and llama.cpp's `llama-server` or MLX's `mlx_lm.server` (8080), plus any server that speaks the OpenAI API at an address you add: `agentmgr models --add mlx=http://127.0.0.1:8081`. **OS** lists each server's models with their size and whether an agent can use them, as does `agentmgr models`. A model that can't call tools is listed but can't be chosen: an agent needs tools to read and change files. Embedding models are left out.
- **Starting an agent on one.** Choose **Local · Codex**, **Local · OpenCode** or **Local · Claude Code** as the engine in New agent or Ask Agent (each offered while its harness is installed and a server with a usable model is running) and pick the model, or `agentmgr add --engine local --model ollama/qwen3-coder:30b "…"`. A model is written `<server>/<model>`. `agentmgr models --default <model>` sets the one used when none is given.
- **Everything else is the harness's own engine**: worktrees and lanes, the brief, the inbox with the harness's approval menus, stuck detection, stop and resume. Summaries and reviews (Explain, Review with AI) stay with your usual engine, no cost is counted, and the Usage window leaves local engines out: there is no plan to show. Claude Code is started without MCP servers, whose tool lists would take much of a local model's context. Not in containers yet.
- **Context on Ollama.** Ollama starts a model with a few thousand tokens of context whatever the model can take, which is less than a coding agent's first message. So the first time an agent starts on an Ollama model, a copy of it with room for 32,768 tokens is made (`gpt-oss:20b` becomes `gpt-oss-am32k:20b` in `ollama list`; the weights are shared, so it takes no disk space). `agentmgr models --context <tokens>` changes the room, and `--context 0` leaves Ollama's own setting alone. Other servers keep the context they were started with: give LM Studio, llama.cpp or MLX at least 16,000 tokens.
- **A Codex home of its own.** Local Codex agents run Codex from `~/.agentmanager/codex-local`, not your `~/.codex`: your Codex plugins and MCP servers would fill a local model's context before the task starts. Your `AGENTS.md` is still used, and sessions are kept with your other Codex sessions.
- **What to expect.** A local model is much weaker than Claude or GPT at work of many steps, and slower. On a Mac with 24 GB of memory, a model of about 20 billion parameters is the practical ceiling, one agent at a time. Small models (under 7 billion parameters) are marked: they answer a question but rarely finish a task.

`"localModels": { "enabled": false }` in config.json (or `agentmgr models --off`) stops the lookups. `agentmgr models --remove <name>` stops asking one server.

## Agents in containers

For isolation, an agent can run in its own Docker container: it sees only its own folder (mounted at the same path), its repository's git data, its brief and its uploads, and nothing else on the computer. Everything else works as usual: sessions, resume, tracking and usage, the inbox, **Open shell** (which opens inside the container), stop and restart.

1. Start Docker (Docker Desktop, OrbStack or Colima).
2. **☰ → Settings → Containers → Build image** (or `agentmgr sandbox build`): Node, git, ripgrep, Claude Code and Codex, from `docker/agent.Dockerfile`. About a minute.
3. For Claude Code, run `claude setup-token` in a terminal and paste the token in **Settings → Containers** (or `agentmgr sandbox token <token>`); it's kept in `~/.agentmanager/secrets.json`, readable only by you. Codex uses its own `auth.json`, read-only.
4. Tick **Run each agent in its own container** in New agents (`agentmgr add --container`), or make it the default in Settings.

Claude Code and Codex can run in containers; Antigravity and Muse Code ship macOS-only programs. Files are written as your user. Limits and extras go in config.json: `"isolation": { "cpus": 2, "memory": "4g", "network": "none", "mounts": [{ "host": "~/.npm", "readOnly": true }], "env": ["NPM_TOKEN"] }` (variables are passed by name, so their values stay out of command lines). `agentmgr sandbox status` shows what's ready.

## ACP agents

Any agent that speaks [ACP](https://agentclientprotocol.com) (the Agent Client Protocol) works as an engine. Gemini CLI, OpenCode, Goose and Qwen Code show in the Engine picker once installed (and signed in once in a terminal); add others in config.json:

```json
"acp": { "myagent": { "command": ["myagent", "acp"], "label": "My Agent" } }
```

That adds the engine `acp-myagent` (`agentmgr add --engine acp-myagent …`); `"opencode": false` hides a preset. ACP agents have no screen of their own, so AI Agent Manager runs a small terminal client in the agent's terminal: it shows the agent's messages, tool calls and plan, sends what you type as prompts (Ctrl+C cancels the turn), asks permission as a numbered menu that the inbox can answer (**Bypass** allows by itself), writes files only inside the agent's folder and brief, resumes sessions the agent can load, and keeps a log in `~/.agentmanager/acp/<name>/` that drives usage, PR links, stuck detection and Explain.

## Several machines: the hub

With agents on more than one Mac, a **hub** shows all of them in one place: every machine's agents and one inbox of what needs you. Where a machine allows it, you can also act from the hub: answer, message, start and stop agents, start new ones, and open live terminals. Each Mac keeps running its own daemon. It connects out to the hub, so no ports need opening on it, and the hub's requests travel back over that same connection.

```sh
# Where the hub runs (any Mac that stays on, or Railway):
agentmgr hub serve                                   # this Mac and its Tailscale address; prints a sign-in link
agentmgr hub invite                                  # one-time code, valid 10 minutes

# On each Mac to add:
agentmgr join http://<hub-tailscale-ip>:4720 ABCD-EFGH-JKLM --name laptop

agentmgr fleet           # agents on every machine, and what needs you
agentmgr fleet answer laptop/3f2a1c q1 "Postgres"
agentmgr fleet tell laptop/3f2a1c "Also update the docs"
agentmgr fleet start laptop/3f2a1c          # or stop
agentmgr fleet new laptop web "Add a dark mode toggle"
agentmgr fleet backlog add web "Fix the footer links" "Add a sitemap"   # runs where there's room
agentmgr fleet backlog   # shared backlog: where each item runs, what waits and why
agentmgr hub machines    # online/offline, versions, what each allows
agentmgr hub status      # this Mac's link to its hub
agentmgr leave           # the hub forgets this Mac
```

**Addresses.** Use `https://` for the hub, or plain `http://` only on this machine or over Tailscale, which already encrypts traffic. **Open** links go to each Mac's remote-access address, its Tailscale one first, so remote access must be on there (`agentmgr remote on`).

**Each Mac decides what the hub may do.** A new machine shares `view` only. More is opt-in, per machine, in its `~/.agentmanager/config.json` (restart its daemon after changing it):

```json
{ "hub": { "allow": ["view", "inbox", "control", "create", "terminal"], "projects": ["cc", "web"], "labels": ["gpu"], "maxAgents": 4, "perProject": 2 } }
```

| Permission | The hub may |
| --- | --- |
| `view` | See agents (name, status, intent, branch, PRs, cost) and inbox items. Never code, transcripts or local paths. |
| `inbox` | Answer questions, pick a prompt's choice (this can approve a tool), send stuck nudges, warn about overlaps, answer what the AI judge read, handle AI reviews |
| `control` | Message an agent, start, stop, checkpoint, change priority |
| `create` | Start new agents in this machine's registered projects. Never with permission prompts skipped. |
| `terminal` | Open the live Claude terminal |
| `shell` | Open shells in an agent's folder. These run any command, so grant with care. |
| `signin` | Open this machine's own page already signed in: **Open on <machine>** asks for a one-time link (single use, valid for a minute) instead of the access token. That page has full control, beyond the rest of this policy, so grant it only on a hub that only you can sign in to. |
| `move` | Move agents to and from other machines that also allow it (**Move to…** on the hub, or `agentmgr fleet move`). See **Moving an agent** below. |

`projects` (names or shortcuts) limits all of it to those projects: other agents aren't shown and can't be touched. `"allow": []` stops sharing but stays joined. The machine checks every request itself, even if the hub thinks it's allowed, matches agents by exact ID, and only runs a fixed list of actions (deleting agents isn't one). Each request, and every refusal, is written to `~/.agentmanager/hub-audit.log`; the hub keeps its own `audit.log` too.

**The shared backlog.** Work you queue on the hub (the **Backlog** tab, or `agentmgr fleet backlog add`) starts on whichever machine can take it, one agent per item. Each item has to land on a machine that is online, allows `create` and shares the project, and that has every label the item asks for. Among those, it goes to one with room, preferring a machine that already has the repo cloned, then the least busy.

- **Projects across machines.** A project matches across machines by its repo, even under different shortcuts; projects without a remote repo match by name.
- **Room.** Each machine sets its own limits: `hub.maxAgents` in total (default `backlogMaxActive`, 4) and `hub.perProject` (default `backlogParallel`, 2). Items from its own local backlog count against them too.
- **Labels.** `os:mac` and `arch:arm64` come automatically, `machine:<name>` pins an item to one machine, and anything else comes from that machine's `hub.labels`, for example `["gpu", "fast-net"]`.
- **Review.** As with the local backlog, an agent whose brief says done moves to **review**: **Accept** finishes it, and **Reopen** sends a note back to the same agent (this needs `control` on that machine). An item waiting for room says why, for example `laptop is full (2/2 in this project)`.
- **When a machine drops mid-item.** Its item shows as **stalled** and isn't restarted elsewhere on its own, because the work in that machine's worktree would be lost or duplicated. Wait for the machine, or **Requeue** to start over on a different one.
- **Pausing.** `agentmgr fleet backlog pause` (or **Auto-start** off) stops new starts; **Start now** runs one item past the limits.

**Moving an agent to another machine.** **Move to…** on an agent in the hub (or `agentmgr fleet move mini/3fa2b1 --to laptop`) continues it on another machine with the same conversation, the same branch and its uncommitted work. Use it to pick up on the laptop what the mini started, or to free a busy machine. Both machines must allow `move`, and the other machine needs the same project (matched by repo).

1. On the machine it leaves, its session closes. A snapshot of the folder (commits, edits and new files) is pushed to the repo's own remote as `agentmgr-handoff/<id>`.
2. The other machine creates the agent in its matching project with the same session id. It checks out the branch, restores the uncommitted work, places the conversation where Claude looks for it (with folder paths rewritten), and resumes it if it was running.
3. The first machine marks its copy **Moved to <machine>**, which can't be resumed (two copies of one conversation would diverge), and the handoff branch is deleted.

The conversation passes through the hub in pieces, in memory only for the move, so the hub keeps neither code nor transcripts. If any step fails, the copy made on the other machine is removed, and the agent opens again where it was. It needs a repository with a remote that both machines can reach; Claude Code agents only, for now.

**How machines prove who they are.** Joining makes an Ed25519 key pair on the Mac. The private key stays in `~/.agentmanager/hub-link.json` (mode 600), and the hub keeps only the public key. Each connection signs a fresh challenge from the hub. Invite codes work once. **Remove** on the hub (or `agentmgr hub remove <machine>`) disconnects a machine, and it stops retrying until it joins again.

**Signing in with Google.** Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (a Web application OAuth client whose redirect URI is `<hub address>/api/auth/google/callback`) and `AGENTMGR_HUB_GOOGLE_EMAILS` (comma-separated accounts allowed in). The sign-in page then offers **Sign in with Google**, with the access token folded away below it. It uses the authorization code flow with PKCE, state and nonce, and accepts only verified emails on that list. Without the list, Google sign-in stays off.

**Signing in to the hub.** The hub has one access token: `AGENTMGR_HUB_TOKEN`, or one it generates and prints as a sign-in link (`agentmgr hub token` shows it again). Browsers get a 30-day session cookie. The CLI sends the token: on the hub's own Mac it is read from the hub's state, elsewhere set `AGENTMGR_HUB_TOKEN` and `AGENTMGR_HUB_URL`, or rely on the hub this Mac joined.

**On Railway.** `hub/Dockerfile` builds the hub alone, with no node-pty and no Claude. Set `RAILWAY_DOCKERFILE_PATH=hub/Dockerfile`, `AGENTMGR_HUB_TOKEN`, `AGENTMGR_HUB_URL` (its https address) and, for Google sign-in, the three variables above; add a volume at `/data` so enrollments survive redeploys, and join with the `https://…up.railway.app` address.

**Cloud runners.** For agents that keep working with your laptop closed, run AI Agent Manager on a server (Railway, any VM with Docker) as a runner joined to your hub, and Move agents to it: see [docs/cloud-runner.md](docs/cloud-runner.md).

## Assistant

An always-on Claude session that works on your behalf. **Assistant** in the top bar (or `agentmgr assistant start`) sets it up. Every 15 minutes the daemon asks it to check for new work, and it starts an agent for each new item, or passes the news to the agent already on it. You don't approve each one; it tells you in its activity log and, with Slack alerts on, in Slack.

| It watches | What it does |
|---|---|
| Jira issues newly assigned to you | Starts an agent in the matching project, with the issue link first so the agent is named after the issue (`OPS-7`); with **Let me pick** on, lists it under **Jira → Not started** for you to tick instead |
| Linear issues newly assigned to you (turn it on in the dialog) | The same, with the Linear link first (`ENG-42`) |
| New comments and mentions on your Jira issues | Passes the comment to the agent on that issue (`agentmgr tell`), or starts one if the comment asks for new work |
| GitHub pull requests waiting for your review | Starts a review agent that drafts the review for you to post |
| Failing checks on your open pull requests | Tells the agent on that PR to fix it, or starts one |
| Slack messages to you that ask for work | Starts an agent for clear requests in a known project |

It reads Jira and Slack with the tools your Claude Code already has (no credentials in agentmgr), so connect the Atlassian and Slack MCP servers at user scope, and sign in to `gh`. It runs in `~/.agentmanager/assistant` in `auto` permission mode, so it can run `agentmgr` and `gh` without asking. It never merges, approves, comments or sends messages as you.

The daemon enforces its limits, whatever the session decides: at most 10 new agents a day, at most 5 of its agents running at once, and never a second agent for the same Jira key. Agents it started are marked **by assistant**. It keeps what it has handled in `handled.json` so it never acts twice, and writes `activity.md`, shown in the dialog, with a **Needs you** list for anything it couldn't place. Use **Notes for the assistant** to say which Jira project goes to which repo. Clean up never closes the assistant.

```bash
agentmgr assistant start                    # set it up, or turn it back on
agentmgr assistant                          # on or paused, last check, agents it started (--activity for its log)
agentmgr assistant check                    # check now
agentmgr assistant set --every 10 --sources jira,comments,reviews,ci --max-per-day 5 --notes "OPS is the @cc repo"
agentmgr assistant pause                    # stop checking and close the session
```

Settings live in `config.json` under `"assistant"`. A running assistant reads new watch lists and notes after **Pause** and **Turn on**.

### Jira summary

**Jira** in the top bar (or `i`) lists every Jira or Linear issue an agent works on (the ones started from an issue link, by you or the assistant), one row per agent. **Waiting for you** comes first, and its count shows on the button:

| Where it stands | When |
|---|---|
| Needs your answer | The agent asked a question, waits at a prompt, or its plan waits for review |
| Ready for your review | Its pull request is open, not a draft, with no review yet and checks not failing; or it finished without a pull request |
| Blocked | It says it can't go on |
| Approved, not merged yet | You approved; merging is left |

**Not started** comes before them: issues proposed for agents, each with a box to tick. Tick the ones you want and press **Start**: agents start only for those, named after the issue. **Dismiss** takes ticked ones off the list, and they aren't proposed again. Issues get there when **Let me pick** is on in **Assistant** (`agentmgr assistant set --pick-issues on`): the assistant then proposes new Jira and Linear issues assigned to you instead of starting agents for them. You can propose one yourself too: `agentmgr issues propose @cc "<issue link> what to do"`.

**Agents on it** has the ones still working, fixing failing checks or working on your review comments; **Done** the merged and closed ones. Each row shows the issue with its Jira status, the agent's plan (**Read** it here, steps done, and whether it waits for your approval) and design doc (**Read**, its design page and Google Doc), the pull request with its checks and AI review, and the agent, which opens its session. Jira status needs your site, email and API token in **Settings → Jira** (public Atlassian Cloud issues need nothing); it's fetched a few issues at a time and kept five minutes. **Copy** puts the list as a Markdown table on the clipboard, for Slack, Jira or a doc.

```bash
agentmgr issues               # not started, and waiting for your review
agentmgr issues start OPS-7 OPS-9   # start agents for proposed issues
agentmgr issues dismiss OPS-8       # not for an agent
agentmgr issues --all         # and the rest
agentmgr issues --markdown    # a table to paste
```

### Explain the review, by voice

**🔊 Explain** on a pull request (in **Jira**, **Land**, and next to **Review with AI** on the agent) reads a short spoken briefing for whoever reviews it, in this order: the issue; the PR and its state (open or draft, checks, conflicts, approved or changes requested); what it does, from the agent's design doc, else its change walkthrough; the AI review's verdict with what is met, missing and risky; the high-risk changes from the walkthrough; questions the agent is waiting on; and what's left before it can merge. It's built from what AI Agent Manager already tracks, so it starts at once; for each change in turn, use 🔊 Listen in **Review**. Pause, stop and speed are next to it while it plays.

### Designs

**Designs** in the top bar (or `d`) lists every agent's design doc, the ones whose work waits for your review first, with their count on the button. Each shows the doc's name and the summary from its DESIGN.md, the agent (opens its session), its Jira issue and where the work stands, and links: **Read** it here, the design page the agent published, its Google Doc after **Publish to Google Drive**, and the PRDs and tech specs in the agent's brief. Search by name, summary, agent, project or issue; **Copy** puts the shown list on the clipboard as Markdown.

```bash
agentmgr designs              # all design docs
agentmgr designs --waiting    # only the ones waiting for your review
agentmgr designs --markdown   # a list to paste
```

### Reviews: other people's pull requests

When you're a reviewer on someone else's pull request, a reviewer agent does the first careful pass for you. **Reviews** in the top bar (or `g`) lists pull requests where GitHub has your review requested; tick some and **Review with agents**, or paste any PR link and **Review**. The project is the one whose repository the PR is in.

A reviewer is read-only. It checks out the PR's head, reads the description, discussion and diff and as much of the surrounding code as it needs, and may run the tests; it never commits, pushes, approves or comments. It writes:

- **A verdict:** approve, approve with nits, or **blocked**, with the reason. Any open blocker means blocked.
- **Approval blockers:** each with its file and line, why it fails (correctness, security, data loss, a breaking change, missing tests for risky logic, not doing what the PR says), and what would resolve it. Style is never a blocker.
- **Critical questions for the author:** what the code and description don't answer, such as intent, edge cases, rollout and rollback.
- **Risks, test gaps and nits**, kept apart from the blockers.

Open a review to read it, ask the reviewer about it in its session, or hear it with **🔊 Explain**. Tick what to send (open blockers and questions are ticked to start with) and **Post as pending review**: it becomes a draft review on GitHub under your name, with each item on its line, that only you see until you submit it there. A line outside the diff goes in the review's text instead. **Copy** gives the ticked items as Markdown. When the author pushes, the review is marked **New commits** and the reviewer re-checks each blocker, marking the fixed ones resolved.

With **GitHub reviews** on in **Assistant**, it starts reviewers for new requests by itself, unless **Let me pick** is on; then they wait in **Reviews** for you to tick.

```bash
agentmgr review https://github.com/acme/api/pull/42   # start a reviewer (--project, --notes)
agentmgr reviews                                       # the list, with verdicts
agentmgr reviews show <agent>                          # blockers, questions, risks
agentmgr reviews post <agent> b1 q2                    # a pending review with those items
```

## Triggers

Start agents from where the work lives, with no session watching and no tokens spent on it. **Assistant → Triggers…**, or `agentmgr triggers`:

- **GitHub label.** Every few minutes, open issues with a label (`agentmgr` by default) in the repos or owners you list each get an agent in that repo, named `repo#12`, asked to open a pull request that fixes the issue. A project already on that repo reuses its clone. Each issue starts one agent, once. Labeling an issue needs triage access to the repo, so that is the go-ahead. **Comment on the issue** (off by default) says an agent is on it.
- **Pull request comments.** A comment that starts with `/agent` on an agent's open pull request, from the repo's owners, members or collaborators, is typed into that agent: `/agent add a test for Safari`. On by default.
- **Webhook.** `POST /api/hooks/agents` with `Authorization: Bearer <token>` and `{"intent": "…", "project": "<shortcut>"}` (or `"repo": "<git URL>"`, optional `"name"`, `"priority"`, `"url"`) creates an agent, for Jira automation, CI or scripts. Off until you make a token (**New token**, or `agentmgr triggers set --new-token`); the token is shown once. **Only these repos** limits where it may start agents. The daemon listens on this computer only, so other machines reach it through remote access.

Agents started this way are marked **⚡ GitHub** or **⚡ webhook**, Slack alerts can announce them, and triggers start at most 20 agents a day (`maxPerDay`). Agents use your default permission mode; a webhook can't pick another. In config.json:

```json
"triggers": {
  "github": { "enabled": true, "label": "agentmgr", "repos": ["acme/web"], "owners": [], "everyMin": 5, "comment": false },
  "prCommands": { "enabled": true, "prefix": "/agent" },
  "webhook": { "enabled": false, "repos": [] },
  "maxPerDay": 20
}
```

## Try the other path

Agents write down the paths they weighed before building, the one they take first (**Paths it weighed** in their Results). Each other path has **Try this path**, or `agentmgr try-path <agent> <n>`. It starts a second agent from the commit the first one started from, told to take that path, and races the two: the [race](#races) scoreboard, a test command run in both, and **Pick** to keep one. More paths join the same race. Only you start one, not an agent.

## Why is this line here?

In **Review changes**, each added line has a **?**. It shows the moment in the agent's conversation that wrote the line: what it had been asked, what it said just before, the commands it had just run, and how many times it wrote that line. `agentmgr why <agent> src/cart.js:42` prints the same, with the edit. It is read from the agent's own transcripts (and its subagents'), so a line no edit wrote is reported as not found rather than guessed. Claude Code agents for now.

## Scope fence

An agent asked to fix login that starts rewriting payments is not stuck; it is wandering. The areas of code it changes (a folder such as `src/payments`) are set against what it was asked and planned: its intent, spec, plan and brief. An area none of them names, changed in more than a line or two, shows in Glance and its Results as drifting. Tests, docs and config never count. **Allow** puts an area in scope; **Pull it back** tells it to stay within the task. `agentmgr fence <agent> [--allow <area> | --pull]`. No model is asked.

## Bug echo

Accepting a lesson in a repository's standards gives it to every later agent there. Bug echo also checks the agents already at work: a model reads each one's diff against the lesson, and one that repeats the mistake shows in Glance with where, to **Tell it** or mark **Not the same**. Off with `"echo": { "enabled": false }` in config.json.

## Night watch

Does merged work still hold? For work merged in the last 14 days, the agent's recorded proof commands are run again against the latest main, in a checkout of their own. One that no longer gives the recorded result shows in Glance, with the commits since its merge that changed the same files. Off until you turn it on: **Night watch** at the foot of Glance (on or off, the hour, **Run now**, and what it found), or `agentmgr night-watch --on` (every night at 3, `--hour` to change) and `--run` to run it now. Commands that change things are never run.

## Your calibration

Under **Your guess** in New agent (or `agentmgr guess <agent> --finish yes --hours 2 --review look`), say whether it will finish, how long it will take, and how much reading its work will need. Once the work settles, **Your calibration** (at the foot of Glance, or `agentmgr calibration`) sets your guesses against what happened, names the kind of work you misjudge most, and shows how the agents' own confidence held up on the same work. Private to this computer.

## At a glance: every agent, and what to act on

**Glance** in the top bar, or `agentmgr glance`, puts every agent on one line, grouped by what it needs from you:

- **Needs you now**: stopped at a prompt, stopped at a question, waiting for you to sign in, stopped with an error, or stuck.
- **To fix**: its pull request has failing checks, requested changes or a merge conflict; it says it is blocked; or it changes the same files as another agent.
- **To review**: finished work waiting for review, with its [Read first](#read-first-where-your-attention-goes) level, and pull requests ready to merge.
- **To answer**: questions it asked without stopping, still unanswered (the Inbox).
- **Working**, **Follow up** (quiet and not finished), **Tidy up** (done, but its session is still open) and **Idle**.

Each line says why, from what the app already knows; no model is asked. The badge on the button counts what needs you now and what is to fix. Click a line to open the agent. `agentmgr glance --all` lists the idle agents too, `-o glance.md` writes it as Markdown, and the command exits with 1 when something needs you now or is to fix.

## Read first: where your attention goes

You cannot read everything agents produce with the same care. **Read first** in the top bar, or `agentmgr read-first`, ranks finished work waiting for your review by how much it needs reading.

Each piece gets a level, the reasons, and where to start:

| Level | Means |
| --- | --- |
| **Read closely** | Several things measured speak against it (45 points or more) |
| **Look** | Something does, or little was measured (20 to 44) |
| **Skim** | Nothing measured speaks against it |

The points add up facts the app already holds. No model decides the ranking, so each reason can be checked:

| What | Points |
| --- | --- |
| Touches files you marked high risk | 30 |
| The scorecard says not ready; says to look first; not scored yet | 30; 15; 10 |
| The quality bar is not met; CI is failing; its own tests fail when run | 25 each |
| A recorded command gave a different result when run again | 25 |
| One of its own checks failed | 20 |
| Deliberate breaks its tests did not notice | 12 to 20 |
| A large change: over 1500 lines; over 400 | 20; 10 |
| Its own confidence under 65%; under 85%; none given | 15; 5; 5 |
| Points of what done means that are not met; that have no recorded run behind them | 15 each up to 30; 6 each up to 18 |
| Things it lists as not done | 6 each, up to 18 |
| Risks it named that happened; that it did not check | 10 each; 5 each |
| It says the work is partial | 10 |
| No proof recorded for passed checks; code changed with no test file | 8 each |
| Questions answered for you while it ran without you | 6 to 12 |
| Its tests have not been tested | 5 |

What speaks for a piece is listed too: the scorecard says ready, its tests caught every break, its recorded commands gave the same result again.

- **Start with.** High-risk files, the places the scorecard pointed at, and the lines whose breaks went unnoticed.
- **In an agent's Results.** A **Review** line with its level and the first reasons; **Why** opens the full list.
- **Leaving the queue.** A piece leaves when its pull request merges, or when you press **Mark as reviewed** (`--reviewed <agent>`). It comes back if the agent changes its work again. **Mark those as reviewed** clears everything finished more than 14 days ago (`--reviewed-older 14`). An agent cannot mark its own work.
- **Exit code.** `agentmgr read-first` exits with 1 when something is to be read closely.

### Understanding check

Ranking tells you where to look. **Check my understanding** (on a piece in Read first, or `agentmgr understand <agent>`) asks whether you did, before you approve.

- It writes two or three questions from the agent's changes: what happens on a failure, an empty input, a second call, or what else depends on what changed. Not trivia and not names.
- You answer in your head. Then **Show the answer**, which comes with where to read it, and say whether you knew it.
- The ones you did not know point to the file and hunk. Nothing grades you and nothing is sent anywhere.
- The command prints only the questions; `--answers` prints the answers. `--again` writes new ones.
- It is one model call. The questions and answers are the model's reading of the diff: check an answer against the code before you trust it.

**Limits.** "Skim" means nothing that was measured speaks against it. It does not mean the work is correct. Work finished before proof, confidence and the scorecard existed has little measured, so it ranks as "Look" for that reason alone. The points are a fixed table chosen by judgement, not fitted to data; the [track record](#track-record-was-the-confidence-right) will show over time whether the ranking matches what held up.

## Requirement trace: from each point of what done means to what shows it

In an agent's **Proof** dialog under **What done means, traced**, or `agentmgr trace <agent>`: each point you [agreed on](#acceptance-agree-on-what-done-means) (or the scorecard's criteria when none were agreed), followed to:

- the scorecard's finding (met, not met, not verified) and its evidence,
- the checks the agent recorded for it, with the command, the exit code, and whether it gave the same result when the app ran it again,
- what is missing: nothing recorded, checked by reading only, a different result when run again, or not met.

A point with a gap stands out and counts in the [Read first](#read-first-where-your-attention-goes) ranking. `agentmgr trace` exits with 1 when a point has a gap. It joins what the scorecard and the proof already hold, with no model call. A point is matched to a check by the id its section starts with ("A2 ...") or by the same wording.

## Weekly summary: the week's work and achievements, for management

**Work record → Weekly summary**, or `agentmgr weekly`, gives one page on a week that you can pass to your manager.

| Section | What it holds |
| --- | --- |
| The week in one line | Pull requests merged and across how many projects, tasks finished, bugs fixed, engineering hours delivered (an estimate) |
| Highlights | The three largest pieces of work, each with a sentence on what it is and how it was done |
| Achievements | What merged, by project, with links and bug keys; then what finished without a merge; bugs fixed; issues filed. Under each piece: **How** it was done, what was **Changed**, and how it was **Checked** |
| Numbers | Merged, opened, bugs fixed, issues filed, tasks finished and hours to merge, against the week before; and the estimated size in engineering hours |
| Technical summary | Files and lines changed, the areas of the code touched, checks passed and commands recorded, tests tested, the average review scorecard, risks named and avoided, change requests, and the engines and models used |
| Quality | How many of the week's merged pull requests held up, and the ones reverted or fixed afterwards |
| In progress | Open work by project: in review or in progress |
| Blocked | What needs a decision or help, with what it waits for |

- **Which period.** A week by default; **Month** or **Quarter** (`--month`, `--quarter`) for a performance review or a planning meeting, with the same sections and the period before beside it. Last one by default; **This ... so far** or `--current` for the one running.
- **Getting it out.** **Copy** (Markdown, for an email, a document or Slack), **Download**, or **Save on this computer** (`--save`, or `-o <file>`). When a week, a month or a quarter is over, its summary is also written by itself to `~/.agentmanager/reports/` (`weekly-<monday>.md`, `monthly-<year>-<month>.md`, `quarterly-<year>-Q<n>.md`) (`"weekly": { "auto": false }` in config.json turns that off).
- **Nothing is sent.** It is a draft for you to read and pass on.
- **Private work stays private.** Work that is [kept private](#kept-private-possibly-patentable-work-is-not-sent-out) is counted and listed as "(kept private)", with no title, link or description.

**It is technical, with no money amounts.** Under each delivered piece:

- **How:** the first sentences of the Solution in the agent's brief.
- **Changed:** files and lines of its merged pull request, the folders they are in, and how many are test files.
- **Checked:** checks passed and failed, commands recorded with their output ([Proof](#proof-what-it-ran-and-what-it-did-not-do)), breaks caught ([Test the tests](#test-the-tests-would-they-notice-a-mistake)), the scorecard, named risks avoided, reviews and change requests.

It is put together from what is already recorded, with no model call: the [work record](#work-record), the agents' briefs, [Quality](#quality-what-happened-after-the-merge) for the files and lines of merged pull requests, and [Value](#value) for the sentence on each piece and its estimated engineering hours. A line appears only when there is something to say: an agent that was removed keeps what was recorded as its pull request merged, and loses the rest.

## Value

**Value** in the top bar (or `v`) shows what the work delivered with agents is worth, for you and for management: by **Day**, **Week**, **Month**, **Quarter** or **Year**, with bars for the last periods and the items behind each.

| Figure | What it is |
|---|---|
| Value delivered | Engineering hours the work saved × your loaded hourly rate, plus other savings in its first year |
| Pull requests | Pull requests merged in the period (each counts when it merged), and how many a day |
| Potential revenue | Revenue the work plausibly enables or protects in its first year (kept apart: it's the least certain) |
| Strategic | Items rated 4 or 5 of 5 for moving the product or company position |
| Leverage | Engineering hours delivered per hour of your own time (30 minutes per item unless you set it) |
| AI cost | What the agents cost, and value per AI dollar |

Work counts once it's delivered: its pull request merged, or the agent finished without one. Each item gets an estimate from one short model call (at most 30 a day) based on its issue, pull request, design doc, results and AI review, with a reason for each figure. They are estimates, and conservative by instruction. **Edit** any figure, category or the one-line summary for management: yours win, are marked, and stay through re-estimates. **Don't count it** leaves an item out. **Notes for the estimates** in settings give the model your context ("B2B SaaS, ~2,000 customers; checkout work affects revenue").

Pull requests count in the period they merged in, so a second one on the same work is counted when it lands. Value keeps work from about 100 days before you first opened it, so a year's figures start there.

Reports: **Copy report** (Markdown) or **Send** for the current period or the one just ended, and on a schedule (weekly on Mondays, monthly on the 1st and quarterly by default; daily if you turn it on; at 09:00) to Slack (with **value reports** on in Slack alerts) and, if you choose, as a Google Doc in "Value reports (AI Agent Manager)" through the Google Drive connector of your Claude account. Every report is also saved in `~/.agentmanager/value/`, next to `value.csv` with every item's figures.

```bash
agentmgr value --period month            # totals by month, and this month's items
agentmgr value --period year             # by year, with the pull requests merged in each
agentmgr value edit OPS-7 --revenue 15000 --summary "Ends login timeouts for our largest customer"
agentmgr value report --kind quarter --current   # this quarter so far, as Markdown
agentmgr value set --rate 140 --reports weekly,monthly,quarterly --at 08:30 --drive on
```

## Quality: what happened after the merge

**Quality** in the top bar (or `Q`) shows what became of the agents' pull requests once they merged, by **Day**, **Week**, **Month**, **Quarter** or **Year**. Merging more is only good news if it holds up, so this sits next to the pull request count in Value.

| Figure | What it is |
|---|---|
| Held up | The share of the merged pull requests looked at that had no problem after the merge |
| Reverted | A later pull request titled Revert that names it, or a commit that reverts the commit it merged as |
| Fixed afterwards | A later pull request, within the days watched, whose title says it fixes something and that changes one of the same files or names it |
| Checks failed | A check failed or timed out on the commit it merged as (a cancelled run is not a failure) |
| Changes requested | How many had a reviewer ask for changes before the merge |
| Opened to merged | Median hours from opening the pull request to merging it |

Each pull request is watched for 14 days after it merges (set it from 1 to 90). GitHub is asked through the `gh` CLI as you: a few pull requests every two minutes, and each again every six hours while it is watched. No model is called.

**Fixed afterwards is a guess**, from titles and files: a fix in the same file may be about something else. **Not a problem** on a pull request overrules what was found, **It was a problem** records one nothing here saw, and **Undo** goes back; yours are marked. **Look again** asks GitHub now. **Only the ones with a problem** narrows the list, and **Copy report** gives the period as Markdown.

It covers pull requests of agents here, from about 100 days before you first opened it. A problem that never showed on GitHub (an incident fixed elsewhere, a bug nobody linked) is not seen unless you mark it.

```bash
agentmgr quality --period month          # the share that held up, by month
agentmgr quality mark https://github.com/acme/shop/pull/77 --clean --note "the fix was about another bug"
agentmgr quality report --kind month     # last month, as Markdown
agentmgr quality set --days 30           # watch each merge for 30 days
```

## Standards: what every change in a repository has to meet

The **Standards** tab in Quality (or `agentmgr standards`) holds, per repository, the rules that turn what went wrong before into how agents work next. Only you set them; an agent's own calls to change them are refused.

**Lessons.** Whenever a merged pull request is reverted, fixed afterwards, fails its checks or had changes requested by a reviewer, a lesson is proposed for its repository. Word it in one line, or use **Suggest wording** to have a model draft it from the pull request and what reviewers wrote, then **Accept** or **Dismiss**. You can add your own too. Accepted lessons (at most 40 per repository) are given to every agent started there from then on, and the review scorecard checks each one against the changes: a lesson not followed means "Not ready", and Improve sends it back to the agent.

**High-risk paths.** Mark the parts where a mistake is expensive: `src/auth/**`, `**/migrations/**`, `*.sql`. `*` stays inside a folder, `**` crosses folders, and a name without a slash fits at any depth. A change that touches one:

- cannot be scored "Ready to approve"; the scorecard says which paths it touched
- is held by autopilot for you. **Ship it** opens the pull request, and autopilot never merges it
- is not merged on its Eval ("merge when sure")
- is reviewed by another model when the agent finishes, also with review rounds turned off; the pull request is then yours to open

Agents are told which paths are high risk and to say in their brief what they will change there before they do.

**The quality bar.** Checks the app runs itself, in the agent's folder, before its changes are scored:

- your commands, each with a name: lint, a type check, the tests, a dependency scan. Commands found in the repository are offered with one click
- code changes need a test file changed too (off by default)
- no keys or tokens on the added lines (on by default, for every repository)

A failed check caps the Tests score at 30 and means "Not ready" whatever the agent says, and on autopilot the work goes back to the agent with the check's output. The bar runs once per state of the changes; `agentmgr standards run <agent>` runs it now. Each command gets 10 minutes (`"standards": { "checkTimeoutMs": 600000 }` in `config.json`), and runs on this computer as you. `"standards": { "enabled": false }` turns all of it off.

```sh
agentmgr standards                                  # every repository: lessons, high-risk paths, the bar
agentmgr standards lesson shop "Exports are paged, never loaded whole"
agentmgr standards lesson shop --accept 3fa2c1d0 "Rotate tokens behind a flag"
agentmgr standards risk shop "src/auth/**" "**/migrations/**" --why "sign-in and data"
agentmgr standards bar shop --add "Lint=npm run lint" --add "Types=npx tsc --noEmit" --tests
agentmgr standards run my-agent                     # run the bar on its changes now
```

## Claims check: what the documents say, against the work

Models write confidently, also when they are wrong. **Claims**, among an agent's documents, checks what was written about its work against the work itself: the agent's own brief, the update for the people who asked, and the Explanation, Insights, Analysis and Documentation if they are written.

```sh
agentmgr claims fix-login            # check, and print each statement with what backs it
agentmgr claims fix-login --cached   # the last check
agentmgr claims fix-login --json
agentmgr claims --auto off           # do not check updates by themselves
```

**How it works.** Another model than the one that wrote the text (another engine if one is installed, as for Human vs AI) lists every statement of fact in it and gives each a verdict, with the source and a quote from it, word for word. Then the app checks the checker, with no model:

- a statement that is not in the text is left out;
- a quote that is not in the source it names (or any other) makes the statement **Not backed**;
- a file, link, pull request, ticket, commit, version or number in the statement that appears in none of the sources makes it **Not backed**;
- what only the agent itself says (its brief, spec, plan, the conversation) counts as **Only the agent says so**, not as backed. The brief is never a source for itself.

| Verdict | Meaning |
|---|---|
| **Contradicted** | A source says otherwise: the update says merged, the pull request is open |
| **Not backed** | No source says so, or the checker could not quote one |
| **Only the agent says so** | In the brief, spec, plan or conversation only; nothing measured shows it |
| **Backed** | A measured source says so, and the quote was found in it |
| **Opinion or plan** | A judgment, estimate or recommendation: not counted |

The sources are what the app measured (status, pull requests and their checks, files changed, the quality bar), the commits, the diff (the first 60,000 characters), what was asked, and the agent's own account. Particulars in statements the checker passed over are listed too.

**By itself.** An update written by itself (when an agent finishes or opens a pull request) is checked before you are told it is ready, together with the brief (and the other documents above that are written); the alert says how many of its statements are not backed, and the Update shows it over the drafts with **Claims** one press away. `agentmgr claims --auto off` or `"claims": { "auto": false }` in config.json turns that off. Everything else is checked when you ask: **Claims** among the documents, **Regenerate** to check again.

**Limits.** That a quote is in a source is checked by the app; that the quote really shows the statement is the checking model's reading, so read the ones that matter. A statement can be true and not backed (the sources are what this computer has, and long diffs and conversations are cut), and numbers under 10 are not checked as particulars. Each text is one model call. Standups and Value estimates are not checked. `agentmgr claims` exits with 1 when something is contradicted.

## Results and spend

**Results** in the top bar shows how agents did over the last 7, 30 or 90 days (or all time): how many started and how many opened a pull request, PRs merged and closed, the merge rate, the median time from starting an agent to its first PR and to merge, and the cost per merged PR. The same by engine and model (which one gets merged more, for less), by where agents came from (you, the assistant, triggers, the backlog, teams, races) and by project. `agentmgr stats --days 30`.

### Work record

**Work record…** in the menu (and `agentmgr worklog`) keeps what your agents got done, for your own notes and for performance reviews. It's recorded as it happens, into two spreadsheets (CSV files that open in Excel or Numbers, or File → Import in Google Sheets):

- **`~/.agentmanager/worklog.csv`**: one row per event, with the date, project, agent, title, link, linked bugs, engine and model:
  - *pull request opened*, *merged* (with the hours from opening to merge) or *closed* unmerged;
  - *bug fixed*: a bug the agent's request linked (a Jira or GitHub issue), once its pull request merges;
  - *issue filed*: an issue the agent opened, from a `- Filed: <link> <title>` line in its brief's Results (agents are asked to add one for each);
  - *agent finished*: its brief says done, with the hours since it started and what it cost.
- **`~/.agentmanager/worklog-weekly.csv`**: one row per week, Monday to Sunday, added once the week is over. It counts PRs opened, merged and closed, the merge rate, bugs fixed, issues filed, agents finished, the median time to merge, and the week's spend.

Rows are only ever added; edit or chart them in your spreadsheet. The first time, the history already recorded is written too, with the dates it happened. The dialog shows a period's totals, the weeks and every event. **Copy summary** (`agentmgr worklog --days 90 --summary`) gives the period as Markdown with links, ready for a review document. To keep the files somewhere else, such as a synced folder, set `"worklog": { "dir": "~/Documents/agent-work" }` in config.json; `"enabled": false` stops recording.

### Spend and budgets

The same dialog shows what agents cost today, the last two weeks and the costliest agents, from the cost Claude Code records for each session (the API price, even on a subscription plan; Codex and Antigravity record none). Set limits there, with `agentmgr spend --per-agent 5 --per-day 50`, or in config.json (`"budgets": { "perAgentUsd": 5, "perDayUsd": 50 }`):

- **Each agent.** At 80% of its budget you get an alert. At its budget its session is closed, and it doesn't start or resume until you raise its budget. **Edit** on an agent (or `agentmgr edit <agent> --budget 20`) gives it its own budget.
- **All agents a day.** Once today's spend reaches it, no new agents start or resume, from the UI, the CLI, the backlog, triggers or the assistant, until tomorrow or a higher limit. Running agents go on.

Alerts for both go to Slack with **Alerts → nears or reaches its budget**.

## Cleaning up old agents

**Close all** (next to the agent counts above the list) closes every open agent session at once. The assistant's stays open, and so do agents working at that moment unless you choose **Close them too**. Closed sessions keep their conversation and resume when you open them. From the command line: `agentmgr close --all`.

Agents you no longer use keep a session open and a worktree on disk. **Clean up** (in the top bar, or `agentmgr cleanup`) closes agents with no activity for a while and deletes agents that stayed closed long after that. Pick a strategy:

| Strategy | What happens on its own (checked every few hours) |
|---|---|
| **Close, then delete** (`close-delete`) | Closes agents idle 14 days, and deletes agents closed for 14 more days. |
| **Close; delete when I say** (`close`, the default) | Closes idle agents. Deleting waits for **Close and delete due now** or `agentmgr cleanup --run`. |
| **Manual** (`manual`) | Nothing. Run it when you want. |
| **Off** (`off`) | Nothing. |

Both numbers of days are adjustable. Closing ends the session; resume the agent any time. Deleting removes the agent from your list along with the worktree AI Agent Manager created (Claude's own transcripts stay in `~/.claude`). Clean up never touches an agent marked **Keep** (the button on an agent), one that is working or still setting up, or a member of a team that is still going. It doesn't delete an agent with an open pull request, uncommitted changes, or commits that aren't on any other branch or remote: merge or push the work first. The dialog lists what is due, what is left alone and why, and the last run.

```bash
agentmgr cleanup                                  # what is due, and what is left alone
agentmgr cleanup --run                            # close and delete what is due now (--close-only: just close)
agentmgr cleanup --strategy close-delete --close-after 14 --delete-after 14
```

Agents closed before clean up was turned on count as closed from the first check, so nothing is deleted the day you turn it on.

**A limit on open agents.** Many open sessions slow the machine down. In **☰ → Settings** (or `agentmgr cleanup --max-open 12`), set how many agents may be open at once: above it, the agents idle longest are closed, and they resume when you open them. Never closed for the limit: agents working, waiting for your answer, active in the last 5 minutes, marked **Keep**, or in a team that is still going. Off by default (`--max-open off`).

**Closing idle sessions.** In the same place (or `agentmgr cleanup --idle-hours 4`), set how many hours an open session may sit idle: after that it is closed, on the same rules as the limit, and it resumes with its conversation when you open it. Off by default (`--idle-hours off`).

## Saving state: flush and restart

- **What's saved immediately.** Agent records (session IDs, settings, links) are written to `state.json` on every change, fsynced, then atomically replaced. Claude writes each conversation to its own transcript as it goes.
- **What flush adds.** Each agent's terminal scrollback (restored into the terminal after a restart), session IDs Claude switched to mid-run (`/clear`), and token usage.
- **When it runs.** Every `flushSec` (30 s), on shutdown, and on demand: **Save now** in the agent list, or `agentmgr flush`.
- **Restart.** `agentmgr restart` flushes, stops the daemon (closing agents so Claude saves its sessions), and starts it again, through the login service when installed. Agents that were running resume with the same session IDs.

## Folder trust

Before launching Claude in a folder, agentmgr marks that folder as trusted in Claude Code's config (`~/.claude.json`, `projects[<path>].hasTrustDialogAccepted`). That is the same record Claude writes when you choose "Yes, I trust this folder". It only does this for the folders agents run in: workspaces, the planning folder, general sessions and folders you pass with `-d`.

The first change keeps a backup at `~/.claude.json.agentmgr-backup`. Trusting a folder lets Claude load that repo's project settings and hooks without asking, so set `"trustAgentFolders": false` if you'd rather review repos first.

## Tokens and cost

Usage comes from the session transcripts and is refreshed every few seconds while an agent runs:

- **Sources.** Input, output, cache-write and cache-read tokens for every API request, including the session's subagents.
- **Where it shows.** Per session in **Session history** and `agentmgr sessions`, and summed per agent in the list, the session card, `agentmgr ls` (TOKENS) and `agentmgr show`.
- **Cost.** The figure Claude Code records itself (`cost-state`), shown once it has written one.

## Studio: code and terminals

- **Code** (a tab next to **Claude** in the terminal pane) opens the agent's folder: a file tree, tabs, and Monaco, the editor inside VS Code, with syntax highlighting and search within a file. **Save** (Ctrl/Cmd+S) writes into the agent's folder. If the agent changed the file since you opened it, you're asked before anything is overwritten. Files you haven't edited pick up the agent's changes as it makes them. **Search** finds text across the folder (git grep, so ignored files are skipped). **Diff** compares the file with where the agent started, side by side, and you can edit on the right. **＋ / ▣ / ✎ / 🗑** create, rename and delete. Every path stays inside the agent's folder: `..`, and links that point outside, are refused.
- **◫ Split** (in the terminal bar) keeps the terminal, a shell or a browser tab on the left and opens a pane on the right with **Code**, **Docs** (Diagrams by default; Design, Flow, Analysis, Proposal or Explain from the menu, written there if missing) or **Changes** (the change-by-change explanations, each with its diff). Drag the divider to resize; the pane, its tab and its width are remembered in this browser. Desktop only.
- **VS Code / Cursor** opens the agent's folder (and the open file) in the editor installed on this computer. The buttons show when its `code` or `cursor` command is found.
- Monaco loads from the jsDelivr CDN the first time you open **Code**. Offline, a plain text editor takes its place.
- **Terminal** in the top bar opens a shell on this computer in your home folder, not tied to any agent. It works from any device you're signed in on, so you can run any command from your phone. **+ Terminal** opens more. They keep running when hidden; **×** ends one. Plugins can refuse it with the `terminal.open` policy (`kind: "machine"`).

## Shell and general sessions

- **Open shell** (or `agentmgr shell <agent>`) starts `$SHELL -l` in the agent's working folder. It shows as a **Shell 1** tab next to the **Claude** tab in the terminal pane; **+ Shell** (or `agentmgr shell <agent> -n 2`) opens more, and **×** on a tab closes that shell. Shells live as long as the daemon and don't start Claude.
- **+ Browser** opens a tab on an address: a port (`5173`), a local address (`localhost:3000/app`), something on the machine's network (`10.0.0.7:8080`, `staging.internal`) or any site (`example.com`, which defaults to https). Tabs are kept with the agent, so every device sees them, and **×** closes one.
  - **On this computer** the tab loads the address directly. Many public sites refuse to appear inside another page, so use **↗** for those.
  - **From another device** (remote access), AI Agent Manager gives each site its own HTTPS port. That port relays to the site as the machine sees it, so you can check from your phone what the agent built or what the machine can reach. Absolute links, redirects and hot-reload WebSockets on the same site keep working, and the site's "don't show me in a frame" headers are dropped. A link or redirect to a different site leaves the relay.
  - **Safety:** the relay serves only signed-in devices. It never relays to AI Agent Manager's own ports on any of the machine's addresses, and it removes AI Agent Manager's sign-in cookie before forwarding. Sites other than localhost must present a valid certificate. The relays close when remote access is turned off.
  - If a tab stays blank on a device, open it once with **↗** and accept the certificate there.
- **Ask Agent** (or `agentmgr ask`, with `--engine` for another engine) creates a `general` agent. All general sessions share `~/.agentmanager/general`, so Claude's folder-trust prompt only appears the first time.

## MCP servers and tools

**MCP** in the top bar (or **MCP tools** in an agent's detail, or `agentmgr mcp [agent]`) lists the MCP servers Claude Code has in a folder: your own servers, the project's `.mcp.json`, local ones, claude.ai connectors and plugins' servers. Each shows its status, where it comes from, where it runs and its tools, marked *read-only* or *destructive* when the server says so. Pick the home folder or any agent's workspace at the top, since a workspace adds its project's servers. Environment variables, headers, URL queries and secret-looking arguments are never shown.

**Its own MCP session.** Each folder gets an MCP session of its own on the daemon: one Claude Code process, separate from any agent's session, that the app talks to through Claude Code's control protocol. It keeps the servers connected, so listing, signing in, reconnecting and calling a tool make no model call and don't interrupt an agent. The session closes after 15 minutes unused and starts again when needed. **Refresh all** starts a new one, which reads the configuration again. **↗ Window** opens the panel in a window of its own (`#mcp` or `#mcp/<agent>`), and **Runs in this MCP session** at the bottom keeps the last 30 runs with their results.

**Signing in.** A server that needs it shows **needs sign-in** and a **Sign in** button (or `agentmgr mcp signin <agent|home> <server>`), which opens that server's sign-in page in a new tab and keeps the link on the page. Claude Code runs the sign-in and keeps the tokens; the app never sees them. When you finish, the server connects by itself. The sign-in ends on an address on the computer the daemon runs on, so from another device (or when that last page doesn't load) paste the address the browser ended on into the box under the link. A claude.ai connector is connected on claude.ai instead: the link goes there.

**↻ on each server** (or `agentmgr mcp reconnect <agent|home> <server>`) connects that one server again and lists its tools, after signing in or when it failed. The others are left alone.

**Run…** on a tool takes its input and runs it in one of three ways:
- **Run** with the tool's arguments as JSON (`{"query": "…"}`), or with nothing: the tool is called directly in the folder's MCP session, with no model call, and its output is shown as it is.
- **Run** with a request in plain words: a separate one-off Claude Code call in that folder, allowed only that one tool, works out the arguments and shows what the tool returned.
- **Run in agent session** tells the agent to use the tool, with its conversation and context. The answer is in the session. This works for Claude Code agents.

`agentmgr mcp run <agent|home> <server> <tool> [arguments or request]` does the first two, and `--session` the third. A destructive tool needs a second click. Plugins can refuse runs outside an agent's session with the `mcp.run` policy.

## Plan: dates, decisions and tech debt

**Plan** in the top bar (or `c`, or `#plan`) looks ahead, in three tabs. Its button counts the dates that are late or at risk.

### Dates

Give a project its **code complete**, **release candidate** and **GA** dates (**+ Dates for a project**, or `agentmgr dates <project> --cc … --rc … --ga …`; they must be in that order). For each date you get:

- **How far it is and where it stands.** *On track*, *at risk* (a week or less away with counted work still open), *late*, or *reached* once you mark it.
- **A checklist.** What the app can count for itself, and what only you can tick:

| Date | Counted by the app | Yours to tick |
|---|---|---|
| Code complete | agents still working, backlog items not finished, things waiting on you (plans, questions, prompts) | scope agreed |
| Release candidate | pull requests still open, pull requests with failing checks, critical or high bugs open (bug hunts) | release notes and changelog drafted, RC cut and smoke-tested |
| GA | critical or high bugs open, pull requests still open | docs and upgrade notes, release notes final, version tagged and published |

- **Related actions.** **Show** jumps to the agents, backlog, Land tab or Bugs behind a count. **Have an agent do it** hands one of your items (release notes, docs) to an agent through the project's backlog.
- **Reminders.** Planned 14, 7, 3 and 1 days before and on the day, and once when a date passes. Each goes to Slack with what is still open (Alerts → *a project's date*), between 8:00 and 20:00; coming within a nearer one covers the further ones. A date you move gets its reminders again.
- **In Today.** A date shows from two weeks out, higher up as it nears, with what is open.

### Decisions

What was decided on each project and why, newest first, gathered from what already happens here:

- **Plan reviews:** a plan you approved or sent back, with your notes.
- **Your answers** to agents' questions.
- **Design docs:** the bullets under *Decisions and risks*. When a design moves on, what it no longer says is kept and marked *replaced since*.
- **Your own**, with **+ Add a decision** (or `agentmgr decisions <project> --add …`).

Entries stay after their agent is deleted. Filter by project or by words, remove one with ×, and **Copy as Markdown** (or `agentmgr decisions --md`) gives the log as a document. No model is called.

### Debt

Where a project's code costs the most to change. **Scan** (or `agentmgr debt <project> --scan`) reads the repository's last 90 days of git history and its source files, and scores each file by:

- how often it changed, and how many of those changes were fixes;
- how tangled it is: its length, branch points, lines nested five deep or more, TODO/FIXME notes;
- open bugs the bug hunts found in it.

Files that are both changed often and hard to read come first, each with its reasons. Test files count for less; vendored, generated and binary files, and commits that touch more than 40 files, are left out. **Hand to an agent** queues a task in the project's backlog (cover it with tests, then refactor in small steps); **Not debt** sets a file aside for good. Projects with a repository on this computer are scanned again every 7 days. It reads git and the files only: no model is called and nothing leaves the machine. In config.json: `"debt": { "enabled": true, "days": 90, "autoDays": 7, "top": 30 }`.

## Your day: Today around your calendar

In **Today**, **Connect calendar** takes your calendar's private iCal address:

- **Google Calendar:** Settings → your calendar → Integrate calendar → *Secret address in iCal format*.
- **Outlook:** Settings → Calendar → Shared calendars → Publish a calendar → *ICS*.

The address gives read access only. It is kept in config.json on this computer, is never shown in the page again, and is fetched only by the daemon (every 10 minutes at most). Nothing is written to your calendar.

With it, Today opens with **Your day**:

- **Meetings** from now on, with the one in progress marked, and all-day events on a line of their own.
- **Free time** between them until the end of your working day (09:00 to 18:00 unless you change it), with what needs you placed in it, most pressing first. Each kind of item has a usual length (a prompt 3 minutes, a question 5, a pull request review 25), and what doesn't fit is counted as *won't fit today* instead of squeezed in.
- **What a meeting is about:** the agents, pull requests and issues its title or description names (a Jira key, `#482`, an agent's or project's name), to open before you walk in.

Repeating meetings, time zones, moved or cancelled occurrences and events marked *free* are understood. Several calendars can be added; **Disconnect** forgets them. In config.json: `"calendar": { "ics": ["https://…"], "workStart": "09:00", "workEnd": "18:00" }`.

## Usage: what is left of each engine's plan

A chip by the connection light shows the engine new agents start on with what is used of its limits (`Claude Code 5h 23% · wk 41%`), turning amber and red as a limit nears. Click it (or **Usage…** in the menu, `z`, or `agentmgr usage`) for every engine: each limit with the percent used, the percent left, and when it resets.

- **Claude Code**: its 5-hour session and 7-day limits. Claude Code hands these to a session's status line command (for Pro, Max and Ultra plans, once the session has had a reply), so the sessions started here get a status line that records them. Your own status line, if you have one, still shows: it is run with the same input. Without one you get a short line with the model and the two percentages. Not for agents in a container.
- **Codex**: the limits Codex writes in its session logs, when it reports them.
- **Any engine**: a limit an agent actually hits is shown until it resets (and the agent carries on by itself when it does, as before).
- **Alert me at** a percent used (80% by default): one alert per limit and reset, in Slack if alerts are on (the *usage* alert).
- **Hold new work at** a percent (off by default): no new agent starts on an engine at or past it; the backlog waits and New agents says why. Agents already running carry on.
- **Start new agents here** makes another installed engine the default for new agents; agents already running stay where they are (**Continue on** moves one).

These are numbers the engines hand out on this computer, so a reading is as old as the last reply of a session started here; Claude Code you use elsewhere moves the real numbers on meanwhile. **↻ Read now** (or `agentmgr usage --now`) brings them up to date: Claude Code only reports its limits to a session that has had a reply, so it starts a short one that says one word on its smallest model (a very small amount of usage) and removes it after. Nothing else calls a model. Turn it off with `"usage": { "enabled": false }` in config.json.

## Reverse engineer

**🔍 Reverse engineer** in an agent's detail (or the **Reverse** tab of the split) puts the agent's session on the left and a pane on the right. Name a **target** (an app's folder or `.asar`, a binary's path, a website's address) and what you want to understand ("how does search work in this app"). The agent investigates in its own session with the tools of [REA](https://github.com/morluto/rea), the "Reverse Engineer Anything" MCP server, and changes nothing.

- **The report**, drawn beside the session as the agent writes it: what the target is, how the feature works as an animated diagram, the data and interfaces (storage, formats, calls between processes, network requests), findings with their evidence marked confirmed or inferred, what could not be determined, and a plan for building your own version in this project.
- **Follow-ups and building.** **Ask** continues the investigation. **Build it in my project** has the agent write your own version from the behaviour the report describes, with tests: its own code, nothing copied from the target.
- **REA is set up by you.** The pane says whether REA is registered with Claude Code for the agent's folder (read from Claude Code's settings and the project's `.mcp.json`; a plugin that brings REA is not seen there). If it isn't, run `npx rea-agents setup` in a terminal and restart the agent's session: the app installs nothing. Native binaries also need Hopper, Ghidra, IDA or Kuna; JavaScript, Electron and websites need nothing more.
- **What it is for.** Software you own or are allowed to analyse: a licence or the law may restrict reverse engineering someone else's product. The agent is told to analyse only, not to work on getting around licence checks, copy protection or sign-in, not to collect credentials or personal data, and to build from behaviour without copying code or assets.

`agentmgr reverse <agent> -t <target> "<what to understand>"` asks from the terminal, `agentmgr reverse <agent>` prints the report, and `--build` builds your own.

## Debug

**🐞 Debug** in an agent's detail (or the **Debug** tab of the split, **◫ Split** in the terminal bar) puts the agent's session on the left and the debug pane on the right. Type what is going wrong, for example *imports fail at max scale after about 20 minutes* or *p99 latency triples under load*, and press **Debug** (or Enter).

The agent investigates in its own session, with everything it already knows about the work: it reads the code on the path, the logs and the tests, reproduces the problem where it can (the failing test, a small load, a script) and measures. It keeps a report, drawn in the pane as it grows:

| Section | What it has |
|---|---|
| Summary | What goes wrong, the most likely cause, and how sure it is |
| Symptoms | What is seen and when (scale, load, timing), and how to reproduce it |
| Code path | An animated flowchart of the path the failing request, job or test takes through the real files and functions; where it breaks is outlined red, what is only suspected dashed amber |
| Data flow | An animated flowchart or sequence diagram of the data on that path: where it grows, waits, is dropped or goes wrong |
| Interleaving | For timing, concurrency and load problems: the order of events that breaks |
| Findings | Each with its evidence (file and line, a log line, a metric, a command and its output), marked confirmed or suspected |
| Root cause | The causes, most likely first, with a confidence and what would confirm each |
| Recommended fixes | Each with where, the effort, the risk and how to verify it |
| Next checks | What to measure next, and what it needs from you |

- **Follow-ups.** Type what you know or what to look at next and press **Ask**: the investigation continues and the report is brought up to date. If the agent needs something only you have (the scale it fails at, logs), it asks in its session on the left.
- **Apply fixes.** The agent changes no repository code while it investigates. **Apply fixes** asks it to make the fixes (name them in the box, like *1 and 3*, or leave it empty for the ones it recommends), verify each the way the report says, and add a **Fixes applied** section with the result before and after.
- **How it runs.** Your question is typed into the agent's session like any message: when it is idle, resuming it if it was closed. It uses the agent's own engine, model and permissions; no other model call is made. The report is `DEBUG.md` next to the agent's brief, outside the repository.

`agentmgr debug <agent> "<what goes wrong>"` asks from the terminal, `agentmgr debug <agent>` prints the report, and `--fix ["1 and 3"]` applies fixes.

## Runbooks for the support team

**Plan → Runbooks** (or `agentmgr runbook`) writes a runbook for the people who answer customers, from one of three sources:

- **A release ticket**: the ticket, what it links to, its sub-tasks, and every ticket in its fix versions (up to 150).
- **An epic**: every ticket of the epic.
- **Code changes**: a project's commits in a time frame (since a day, until a day or now), the diffs of the most telling and most changed files (settings, migrations, flags, routes and messages first), and the Jira tickets the commits name.

Tickets are read from Jira with the site and API token in Settings → Jira; code is read from the project's repository on this computer. One tool-less model call then writes the runbook, on your own plan: a summary, what changed, what customers may see or ask, how to check it is working, troubleshooting, known issues, settings and migrations, rolling back, when to escalate, replies you can send, and sources. It is told to state only what the tickets and code support and to put every open question under **To confirm with engineering**, so have an engineer read it before support relies on it.

Open one to read it, **Edit** it, **Revise** it with a note (written again from the tickets and code as they are now, keeping what still holds and your edits), **Copy** it or **Download** it as Markdown for your knowledge base, or **Print** it. Runbooks are Markdown files in `~/.agentmanager/runbooks`.

## Decide

**Decide** in the top bar (or `q`, `#decide`, or `agentmgr decide`) helps with the decisions themselves. The reasoning is the AI judge's: one tool-less call each, on your own Claude or Codex plan, within the judge's daily budget. With the judge off nothing is recommended and nothing is decided for you.

- **Waiting.** A plan waiting for review, or a question an agent asks, comes with its options, the one recommended, why, the evidence, the risk, how sure it is, and whether it is hard to undo. One click carries out the recommendation or another option. The same recommendation is on the item's Inbox card. However you decide, the decision log (Plan → Decisions) gets the reasoning and whether you went with the recommendation.
- **Try both.** For a question with two or more options, each option is tried by its own agent as a race, so you decide from the results side by side.
- **Standing decisions.** A call you made once for every time it comes up, such as "when the plan only bumps a dependency, approve". Offered when three of your decisions agree (and never as broad as "always approve"), or written by you. When one applies it is carried out for you, and reported under **Handled for you** with the reasoning and in Slack (the *decided* alert).
- **How much may be decided without you**, per project: *Ask me everything*; *Only my standing decisions* (the default, so nothing changes until you make one); *Also what is sure and easy to undo* (85% or more); *Most things; ask when unsure* (70% or more). Anything hard to undo always waits for you unless a standing decision of yours covers it.
- **Priority.** Each project's open backlog ranked by impact: the nearest date, what an item unblocks, risk removed, age, with the reason beside each. Plain rules rank at once; the judge's ranking replaces them when the window is open. **Use this order** reorders the queue (and sets a priority the judge found wrong), and free agents pick from the top.
- **Dates at risk.** A date that is at risk or late (Plan → Dates) as choices: hold the least valuable queued items until after the date, move the date by what the recent pace says is missing (later dates move with it), or run more agents at once. One is recommended; picking one carries it out and records it as a decision.
- **Looking back.** Two days after a decision, what followed it: the work landed, or it was sent back, judged incomplete, failed its checks, was reopened, or a date was missed. For the ones worth another look the judge writes the lesson, and the lessons are given to the next recommendation.

Turn it all off with `"decide": { "enabled": false }` in config.json.

## OS

**OS** in the top bar (or `u`, `#os`, or `agentmgr os`) shows the computer the agents run on and how loaded it is right now:

- **Load**: the processor in use and the load average against the number of cores, memory and swap in use, and the free space on the disks under your home folder and the app's data. Processor and memory come with a line of their last ten minutes. A word sums it up: light load, busy, or heavy load.
- **This computer**: its name, system and kernel, processor and cores, memory, how long it has been up, its network addresses, and the app's version and uptime.
- **Agent sessions**: each open session with the processor and memory it takes, counting everything it started (Claude Code, the tools and tests it runs). Click a name to open the agent.
- **Busiest processes**: the top of everything running on the computer.

### Lanes: each agent's own ports

Worktrees keep agents' files apart, but two dev servers still want port 3000 and two test runs the same database. So every agent gets a **lane**: a range of ports (ten, from 21000: the first agent has 21000–21009, the next 21010–21019) and a name ending (`_a1`, `_a2`) that no other agent has. A lane is given when an agent's session first starts, stays with the agent across restarts, and is free for a new agent once the agent is deleted.

- **In its environment**: `AGENT_PORTS` (`21010-21019`), `AGENT_PORT` and `AGENT_PORT_END` (first and last), `AGENT_LANE` (its number), `AGENT_SUFFIX` (`_a2`), and `PORT` set to its first port, which many dev servers listen on by themselves. The shells you open in its folder get the same.
- **In its instructions**: to use its own ports for anything it starts that listens, to leave what holds a port outside them alone, and to end the names of things it creates outside its folder (a database, a container, a compose project) with its ending.
- **In OS**: the **Ports** column of Agent sessions shows each open session's lane and what it listens on now, read from the system (`lsof`, or `ss` on Linux). Click a port to open it in a browser tab beside the session. A port outside the lane is marked, and so is a port of the lane that something else holds.
- **In an agent's detail**: **Lane** under Workspace.

The switches are under Agent sessions in OS: **A lane of ports for each agent**, and **Set PORT to its first port** (turn it off if your projects use `PORT` for something else). A change reaches a session the next time it starts. From the command line:

```sh
agentmgr lanes                      # the settings, and every agent's lane
agentmgr lanes --off                # no lanes (--on brings them back)
agentmgr lanes --port off           # keep the lanes, leave PORT alone
agentmgr lanes --base 30000 --size 20
```

Lanes are a convention the agent is told and given, not a wall: nothing stops a tool that ignores `PORT` from taking 3000. That is what the Ports column is for. Agents in containers get no lane; a container has its own ports.

## Board

**Board** in the top bar (or `B`, or `#board`) shows every agent as a card, in the column for where its work stands:

| Column | An agent is here when |
| --- | --- |
| Starting | its workspace is being prepared, or it is planning |
| Working | it is producing output now |
| Needs you | a prompt, an open question, a plan to approve, a usage limit, an error, or it may be stuck. This comes before every other column |
| Waiting | its session is open and waits for its next instruction |
| In review | it has an open pull request (the card says ready to merge, needs fixes, behind, checks running or draft) |
| Done | its pull request merged, or it reported its work done |
| Closed | its session is closed and can be resumed |

Cards are ordered by priority, then the most recently active. A card moves by itself as its agent's work moves; the columns are not something you set. Two drags do something: a card onto **Closed** closes its session (not while it is working), and a card from Closed onto **Waiting** resumes it; the **Close** and **Resume** buttons on the cards do the same. Any other drop says why nothing moved. Click a card to open its agent. With more than one project, a list at the top narrows the board to one.

It reads again every 3 seconds while open, with `ps` and the system's own counters; nothing leaves the computer.

Above the agent list, **N running** is a filter: click it to list only the agents whose session is open, and again to list them all.

## AI News

**AI News** in the top bar (or `l`, `#news`, or `agentmgr news`) lists what the frontier labs released in the last 30 days, newest first and grouped by day. Each entry has its lab, a summary of a sentence or two, a link to the release and the links from the note. Filter by lab or by words. What arrived since you last looked is marked *new* and counted on the button.

Where it comes from:

| Source | Read from |
|---|---|
| Claude Platform (Anthropic) | [platform.claude.com release notes](https://platform.claude.com/docs/en/release-notes/overview) |
| Claude Code (Anthropic) | its [GitHub releases](https://github.com/anthropics/claude-code/releases), one entry per version |
| OpenAI API | [developers.openai.com/changelog](https://developers.openai.com/changelog) |
| Gemini API (Google) | [ai.google.dev release notes](https://ai.google.dev/gemini-api/docs/changelog) |
| Top 10 labs | a web search once a day, for labs without release notes read here (xAI, Meta, Mistral and the rest) |

The daemon reads the release notes every 6 hours; **Refresh** reads them now, and **Search top labs** also searches now. Model calls, on your own Claude plan:

- **Summaries:** one tool-less call per 25 new entries, each entry summarized once. Until then an entry shows the start of its own text.
- **Web search:** one Claude Code call a day that may use only web search and web fetch, with no MCP servers and none of its other tools. What it finds is as reliable as a web search: check the link.

Only public pages are read, and nothing is sent anywhere. A source whose page can't be read is marked ⚠ with the reason, and the others still show.

In config.json: `"news": { "enabled": true, "sources": ["claude-platform", "claude-code", "openai", "gemini"], "search": true, "summaries": true, "refreshHours": 6, "searchHours": 24, "days": 30 }`. Add release notes of your own, in Markdown with a dated heading per day and a bullet per change, with `"custom": [{ "id": "mistral", "lab": "Mistral AI", "label": "Mistral API", "url": "https://…/changelog.md" }]`.

## Configuration

State lives in `~/.agentmanager/` (`state.json`, `daemon.log`, `repos/` for shared clones, `workspaces/` for worktrees). Set `AGENTMGR_HOME` or `AGENTMGR_PORT` to change the location or port. Optional `~/.agentmanager/config.json`:

```json
{
  "claudeArgs": ["--model", "opus"],
  "permissionMode": "acceptEdits",
  "bugPatterns": ["\\bABC-\\d+\\b"],
  "gitRefreshSec": 15,
  "prRefreshSec": 120,
  "autoResume": true,
  "trustAgentFolders": true,
  "brief": true,
  "explainModel": null,
  "summaryConcurrency": 2,
  "flushSec": 30,
  "backlogParallel": 2,
  "backlogMaxActive": 4,
  "reviewConventions": true,
  "handoffIdleSec": 5,
  "cloneFilter": "blob:none",
  "shell": "/bin/zsh",
  "inbox": true,
  "maxCheckpoints": 40,
  "raceTestTimeoutSec": 900,
  "teams": { "mode": "lead", "critics": 1, "maxRounds": 3, "maxLoops": 3, "gapRounds": 0, "newProjectsDir": "~/projects", "models": { "analyst": "opus", "reviewer": "opus" } },
  "conflictRefreshSec": 60,
  "stuck": { "repeatFailures": 3, "thrashReverts": 2, "thrashEdits": 10, "driftMinutes": 20, "driftActions": 25 },
  "judge": { "enabled": true, "model": "haiku", "dailyCalls": 300 },
  "preReview": { "enabled": true, "rounds": 4, "critics": 2, "openPr": true },
  "screen": { "enabled": false, "port": 5900 },
  "cleanup": { "strategy": "close", "closeAfterDays": 14, "deleteAfterDays": 14 },
  "hub": { "allow": ["view"], "projects": ["*"] }
}
```

## Security

The daemon drives real terminals, so it is locked down to this machine:

- It listens on `127.0.0.1` only.
- It rejects requests whose `Host` is not loopback, which blocks DNS rebinding.
- It rejects browser requests from any other origin, which blocks cross-site WebSockets.
- Every write needs an `x-agentmgr` header, which browsers can't send cross-origin.

Anyone with a shell on the machine as your user can still use it.

## Notes

- Agents live in the daemon process. A daemon restart closes them, saving their sessions, and resumes them when it starts again. The terminal scrollback starts fresh; Claude redraws the conversation when it resumes.
- Child `claude` processes get a clean environment. The markers a parent Claude Code session sets (such as `CLAUDE_CODE_CHILD_SESSION`) are removed, because inherited markers switch transcript saving off and then the session can't be resumed.
- `rm --delete-workspace` only deletes worktrees and folders agentmgr created, never a folder you passed with `-d`.

## Development

```sh
npm test    # unit tests + end-to-end daemon tests against a stub claude (test/fake-claude.js)
```

## Contributing, security and license

- How the code fits together: [docs/architecture.md](docs/architecture.md). Extending it from a separate package (policies, audit, routes, engines, hub sign-in): [docs/plugins.md](docs/plugins.md). How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md). Changes per release: [CHANGELOG.md](CHANGELOG.md).
- Security model and how to report a problem privately: [SECURITY.md](SECURITY.md).
- AI Agent Manager sends no telemetry. The only request it makes on its own behalf is **Check for updates**, when you click it.
- AI Agent Manager runs the agent CLIs you install and sign in to (Claude Code, Codex, Antigravity) with your own accounts. Use them within your provider's terms.
- Maintained in spare time. Issues and pull requests are welcome; replies may take a few days.
- Licensed under the [Apache License 2.0](LICENSE).
