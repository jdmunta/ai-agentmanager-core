import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';
import { WebSocketServer } from 'ws';
import { ensureHome, HOST, loadConfig, paths, PORT, saveConfig } from './config.js';
import { AgentManager, MACHINE, projectOf, shellNumber } from './manager.js';
import { Backlog } from './backlog.js';
import { Races } from './races.js';
import { Review } from './review.js';
import { Teams } from './teams.js';
import { Assistant, FEATURES, featuresOf } from './assistant.js';
import { Cleanup } from './cleanup.js';
import { Landing } from './landing.js';
import { Autopilot } from './autopilot.js';
import { Goals, goalMarkdown } from './goals.js';
import { Budgets } from './budgets.js';
import { stats } from './stats.js';
import { Playbooks } from './playbooks.js';
import { Repeats } from './repeats.js';
import { Updates } from './update.js';
import { identity } from './identity.js';
import { WorkLog, summaryMarkdown } from './worklog.js';
import { todayAside, todayItems, todaySpeech } from './today.js';
import { Studio } from './studio.js';
import { Memory } from './memory.js';
import { doctor } from './doctor.js';
import { Triggers, tokenMatches } from './triggers.js';
import { listEngines, registerAcpEngines, registerEngine } from './engines/index.js';
import { Plugins, pluginSpecs } from './plugins.js';
import { HubLink, linkUrls } from './hublink.js';
import { Notifier, isWorkflowUrl, loadNotify, publicNotify, saveNotify, sendSlack } from './notify.js';
import { Previews, parseUrl } from './preview.js';
import { LiveBrowser } from './livebrowser.js';
import * as remote from './remote.js';
import * as service from './service.js';
import { assignedIssues, jiraProblem, jiraView, saveJira } from './jira.js';
import { ProposedIssues, issuesMarkdown } from './issues.js';
import { MyActions } from './actions.js';
import { designsMarkdown } from './designs.js';
import { Reviews, reviewDraft, reviewMarkdown } from './reviews.js';
import { CONTAINER_ENGINES, buildImage, claudeToken, dockerStatus, isBuilding, saveSecrets } from './container.js';
import { AgentkitReports } from './agentkit-reports.js';
import { Builder } from './builder.js';
import { Standup } from './standup.js';
import { Value, valueSlack } from './value.js';
import { Store } from './store.js';
import { about, latestRelease } from './about.js';
import { Support } from './support.js';
import { ghBin, leadingJiraKey } from './tracker.js';
import { BugHunts } from './bughunt.js';
import { ModuleBenchmarks } from './benchmarks.js';
import { Evals, readTail, stateHash } from './eval.js';
import { engineOf } from './engines/index.js';
import * as git from './git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const CLIENT_HEADER = 'x-agentmgr';

/**
 * The API drives real terminals, so callers are restricted.
 *
 * Local listener (127.0.0.1): Host must be loopback (blocks DNS rebinding), a
 * browser Origin must be this server (blocks cross-site WebSockets), and writes
 * need a custom header (browsers cannot send one cross-origin without a CORS
 * preflight we never grant).
 *
 * Remote listener (opt-in HTTPS on the LAN): the same, with this machine's own
 * addresses as the only valid Host, and a signed-in device session on every API
 * call except login. Managing remote access and shutting down stay local-only.
 */
function isLocalHost(host, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
}
function isAllowedOrigin(origin, port) {
  return !origin || [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin);
}

const PUBLIC_REMOTE_API = new Set(['POST /api/login', 'GET /api/session']);
// Updates are not here: a signed-in device (a phone) can install the newest release too. It only
// ever installs an official release from where this copy came from (git tag or npm) and restarts.
const LOCAL_ONLY_API = /^\/api\/(remote(\/|$)|notify(\/|$)|hub(\/|$)|triggers(\/|$)|service$|jira(\/check)?$|isolation\/|editors$|agentkit\/connect$|agents\/[\w-]+\/open-in$|shutdown$)/;
const HOOK_PATH = '/api/hooks/agents';
const REPORT_PATH = '/api/agentkit/report';
const NO_REPO_KINDS = new Set(['general', 'assistant']);

export async function startServer({ port = PORT, host = HOST } = {}) {
  ensureHome();
  const config = loadConfig();
  const store = new Store(paths.state);
  const plugins = await new Plugins({ log: (m) => console.log(`[agentmgr] ${m}`) }).load(pluginSpecs(config), { config, base: paths.home });
  for (const { def } of plugins.engines) registerEngine(def);
  // ACP agents (Gemini CLI, OpenCode, Goose, … and config's "acp") become engines.
  registerAcpEngines(config);
  const manager = new AgentManager({ store, config, plugins });
  const backlog = new Backlog({ manager, store, config });
  const proposed = new ProposedIssues({ store, manager });
  const myActions = new MyActions({ store, manager });
  const reviews = new Reviews({ manager, store, log: (m) => console.log(`[agentmgr] ${m}`) });
  // Bug hunts: the judge checks each finding when it's on (else only failing tests are kept).
  // Fixing automatically: the change, the tests, a commit and a draft pull request, or an issue.
  const huntGit = {
    diff: async (id) => {
      const a = manager.mustGet(id);
      const base = await review.base(a);
      return base ? git.fullDiff(a.workdir, base.sha) : '';
    },
    commit: (id, message) => review.commit(id, { message }),
    pr: (id, opts) => review.pr(id, opts),
    test: (id, command) => runCommand(manager.mustGet(id), command),
    fileIssue: async (project, { title, body }) => {
      const p = manager.resolveProject(project);
      const slug = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(p?.repo ?? '')?.[1];
      if (!slug && !p?.dir) throw new Error('The project has no GitHub repository to file in');
      const out = await git.run(ghBin(), ['issue', 'create', ...(slug ? ['-R', slug] : []), '--title', title, '--body', body, '--label', 'bug'], { cwd: p?.dir ?? undefined, timeout: 60_000 }).catch((e) =>
        // A repository without a "bug" label: file it without one.
        /label/i.test(e.message) ? git.run(ghBin(), ['issue', 'create', ...(slug ? ['-R', slug] : []), '--title', title, '--body', body], { cwd: p?.dir ?? undefined, timeout: 60_000 }) : Promise.reject(e),
      );
      return /https:\/\/\S+\/issues\/\d+/.exec(out)?.[0] ?? null;
    },
  };
  /** A shell command in an agent's folder: { passed, output } (the last lines), killed after 15 minutes. */
  const runCommand = (agent, command) =>
    new Promise((resolve) => {
      const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', command], { cwd: agent.workdir, env: manager.childEnv(agent), detached: true });
      let out = '';
      const keep = (d) => (out = (out + d).slice(-4000));
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 15 * 60_000);
      child.on('error', (e) => (clearTimeout(timer), resolve({ passed: false, output: e.message })));
      child.on('close', (code) => (clearTimeout(timer), resolve({ passed: code === 0 && !timedOut, output: out, timedOut })));
    });
  const hunts = new BugHunts({ manager, store, judge: manager.judge, git: huntGit, log: (m) => console.log(`[agentmgr] ${m}`) });
  hunts.startTimer();
  // Micro benchmarks of the modules where speed matters, for the Jira issues that change them.
  const benches = new ModuleBenchmarks({
    manager,
    store,
    changedFiles: async (a) => {
      const base = await review.base(a);
      return base ? Object.keys((await git.changes(a.workdir, base.sha))?.files ?? {}) : [];
    },
    log: (m) => console.log(`[agentmgr] ${m}`),
  });
  // Eval: the tests run, the checks done and what's pending for each Jira change, with a confidence.
  const evals = new Evals({
    manager,
    store,
    benches,
    run: (a, command) => runCommand(a, command),
    state: async (a) => {
      const opts = { cwd: a.workdir, timeout: 30_000 };
      const [head, status, diff] = await Promise.all([git.run('git', ['rev-parse', 'HEAD'], opts), git.run('git', ['status', '--porcelain'], opts), git.run('git', ['diff', 'HEAD'], opts)]);
      return stateHash(head.trim(), status, diff);
    },
    changes: (a) => review.get(a.id),
    // Claude Code's session: the test runs in it. Other engines keep theirs differently.
    transcript: (a) => (engineOf(a).id === 'claude' && a.workdir ? readTail(engineOf(a).sessionFile(a.workdir, a.sessionId)) : null),
    log: (m) => console.log(`[agentmgr] ${m}`),
  });
  evals.startTimer();
  const races = new Races({ manager, store });
  const review = new Review({ manager });
  // The walkthrough explains the same diff the review screen shows.
  manager.changesSource = (id) => review.get(id);
  const studio = new Studio({ manager, review });
  const teams = new Teams({ manager, store, config });
  const cleanup = new Cleanup({ manager, store, config, teams });
  const landing = new Landing({ manager, store, config });
  // Backlog work the scorecard calls ready goes on to a pull request (and merged) by itself.
  const autopilot = new Autopilot({ manager, store, backlog, review, landing, config });
  manager.inboxSources.push(() => autopilot.inbox());
  // Daily or weekly goals across projects, planned into backlog tasks and seen through (goals.js).
  const goals = new Goals({ manager, store, backlog, config });
  // What agents got done, appended to a CSV for reviews (worklog.js).
  const me = identity().then((i) => i.display, () => '');
  const worklog = new WorkLog({ manager, store, config, who: me });
  const assistant = new Assistant({ manager, store, config });
  // Alerts link to the phone address when remote access is on, else the local UI.
  const notifier = new Notifier({
    manager,
    teams,
    backlog,
    linkFor: (id) => {
      const phone = remoteServer ? remote.remoteUrls(remotePort).find((u) => !u.vpn) : null;
      return `${phone ? phone.url : `http://127.0.0.1:${port}/`}#${id}/term`;
    },
  });
  // A daily standup: each agent's news, worded for listening; the page plays it (standup.js).
  let pushStandup = () => {};
  const standup = new Standup({
    manager,
    store,
    config,
    onChange: (latest) => pushStandup(latest),
    notify: (latest) => {
      const n = loadNotify();
      if (!n.enabled || !n.events.standup) return;
      const phone = remoteServer ? remote.remoteUrls(remotePort).find((u) => !u.vpn) : null;
      const link = `${phone ? phone.url : `http://127.0.0.1:${port}/`}#standup`;
      const need = latest.items.filter((i) => i.needs).length;
      const what = `${latest.items.length} agent${latest.items.length === 1 ? '' : 's'} with news${need ? `, ${need} need you` : ''}`;
      sendSlack(`:sunrise: *Standup ready*: ${what}\n<${link}|Play it>`, n, `Standup ready: ${what}\nPlay it: ${link}`).catch(() => {});
    },
  });
  // Value: what delivered work is worth, by day, week, month and quarter, with scheduled reports (value.js).
  let pushValue = () => {};
  const value = new Value({
    manager,
    store,
    config,
    who: me,
    onChange: () => pushValue(),
    notify: async (period, s) => {
      const n = loadNotify();
      if (!n.enabled || !n.events.value) throw new Error('Slack alerts are off');
      const phone = remoteServer ? remote.remoteUrls(remotePort).find((u) => !u.vpn) : null;
      const link = `${phone ? phone.url : `http://127.0.0.1:${port}/`}#value`;
      const msg = valueSlack(period, s, link);
      await sendSlack(msg.text, n, msg.plain);
    },
    publishDrive: async (title, markdown) => {
      const st = store.data.value;
      const r = await manager.publishDriveDoc({ folderTitle: 'Value reports (AI Agent Manager)', folderId: st.driveFolderId ?? null, title, markdown });
      st.driveFolderId = r.folderId ?? st.driveFolderId;
      store.save();
      return r;
    },
  });
  const triggers = new Triggers({ manager, store, config, notifier });
  const budgets = new Budgets({ manager, store, config, notifier });
  const playbooks = new Playbooks({ manager, store });
  // Requests you keep typing, offered as a playbook.
  const repeats = new Repeats({
    suggestAfter: config.repeats?.suggestAfter,
    enabled: config.repeats?.enabled !== false,
    playbooks: () => playbooks.list(),
    projects: () => Object.fromEntries(Object.values(store.data.projects ?? {}).map((p) => [p.key, p.shortcut || p.name])),
  });
  manager.inboxSources.push(() => repeats.inbox());
  const memory = new Memory({ manager, config });
  const updates = new Updates({ config });
  let remoteServer = null;
  let remotePort = null;
  // Live browser tabs: what a page does is saved on the agent's tab; popups become new tabs.
  const live = new LiveBrowser({
    config,
    onNavigate: (id, n, url) => {
      try {
        manager.setBrowser(id, n, url, { raw: true });
      } catch {}
    },
    onPopup: (id, url) => {
      try {
        return manager.addBrowser(id, url, { mode: 'live', raw: true }).n;
      } catch {
        return null;
      }
    },
    onClosed: (id, n) => {
      try {
        manager.dropBrowser(id, n);
      } catch {}
    },
  });
  const previews = new Previews({
    tls: () => {
      const { key, cert } = remote.certificatePaths();
      return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    },
    allowedHosts: (p) => remote.allowedRemoteHosts(p),
    signedIn: (cookies) => Boolean(remote.checkSession(remote.parseCookies(cookies)[remote.SESSION_COOKIE])),
    cookieName: remote.SESSION_COOKIE,
    reserved: () => [port, remotePort].filter(Boolean),
    savedPorts: () => remote.loadSettings().relayPorts,
    savePorts: (relayPorts) => remote.saveSettings({ relayPorts }),
    ownHosts: () => new Set([...remote.lanAddresses().map((a) => a.address), remote.localHostname(), ...remote.loadSettings().extraHosts].map((h) => h.toLowerCase())),
  });
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  // "Open on this machine" links from the hub point at remote access, when it's on.
  const hubLink = new HubLink({ manager, config, backlog, version: pkgVersion, urls: () => (remoteServer ? linkUrls(remote.remoteUrls(remotePort)) : []) });

  /** Returns an error string if the request may not proceed, else null. Sets req.device for remote sessions. */
  function denied(req) {
    const host = (req.headers.host ?? '').toLowerCase();
    const origin = req.headers.origin;
    if (!req.remote) {
      if (!isLocalHost(host, port) || !isAllowedOrigin(origin, port)) return 'Forbidden';
      return null;
    }
    if (!remote.allowedRemoteHosts(remotePort).has(host)) return 'Unknown host';
    if (origin && origin !== `https://${host}`) return 'Forbidden origin';
    const pathname = req.url.split('?')[0];
    const isApi = pathname.startsWith('/api/') || pathname.startsWith('/ws/');
    if (!isApi) return null; // page, scripts and styles: no secrets
    if (LOCAL_ONLY_API.test(pathname)) return 'Only available on this computer';
    if (PUBLIC_REMOTE_API.has(`${req.method} ${pathname}`)) return null;
    const cookie = remote.parseCookies(req.headers.cookie)[remote.SESSION_COOKIE];
    req.device = remote.checkSession(cookie);
    return req.device ? null : 'Sign in required';
  }

  const reports = new AgentkitReports();
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The webhook signs in with its token instead of a device session or the client header.
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const hook = req.method === 'POST' && req.url.split('?')[0] === HOOK_PATH && tokenMatches(req.headers['x-agentmgr-token'] ?? bearer, config.triggers?.webhook?.enabled ? config.triggers.webhook.token : null);
    // So do agents built with agentkit reporting in (from this computer or another one).
    const reportPath = req.method === 'POST' && req.url.split('?')[0] === REPORT_PATH;
    const reporting = reportPath && tokenMatches(bearer, reports.token);
    const why = denied(req);
    if (why && !((hook || reporting) && why === 'Sign in required')) return res.status(why === 'Sign in required' ? 401 : 403).json({ error: why });
    if (req.url.split('?')[0] === HOOK_PATH && !hook) return res.status(401).json({ error: 'Bad or missing token' });
    if (reportPath && !reporting) return res.status(401).json({ error: 'Bad or missing report token' });
    if (!hook && !reporting && !['GET', 'HEAD'].includes(req.method) && req.headers[CLIENT_HEADER] !== '1') {
      return res.status(403).json({ error: `Missing ${CLIENT_HEADER} header` });
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  // Package root, found from its entry point (not every package exports package.json).
  const pkgDir = (name) => {
    let dir = path.dirname(require.resolve(name));
    while (!fs.existsSync(path.join(dir, 'package.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name !== name) {
      const up = path.dirname(dir);
      if (up === dir) throw new Error(`Cannot find package root for ${name}`);
      dir = up;
    }
    return dir;
  };
  app.use('/vendor/xterm', express.static(pkgDir('@xterm/xterm')));
  app.use('/vendor/xterm-addon-fit', express.static(pkgDir('@xterm/addon-fit')));
  app.use('/vendor/marked', express.static(path.join(pkgDir('marked'), 'lib')));
  app.use('/vendor/dompurify', express.static(path.join(pkgDir('dompurify'), 'dist')));
  app.use('/vendor/mermaid', express.static(path.join(pkgDir('mermaid'), 'dist')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const api = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  };
  const fail = (status, message) => Object.assign(new Error(message), { status });

  // `closing` while shutting down: it still answers until every agent is closed, then exits.
  api.get('/health', wrap(() => ({ ok: true, pid: process.pid, home: paths.home, claudeBin: config.claudeBin, closing })));
  api.get('/agents', wrap(() => manager.list()));
  api.get('/engines', wrap(() => listEngines(config)));
  api.post(
    '/agents',
    wrap((req) => {
      const { intents, intent, startedBy, ...opts } = req.body ?? {};
      if (opts.kind === 'assistant') throw fail(400, 'Start the assistant with POST /assistant/start');
      const list = (Array.isArray(intents) ? intents : [intent]).map((i) => String(i ?? '').trim()).filter(Boolean);
      // Agents the assistant's own session starts: its limits apply, and they are marked as its.
      const extra = assistant.admit(req.headers['x-agentmgr-agent'], list, opts);
      if (extra.startedBy) proposed.refuseSetAside(list);
      const created = manager.createMany(list, { ...opts, ...extra });
      if (!extra.startedBy) repeats.record(created.map((a) => ({ text: a.intent, projectKey: projectOf(store.get(a.id) ?? a).key })));
      if (extra.startedBy) {
        for (const a of created) notifier.send('assistant', a, `was started by the assistant: ${a.intent.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      return created;
    }),
  );
  api.post('/general', wrap((req) => manager.createGeneral(req.body ?? {})));
  api.get('/agents/:id/brief', wrap((req) => manager.briefFile(req.params.id)));
  // ?background=1 starts the work and returns at once (watch the agent's events for the result).
  const bg = (req) => req.query.background === '1' || req.body?.background === true;
  api.post('/agents/:id/explain', wrap((req) => (bg(req) ? manager.summarizeInBackground(req.params.id, ['explain']) : manager.explain(req.params.id))));
  api.post('/agents/:id/insights', wrap((req) => (bg(req) ? manager.summarizeInBackground(req.params.id, ['insights']) : manager.insights(req.params.id))));
  const DOC_LIST = ['analysis', 'design', 'flow', 'proposal', 'humanai'];
  api.post('/agents/:id/humanai/answers', wrap((req) => manager.humanAiAnswers(req.params.id, req.body?.answers, { send: req.body?.send === true })));
  api.post(
    '/agents/:id/docs/:kind',
    wrap((req) => {
      const kinds = req.params.kind === 'all' ? DOC_LIST : [req.params.kind];
      if (bg(req) || kinds.length > 1) return manager.summarizeInBackground(req.params.id, kinds);
      return manager.document(req.params.id, req.params.kind);
    }),
  );
  api.get('/agents/:id/specs/:name', wrap((req) => manager.specDoc(req.params.id, req.params.name)));
  // The agent's demo page, sandboxed: no access to this page's origin, and nothing loaded from elsewhere.
  api.get('/agents/:id/demo', (req, res) => {
    try {
      const html = manager.demoPage(req.params.id);
      res.set('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-modals; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:");
      res.set('X-Content-Type-Options', 'nosniff');
      res.type('html').send(html);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
  // All of an agent's documents to Google Drive (through the Claude account's Google Drive connector).
  api.post('/agents/:id/drive', wrap((req) => manager.publishToDrive(req.params.id)));
  api.post('/agents/:id/scorecard/post', wrap((req) => review.postScorecard(req.params.id)));
  // Improve: its scorecard goes back to the agent; a backlog item in review is reopened with it.
  api.post(
    '/agents/:id/scorecard/improve',
    wrap((req) => {
      const id = manager.mustGet(req.params.id).id;
      const it = backlog.items().find((i) => i.agentId === id && i.status === 'review');
      return manager.improve(id, it ? { send: (note) => backlog.reopen(it.id, { note }) } : {});
    }),
  );
  api.post('/agents/:id/plan', wrap((req) => manager.startPlanning(req.params.id)));
  api.post('/agents/:id/plan/approve', wrap((req) => manager.approvePlan(req.params.id, req.body?.note)));
  api.post('/agents/:id/plan/changes', wrap((req) => manager.requestPlanChanges(req.params.id, req.body?.note)));
  api.post('/agents/:id/plan/review', wrap((req) => manager.setPlanReview(req.params.id, req.body?.on === true)));
  api.post('/agents/:id/handoff', wrap((req) => manager.maybeHandoff(manager.mustGet(req.params.id).id, { force: true })));
  // ---------------------------------------------------------- studio: files and editor
  api.get('/agents/:id/files', wrap((req) => studio.list(req.params.id, req.query.dir ?? '')));
  api.post('/agents/:id/files', wrap((req) => studio.create(req.params.id, req.body?.path, req.body?.type)));
  api.post('/agents/:id/files/rename', wrap((req) => studio.rename(req.params.id, req.body?.from, req.body?.to)));
  api.get('/agents/:id/file', wrap((req) => studio.read(req.params.id, req.query.path)));
  api.put('/agents/:id/file', wrap((req) => studio.write(req.params.id, req.body?.path, req.body?.content, { mtimeMs: req.body?.mtimeMs ?? null, force: Boolean(req.body?.force) })));
  api.delete('/agents/:id/file', wrap((req) => studio.remove(req.params.id, req.query.path)));
  api.get('/agents/:id/file/original', wrap((req) => studio.original(req.params.id, req.query.path)));
  api.get('/agents/:id/search', wrap((req) => studio.search(req.params.id, req.query.q)));
  // Opening VS Code or Cursor happens on this computer, so only from it.
  api.get('/editors', wrap(() => studio.editors()));
  api.post('/agents/:id/open-in', wrap((req) => studio.openIn(req.params.id, req.body?.editor, req.body?.path ?? null)));
  // The machine terminal: shells in the home folder, not tied to an agent (Open Terminal).
  api.get('/machine/shells', wrap(() => ({ shells: manager.shellNumbers(MACHINE), home: os.homedir() })));
  api.post('/machine/shell/new', wrap(() => ({ n: manager.nextShellNumber(MACHINE) })));
  api.post('/machine/shell/close', wrap((req) => manager.closeShell(MACHINE, req.body?.n ? Number(req.body.n) : undefined)));
  api.post('/machine/shell/drop', wrap((req) => manager.dropShell(MACHINE, Number(req.body?.n) || 1)));
  api.post('/agents/:id/shell/close', wrap((req) => manager.closeShell(req.params.id, req.body?.n ? Number(req.body.n) : undefined)));
  api.post('/agents/:id/shell/new', wrap((req) => ({ n: manager.nextShellNumber(manager.mustGet(req.params.id).id) })));
  api.post('/agents/:id/shell/drop', wrap((req) => manager.dropShell(req.params.id, Number(req.body?.n) || 1)));
  // A file attached before its agent exists (New agents, Ask). Raw body, name in the query.
  api.post(
    '/uploads',
    express.raw({ type: () => true, limit: '50mb' }),
    wrap((req) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(400, 'Empty file');
      return manager.stageUpload(req.query.name, req.body);
    }),
  );
  // Raw file body; the name comes in the query. Returns the saved path to paste into a terminal.
  api.post(
    '/agents/:id/upload',
    express.raw({ type: () => true, limit: '50mb' }),
    wrap((req) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(400, 'Empty file');
      return manager.saveUpload(req.params.id, req.query.name, req.body);
    }),
  );
  api.get(
    '/agents/:id',
    wrap((req) => {
      const agent = manager.get(req.params.id);
      if (!agent) throw fail(404, `No agent matches "${req.params.id}"`);
      return agent;
    }),
  );
  api.patch('/agents/:id', wrap((req) => manager.update(req.params.id, req.body ?? {})));
  api.post('/agents/:id/browsers', wrap((req) => manager.addBrowser(req.params.id, req.body?.url, { mode: req.body?.mode })));
  api.patch(
    '/agents/:id/browsers/:n',
    wrap(async (req) => {
      const n = Number(req.params.n);
      const tab = manager.setBrowser(req.params.id, n, req.body?.url, { mode: req.body?.mode });
      // A live tab that is open goes there now; one that isn't opens there next time.
      if (req.body?.url !== undefined && live.tabs.has(live.key(req.params.id, n))) await live.navigate(req.params.id, n, tab.url).catch(() => {});
      return tab;
    }),
  );
  api.delete(
    '/agents/:id/browsers/:n',
    wrap(async (req) => {
      await live.close(req.params.id, Number(req.params.n));
      return manager.dropBrowser(req.params.id, Number(req.params.n));
    }),
  );

  // Live browser tabs: a real browser on this machine, streamed (see livebrowser.js).
  api.get('/browser', wrap(() => live.status()));
  const liveArgs = (req) => {
    const agent = manager.mustGet(req.params.id);
    const n = Number(req.params.n);
    if (!(agent.browsers ?? []).some((t) => t.n === n)) throw fail(404, `No browser tab ${n}`);
    return [agent.id, n];
  };
  api.post('/agents/:id/browsers/:n/live/input', wrap(async (req) => ({ ok: true, ...(await live.input(...liveArgs(req), req.body?.events)) })));
  api.post('/agents/:id/browsers/:n/live/resize', wrap(async (req) => (await live.resize(...liveArgs(req), req.body ?? {}), { ok: true })));
  api.post('/agents/:id/browsers/:n/live/go', wrap(async (req) => (await live.go(...liveArgs(req), String(req.body?.where ?? '')), { ok: true })));
  api.get('/agents/:id/browsers/:n/live/selection', wrap((req) => live.selection(...liveArgs(req))));
  api.get('/agents/:id/browsers/:n/live/stream', async (req, res) => {
    let args;
    try {
      args = liveArgs(req);
    } catch (err) {
      return res.status(err.status ?? 400).json({ error: err.message });
    }
    const tab = manager.mustGet(args[0]).browsers.find((t) => t.n === args[1]);
    const write = sse(req, res);
    // Frames are big: while the connection is backed up, keep only the newest and send it after.
    let held = null;
    res.on('drain', () => {
      if (held) write(held);
      held = null;
    });
    const client = {
      audio: req.query.audio === '1', // this viewer wants the page's sound
      send: (msg) => {
        if (msg.t === 'frame' && res.writableNeedDrain) held = msg;
        else write(msg);
      },
    };
    let detach = null;
    req.on('close', () => detach?.());
    try {
      const q = req.query;
      detach = await live.view(args[0], args[1], tab.url, client, q.width ? { width: q.width, height: q.height, mobile: q.mobile, scale: q.scale } : undefined);
      if (req.destroyed) detach();
    } catch (err) {
      write({ t: 'error', error: err.message });
      res.end();
    }
  });
  // Claude Code sessions started in a terminal, continued here.
  api.get('/sessions/scan', wrap((req) => manager.scanSessions({ days: req.query.days })));
  api.post('/sessions/import', wrap((req) => manager.importSessions(req.body?.sessions, { start: req.body?.start !== false, copy: Boolean(req.body?.copy) })));
  api.get('/agents/:id/local-urls', wrap((req) => manager.localUrls(req.params.id)));
  // A CLI's sign-in link: opened in a real browser window; its callback finished on this machine.
  api.post('/agents/:id/signin', wrap((req) => manager.addSignIn(req.params.id, req.body?.url)));
  api.post('/agents/:id/signin/finish', wrap((req) => manager.finishSignIn(req.params.id, req.body?.url)));
  api.post('/agents/:id/signin/dismiss', wrap((req) => manager.dismissSignIn(req.params.id)));
  // Where a browser tab loads an address: directly on this computer, through a relay from another device.
  api.post(
    '/preview',
    wrap(async (req) => {
      if (!req.remote) return { src: parseUrl(req.body?.url).href };
      return { src: await previews.frameUrl(req.body?.url, req.headers.host) };
    }),
  );

  api.delete(
    '/agents/:id',
    wrap((req) => manager.remove(req.params.id, { deleteWorkspace: req.query.deleteWorkspace === '1' })),
  );
  api.post('/agents/:id/start', wrap((req) => manager.start(req.params.id, req.body ?? {})));
  api.post('/agents/:id/stop', wrap((req) => manager.stop(req.params.id)));
  api.post('/agents/close-all', wrap((req) => manager.closeAll({ working: Boolean(req.body?.working) })));
  api.post('/agents/:id/reminder', wrap((req) => manager.remind(req.params.id, req.body?.action)));
  api.post('/agents/:id/desktop', wrap((req) => manager.openInDesktop(req.params.id)));
  api.post('/agents/:id/refresh', wrap((req) => manager.refresh(req.params.id, { withPrs: true })));
  api.post('/agents/:id/links', wrap((req) => manager.addLink(req.params.id, req.body ?? {})));
  api.delete('/agents/:id/links', wrap((req) => manager.removeLink(req.params.id, req.query)));
  api.post('/flush', wrap(() => manager.flush()));

  // ---------------------------------------------------------- Slack alerts (local only)
  const okUrl = (u) => /^https:\/\/[\w.-]+\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u);
  api.get('/notify', wrap(() => ({ ...publicNotify(), workflow: isWorkflowUrl(loadNotify().slack.webhookUrl), recent: notifier.log, judge: judgeAlerts() })));
  const judgeAlerts = () => (manager.judge.enabled ? { digestMin: manager.judge.settings.digestMin, pending: notifier.digest.length } : null);
  api.post(
    '/notify',
    wrap((req) => {
      const b = req.body ?? {};
      const slack = {};
      if (b.webhookUrl !== undefined) {
        if (b.webhookUrl && !okUrl(b.webhookUrl)) throw fail(400, 'The webhook URL must be https://…');
        slack.webhookUrl = b.webhookUrl || null;
      }
      if (b.botToken !== undefined) slack.botToken = b.botToken || null;
      if (b.channel !== undefined) slack.channel = b.channel || null;
      const patch = { slack };
      for (const k of ['enabled', 'skipWhenWatching', 'includeIntent']) if (typeof b[k] === 'boolean') patch[k] = b[k];
      for (const k of ['needsInputDelaySec', 'waitingDelaySec']) if (Number(b[k]) >= 0) patch[k] = Number(b[k]);
      if (b.events && typeof b.events === 'object') patch.events = b.events;
      const next = saveNotify(patch);
      // Configuring Slack for the first time turns alerts on.
      if (b.enabled === undefined && (slack.webhookUrl || (slack.botToken && (b.channel ?? next.slack.channel)))) saveNotify({ enabled: true });
      return { ...publicNotify(), recent: notifier.log };
    }),
  );
  api.post(
    '/notify/test',
    wrap(async () => {
      await sendSlack(':wave: Test from AI Agent Manager: alerts will arrive here when an agent needs you.', loadNotify());
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------- project shortcuts
  api.get('/projects', wrap(() => manager.listProjects()));
  api.post('/projects', wrap((req) => manager.addProject(req.body ?? {})));
  api.patch('/projects/:ref', wrap((req) => manager.updateProject(req.params.ref, req.body ?? {})));
  api.delete('/projects/:ref', wrap((req) => manager.removeProject(req.params.ref)));

  // ---------------------------------------------------------- backlog
  api.get('/backlog', wrap(() => backlog.view()));
  api.post(
    '/backlog',
    wrap((req) => {
      const { items, item, ...opts } = req.body ?? {};
      const added = backlog.add(Array.isArray(items) ? items : [item], opts);
      repeats.record(added.map((it) => ({ text: it.title, projectKey: it.projectKey })));
      return added;
    }),
  );
  // Everything waiting on the user: live prompts, agents' questions, stuck agents, overlaps.
  api.get('/inbox', wrap(() => manager.inbox()));
  // Approval rules learned from your answers (src/rules.js): allowed per repo, and suggestions.
  const ruleArgs = (req) => {
    const { repo, rule } = req.body ?? {};
    if (typeof repo !== 'string' || typeof rule !== 'string') throw Object.assign(new Error('repo and rule are required'), { status: 400 });
    return [repo, rule];
  };
  api.get('/rules', wrap(() => manager.rules.view()));
  api.post('/rules/accept', wrap((req) => (manager.rules.accept(...ruleArgs(req)), manager.applyRules(), manager.rules.view())));
  api.post('/rules/dismiss', wrap((req) => (manager.rules.dismiss(...ruleArgs(req)), manager.rules.view())));
  api.post('/rules/remove', wrap((req) => (manager.rules.remove(...ruleArgs(req)), manager.rules.view())));
  api.post('/agents/:id/tell', wrap((req) => manager.tell(req.params.id, req.body?.text)));
  api.post('/agents/:id/answer', wrap((req) => manager.answerQuestion(req.params.id, req.body?.question, req.body?.text)));
  api.post('/agents/:id/prompt-key', wrap((req) => manager.answerPrompt(req.params.id, String(req.body?.key ?? ''))));
  api.post('/agents/:id/stuck/dismiss', wrap((req) => manager.dismissStuck(req.params.id, req.body?.key)));
  api.post('/agents/:id/stuck/nudge', wrap((req) => manager.nudge(req.params.id, req.body?.key, req.body?.text)));
  // The AI judge: what it read on an idle screen, and its review of finished work.
  api.post('/agents/:id/conflicts/dismiss', wrap((req) => manager.dismissConflict(req.params.id, req.body?.with)));
  api.post('/agents/:id/waiting/answer', wrap((req) => manager.answerWaiting(req.params.id, req.body?.text)));
  api.post('/agents/:id/waiting/dismiss', wrap((req) => manager.dismissWaiting(req.params.id)));
  api.post('/agents/:id/review', wrap((req) => manager.requestReview(req.params.id, { force: true })));
  api.post('/agents/:id/review/ack', wrap((req) => manager.ackReview(req.params.id, req.body?.action)));
  api.get('/about', wrap(() => about({ port, config: { home: paths.home, claudeBin: config.claudeBin } })));
  api.get('/about/latest', wrap(() => latestRelease()));
  api.get('/me', wrap(async (req) => ({ ...(await identity()), remote: Boolean(req.remote) })));
  // Updating runs npm or git here and restarts the daemon, so only from this computer.
  api.get('/update', wrap(() => updates.status()));
  api.post('/update/check', wrap(async () => (await updates.refresh(), updates.status())));
  api.post('/update', wrap(() => updates.apply()));
  api.put(
    '/update',
    wrap((req) => {
      saveConfig({ updates: updates.setCheck(req.body?.check !== false) });
      return updates.status();
    }),
  );
  api.get('/judge', wrap(() => manager.judge.status()));
  // On or off for this daemon, kept in config.json. The judge spends calls on your own engine plan.
  api.put('/judge', wrap((req) => {
    const enabled = Boolean(req.body?.enabled);
    manager.config.judge = { ...manager.config.judge, enabled };
    saveConfig({ judge: { enabled } });
    return manager.judge.status();
  }));
  api.post('/agents/:id/conflicts/warn', wrap((req) => manager.warnConflict(req.params.id, req.body?.with)));
  api.post('/agents/:id/checkpoint', wrap(async (req) => {
    const id = manager.mustGet(req.params.id).id;
    manager.lastCheckpointTry?.delete(id); // on demand: skip the throttle
    await manager.checkpoint(id);
    return manager.get(id);
  }));
  api.get('/agents/:id/changes', wrap((req) => review.get(req.params.id)));
  api.post('/agents/:id/changes/comments', wrap((req) => review.comment(req.params.id, req.body ?? {})));
  api.post('/agents/:id/changes/commit', wrap((req) => review.commit(req.params.id, req.body ?? {})));
  api.post('/agents/:id/changes/pr', wrap((req) => review.pr(req.params.id, req.body ?? {})));
  // Done but no pull request: commit what's left, push and open one, titled after the issue or request.
  api.post('/agents/:id/ship', wrap(async (req) => {
    const a = manager.mustGet(req.params.id);
    const key = leadingJiraKey(a.intent);
    const words = a.synopsis?.text ?? a.brief?.title ?? String(a.intent ?? '').replace(/^<?https?:\/\/\S+>?\s*/, '').split('\n')[0];
    const title = String(req.body?.title ?? '').trim() || `${key ? `${key}: ` : ''}${words || a.name}`.slice(0, 100);
    try {
      await review.commit(a.id, { message: title });
    } catch (e) {
      if (e.status !== 409 || !/nothing to commit/i.test(e.message)) throw e;
    }
    const r = await review.pr(a.id, { title });
    await manager.refresh(a.id, { withPrs: true }).catch(() => {});
    return { url: r.url ?? null, title };
  }));
  api.post('/agents/:id/fork', wrap((req) => manager.fork(req.params.id, req.body ?? {})));

  api.get('/races', wrap(() => races.list()));
  // Attachments: copied once to a shared folder and listed in the request every attempt gets.
  const withFiles = ({ attachments, ...body } = {}) => ({ ...body, intent: manager.withSharedAttachments(body.intent, attachments) });
  api.post('/races', wrap((req) => races.create(withFiles(req.body ?? {}))));
  api.get('/races/:id', wrap((req) => races.view(req.params.id)));
  api.post('/races/:id/tests', wrap((req) => races.runTests(req.params.id, req.body ?? {})));
  api.get('/races/:id/diff/:agent', wrap((req) => races.diff(req.params.id, req.params.agent)));
  api.post('/races/:id/pick', wrap((req) => races.pick(req.params.id, req.body?.agent, { cleanup: Boolean(req.body?.cleanup) })));
  api.delete('/races/:id', wrap((req) => races.remove(req.params.id)));

  // Clean up old agents: the strategy and days (kept in config.json), what a run would do, run now.
  api.get('/assistant', wrap(() => assistant.status()));
  api.put('/assistant', wrap((req) => {
    const next = assistant.update(req.body ?? {});
    saveConfig({ assistant: next });
    return assistant.status();
  }));
  api.post('/assistant/start', wrap(() => assistant.start()));
  api.post('/assistant/pause', wrap(() => assistant.pause()));
  api.post('/assistant/check', wrap(() => assistant.check()));
  api.get('/triggers', wrap(() => triggers.view()));
  api.put('/triggers', wrap((req) => {
    const { saved, token } = triggers.update(req.body ?? {});
    saveConfig({ triggers: saved });
    return { ...triggers.view(), ...(token ? { token } : {}) };
  }));
  api.post('/triggers/poll', wrap(async () => ({ ...(await triggers.poll()), ...triggers.view() })));
  api.post('/hooks/agents', wrap((req) => triggers.hook(req.body ?? {})));
  api.get('/agents/:id/memory', wrap((req) => memory.read(req.params.id)));
  api.put('/agents/:id/memory', wrap((req) => memory.write(req.params.id, req.body?.text)));
  api.post('/agents/:id/learn', wrap((req) => memory.learn(req.params.id, req.body?.text, { by: req.headers['x-agentmgr-agent'] ? undefined : 'you' })));
  // The agent builder (agentkit agents built from a task, each developed in an agent session
  // working in its folder): build, change, test, run, package, download. Agents started here
  // report to this daemon (runs, cost, approvals).
  const sessions = {
    create: (opts) => manager.create({ ...opts, worktree: false }),
    get: (id) => {
      const a = manager.get(id);
      return a ? manager.view(a) : null;
    },
    tell: (id, text) => manager.tell(id, text),
    stop: (id) => manager.stop(id).catch(() => {}),
  };
  const builder = new Builder({ sessions, oneShot: (prompt) => manager.oneShot(null, prompt, { ...manager.writerFor({}), timeoutMs: 300_000 }), reportEnv: () => ({ AGENTKIT_REPORT_URL: `http://127.0.0.1:${port}`, AGENTKIT_REPORT_TOKEN: reports.reportToken() }) });
  api.post('/agentkit/report', wrap((req) => reports.report(req.body ?? {})));
  api.get('/agentkit/agents', wrap(() => reports.list()));
  api.post('/agentkit/agents/:key/approvals/:id', wrap((req) => reports.decide(req.params.key, req.params.id, req.body?.allow === true, req.device ? `${req.device.name ?? 'a signed-in device'}` : 'you')));
  api.delete('/agentkit/agents/:key', wrap((req) => reports.forget(req.params.key)));
  // What an agent elsewhere needs to report here (this computer only: it shows the token).
  api.get('/agentkit/connect', wrap(() => ({ token: reports.reportToken(), local: `http://127.0.0.1:${port}`, remote: remoteServer ? remote.remoteUrls(remotePort).map((u) => u.url) : [], cert: remoteServer ? remote.certificateFingerprint() : null })));
  api.get('/builder', wrap(() => builder.list()));
  api.post('/builder', wrap((req) => builder.design({ task: req.body?.task, engine: req.body?.engine || 'claude', name: req.body?.name || undefined, attachments: req.body?.attachments, permissionMode: req.body?.permissionMode || undefined, model: req.body?.model || undefined })));
  api.post('/builder/:name/change', wrap((req) => builder.change(req.params.name, req.body?.text)));
  api.get('/builder/:name', wrap((req) => builder.view(req.params.name)));
  api.put('/builder/:name', wrap((req) => builder.update(req.params.name, req.body ?? {})));
  api.post('/builder/:name/test', wrap((req) => {
    builder.test(req.params.name).catch(() => {}); // in the background; the view says when it's done
    return new Promise((r) => setTimeout(() => r(builder.view(req.params.name)), 50));
  }));
  api.post('/builder/:name/package', wrap((req) => {
    builder.package(req.params.name, req.body?.platform || undefined).catch(() => {}); // checks first, then builds in the background
    return new Promise((r) => setTimeout(() => r(builder.view(req.params.name)), 50));
  }));
  api.get('/builder/:name/executable/:platform', (req, res) => {
    let file;
    try {
      file = builder.executable(req.params.name, req.params.platform);
    } catch (e) {
      return res.status(e.status ?? 500).json({ error: e.message });
    }
    res.download(file, path.basename(file));
  });
  api.post('/builder/:name/start', wrap((req) => builder.start(req.params.name)));
  api.post('/builder/:name/stop', wrap((req) => builder.stop(req.params.name)));
  api.delete('/builder/:name', wrap((req) => builder.remove(req.params.name)));
  // The agent's folder as a .tar.gz (its own files; not its runs, memory or log).
  api.get('/builder/:name/download', (req, res) => {
    let dir;
    try {
      dir = builder.view(req.params.name).dir;
    } catch (e) {
      return res.status(e.status ?? 500).json({ error: e.message });
    }
    res.setHeader('content-type', 'application/gzip');
    res.setHeader('content-disposition', `attachment; filename="${req.params.name}.tar.gz"`);
    const tar = spawn('tar', ['-czf', '-', '--exclude', '.agentkit', '--exclude', 'agent.log', '--exclude', 'build.json', '--exclude', 'work', '--exclude', 'dist', '-C', path.dirname(dir), path.basename(dir)]);
    tar.stdout.pipe(res);
    tar.on('error', () => res.end());
  });
  // Isolation: Docker, the agent image, the Claude token for containers, and the default for new agents.
  let buildError = null;
  const isolationView = async () => ({ ...(await dockerStatus(config)), building: isBuilding(), buildError, hasClaudeToken: Boolean(claudeToken()), engines: [...CONTAINER_ENGINES], default: config.isolation?.default ?? null });
  api.get('/isolation', wrap(isolationView));
  api.post(
    '/isolation/build',
    wrap(async () => {
      buildError = null;
      buildImage(config).catch((err) => (buildError = err.message));
      return isolationView();
    }),
  );
  api.put('/isolation/token', wrap(async (req) => (saveSecrets({ claudeOauthToken: String(req.body?.token ?? '').trim() || null }), isolationView())));
  api.put(
    '/isolation/default',
    wrap(async (req) => {
      const value = req.body?.container ? 'container' : null;
      config.isolation = { ...config.isolation, default: value };
      saveConfig({ isolation: config.isolation });
      return isolationView();
    }),
  );
  // Jira: the site and API token used to show an issue's summary for agents created from its link.
  api.get('/jira', wrap(() => jiraView()));
  // Whether the saved settings work: how many open issues are yours, or why Jira can't be used.
  api.get(
    '/jira/check',
    wrap(async () => {
      const view = jiraView();
      if (!view.site || !view.hasToken) return { assigned: null, problem: 'Add the site and API token first' };
      const mine = await assignedIssues({ timeoutMs: 8000 });
      return { assigned: mine ? mine.length : null, problem: mine ? null : jiraProblem()?.reason ?? 'Jira could not be reached' };
    }),
  );
  api.put(
    '/jira',
    wrap(async (req) => {
      const view = saveJira(req.body ?? {});
      // Agents already created from links get their summaries now (in the background).
      manager.refreshSynopses().catch(() => {});
      // Tried at once, so Settings can say whether it works: how many issues are yours, or why not.
      const mine = view.site && view.hasToken ? await assignedIssues({ timeoutMs: 8000 }) : null;
      return { ...view, assigned: mine ? mine.length : null, problem: view.site && view.hasToken && !mine ? jiraProblem()?.reason ?? 'Jira could not be reached' : null };
    }),
  );
  // Start at login: the login service (launchd or systemd) that brings the daemon back after a reboot.
  const serviceSupported = ['darwin', 'linux'].includes(process.platform);
  const serviceView = async () => ({ supported: serviceSupported, ...(serviceSupported ? await service.status().catch(() => ({ installed: false, loaded: false })) : { installed: false, loaded: false }) });
  api.get('/service', wrap(serviceView));
  api.put(
    '/service',
    wrap(async (req) => {
      if (!serviceSupported) throw fail(400, `Start at login isn't supported on ${process.platform}`);
      // Installing loads it; its own copy finds this daemon running and exits cleanly (no restart),
      // so it takes over at the next login.
      const res = req.body?.enabled === true ? await service.install() : await service.uninstall();
      return { ...(await serviceView()), note: res.note ?? null };
    }),
  );
  // The first-run checklist: what is set up, and what this machine is missing.
  api.get('/setup', wrap(async () => {
    const checks = (await doctor().catch(() => [])).filter((c) => c.status === 'fail' || c.status === 'warn').filter((c) => c.name !== 'Daemon');
    const agentsNow = store.list();
    return {
      checks,
      steps: {
        agent: agentsNow.some((a) => !NO_REPO_KINDS.has(a.kind)),
        alerts: Boolean(loadNotify().enabled),
        assistant: agentsNow.some((a) => a.kind === 'assistant') || Boolean(config.triggers?.github?.enabled || config.triggers?.webhook?.enabled),
        remote: Boolean(remote.loadSettings().enabled),
        budget: Boolean(config.budgets?.perAgentUsd || config.budgets?.perDayUsd),
        // Only where it can be set up (macOS, Linux); elsewhere there's nothing to do.
        service: serviceSupported ? Boolean((await service.status().catch(() => ({}))).installed) : true,
      },
    };
  }));
  api.get('/playbooks', wrap(() => playbooks.list()));
  // Saving a playbook can answer a repeated-request suggestion.
  const withRepeats = (fn) => (req) => {
    const out = fn(req);
    repeats.changed();
    return out;
  };
  api.post('/playbooks', wrap(withRepeats((req) => playbooks.create(req.body ?? {}))));
  api.put('/playbooks/:id', wrap(withRepeats((req) => playbooks.update(req.params.id, req.body ?? {}))));
  api.delete('/playbooks/:id', wrap(withRepeats((req) => playbooks.remove(req.params.id))));
  api.get('/repeats', wrap(() => repeats.view()));
  api.post('/repeats/dismiss', wrap((req) => repeats.dismiss(String(req.body?.key ?? ''))));
  api.post('/playbooks/:id/run', wrap((req) => playbooks.run(req.params.id, { vars: req.body?.vars ?? {} })));
  api.get('/worklog', wrap(async (req) => (await worklog.record(), worklog.view({ days: Number(req.query.days ?? 30) || 0 }))));
  api.get('/worklog/summary', wrap(async (req) => {
    await worklog.record();
    return { markdown: summaryMarkdown(worklog.view({ days: Number(req.query.days ?? 30) || 0 }), { who: await me }) };
  }));
  for (const [name, which] of [['worklog.csv', 'events'], ['worklog-weekly.csv', 'weekly']]) {
    api.get(`/worklog/${name}`, async (req, res) => {
      await worklog.record().catch(() => {});
      const file = worklog.files[which];
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'Nothing recorded yet' });
      res.download(file, name);
    });
  }
  api.get('/stats', wrap((req) => {
    const days = req.query.days === undefined ? 30 : Math.max(0, Math.min(3650, Math.floor(Number(req.query.days)) || 0));
    return stats(store.list(), { days, projectOf: (a) => manager.projectInfo(a)?.name ?? null });
  }));
  // ?layer=bugs adds where the bug hunts found bugs: heat per folder, and the paths through the code.
  api.get('/codemap', wrap((req) => manager.codeMap(req.query.project ? String(req.query.project) : null, { bugs: req.query.layer === 'bugs' ? { findings: hunts.findings, hunts: hunts.hunts } : null, speed: req.query.layer === 'speed' ? benches : null })));
  // Modules to benchmark, and what their benchmarks found (benchmarks.js).
  api.post('/benchmodules', wrap((req) => benches.watch(req.body ?? {})));
  api.delete('/benchmodules/:id', wrap((req) => benches.unwatch(req.params.id)));
  api.post('/benchruns/:id/accept', wrap((req) => benches.accept(req.params.id, req.body?.accepted !== false)));
  api.post('/benchruns/:id/fix', wrap((req) => benches.askToFix(req.params.id)));
  api.get('/agents/:id/eval', wrap(async (req) => (manager.mustGet(req.params.id).eval ? evals.view(manager.mustGet(req.params.id).id) : evals.compute(manager.mustGet(req.params.id).id))));
  api.post('/agents/:id/eval', wrap((req) => evals.compute(manager.mustGet(req.params.id).id)));
  api.post('/agents/:id/eval/verify', wrap(async (req) => {
    const a = manager.mustGet(req.params.id);
    // Answered at once; the run's result comes with the agent's next update.
    evals.verify(a.id).catch((e) => console.log(`[agentmgr] eval: ${e.message}`));
    return { started: true };
  }));
  api.put('/agents/:id/eval/command', wrap((req) => evals.setTestCommand(req.params.id, req.body?.command)));
  api.post('/agents/:id/eval/gaps', wrap((req) => evals.closeGaps(req.params.id)));
  api.post('/agents/:id/eval/seen', wrap((req) => evals.seen(req.params.id, req.body?.seen !== false)));
  api.post('/agents/:id/eval/post', wrap((req) => review.postEval(req.params.id, evals.view(manager.mustGet(req.params.id).id)?.markdown)));
  // Issues agents work on, for the summary; ?group=you|agent|done and ?format=markdown to paste.
  api.get('/issues', wrap(async (req) => {
    // ?fresh=1 (the ↻ button) asks Jira again: the issues assigned to you and each issue's status.
    if (req.query.fresh === '1') {
      manager.assignedAt = 0;
      manager.jiraCache?.clear();
    }
    manager.jiraOff = !featuresOf(config).jira;
    const v = await manager.issues(proposed.listed(), proposed.actions);
    const group = req.query.group ? String(req.query.group) : null;
    // "all" is everything still on the list: removed ones only when asked for.
    const rows = !group ? v.rows : group === 'all' ? v.rows.filter((r) => r.group !== 'removed') : v.rows.filter((r) => r.group === group);
    return req.query.format === 'markdown' ? { markdown: issuesMarkdown(rows) } : { ...v, rows };
  }));
  // Issues proposed for agents (the assistant, when you pick): start the ticked ones, or dismiss them.
  api.post('/issues/proposed', wrap((req) => proposed.add({ ...req.body, by: req.headers['x-agentmgr-agent'] ? 'assistant' : 'you' })));
  api.post('/issues/start', wrap((req) => proposed.start(Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [])));
  api.post('/issues/dismiss', wrap((req) => proposed.dismiss(Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [])));
  // My actions: what's asked of you in Slack and meeting notes (the assistant adds them).
  api.get('/actions', wrap(() => ({ rows: myActions.rows(), features: featuresOf(config) })));
  api.post('/actions', wrap((req) => myActions.add({ ...req.body, by: req.headers['x-agentmgr-agent'] ? 'assistant' : 'you' })));
  api.post('/actions/set', wrap((req) => myActions.set(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [], String(req.body?.state ?? ''), { project: req.body?.project ?? null, until: req.body?.until ?? null })));
  // The draft answer to a question: the assistant's (from its session) or yours, edited.
  api.put('/actions/:id/answer', wrap((req) => myActions.answer(req.params.id, { text: req.body?.text, sources: req.body?.sources ?? null, by: req.headers['x-agentmgr-agent'] ? 'assistant' : 'you' })));
  // A session that researches the question and records a draft answer.
  api.post('/actions/:id/draft', wrap((req) => myActions.draft(req.params.id, `node ${JSON.stringify(path.join(__dirname, '..', 'bin', 'agentmgr.js'))}`, manager.listProjects().map((p) => ({ name: p.name ?? p.shortcut, dir: p.dir ?? null, repo: p.repo ?? null })))));
  api.post('/actions/:id/discuss', wrap((req) => myActions.discuss(req.params.id, `node ${JSON.stringify(path.join(__dirname, '..', 'bin', 'agentmgr.js'))}`)));
  // The parts you use: Jira, Slack, meeting notes. Off hides its list and the assistant skips it.
  api.get('/features', wrap(() => ({ features: featuresOf(config), me: assistant.settings.me })));
  api.put('/features', wrap((req) => {
    const next = {};
    for (const k of Object.keys(FEATURES)) if (typeof req.body?.features?.[k] === 'boolean') next[k] = req.body.features[k];
    config.features = { ...config.features, ...next };
    saveConfig({ features: config.features });
    if (typeof req.body?.me === 'string') saveConfig({ assistant: assistant.update({ me: req.body.me.trim() }) });
    return { features: featuresOf(config), me: assistant.settings.me };
  }));
  // Your action on issues: assign (starts an agent from the proposal), skip, done, remove, or null to clear.
  api.post('/issues/action', wrap((req) => proposed.setAction(Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [], req.body?.action ?? null, { until: req.body?.until ?? null })));
  // Design docs of all agents; the same ?group= and ?format=markdown.
  api.get('/designs', wrap((req) => {
    const v = manager.designs();
    const group = req.query.group ? String(req.query.group) : null;
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const rows = v.rows
      .filter((r) => !group || group === 'all' || r.group === group)
      .filter((r) => !q || [r.title, r.summary, r.agent.name, r.agent.project, r.issue?.key].some((s) => String(s ?? '').toLowerCase().includes(q)));
    return req.query.format === 'markdown' ? { markdown: designsMarkdown(rows) } : { rows };
  }));
  // Reviews: reviewer agents on other people's PRs, and PRs where your review is requested.
  api.get('/reviews', wrap(async (req) => {
    const rows = await reviews.rows({ fresh: req.query.fresh === '1' });
    return req.query.format === 'markdown' ? { markdown: rows.filter((r) => r.agent).map(reviewMarkdown).join('\n\n---\n\n') || 'No reviews.' } : { rows };
  }));
  api.post('/reviews', wrap((req) => {
    // Started by the assistant's own session: its limits apply, and it's marked as its.
    const extra = assistant.admit(req.headers['x-agentmgr-agent'], [String(req.body?.url ?? '')]);
    return reviews.start({ url: req.body?.url, project: req.body?.project, notes: req.body?.notes, startedBy: extra.startedBy ?? null });
  }));
  api.post('/reviews/dismiss', wrap((req) => reviews.dismiss(Array.isArray(req.body?.urls) ? req.body.urls.map(String) : [])));
  api.get('/reviews/:id', wrap((req) => {
    const row = reviews.row(req.params.id);
    return { ...row, markdown: reviewMarkdown(row), draft: row.review ? reviewDraft(row.review) : null };
  }));
  api.post('/reviews/:id/post', wrap((req) => reviews.post(req.params.id, { ids: Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null })));
  // Value: totals by period, items with estimates you can correct, reports.
  api.get('/value', wrap((req) => value.view({ period: String(req.query.period ?? 'week') })));
  api.put('/value', wrap((req) => {
    const next = value.update(req.body ?? {});
    saveConfig({ value: next });
    return value.view({ period: String(req.query.period ?? 'week') });
  }));
  api.patch('/value/items/:id', wrap((req) => value.edit(req.params.id, req.body ?? {})));
  api.post('/value/items/:id/estimate', wrap((req) => value.estimate(req.params.id).then((it) => value.itemView(it))));
  api.post('/value/items/:id/exclude', wrap((req) => value.exclude(req.params.id, req.body?.excluded !== false)));
  api.get('/value/report', wrap((req) => value.report(String(req.query.kind ?? 'week'), { current: req.query.current === '1' })));
  api.post('/value/report', wrap((req) => value.sendReport(String(req.body?.kind ?? 'week'), { current: req.body?.current === true })));
  api.get('/value/value.csv', (req, res) => {
    try {
      res.download(value.writeCsv(), 'value.csv');
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  // Today: what needs you, from every list, most pressing first (today.js). A list that's off or
  // can't be had right now is left out, and said so.
  api.get('/today', wrap(async (req) => {
    const f = featuresOf(config);
    // ?fresh=1 (↻ or r) asks Jira again rather than using what was fetched in the last few minutes.
    if (req.query.fresh === '1') {
      manager.assignedAt = 0;
      manager.jiraCache?.clear();
    }
    manager.jiraOff = !f.jira;
    const errors = [];
    const got = async (name, fn) => {
      try {
        return await fn();
      } catch (e) {
        errors.push({ source: name, error: e.message });
        return [];
      }
    };
    const [inbox, issues, actions, prs] = await Promise.all([
      got('inbox', () => manager.inbox()),
      f.jira
        ? got('jira', async () => {
            const v = await manager.issues(proposed.listed(), proposed.actions);
            if (v.jira.problem) errors.push({ source: 'jira', error: v.jira.problem });
            return v.rows;
          })
        : [],
      f.slack || f.gemini ? got('actions', () => myActions.rows()) : [],
      got('reviews', () => reviews.rows()),
    ]);
    const findings = hunts.list().findings.filter((x) => x.status === 'open' || x.status === 'pr');
    const items = todayItems({ inbox, issues, actions, reviews: prs, findings, slower: benches.slower(), unsure: evals.unsure().map((a) => ({ id: a.id, name: a.name, issue: manager.issueKey(a), confidence: a.eval.confidence, pending: a.eval.pending, at: a.eval.at })) });
    return { items, aside: todayAside({ issues, actions }), speech: todaySpeech(items), features: f, errors };
  }));
  // Support tickets: kept on this computer, each with a filled-in link to a new GitHub issue.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const support = new Support({
    issuesUrl: pkg.bugs?.url ?? 'https://github.com/jdmunta/ai-agentmanager-core/issues',
    about: () => ({ version: pkgVersion, features: featuresOf(config), agents: store.list().length }),
  });
  api.get('/support', wrap(() => ({ tickets: support.list() })));
  api.post('/support', wrap((req) => support.create({ ...req.body, browser: req.headers['user-agent'] ?? null })));
  // The screenshot comes as the image itself (not JSON): up to 10 MB.
  api.put('/support/:id/screenshot', express.raw({ type: 'image/*', limit: '10mb' }), wrap((req) => support.addScreenshot(req.params.id, req.body, req.headers['content-type'])));
  api.get('/support/:id/screenshot', (req, res) => {
    try {
      const { file, type } = support.screenshot(req.params.id);
      res.type(type).sendFile(file);
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });
  // Bug hunts and what they found.
  api.get('/hunts', wrap(async () => {
    await hunts.sweep();
    return hunts.list();
  }));
  api.post('/hunts', wrap((req) => hunts.add(req.body ?? {})));
  api.put('/hunts/:id', wrap((req) => hunts.update(req.params.id, req.body ?? {})));
  api.delete('/hunts/:id', wrap((req) => hunts.remove(req.params.id)));
  api.post('/hunts/:id/run', wrap((req) => hunts.run(req.params.id)));
  api.post('/findings/set', wrap((req) => hunts.set(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [], req.body?.status, { until: req.body?.until ?? null })));
  api.post('/findings/:id/fix', wrap((req) => hunts.fix(req.params.id)));
  api.get('/findings/:id/issue', wrap((req) => hunts.issue(req.params.id)));
  api.get('/standup', wrap(() => standup.view()));
  api.post('/standup', wrap(async () => ({ ...standup.view(), latest: await standup.make({ reason: 'asked' }) })));
  api.put('/standup', wrap((req) => {
    const next = standup.update(req.body ?? {});
    saveConfig({ standup: next.settings });
    return next;
  }));
  api.get('/budgets', wrap(() => budgets.status()));
  api.put('/budgets', wrap((req) => {
    const next = budgets.update(req.body ?? {});
    saveConfig({ budgets: next });
    return budgets.status();
  }));
  api.get('/landing', wrap(() => landing.list()));
  api.put('/landing', wrap((req) => {
    const next = landing.update(req.body ?? {});
    saveConfig({ landing: next });
    return landing.list();
  }));
  api.post('/agents/:id/land/update', wrap((req) => landing.updateBranch(req.params.id, req.body ?? {})));
  api.post('/agents/:id/land/fix', wrap((req) => landing.fix(req.params.id, req.body ?? {})));
  api.post('/agents/:id/land/merge', wrap((req) => landing.merge(req.params.id, req.body ?? {})));
  api.get('/cleanup', wrap(() => cleanup.status()));
  api.put('/cleanup', wrap(async (req) => {
    const next = cleanup.update(req.body ?? {});
    saveConfig({ cleanup: next });
    return cleanup.status();
  }));
  api.post('/cleanup/run', wrap(async (req) => {
    const b = req.body ?? {};
    return cleanup.run({ close: b.close !== false, delete: b.delete !== false, ids: Array.isArray(b.ids) ? b.ids : null });
  }));
  api.get('/teams', wrap(() => teams.list()));
  api.post('/teams', wrap((req) => teams.create(withFiles(req.body ?? {}))));
  api.get('/teams/:id', wrap((req) => teams.view(req.params.id)));
  api.get('/teams/:id/files/:name', wrap((req) => teams.file(req.params.id, req.params.name)));
  api.post('/teams/:id/resume', wrap((req) => teams.resume(req.params.id, req.body ?? {})));
  api.post('/teams/:id/send-back', wrap((req) => teams.sendBack(req.params.id, req.body?.note)));
  api.post('/teams/:id/fix-gaps', wrap((req) => teams.fixGaps(req.params.id, req.body?.note)));
  api.post('/teams/:id/finalize', wrap((req) => teams.finalize(req.params.id, { mode: req.body?.mode, pr: req.body?.pr })));
  api.post('/teams/:id/stop', wrap((req) => teams.stop(req.params.id)));
  api.post('/teams/:id/ask', wrap((req) => teams.ask(req.params.id, req.body?.text)));
  api.delete('/teams/:id', wrap((req) => teams.remove(req.params.id, { agents: req.query.agents === '1' })));

  api.post('/backlog/settings', wrap((req) => backlog.settings(req.body ?? {})));
  api.patch('/backlog/:id', wrap((req) => backlog.update(req.params.id, req.body ?? {})));
  api.delete('/backlog/:id', wrap((req) => backlog.remove(req.params.id)));
  api.post('/backlog/:id/start', wrap((req) => backlog.start(req.params.id)));
  api.post('/backlog/:id/accept', wrap((req) => backlog.accept(req.params.id)));
  api.post('/backlog/:id/reopen', wrap((req) => backlog.reopen(req.params.id, req.body ?? {})));
  api.post('/backlog/:id/cancel', wrap((req) => backlog.cancel(req.params.id)));
  api.post('/backlog/:id/move', wrap((req) => backlog.move(req.params.id, req.body?.where)));
  api.post('/backlog/:id/split', wrap((req) => backlog.split(req.params.id, req.body?.parts)));
  api.post('/backlog/:id/keep-whole', wrap((req) => backlog.keepWhole(req.params.id)));
  api.get('/goals', wrap(() => goals.list()));
  api.post('/goals', wrap((req) => goals.create(req.body ?? {})));
  api.post('/goals/:id/approve', wrap((req) => goals.approve(req.params.id, req.body ?? {})));
  api.post('/goals/:id/replan', wrap((req) => goals.replan(req.params.id)));
  api.post('/goals/:id/extend', wrap((req) => goals.extend(req.params.id)));
  api.post('/goals/:id/stop', wrap((req) => goals.stop(req.params.id)));
  api.delete('/goals/:id', wrap((req) => goals.remove(req.params.id)));
  api.get('/goals/:id/summary', wrap((req) => ({ markdown: goalMarkdown(goals.view(goals.get(req.params.id))) })));
  api.post('/backlog/:id/ship', wrap((req) => autopilot.shipNow(req.params.id)));
  api.post(
    '/shutdown',
    wrap(() => {
      setTimeout(() => shutdown('api'), 50);
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------- hub link (local only)
  api.get('/hub', wrap(() => hubLink.status()));
  api.post('/hub/join', wrap((req) => hubLink.join(req.body?.url, req.body?.code, req.body?.name)));
  api.post('/hub/leave', wrap(() => hubLink.leave()));

  // ---------------------------------------------------------- sessions (remote sign-in)

  api.get('/session', wrap((req) => ({ remote: Boolean(req.remote), authenticated: !req.remote || Boolean(
    remote.checkSession(remote.parseCookies(req.headers.cookie)[remote.SESSION_COOKIE]),
  ) })));
  api.post(
    '/login',
    wrap((req, res) => {
      if (!req.remote) return { ok: true };
      const ip = req.socket.remoteAddress;
      if (!remote.loginAllowed(ip)) throw fail(429, 'Too many attempts; try again in 15 minutes');
      const ticket = req.body?.ticket !== undefined;
      if (ticket ? !remote.useTicket(req.body.ticket) : !remote.checkToken(req.body?.token)) {
        remote.loginFailed(ip);
        throw fail(401, ticket ? 'That sign-in link was used or has expired; open it from the hub again' : 'Wrong or expired access token');
      }
      const { secret, maxAgeSec } = remote.createSession({ ua: req.headers['user-agent'], ip, via: ticket ? 'hub' : undefined });
      res.setHeader(
        'Set-Cookie',
        `${remote.SESSION_COOKIE}=${secret}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`,
      );
      return { ok: true };
    }),
  );
  api.post(
    '/logout',
    wrap((req, res) => {
      remote.endSession(remote.parseCookies(req.headers.cookie)[remote.SESSION_COOKIE]);
      res.setHeader('Set-Cookie', `${remote.SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------- remote access management (local only)

  const remoteStatus = async () => {
    const settings = remote.loadSettings();
    const urls = remote.remoteUrls(settings.port);
    return {
      ...settings,
      running: Boolean(remoteServer),
      fingerprint: remote.certificateFingerprint(),
      hostname: remote.localHostname(),
      urls: await Promise.all(
        urls.map(async (u) => ({ ...u, loginUrl: remote.loginLink(u.url), qr: await remote.qrSvg(remote.loginLink(u.url)) })),
      ),
      devices: remote.listSessions(),
    };
  };
  api.get('/remote', wrap(remoteStatus));
  api.post(
    '/remote/enable',
    wrap(async (req) => {
      const p = Number(req.body?.port) || remote.loadSettings().port;
      remote.saveSettings({ enabled: true, port: p });
      await startRemote();
      return remoteStatus();
    }),
  );
  api.post(
    '/remote/disable',
    wrap(async () => {
      remote.saveSettings({ enabled: false });
      await stopRemote();
      return remoteStatus();
    }),
  );
  api.post(
    '/remote/rotate',
    wrap(() => {
      remote.rotateToken();
      return remoteStatus();
    }),
  );
  api.delete(
    '/remote/devices/:id',
    wrap((req) => {
      remote.revokeSession(req.params.id);
      return remoteStatus();
    }),
  );

  // ---------------------------------------------------------- streaming over plain HTTP (SSE)
  // iOS Safari applies an accepted self-signed certificate to pages and fetches but not to
  // WebSockets, so the phone UI streams with Server-Sent Events and sends input with POSTs.

  const sse = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => clearInterval(ping));
    return (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  };

  const eventSinks = new Set();
  api.get('/events/stream', (req, res) => {
    const send = sse(req, res);
    send({ t: 'snapshot', agents: manager.list(), backlog: backlog.view(), goals: goals.list(), projects: manager.listProjects(), races: races.list(), teams: teams.list(), built: reports.list() });
    eventSinks.add(send);
    req.on('close', () => eventSinks.delete(send));
  });

  const termKind = (q) => (shellNumber(q) ? `shell:${shellNumber(q)}` : 'claude');
  // The machine terminal (Open Terminal) has no agent: its shells live under MACHINE.
  const termAgent = (id) => (id === MACHINE ? { id: MACHINE } : manager.mustGet(id));
  const attachTerm = (id, kind, client) =>
    shellNumber(kind) ? manager.attachShell(id, client, shellNumber(kind)) : manager.attach(id, client);
  api.get('/agents/:id/term/stream', (req, res) => {
    let agent;
    const kind = termKind(req.query.kind);
    try {
      agent = termAgent(req.params.id);
      if (agent.id === MACHINE) manager.plugins.check('terminal.open', { agent: null, kind: 'machine' });
      else manager.plugins.check('terminal.open', { agent: manager.auditView(agent), kind });
    } catch (err) {
      return res.status(err.status || 404).json({ error: err.message });
    }
    const send = sse(req, res);
    // Batch output so a busy terminal is a few events per second, not one per chunk.
    let pending = '';
    let timer = null;
    const flush = () => {
      timer = null;
      if (pending) send({ t: 'o', d: pending });
      pending = '';
    };
    const client = {
      send: (msg) => {
        if (msg.t === 'o') {
          pending += msg.d;
          timer ??= setTimeout(flush, 30);
        } else {
          flush();
          send(msg);
        }
      },
      close: () => res.end(),
    };
    let session;
    try {
      session = attachTerm(agent.id, kind, client);
    } catch (err) {
      send({ t: 'error', error: err.message });
      return res.end();
    }
    send({ t: 'hello', id: agent.id, kind, running: session.running, backlog: session.backlog, cols: session.cols, rows: session.rows });
    req.on('close', () => {
      clearTimeout(timer);
      session.detach();
    });
  });
  api.post(
    '/agents/:id/term/input',
    wrap((req) => {
      const agent = termAgent(req.params.id);
      if (typeof req.body?.d !== 'string') throw fail(400, 'd (string) is required');
      manager.write(agent.id, req.body.d, termKind(req.body.kind));
      return { ok: true };
    }),
  );
  api.post(
    '/agents/:id/term/resize',
    wrap((req) => {
      const agent = termAgent(req.params.id);
      manager.resize(agent.id, req.body?.cols | 0, req.body?.rows | 0, termKind(req.body?.kind));
      return { ok: true };
    }),
  );
  plugins.mount(api, express); // /api/ext/<plugin>, behind the same checks
  app.use('/api', api);

  // ---------------------------------------------------------- WebSockets (local UI and CLI)

  const wss = new WebSocketServer({ noServer: true });
  const onUpgrade = (isRemote) => (req, socket, head) => {
    req.remote = isRemote;
    if (denied(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };

  const eventClients = new Set();
  const broadcast = (msg) => {
    const raw = JSON.stringify(msg);
    for (const ws of eventClients) ws.send(raw);
    for (const send of eventSinks) send(msg);
  };
  manager.on('change', (agent) => broadcast({ t: 'agent', agent }));
  pushStandup = (latest) => broadcast({ t: 'standup', latest });
  pushValue = () => broadcast({ t: 'value' });
  reports.on('change', () => broadcast({ t: 'built', reports: reports.list() }));
  manager.rules.on('change', (rules) => broadcast({ t: 'rules', rules }));
  repeats.on('change', (view) => broadcast({ t: 'repeats', repeats: view }));
  manager.on('removed', (id) => {
    broadcast({ t: 'removed', id });
    live.closeAgent(id).catch(() => {});
  });
  backlog.on('change', (view) => broadcast({ t: 'backlog', backlog: view }));
  // Goals' summaries follow their tasks and agents: sent at most every couple of seconds.
  let goalsSoon = null;
  const sendGoals = () => {
    if (goalsSoon) return;
    goalsSoon = setTimeout(() => {
      goalsSoon = null;
      broadcast({ t: 'goals', goals: goals.list() });
    }, 2000);
    goalsSoon.unref?.();
  };
  goals.on('change', sendGoals);
  backlog.on('change', sendGoals);
  manager.on('change', () => Object.values(goals.data).some((g) => g.status === 'running') && sendGoals());
  const raceTimers = new Map();
  races.on('change', (id) => {
    if (raceTimers.has(id)) return;
    raceTimers.set(id, setTimeout(() => {
      raceTimers.delete(id);
      try {
        broadcast({ t: 'race', race: races.view(id) });
      } catch {}
    }, 300));
  });
  races.on('removed', (id) => broadcast({ t: 'race-removed', id }));
  const teamTimers = new Map();
  teams.on('change', (id) => {
    if (teamTimers.has(id)) return;
    teamTimers.set(id, setTimeout(() => {
      teamTimers.delete(id);
      try {
        broadcast({ t: 'team', team: teams.view(id) });
      } catch {}
    }, 300));
  });
  teams.on('removed', (id) => broadcast({ t: 'team-removed', id }));
  manager.on('projects', (projects) => {
    broadcast({ t: 'projects', projects });
    broadcast({ t: 'backlog', backlog: backlog.view() });
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/ws/events') {
      eventClients.add(ws);
      ws.send(JSON.stringify({ t: 'snapshot', agents: manager.list(), backlog: backlog.view(), goals: goals.list(), projects: manager.listProjects(), races: races.list(), teams: teams.list(), built: reports.list(), rules: manager.rules.view(), repeats: repeats.view() }));
      ws.on('close', () => eventClients.delete(ws));
      return;
    }

    const m = url.pathname.match(/^\/ws\/term\/([\w-]+)$/);
    if (!m) return ws.close(1008, 'unknown endpoint');
    let session;
    try {
      // The machine terminal has no agent; its shells live under MACHINE.
      const agent = m[1] === MACHINE ? { id: MACHINE } : manager.mustGet(m[1]);
      const client = {
        send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
        close: () => ws.close(1000, 'agent removed'),
      };
      const kind = agent.id === MACHINE ? `shell:${shellNumber(url.searchParams.get('kind')) || 1}` : termKind(url.searchParams.get('kind'));
      session = attachTerm(agent.id, kind, client);
      client.send({ t: 'hello', id: agent.id, kind, running: session.running, backlog: session.backlog, cols: session.cols, rows: session.rows });
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.t === 'i' && typeof msg.d === 'string') manager.write(agent.id, msg.d, kind);
        else if (msg.t === 'r') manager.resize(agent.id, msg.cols | 0, msg.rows | 0, kind);
      });
      ws.on('close', () => session.detach());
    } catch (err) {
      ws.close(1008, err.message.slice(0, 120));
    }
  });

  // ---------------------------------------------------------- listeners

  const server = http.createServer(app);
  // Outlive clients' idle keep-alive sockets (Node fetch keeps them ~4s+): with the 5s
  // default, a request sent on a socket just as the server closes it fails with ECONNRESET.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.on('upgrade', onUpgrade(false));

  async function startRemote() {
    const settings = remote.loadSettings();
    if (remoteServer && remotePort === settings.port) return;
    await stopRemote();
    const { key, cert } = await remote.ensureCertificate();
    remote.accessToken(); // make sure one exists
    const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      req.remote = true;
      app(req, res);
    });
    srv.keepAliveTimeout = 65_000;
    srv.headersTimeout = 66_000;
    srv.on('upgrade', onUpgrade(true));
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(settings.port, '0.0.0.0', resolve);
    });
    remoteServer = srv;
    remotePort = settings.port;
    console.log(`[agentmgr] remote access on ${remote.remoteUrls(settings.port).map((u) => u.url).join(', ')}`);
  }

  async function stopRemote() {
    if (!remoteServer) return;
    const srv = remoteServer;
    remoteServer = null;
    remotePort = null;
    await previews.stopAll();
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(() => r()));
  }

  let closing = false;
  async function shutdown(reason) {
    if (closing) return;
    closing = true;
    cleanup.close();
    landing.close();
    standup.close();
    value.close();
    reviews.close();
    hunts.close();
    benches.close();
    evals.close();
    autopilot.close();
    goals.close();
    worklog.close();
    triggers.close();
    budgets.close();
    playbooks.close();
    updates.close();
    assistant.close();
    console.log(`[agentmgr] shutting down (${reason}); closing agents so their sessions are saved`);
    builder.stopAll();
    await manager.stopAll({ final: true });
    await manager.flush().catch((err) => console.error(`[agentmgr] final flush failed: ${err.message}`));
    try {
      if (fs.readFileSync(paths.pid, 'utf8').trim() === String(process.pid)) fs.unlinkSync(paths.pid);
    } catch {}
    await stopRemote();
    live.stop();
    hubLink.stop();
    server.close();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  fs.writeFileSync(paths.pid, String(process.pid));
  if (remote.loadSettings().enabled) {
    await startRemote().catch((err) => console.error(`[agentmgr] remote access not started: ${err.message}`));
  }
  if (config.autoResume) {
    manager.resumeAll().then((ids) => {
      if (ids.length) console.log(`[agentmgr] resumed ${ids.length} agent(s) from before the restart: ${ids.join(', ')}`);
    });
  }
  manager.refreshAll().catch(() => {});
  hubLink.start();
  // A cloud runner joins its hub by itself on first start (AGENTMGR_HUB_URL and AGENTMGR_HUB_CODE: an
  // invite, or the hub's runner token), and stays joined across restarts (the link is kept on disk).
  if (process.env.AGENTMGR_HUB_URL && process.env.AGENTMGR_HUB_CODE && !hubLink.status().joined) {
    hubLink
      .join(process.env.AGENTMGR_HUB_URL, process.env.AGENTMGR_HUB_CODE, process.env.AGENTMGR_RUNNER_NAME || undefined)
      .then((st) => console.log(`[agentmgr] joined the hub ${st.url} as ${st.name}`))
      .catch((err) => console.error(`[agentmgr] could not join the hub ${process.env.AGENTMGR_HUB_URL}: ${err.message}`));
  }
  return {
    hunts,
    hubLink,
    server,
    manager,
    teams,
    cleanup,
    landing,
    triggers,
    budgets,
    playbooks,
    assistant,
    backlog,
    live,
    url: `http://${host}:${port}`,
    startRemote,
    stopRemote,
    get remoteServer() {
      return remoteServer;
    },
  };
}
