# Changelog

## 1.51.0 (2026-11-14)

- **Usage: what is left of each engine's plan.** A chip by the connection light shows the engine new agents start on with what is used of its limits (`Claude Code 5h 23% · wk 41%`), amber then red as a limit nears. Click it (or **Usage…** in the menu, `z`, `agentmgr usage`) for every engine: each limit's percent used, percent left, and when it resets.
- **Where the numbers come from.** Claude Code's 5-hour session and 7-day limits, which it hands a session's status line (Pro, Max and Ultra plans, once a session has had a reply): sessions started here get a status line that records them, and your own status line still shows. Codex's limits from its session logs, when it reports them. For any engine, a limit an agent actually hit, until it resets. No service is asked and no model is called.
- **Alert, hold, switch.** An alert once per limit at 80% used (adjustable; the new *usage* alert). **Hold new work at** a percent (off by default): no new agent starts on an engine at or past it, and agents already running carry on. **Start new agents here** makes another installed engine the default for new agents.
- Turn it off with `"usage": { "enabled": false }` in config.json.

## 1.50.0 (2026-11-14)

- **Reverse engineer.** **🔍 Reverse engineer** in an agent's detail (or the **Reverse** tab of the split, or `agentmgr reverse`) puts the agent's session on the left and a pane on the right. Name a target (an app's folder, a binary's path, a website's address) and what you want to understand; the agent investigates in its own session with the tools of [REA](https://github.com/morluto/rea), the "Reverse Engineer Anything" MCP server, and changes nothing.
- **The report.** Drawn beside the session as the agent writes it: what the target is, how the feature works as an animated diagram, the data and interfaces, findings with their evidence marked confirmed or inferred, what could not be determined, and a plan for building your own version.
- **Build it in my project.** The agent writes your own version from the behaviour the report describes, with tests: its own code, nothing copied from the target.
- **REA is set up by you.** The pane says whether REA is registered with Claude Code for the agent's folder; if it isn't, run `npx rea-agents setup` in a terminal and restart the agent's session. The app installs nothing. Native binaries also need Hopper, Ghidra, IDA or Kuna.
- **What it is for.** Software you own or are allowed to analyse. The agent is told to analyse only, not to work on getting around licence checks, copy protection or sign-in, and not to collect credentials or personal data.

## 1.49.0 (2026-11-14)

- **Decide.** **Decide** in the top bar (or `q`, `#decide`, `agentmgr decide`) helps with the decisions, not only the tasks. A plan waiting for review or an agent's question comes with its options, the one recommended, why, the evidence, the risk, how sure it is, and whether it is hard to undo; one click carries out any option, and the same recommendation is on the item's Inbox card. The reasoning is the AI judge's, on your own plan, within its daily budget; with the judge off nothing is recommended or decided.
- **Standing decisions and autonomy.** A call you keep making is offered as a standing decision once three of your decisions agree (or write your own); when one applies it is carried out for you and reported under **Handled for you** and by the new *decided* alert. Per project you choose how much may be decided without you: ask everything, only standing decisions (the default, so nothing changes until you make one), what is sure and easy to undo, or most things. Anything hard to undo always waits for you unless a standing decision covers it.
- **Try both.** A question's options, each tried by its own agent as a race, so you decide from the results.
- **Priority by impact.** Each project's open backlog ranked by what it is worth now (the nearest date, what it unblocks, risk removed), with the reason beside each item; **Use this order** reorders the queue.
- **Dates at risk as choices.** A date that is at risk or late is laid out as three choices: hold the least valuable queued items until after it, move the date, or run more agents. One is recommended; picking one carries it out and records it in the decision log.
- **Looking back.** Two days after a decision, what followed it; for the ones that went badly the judge writes the lesson, and the lessons are given to the next recommendation. The decision log now also says why, who decided, and how it held up.
- **Runbooks for the support team.** **Plan → Runbooks** (or `agentmgr runbook`) writes a runbook from a release ticket (with what it links to and its fix versions), every ticket of an epic, or a project's code changes in a time frame: what changed, what customers may see, how to check it, troubleshooting, rolling back, when to escalate, and replies to send. It states only what the tickets and code support and lists the rest under *To confirm with engineering*. Edit it, revise it with a note, copy or download it as Markdown, or print it.
- **Fix.** AI News showed a weekday instead of "Today" for a release dated today ahead of your time zone.

## 1.48.0 (2026-11-13)

- **OS.** **OS** in the top bar (or `u`, `#os`, `agentmgr os`) shows the computer the agents run on and how loaded it is right now: the processor in use and the load average against the number of cores, memory and swap, and the free space on your disks, with a line of the last ten minutes for processor and memory. A tag sums it up: light load, busy or heavy load.
- **What takes it.** Each open agent session with the processor and memory it takes, counting everything it started (click a name to open the agent), and the busiest processes on the whole computer. Also the basics: name, system, kernel, processor and cores, memory, uptime, addresses and the app's version. It reads again every 3 seconds while open; nothing leaves the computer.
- **Running, as a filter.** **N running** above the agent list is clickable: it lists only the agents whose session is open; click again for all.

## 1.47.1 (2026-11-13)

- **Lists scroll on a small screen.** In AI News, Plan and Bugs the list ran past the bottom of the window on a phone (or any screen shorter than the list) and was cut off; it now scrolls inside the window.

## 1.47.0 (2026-11-13)

- **Plan.** **Plan** in the top bar (or `c`, `#plan`) has three tabs: Dates, Decisions and Debt. Its badge counts dates that are late or at risk.
- **Dates.** Give a project its code complete, RC and GA dates. Each has a checklist: the app counts agents still working, unfinished backlog, open or failing pull requests and critical or high bugs, and you tick the rest (scope agreed, release notes, docs). A date is on track, at risk (a week or less away with counted work open), late or reached. **Show** opens what is behind a count; **Have an agent do it** puts an item on the project's backlog. Reminders come 14, 7, 3 and 1 days ahead, on the day and once when a date passes, with what is still open; dates show in Today from two weeks out. `agentmgr dates [project] --cc --rc --ga`.
- **Decisions.** One log of what was decided and why: plans you approved or sent back with your notes, your answers to agents' questions, and the decisions in each agent's design doc. Entries stay after the agent is deleted. Add your own, filter by project or words, copy as Markdown. `agentmgr decisions [project] --md`.
- **Debt.** Files ranked by how often they changed in 90 days, how many of those changes were fixes and how tangled they are, from git history, scanned weekly. **Hand to an agent** queues a refactor task; **Not debt** sets a file aside. `agentmgr debt [project] --scan`. Turn it off with `"debt": { "enabled": false }`.
- **Your day.** Paste your calendar's private iCal address (Google or Outlook) in Today and it opens with your meetings, the free time between them with what needs you placed in it, and the agents or issues each meeting names. Read-only; the address stays on this computer and isn't shown again.
- No model calls are added by any of this.

## 1.46.0 (2026-11-13)

- **Debug.** **🐞 Debug** in an agent's detail (or the **Debug** tab of the split) puts the agent's session on the left and a debug pane on the right. Say what goes wrong (a failure, E2E instability at max scale, slowness under load) and the agent investigates in its own session: it reads the code and logs, reproduces and measures where it can, and changes no code yet.
- **The report.** Drawn beside the session as the agent writes it: animated diagrams of the code path and the data flow, with where it breaks outlined red and what is only suspected dashed amber; the order of events for timing and load problems; findings with evidence, marked confirmed or suspected; the likely causes; and recommended fixes with how to verify each.
- **Follow-ups and fixes.** **Ask** continues the investigation and brings the report up to date. **Apply fixes** has the agent make the fixes you name (or the ones it recommends), verify each and record the result before and after. From the terminal: `agentmgr debug <agent> "<what goes wrong>"`, and `--fix`.

## 1.45.0 (2026-11-13)

- **AI News.** **AI News** in the top bar (or `l`, `#news`, `agentmgr news`) lists what the frontier labs released in the last 30 days, newest first and grouped by day. Each entry has its lab, a summary of a sentence or two, a link to the release and the links from the note. Filter by lab or by words; what arrived since you last looked is marked *new* and counted on the button.
- **Where it comes from.** The release notes of the Claude Platform, Claude Code, the OpenAI API and the Gemini API, read every 6 hours, and a web search once a day for the other top labs (xAI, Meta, Mistral and the rest). **Refresh** and **Search top labs** look now. Add release notes of your own with `"news": { "custom": [...] }` in config.json.
- **Model calls, on your Claude plan.** One tool-less call per 25 new entries for the summaries (each entry once), and one Claude Code call a day for the web search, allowed only to search and read the web. What the search finds is as reliable as a web search: check the link. Turn either off with `"news": { "summaries": false, "search": false }`.

## 1.44.0 (2026-11-12)

- **Whose session is this?** Expanded, in full screen and on a phone, the terminal bar shows the agent's name on the left, on every tab (Claude, Code, Shell, Browser). It follows a rename, and its tooltip has the agent's task.
- **Due in Actions.** A **Due** tab lists every action with a due date that isn't done or removed, soonest first with overdue ones at the top; ones without a fixed date ("next sprint") come last. Due dates read "overdue 3 days", "due tomorrow", "due Friday" (the tooltip has what was said), overdue ones are red, and the tab is outlined red when something is overdue. `agentmgr actions --due` prints the same list.
- **Due dates are read from when they were asked.** "By Friday" asked last week is that Friday, now overdue, not the next one; Actions and Today agree.
- **Overlaps in a panel of their own.** An agent's overlaps with other agents are behind **⚔ Overlaps** (with the count) in its detail, next to Overview and Questions, instead of taking room on the page. The agent list's ⚔ marker and the Inbox are unchanged.

## 1.43.0 (2026-11-11)

- **An MCP session of its own.** Each folder (your home folder or an agent's workspace) gets one Claude Code process for MCP, separate from any agent's session. Listing servers, signing in, reconnecting and calling a tool make no model call and don't interrupt an agent. It closes after 15 minutes unused; **Refresh all** starts a new one.
- **Sign in to MCP servers.** A server that needs it shows **Sign in** (or `agentmgr mcp signin`), which opens its sign-in page. Claude Code keeps the tokens; the app never sees them. From another device, paste the address the browser ended on.
- **Reconnect one server** with **↻** (or `agentmgr mcp reconnect`), leaving the others alone.
- **Run a tool directly.** **Run** with JSON arguments (or none) calls the tool with no model call and shows its output as it is; plain words still go through a one-off Claude Code call allowed only that tool, and **Run in agent session** asks the agent. The last 30 runs are kept with their results, and **↗ Window** opens the panel on its own (`#mcp`). The `mcp.run` plugin policy now gets `where`.
- **Update from the app** shows an in-page dialog with live progress (install, restart, reload) instead of a browser confirm and a short toast.

## 1.42.0 (2026-11-11)

- **MCP servers and tools.** **MCP** in the top bar (or **MCP tools** in an agent's detail, or `agentmgr mcp [agent]`) lists the MCP servers Claude Code has in your home folder or an agent's workspace: your own, the project's `.mcp.json`, claude.ai connectors and plugins' servers. Each shows its status, where it comes from and its tools. Listing makes no model call, and secrets are never shown.
- **Run a tool.** **Run in session** tells the agent to use it, with its conversation and context. **Run once in workspace** (or `agentmgr mcp run`) is a separate one-off call that may use only that tool and shows what it returned, without interrupting the agent. Destructive tools need a second click, and plugins can refuse one-off runs with the `mcp.run` policy.

## 1.41.0 (2026-11-11)

- **Estimate.** A human time estimate for planning any Jira fix or feature: how long one experienced developer would take to do it by hand, without an AI agent. It's split into tasks of a day or less, each with optimistic, likely, pessimistic and expected hours and a total. Work over about 3 days gets a suggested split into tickets, and it lists the roles, assumptions and risks.
- **Documentation.** The docs for the change, written from the actual diff: what's new, how to use it, configuration, upgrade notes and which docs to add or update. When the change touches an HTTP API, it includes an OpenAPI 3.0 spec of the changed endpoints; **Download OpenAPI** saves it as a .yaml file.
- Both sit with the other documents (Analysis, Design and the rest), and are included in **Write all**, `agentmgr doc`, Google Drive publishing and the side pane.

## 1.40.0 (2026-11-11)

- **A calmer agent list.** No summary line under each name (it's the name's tooltip, and search still finds it); the engine, container, assistant and playbook tags move to the line below. The project name shows where the branch was (the branch is in its tooltip).
- **Open sessions stand out** with a green background, a little stronger while the agent is working and when selected.
- **Overview and Questions panels.** In an agent's detail, **Overview** (the AI review, marked *new* until you've seen it) and **Questions** (open questions with their answer buttons, and what you answered) sit next to **Review changes**, each in its own panel, instead of filling the page. Prompts, limits, stuck warnings and overlaps still show on the page.

## 1.39.0 (2026-11-11)

- **Limits: agents carry on after a usage limit.** When an engine stops at a usage limit or exhausted quota ("5-hour limit reached ∙ resets 3pm", Codex's "try again at 3:05 PM") or a busy or failing service (429, 529 overloaded, 5xx), the inbox shows a **Limit** card with the message and when it resets, read in the time zone it names. A minute after the reset the agent is told to continue (a busy service: after 5 minutes), at most three times an hour; `"limits": { "autoResume": false }` turns that off. **Continue now** does it at once.
- **Continue on another engine.** From the Limit card, **Continue on Codex** (or any other installed engine), or `agentmgr continue-on <agent> <engine>`: a new agent in the same folder and branch, started with the request, the brief and the end of the conversation. It owns the folder from then on; the old agent is closed, says where the work went, and deleting it leaves the folder.
- **Approval rules for every repo.** Once you've allowed a command in 2 repos, the inbox offers it for every repo; accepted, agents in any repo stop asking about it.
- **Read-only commands never ask:** `ls`, `pwd`, `wc`, `git status`, `git diff`, `git log`, `git show`, `git blame`, `git rev-parse`, in every repo (plain commands only; chained or redirected ones still ask). `"rules": { "readOnly": false }` turns it off.
- **Codex agents learn approval rules too:** their "run the following command?" prompt names the command in the inbox, your yeses count toward a rule, and allowed rules answer them.
- **Close idle sessions after hours.** Settings → Open agents → "Close sessions idle for N hours" (or `agentmgr cleanup --idle-hours 4`): open sessions quiet that long close on the same rules as the open-agent limit, and resume with their conversation when you open them. Off by default.

## 1.38.0 (2026-11-11)

- **The top bar fits the window.** View buttons that don't fit go, in order, into a **More ▾** menu at the end of the row (with a dot when one of them has a count); the filter gives up its room first, and below 1100px the title and connection text step aside for the logo and a coloured dot. **+ New agents** and your menu always stay in view.
- **Split screen: one session in two views.** When a session shows in more than one place (the main panel, a group, another window), the view you type in or click sets its size; the others show it at that size with the font scaled to fit, instead of wrapping oddly.
- **Split screen keys**, also from inside a terminal: **Cmd+\\** on a Mac or **Ctrl+Shift+\\** splits right (add Shift on a Mac, or Alt, to split down), **Ctrl+Shift+1…6** goes to a group, **Ctrl+Shift+X** closes the active one. They're listed under **?**.
- Fixed: plain **Ctrl+\\** in a terminal split the screen *and* reached the agent as Ctrl+\\, a quit key. It now only goes to the terminal.
- Fixed: a terminal reconnecting in the main panel took the keyboard away from the split-screen group you were working in.
- Tests now drive the page in headless Chrome (`test/browser.test.js`, skipped without Chrome): the top bar at several widths, and the split screen end to end.

## 1.37.0 (2026-11-10)

- **Split screen, as in VS Code.** The area beside the agents list splits right or down into groups, each showing an agent's session or one of its shells, next to the usual panel with the agent's details. Split with **⊞ Split screen** in the terminal bar, **Ctrl+\\** (Ctrl+Shift+\\ splits down) or the buttons on a group; up to six groups. Load a session into a group by dragging an agent onto it (onto its right or bottom edge to split there), from the group's menu (open sessions first), or by clicking an agent in the list while that group is active. In a group you can switch to its shells or open a new one, resume a closed session, or move it to the main panel. Dividers resize; the layout and what each group shows are kept per browser. Narrow screens show the main panel only.
- Fixed: a built agent's test run or package that finished after the agent was deleted could crash on saving its state.

## 1.36.0 (2026-11-10)

- **Open sessions are always at the top of the agents list.** Agents needing your input come first, then working ones, then open sessions waiting for a prompt, in every list order. In **By project**, projects with an open session come first and, inside each project, open sessions come before the rest. The *last N days* filter no longer hides an older agent whose session is open. The **Running first** order is gone, since every order now does this; a saved choice falls back to **Recently used**.
- Fixed a flaky end-to-end test: the Eval's one-minute timer could redo an Eval the test had set by hand.

## 1.35.0 (2026-11-09)

- **Flaky CI is caught before it reaches the agent.** When GitHub Actions checks fail on an agent's pull request, the failed jobs are run once more on the same commit (`gh run rerun --failed`) before the agent is told. If they pass, the checks are marked **Flaky** on the pull request's row in the Land tab and nothing is sent; if they fail again, the agent is told, and that it failed twice. Checks from other CI systems, and a re-run GitHub refuses, go to the agent straight away as before. Once per commit; turn it off in the Land tab's settings.

## 1.34.0 (2026-11-08)

- **Merge on the Eval.** A pull request is *sure to merge* when its agent's Eval is 100%, the app's own test run passed on the very commit the pull request is at with nothing left uncommitted, a reviewer approved it, and GitHub has it ready. The Land tab lists these first, marked **Sure to merge** with the Eval's percentage; a ready pull request that isn't sure says why (for example "The tests ran on a different commit than the pull request is at"). Turn on **Merge on the Eval** in the Land tab's settings and these merge on their own: each commit is tried once, your policies and branch protection still apply, and a merge that fails says why on the pull request's row. Off by default; the approval requirement can be turned off.

## 1.33.0 (2026-11-08)

- **Eval for each Jira change, with a confidence.** When an agent on a Jira issue says it's done, the app runs the project's tests again itself, on the change as it is (the test command is found in the project's files, or set once per project), and works out an *Eval* from evidence, not from the agent's word. It covers:
  - the tests the agent actually ran in its session and their results;
  - the app's own test run;
  - each acceptance criterion and what proves it;
  - CI on the pull request and the AI judge's review;
  - the brief's checks and the micro benchmarks;
  - what is still pending.
  The **confidence** comes from fixed rules over these: it is **100% only when** the tests pass when run again on the code as it is now, every criterion is met, CI and the judge agree, and nothing is pending. A change made after the run takes it below 100% until the tests run again. It shows as a percentage on the agent, in the Jira list and, for issues done but under 100%, in Today. From the Eval: *Close the gaps* sends what's pending to the agent, *Run tests again*, *Copy for Jira* (Markdown), and *Post to PR* (a comment, only when you press it).

## 1.32.0 (2026-11-08)

- **Micro benchmarks per module, for Jira issues.** The Map has a *Speed* view: click a folder where speed matters, *Benchmark this folder*, and optionally name the Jira components or labels that mean it. An agent on a Jira issue then benchmarks that module when its issue names it (a component or label, or the folder in the request), or when its change touches it: if it says it's done without having measured it, it's asked to once. It runs every case before and after its change on the same machine, and adds cases for what it changed. A module's benchmarks are kept on this computer, outside the repository, so the next issue on it runs the same ones and the numbers line up. Each issue's numbers show on the module (case, before, after, change), and the folder is coloured by what the last issue did to its speed. A case more than 5% slower shows in Today as *Slower*, with *Ask to fix* (the agent makes it as fast as before, or says why it can't be) and *It's fine*. Jira issues' components and labels are now read along with their summary.

## 1.31.0 (2026-11-08)

- **Bugs on the Map.** The Map has a *Bugs* view (next to *Agents*): each folder is coloured by the bugs hunts found in it, the worst weighing most, plus a little for how often it changed in the last 30 days, and its bug count shows on it. Bugs that come with their path through the code (`file:line` steps) are drawn as arrows from folder to folder along it: the hot paths, thicker where more (and worse) bugs go the same way. Folders no hunt has looked at are hatched. Click a folder or an arrow for its bugs, with *Fix* and *Evidence*, or *Hunt here* to start a hunt on that folder.

## 1.30.0 (2026-11-07)

- **Bug hunts fix what they find.** Turn on *Fix automatically* on a hunt, and the bugs it finds at or above the severity you pick (high and up by default) are fixed without you: each by its own agent on its own branch, which must add a test that fails before the fix and passes after, and pass the whole suite. The hunt's test command (optional) is run on the fix too, and the AI judge, when it's on, reviews the change. Only then is a **draft** pull request opened, with the bug, the test and the checks in its description; nothing is merged. They show in Today as *Fix ready* and under Bugs → *Draft PRs*. At most 3 a run, within the hunt's cost limit. A fix that doesn't hold up stays in the list with the reason, and with *file it as an issue* on, it's filed on GitHub so it isn't lost.

## 1.29.0 (2026-11-07)

- **Questions for you, with answers ready.** The assistant now also finds questions put to you in Slack (and email and meeting notes, with those on), including ones you're only copied or mentioned on, and prepares an answer for each: it reads the thread and checks the code of your projects, Jira and docs. They show in Today (*Asked you* is pressing, *CC'd* can wait) and under Actions → Questions, with the draft to *Copy*, *Edit*, or *Draft again*, and *Thread* to open where it was asked. A question without a draft has *Draft an answer*, which starts a session that researches it. Nothing is ever sent for you. (`agentmgr actions add --question … [--cc]`, `agentmgr actions answer <id> "<text>"`.)
- **Answer agents right in Today.** An agent's question shows the choices it offered as buttons (or press 1–6) and a box to type an answer; a permission prompt shows its options. No need to open the session.
- **Finish work with no pull request.** When an agent is done but opened no pull request, Today and the Jira list offer *See changes* (the diff), *Open PR* (commits what's left, pushes and opens one, titled after the issue) and, in Today, *Send back* with a note.
- **Snooze everywhere.** Actions, Jira issues and questions can be snoozed until tomorrow 9am (*Snooze*, or `z`); they come back by themselves. Snoozed ones are under the new *Snoozed* filters and in Today's *Set aside*, with *Bring back*.
- Typing in a box in Today, the Jira, Actions or Bugs list is no longer interrupted when the list refreshes.

## 1.28.0 (2026-11-07)

- **Bug hunts.** *Bugs* (or `b`) runs agents that look for bugs in the background, in a project or one folder of it: in what changed since the last run, or the whole module a part at a time, for any bug or the kinds you pick (races, error handling, leaks, security, data). A hunt runs by hand (*Hunt now*) or every night, one at a time, and stops at its cost limit. The hunter reads the code and runs the tests on its own copy and never commits or pushes. Each bug must come with evidence (a failing test, or the path through the code), and the AI judge checks each one against the code: only those that hold up are listed, worst first, and nothing is reported twice. On each: *Fix* starts an agent with the finding and its test, *File it* opens a filled-in GitHub issue (or copies it as Markdown), *Not a bug* keeps it from coming back, *Snooze* hides it until tomorrow or Monday. Critical and high ones show in Today.

## 1.27.0 (2026-11-07)

- **Jira on your company's own address.** With your site saved in Settings → Jira, every issue's summary and status are asked of that site, whatever address its link has (links often use the company's own domain, like `jira.company.com`, while the API answers on `company.atlassian.net`). A site that sends the API on to its Atlassian address is followed there (and only there). When Jira says it can't find an issue, the Jira list says so: usually the email in Settings isn't the one you sign in to Jira with.
- **Bring back what you set aside, and undo.** Today has a *Set aside* section listing what you skipped, marked done or removed, each with *Bring back*, and *Bring all back*. Skip, Done and Bring back offer *Undo* on their message (or press `u` in Today). The Jira and Actions lists offer *Undo* after each change too, and *Bring all back* on their Skipped, Done and Removed filters. Messages now show over an open window, so their buttons can be clicked.
- **Report a problem or idea.** In the menu (☰), *Report a problem or idea…* takes a title, the details and a screenshot: paste it (⌘V), drop an image, choose a file, or capture the screen. The report is kept on your computer (`support/` in the home folder), and GitHub opens with a new issue filled in, including the version, OS and which lists are on (no names, folders or tokens). The screenshot is put on your clipboard to paste there. Nothing is posted until you submit it on GitHub.

## 1.26.1 (2026-11-07)

- **Jira says why it isn't working.** When your Jira site can't be used (the token isn't accepted, the site sends a sign-in page, it can't be reached), the Jira list and Today say so in words instead of just showing no summaries or statuses. Settings → Jira has a **Check Jira** button that asks the site for your open issues and says how many it found, or why it couldn't.
- **Jira Server and Data Center.** With no email, the API token is sent as a personal access token, and the older API those sites have is used when Jira Cloud's isn't there. The site address may have a port and a path (`https://jira.company.com:8443/jira`).
- **Skip, Done and Remove work on every issue in the list.** Before, an issue listed through its agent, whose request named it after other words rather than starting with its link, could fail with "not on the list".
- **↻ asks Jira again.** Refreshing the Jira list or Today fetches statuses again rather than using those from the last few minutes.

## 1.26.0 (2026-11-07)

- **Today: what needs you, in one list.** The Today button (or `y`) gathers what the other lists know and puts the most pressing first: agents stopped at a prompt or waiting for your answer, overdue and due-today action items, issues and pull requests ready for your review, review requests, then the rest (actions due later, new Jira issues, stuck agents, follow-ups). Each says why it's there ("due today · asked by Pat · in Slack", "Blocked: staging credentials"), and the usual decision is a click or a key away: Done, Skip and Discuss for actions, Assign for new issues, Review it for a requested pull request, Open for the rest. Listen reads the top of it aloud. Lists turned off in Settings are left out. The button's count is the pressing ones.

## 1.25.2 (2026-11-07)

- **Designs, Reviews and Value: bigger too.** Drag the corner to any size, or fill the window with ⤢ (or `f`), as in the Jira and Actions lists.
- **Fixed: Close all could leave an agent open without saying so.** An agent busy when you clicked, which finished while the others closed, was neither closed nor listed as left working; it's now listed as left open.
- For contributors: `npm test` runs the end-to-end tests in parallel slices, each with its own daemon (`E2E_PARTS=1` for one), about three times faster; several timing-dependent tests no longer fail now and then.

## 1.25.1 (2026-11-06)

- **Jira and Actions lists: bigger.** Drag the corner to any size, or fill the window with ⤢ (or `f`); it's remembered. Filled, an issue's summary and synopsis show in full.
- **Fixed: choosing an action with the mouse didn't stick.** The list redraws every few seconds while agents work, which threw away an open dropdown before you chose; it now waits until you've picked.
- **Fixed: a key could act on the wrong issue.** Clicking a row now selects it for the keys, a key pressed in a row's dropdown acts on that row, and when the selected issue leaves the list (skipped, removed) the one now in its place is selected instead of the top one.
- **The Jira summary on every row**: an agent's issue shows its summary and synopsis from your assigned-issues search too, and messages name issues by summary.

## 1.25.0 (2026-11-06)

- **Actions: what's asked of you in Slack and in meeting notes, in one list.** The assistant reads your Slack messages and mentions and your meetings' Notes by Gemini on its checks, and lists what's asked of you (or what you agreed to do) with who asked, where (a link), when and any due date. Decide on each on the left (assign to an agent, skip, done, remove), kept across restarts and changeable any time; **Discuss** talks one through with Claude in a session of its own, which suggests what to do and drafts any reply, but never sends anything. Turn it on under Assistant (on by default for new and existing setups); `agentmgr actions` lists them.
- **Turn off what you don't use**: Settings → What you use has Jira, Slack and Meeting notes. Off, its list and button are hidden and the assistant stops looking there; changes reach a running assistant with its next check. Settings also has your name and email, so the assistant knows what's asked of you.
- **More keyboard shortcuts**: `o` Actions, `h` Assistant, `,` Settings. In the Jira and Actions lists, `j`/`k` move between rows, `a` `s` `d` `x` assign, skip, mark done or remove, `c` discusses an action, Enter opens the source, `[` `]` switch filters. In the standup, Space plays or pauses and ← → move between agents. `?` lists them all.

## 1.24.0 (2026-11-06)

- **Your action on each Jira issue: assign, skip, done or remove.** A picker on the left of every issue in the Jira tab. Your choice is kept by the daemon, so a restart or an update doesn't ask again, and you can change it any time (a removed issue is under Removed, to bring back). Assign starts an agent for an issue not started yet. The assistant doesn't propose or start agents for issues you skipped, marked done or removed. Also `agentmgr issues set <assign|skip|done|remove|clear> <keys...>`.
- **Every open Jira issue assigned to you is listed**, epics too, until it's closed or integrated, with or without an agent. Needs your Jira site, email and API token in Settings → Jira.
- **A synopsis under each issue**: what it's about in a sentence or two, from its Jira description (or the agent's design doc).
- **A clearer standup voice.** The standup used a different voice for each agent, picked from every voice installed, and on a Mac that includes the old robotic ones. Now it uses only the clearest on-device voices (Premium, Enhanced and Siri voices first), names are read as words, and you can pick one voice under the player; it's used for everything read aloud. Online voices (Chrome's Google ones) are offered but never picked for you, since they send the text to Google.

## 1.23.1 (2026-11-06)

- **Diagrams that fail to draw no longer litter the page.** Mermaid's "Syntax error" picture was left at the bottom of the page when an agent's diagram didn't parse. Now the diagram's own spot says it couldn't be drawn and shows its source. A diagram whose node labels have unquoted parentheses or braces (`A[GetView(s)]`, which agents often write) is drawn again with those labels quoted, so most of them now draw.
- **The page reloads itself after an update.** While restarting, the old daemon keeps serving the old version until its agents are closed, so a reload during that time (even Shift+Reload) still showed the old one. Now any open page, including one on a phone over remote access, reloads by itself as soon as the new version is up.

## 1.23.0 (2026-11-06)

- **Reviews.** Reviewer agents for other people's pull requests. **Reviews** (or `g`) lists PRs where your review is requested; tick them, or paste any PR link. A reviewer works read-only on the PR's head: a verdict (approve, approve with nits, blocked), the approval blockers with file, line, why and what would resolve them, critical questions for the author, risks, test gaps and nits. Tick what to send and **Post as pending review** (a draft review under your name that you submit on GitHub), or **Copy**. When the author pushes, the reviewer re-checks its blockers. **🔊 Explain** reads it aloud. The assistant's GitHub reviews source starts reviewers, or only lists them when you pick. `agentmgr review <PR>`, `agentmgr reviews` (`show`, `post`, `dismiss`).

## 1.22.0 (2026-11-06)

- **Value.** A **Value** button (or `v`) shows what the delivered work is worth, by day, week, month and quarter: engineering hours saved (valued at your loaded hourly rate), other savings, potential revenue and strategic weight, against the AI cost and your own time (leverage, value per AI dollar). Each delivered item (its pull request merged, or done without one) gets an estimate from one short model call, with reasons; correct any figure and yours win, marked ✎ in reports. Weekly, monthly and quarterly reports (daily if you like) go to Slack and, if you choose, a Google Doc, and are saved in `~/.agentmanager/value` with `value.csv`. `agentmgr value` (`edit`, `estimate`, `report`, `set`).
- **Jira summary.** A **Jira** button (or `i`) lists every Jira or Linear issue an agent works on, the ones waiting for your review first, with a count on the button: the issue and its Jira status, where the work stands (ready for your review, needs your answer, approved but not merged, checks failing, merged), its plan (steps done, approval) and design doc (read it here, its page and Google Doc), its pull request and checks, and a link to the agent's session. **Copy** puts the list on the clipboard as a Markdown table. From the terminal: `agentmgr issues` (`--all`, `--markdown`, `--json`).
- **Pick which Jira issues get agents.** **Let me pick** in **Assistant** (`agentmgr assistant set --pick-issues on`): the assistant lists new Jira and Linear issues assigned to you under **Jira → Not started** instead of starting agents for them. Tick the ones you want and **Start**; agents start only for those. **Dismiss** takes the rest off the list for good. Also `agentmgr issues propose`, `start` and `dismiss`.
- **Explain the review, by voice.** **🔊 Explain** on each pull request (in Jira, Land and the agent's AI review) reads a short briefing for the person about to review it: the issue, what the PR does (from its design doc or walkthrough), its state and checks, what the AI review found met, missing and risky, the high-risk changes, open questions, and what's left before it can merge. It starts at once (no model call); Review's change-by-change walkthrough goes deeper.
- **Designs.** A **Designs** button (or `d`) lists every agent's design doc, the ones waiting for your review first: its name and summary from DESIGN.md, the agent and its issue, and links to read it here, its design page, its Google Doc and the specs it builds on. Search, filters and **Copy** as Markdown. `agentmgr designs` (`--waiting`, `--markdown`, `--json`).

## 1.21.0 (2026-11-06)

- **Map: where agents are in the code.** A **Map** page (or `m`) shows a project's folders as tiles with each agent on the folders it's changing or reading now. Two agents that changed the same file are joined in red; one reading a file another changed is joined with a dashed line, the warning before they collide, and each is spelled out above the map.
- **Standup.** Every weekday morning (or on demand: **Standup**, or `p`), each agent's news is read aloud in its own voice: what it did, what it's on and what it needs from you, the ones that need you first. It stops on those with their questions beside it: answer by tap, or by voice (read back, sent on "send"). Worded by one short model call; a Slack alert says when it's ready.

## 1.20.0 (2026-11-06)

- **Review comments reach the agent while its pull request is open.** New comments, reviews and line comments on an agent's open pull request are sent to it in one message (waking it if closed), checked every couple of minutes; it makes the changes, pushes and replies on the pull request. Only the repo's owners, members and collaborators (and review bots on the code) count; approvals, resolved threads and the agent's own replies don't. On by default: **Send new review comments** in the Land tab, `agentmgr land set --fix-comments off`, or `"landing": { "fixComments": false }`.
- **Demo page and micro benchmarks, as options.** Tick **Demo page** on the new-agent form (`--demo-page`) and, once the change works, the agent makes a self-contained sample page showing it with real inputs and outputs, published as a claude.ai Artifact and opened here (sandboxed) with **Demo page ↗**. Tick **Micro benchmarks** (`--benchmarks`) and it times the code it changed before and after, writing a results table you open with **Benchmark**, also folded into the pull request description. Both are off by default (`"demoPage"`, `"benchmarks"` in config.json).
- **Watch: agents side by side.** A **Watch** page (top bar, or `#watch`) shows every running agent's live session at once, up to 12, so you can follow them without clicking from one to another. **Fit** puts them all on screen; an agent waiting on you gets a red border and a count at the top; click a tile and type to answer it in place, or click its name to open the agent. Filter by running, waiting on you or working, and by project.
- **Keyboard shortcuts.** Quick actions without the mouse: `j`/`k` to move through agents, `Enter` for the terminal, `r` review changes, `s` resume, `Shift+X` close, `e` edit, `n` new agents, `a` Ask Agent, `/` filter, `w` Watch, `1`-`5` tabs; `Ctrl+Shift+↓`/`↑` jump between agents' terminals and `Ctrl+Shift+L` leaves one. **?** (or **Keyboard shortcuts…** in the menu) lists them.
- A live browser tab keeps trying for its first picture and title for up to 15 seconds when Chrome is slow to start, instead of staying blank.

## 1.19.0 (2026-11-05)

- **Design docs, written automatically.** Once its plan is settled, a task agent writes a short design doc and publishes it as a claude.ai Artifact; the link goes in its brief. The doc covers a summary, the architecture, the design, the data flow and the decisions and risks, with at most three small diagrams and no repeats of the spec or plan. When the work is done, the agent brings it up to date at the same link. It's on by default; untick **Design doc** on the new-agent form, use `agentmgr add --no-design-doc`, or set `"designDoc": false`. View it under **Design doc** next to Intent · Spec · Plan; it's also folded into the pull request description.
- **Publish to Google Drive.** One button (or `agentmgr publish <agent>`) puts all of an agent's documents in a Google Drive folder, one Google Doc each: the brief, intent, spec, plan, design doc and any documents written. It goes through your Claude account's Google Drive connector. Publishing again replaces them with the latest, moving the earlier ones to the trash.
- A live browser tab you open always shows the page: when the page is holding still and Chrome sends no picture, a screenshot is taken instead of leaving the view blank. Its title is fresh too.

## 1.18.2 (2026-11-05)

- **Show one project's agents.** A project picker above the agents list shows only that project's agents (**All projects** for everyone). Each browser remembers it.
- **Newest first** orders the agents list by creation date, the newest on top.

## 1.18.1 (2026-11-04)

- **Planning moves into the repo by itself once it's cloned**, even with its terminal open: no more waiting for **Continue in repo**. It still waits until Claude is idle and you haven't typed for 15 seconds, so nothing is cut off. **Continue in repo** still moves it right away.

## 1.18.0 (2026-11-04)

- **Goals.** Give an outcome for today, this week or no deadline, across one or more projects (**+ Goal** in the Backlog tab, or `agentmgr goal add`). It's planned into tasks, one agent each, which go to the backlog and run until done; autopilot ships them where it's on. When all are finished, the outcome is checked against what was delivered and what's missing is queued, for up to 2 more rounds. Each goal keeps **completed**, **pending** and **follow-ups** current, with **Copy summary**, **Carry over** when overdue, and an optional look at the plan before agents start.
- **Work record.** What your agents got done is appended, as it happens, to `~/.agentmanager/worklog.csv`: pull requests opened, merged and closed, bugs fixed, issues filed and agents finished, with dates, links and costs. A weekly summary goes to `worklog-weekly.csv`. **Work record…** in the menu shows a period's totals, the weeks and the events, with **Copy summary** (Markdown for a review) and the files to download; `agentmgr worklog`. Agents now list issues they open as `- Filed:` lines in their brief.
- **Follow-up reminders.** The Inbox reminds you about recent agents that went quiet: work that isn't finished (still open, or closed by itself, the session cap or clean up), with a nudge to send, Resume or Close session; and finished agents whose session is still open, to close. **Later** snoozes a reminder for a few hours, **Not needed** until the agent is used again (`agentmgr remind`). Timing in config.json under `reminders`.
- **Close all** next to the agent counts closes every open session at once. The assistant stays open, and so do agents working right now unless you also choose **Close them too**.
- **Autopilot ships at a score.** Per project, choose when autopilot ships: when the scorecard says ready, as before, or at 80+, 85+, 90+ or 95+ (`agentmgr backlog autopilot <project> merge --target 85`). With a score set, work that isn't there yet, *Look at these first* included, goes back to its agent with its scorecard to improve, and ships once it's ready at the target. It waits for you when the tries run out (3) or when a try raised the score by less than 3 points. Items show their scores so far (*72 → 81 → 87*).
- Autopilot sends not-ready work back with the full scorecard, as **✨ Improve** does, instead of only the reasons, and up to three times instead of two (`"autopilot": { "rounds": 3 }`).
- **The agents list puts the most recently created or used agents on top.** It's one list now, each agent tagged with its project. Above the list, switch to **Running first** (running agents on top, then the rest) or **By project** (the grouped view as before). Each browser remembers the choice.

## 1.17.0 (2026-11-03)

- **Sessions go both ways with the Claude desktop app.** **Open in Claude desktop** on a Claude agent (and `agentmgr desktop <agent>`) continues its conversation in the desktop app through Claude Code's `claude --desktop --resume`. The agent's session here closes first, messages for it wait until you resume it here, and **Resume** picks up what was said in the desktop app. **Import** now lists sessions started in the desktop app's Code tab (marked **Claude desktop**, with their title there) and in editors. Before, it only listed sessions started from a terminal. A session open in the desktop app is protected like one open in a terminal: close it there, or continue a copy.

## 1.16.0 (2026-11-03)

- **Faster typing and switching with many agents:** the page no longer redraws everything on every agent update. Updates are drawn once per frame, only the views they touch are redrawn (another agent's update leaves the open agent's details and terminal alone), and lists change only the cards that changed. With 40 busy agents, the page's redraw work went from about 870 ms to 35 ms per 10 seconds. Add `?perf` to the address to see how long redraws take.
- Switching agents with a terminal open no longer leaves the previous agent in the address (a reload opened the wrong one).
- **Improve before review:** the review scorecard's score shows on the agent's row (📊 75), in its Results and on backlog items in review, before you open anything. **✨ Improve** sends the agent its own scorecard to fix: the low scores with why, the acceptance criteria not met or not verified, and where a reviewer would look. It's in Results, the scorecard, Review changes, backlog items in review, the inbox, and `agentmgr improve <agent>`. When the agent marks its brief done again, the changes are scored again, and the score shows how far it moved (*82 ↑7*).
- **The scorecard and the AI judge's review now run when an agent marks its work done, as documented.** Neither ever did: the brief was saved before the check for "newly done", so that check never saw the change. Expect one scorecard call per finished task agent (turn it off with `"scorecard": { "auto": false }`).
- A reopened backlog item's note of several lines arrives as one message instead of being sent line by line. This covers Autopilot's send-backs too.

## 1.15.0 (2026-11-03)

- **Autopilot for the backlog:** finished items go on to a pull request, and merged, without you, when the review scorecard says they're ready. Per project (🛫 in the Backlog tab, `agentmgr backlog autopilot <project> off|pr|merge`), off by default. *Open PRs* commits, pushes and opens the pull request. *Merge* also merges it once checks pass, updating a branch that fell behind. Not-ready work goes back to the agent with the scorecard's reasons (twice at most). Anything else waits in the Inbox as *Autopilot held*, with **Ship it**, **Review changes** and **Send back**. An item whose pull request merges is done. **Ship it** is on every item in review.
- **Requests you keep making become playbooks:** when you've typed alike requests 3 times (new agents and backlog items, with numbers, names, URLs and issue keys set aside), the Inbox offers **Make it a playbook?**. **Save as playbook…** opens the editor prefilled: the shared words become the request, the part that changes becomes `{{what}}`, and the projects they ran in become its projects. **Not now** stops offering it. Requests already saved as a playbook aren't offered. `"repeats": { "suggestAfter": 3, "enabled": true }` in config.json.
- **Commit all** no longer fails with `index.lock: File exists` when it lands on the app's own background `git status` of the same worktree. It retries for a moment.

## 1.14.0 (2026-11-02)

- **Fewer questions: approval rules.** When you allow the same command 3 times in a repo (`npm test`, an MCP tool, fetching from a site), the inbox offers **Always allow**. Allowed rules go to every Claude Code agent in that repo at launch and answer its open prompts, including the ones waiting when you allow it. Never offered for compound commands or ones that delete, escalate, publish or reach the network. Settings → Approval rules and `agentmgr rules` list them, with how many prompts each answered, and remove them.
- **Prompt cards say what they ask about:** "Wants to run `npm test`" (from the session's transcript) instead of only "Do you want to proceed?".
- **Yes to all:** several agents waiting on the same command get one card that answers them together.
- **Built agents' tests run in a throwaway copy** of the agent's folder: what a run writes (summaries, changed fixtures, memory) no longer stays in the agent or changes the next test's starting point. The copy keeps the agent's memory, not its engine sessions or run logs. A `workdir` outside the agent's folder is still used in place.

## 1.13.0 (2026-11-01)

- **Agents are built in an agent session.** **+ Build an agent** now starts an agent session that works in the new agent's folder (`~/.agentmanager/built/<name>/`) and goes straight to it. The session writes the analysis (`analysis.json`), `agent.yaml`, `instructions.md` and `tests.yaml`, and checks that the agent loads. You keep shaping the agent in that conversation, like any other session (terminal, resume, inbox).
- The session's page has a panel for its agent: status, tests, **Run tests**, **Start**/**Stop**, its chat, **Details**. Failing tests go back to the session with **Ask this session to fix them**.
- In the Built tab, each agent links to its session. The details dialog has a box that sends a change request to the session. Agents built before this get **Open a session for it**.
- Test results and executables built before the agent's latest change are marked as out of date. Deleting a built agent closes its session; the conversation is kept.
- **Fixes from building a real agent:**
  - A permission prompt is now flagged when newer Claude Code blinks a ⏺ beside the pending tool call. The blinking used to keep the session looking busy, so the prompt never reached the Inbox. This affects every session, not just build sessions.
  - agentkit agents can write files under a folder they're allowed: Claude Code ignores `Write(<path>)` allow rules, so each one now also gets its `Edit(<path>)` rule.
  - The test judge sees the files each test run created or changed, not only the agent's reply, and the Tests list shows them.
  - Build sessions read the agentkit reference without asking, and write the agent's files with their file tools.
- The build dialog takes an optional name; otherwise the name comes from the task's first words. `POST /api/builder/:name/change` sends a change request to the session from scripts.

## 1.12.0 (2026-11-01)

- **agentkit (phase 1): agents you build and run.** An agent is a folder with `agent.yaml` (goal, instructions, engine, MCP tools, allow/approve lists, triggers, loop, memory, interfaces); `agentkit run <agent>` runs it continuously. Each input is a run of plan → act → check (acting again on what's left, up to `maxSteps`) → reflect into memory, through an engine's CLI (Claude Code, Codex, Muse Code or an ACP agent), self-contained (only its own MCP servers; none of your personal Claude settings). Triggers: `every`, `cron`, `webhook`, `watch`. Interfaces: a chat page and HTTP API, A2A (agent card and `message/send` / `tasks/get`), ACP on stdio (`agentkit acp`), and an MCP tool (`agentkit mcp`, one tool `ask_<name>`). `agentkit init`, `check`, `run --once`. See [docs/agentkit.md](docs/agentkit.md).
- **Agent builder:** a **Built** tab with **+ Build an agent**: describe a task or workflow (attachments welcome) and pick an engine; one call designs the agent: an analysis (problem, inputs, outputs, risks), its `agent.yaml` and instructions, suggested MCP tools and 3–5 test cases. Review and edit the spec (checked on save), **Run tests** (each through the real runtime, judged against its expectation), **Start** it on this computer (its chat page and API), **Download** its folder. Built agents live in `~/.agentmanager/built/<name>/`; `/api/builder` for scripts.
- **Single executables and background service for agents:** `agentkit package <agent> [--platform]` makes one file (macOS arm64/x64, Linux x64/arm64) that runs the agent with no Node or agentkit installed: a Node single executable with the agent's files embedded, built on the official Node binary (downloaded from nodejs.org, checksum-verified, cached). Linux ones build on a Mac. The executable unpacks to `~/.agentkit/<name>/` and takes the same commands (`--once`, `acp`, `mcp`, `check`). `service install|status|uninstall` keeps an agent running in the background (launchd or a systemd user service: started at login, restarted after a crash). In the Built tab: **Build executable** for a platform, with download links.
- **Approvals and monitoring for agents:** tools on an agent's `approve` list now ask a person instead of being unavailable (Claude Code engine, through `--permission-prompt-tool` and the agent's own approver), on its chat page and in AI Agent Manager's **Inbox**; the first answer decides, silence past `approveTimeout` is a no, and the approve list wins over `allow`. Agents report to AI Agent Manager (runs, cost, results, open approvals; every 30s, at once after a run): the **Built** tab lists them under *Reporting in*. Agents started here report automatically; others connect with `AGENTKIT_REPORT_URL`, `AGENTKIT_REPORT_TOKEN` and, over remote access, `AGENTKIT_REPORT_CERT` (certificate pinning).

## 1.11.1 (2026-11-01)

- **Copy and paste in terminals on phones:** **Copy** and **Paste** in the terminal's key bar (and in the Terminal's bar). A phone can't select the terminal's text or paste into it directly, so Copy opens its recent output as plain text you can select (or **Copy all**), and Paste reads the clipboard (the phone asks first) or offers a box to paste into, then inserts it as one paste without pressing Enter.

## 1.11.0 (2026-11-01)

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
