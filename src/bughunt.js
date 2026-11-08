// Bug hunts: an agent that looks for bugs in a project, or one folder of it, in the background:
// in what changed since its last run, or in the whole module, a part at a time. It doesn't change
// the code. Each bug it reports comes with evidence (a test that fails, or the path through the
// code that breaks), and a second, independent check (the AI judge) keeps only those that hold up,
// so the list stays worth reading. Bugs already reported, or that you said aren't bugs, aren't
// reported again. From the list: Fix (an agent starts on it, with the failing test), File it (a
// filled-in issue to submit), Not a bug, or Snooze.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { briefDir } from './brief.js';

export const FINDINGS_FILE = 'FINDINGS.json';
export const findingsPath = (agentId) => path.join(briefDir(agentId), FINDINGS_FILE);

export const FOCUS = { changes: 'What changed since the last run', module: 'The whole module, a part at a time' };
export const KINDS = {
  correctness: 'Wrong results and edge cases',
  concurrency: 'Races and deadlocks',
  errors: 'Error handling: swallowed, unchecked or wrong errors',
  resources: 'Leaks: files, connections, goroutines, memory',
  security: 'Security: injection, auth, secrets',
  data: 'Data loss or corruption',
  performance: 'Performance that breaks under load',
};
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const SCHEDULES = { manual: 'Only when you press Hunt now', nightly: 'Every night (1–5am), when no hunt is running' };
export const STATUSES = ['open', 'fixing', 'filed', 'notbug', 'snoozed', 'dropped'];

const MAX_FINDINGS = 500;
const MAX_RUNS = 20;
const KEEP_AT = 0.6;
const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const now = () => new Date().toISOString();

/** A folder in the repository: relative, no way out of it. Empty means the whole repository. */
export function cleanPath(p) {
  const v = String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (!v) return '';
  if (v.split('/').some((s) => s === '..') || path.isAbsolute(v)) throw err(400, 'The folder is a path inside the repository, like pkg/providers');
  return v.slice(0, 300);
}

/** The hunter's instructions: read-only, findings with evidence in `file` as JSON. */
export function hunterPrompt(file, h) {
  const where = h.path ? `the folder ${h.path} (and what it calls, as far as needed to judge a bug)` : 'the repository';
  const kinds = h.kinds?.length ? h.kinds.map((k) => KINDS[k] ?? k).join('; ') : 'any kind of bug';
  const scope =
    h.focus === 'changes'
      ? h.since
        ? `Look at what changed in ${where} since commit ${h.since}: "git log --oneline ${h.since}..HEAD -- ${h.path || '.'}" and "git diff ${h.since}..HEAD -- ${h.path || '.'}". Read enough of the code around each change to judge it.`
        : `Look at what changed in ${where} in the last 14 days: "git log --since=14.days --oneline -- ${h.path || '.'}" and the diffs of those commits. Read enough of the code around each change to judge it.`
      : `Go through ${where}, a part at a time. ${h.covered?.length ? `Earlier runs covered: ${h.covered.slice(-40).join(', ')}. Start with what they didn't, or what changed since.` : 'Start with the code that matters most: entry points, shared state, I/O and error paths.'} Note in "covered" what you went through.`;
  return [
    `You are hunting for bugs in this repository for the user, in the background. Scope: ${where}. Looking for: ${kinds}.`,
    scope,
    "Don't change the code: never commit, push, open pull requests or edit files in the repository. You may build, run the tests, and write new test files to prove a bug (outside the repository's own test folders if you can, or delete them afterwards). The user decides what to fix.",
    'Report only real bugs: behaviour that is wrong for some input, timing or state the code can actually get into. Not style, naming, missing comments, refactoring ideas or speculation. ' +
      'For each, prove it: best is a test that fails (say how you ran it and what it printed); else the exact path through the code, with file:line steps, from an input or event to the wrong result. ' +
      "If you can't show how it fails, leave it out. Fewer, solid findings are worth far more than many weak ones.",
    `Write your findings to ${file} as JSON, and keep it current while you work:\n` +
      '{\n' +
      '  "headSha": "<git rev-parse HEAD>",\n' +
      '  "covered": ["<folders or files you went through>"],\n' +
      '  "findings": [{\n' +
      '    "title": "<short: what goes wrong>",\n' +
      '    "file": "<path>", "line": <line or null>,\n' +
      `    "kind": "${Object.keys(KINDS).join('|')}",\n` +
      `    "severity": "${SEVERITIES.join('|')}",\n` +
      '    "why": "<how it fails: the input or timing, what happens, what should happen>",\n' +
      '    "evidence": { "type": "test" | "trace", "detail": "<the failing test\'s output, or the file:line steps>", "test": "<the test code, when you wrote one>" },\n' +
      '    "fix": "<what would fix it, in a sentence or two>",\n' +
      '    "confidence": <0 to 1>\n' +
      '  }],\n' +
      '  "notes": "<what you checked and found fine, in a few lines>"\n' +
      '}',
    'When you are done, set your status as done in the brief, with how many bugs you found in one line.',
  ].join('\n\n');
}

const lineOf = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/** FINDINGS.json, cleaned up: unknown values dropped, lengths capped. */
export function normalizeFindings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const findings = (Array.isArray(raw.findings) ? raw.findings : [])
    .slice(0, 50)
    .map((f) =>
      f?.title && f?.why
        ? {
            title: clip(f.title, 200),
            file: f.file ? clip(f.file, 300) : null,
            line: lineOf(f.line),
            kind: KINDS[f.kind] ? f.kind : 'correctness',
            severity: SEVERITIES.includes(f.severity) ? f.severity : 'medium',
            why: clip(f.why, 3000),
            evidence: { type: f.evidence?.type === 'test' ? 'test' : 'trace', detail: clip(f.evidence?.detail, 4000), test: f.evidence?.test ? clip(f.evidence.test, 6000) : null },
            fix: clip(f.fix, 1000),
            confidence: Math.max(0, Math.min(1, Number(f.confidence) || 0)),
          }
        : null,
    )
    .filter(Boolean);
  return {
    headSha: /^[0-9a-f]{7,40}$/i.test(raw.headSha ?? '') ? raw.headSha : null,
    covered: (Array.isArray(raw.covered) ? raw.covered : []).slice(0, 100).map((c) => clip(c, 200)).filter(Boolean),
    findings,
    notes: clip(raw.notes, 2000),
  };
}

/** The hunter's FINDINGS.json: { ...findings, updatedAt } or null (missing or not JSON yet). */
export function readFindings(agentId) {
  try {
    const file = findingsPath(agentId);
    const st = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8');
    const got = normalizeFindings(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
    return got ? { ...got, updatedAt: st.mtime.toISOString() } : null;
  } catch {
    return null;
  }
}

/** The same bug found again: same file and the same words in its title (line numbers move). */
export function fingerprint(huntKey, f) {
  const words = String(f.title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .sort()
    .join(' ');
  return crypto.createHash('sha1').update(`${huntKey}|${f.file ?? ''}|${words}`).digest('hex').slice(0, 12);
}

/** The judge's question: does this finding hold up against the code? */
export function checkPrompt(f, snippet) {
  return [
    'A bug-hunting agent reported the bug below. Check it independently against the code: is it a real bug that can happen, and is the evidence sound? Agents over-report: reject speculation, style, things the code already handles, and anything the evidence does not show.',
    `Bug: ${f.title}\nWhere: ${f.file ?? '?'}${f.line ? `:${f.line}` : ''}\nKind: ${f.kind}, severity ${f.severity}\nHow it fails: ${f.why}\nEvidence (${f.evidence.type}): ${f.evidence.detail}${f.evidence.test ? `\nTest:\n${f.evidence.test}` : ''}`,
    snippet ? `The code around it:\n${snippet}` : 'The code around it could not be read.',
    'Reply with JSON only: { "real": true|false, "confidence": <0 to 1>, "severity": "critical|high|medium|low", "reason": "<one or two sentences>" }',
  ].join('\n\n');
}

/** Lines around `line` of `file` in `dir`, numbered; null when it can't be read. */
export function snippetOf(dir, file, line, around = 40) {
  if (!dir || !file) return null;
  try {
    const full = path.resolve(dir, file);
    if (!full.startsWith(path.resolve(dir) + path.sep)) return null;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    const at = line ? line - 1 : 0;
    const from = Math.max(0, at - around);
    return lines
      .slice(from, Math.min(lines.length, at + around))
      .map((l, i) => `${from + i + 1}: ${l}`)
      .join('\n')
      .slice(0, 12_000);
  } catch {
    return null;
  }
}

/** Whether a finding is kept: the judge's word when it gave one, else a failing test. */
export function keep(f, check) {
  if (check) return Boolean(check.real) && check.confidence >= KEEP_AT;
  return f.evidence.type === 'test' && f.confidence >= KEEP_AT;
}

/** What a Fix agent is asked to do. */
export function fixIntent(f) {
  return [
    `Fix this bug found by a bug hunt: ${f.title}`,
    `Where: ${f.file ?? '?'}${f.line ? `:${f.line}` : ''} (${f.kind}, ${f.severity})`,
    `How it fails: ${f.why}`,
    `Evidence (${f.evidence.type}): ${f.evidence.detail}`,
    f.evidence.test ? `A test that shows it:\n${f.evidence.test}` : null,
    f.fix ? `Suggested fix: ${f.fix}` : null,
    'First confirm it with a test that fails, then fix it so the test passes, without changing other behaviour. If it turns out not to be a bug, say why and stop.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The finding as an issue, in Markdown. */
export function findingMarkdown(f) {
  return [
    `**Where:** \`${f.file ?? '?'}${f.line ? `:${f.line}` : ''}\` · ${KINDS[f.kind] ?? f.kind} · severity ${f.severity}`,
    '',
    `**How it fails:** ${f.why}`,
    '',
    `**Evidence (${f.evidence.type === 'test' ? 'a failing test' : 'the path through the code'}):**`,
    '',
    '```',
    f.evidence.detail,
    '```',
    ...(f.evidence.test ? ['', '**Test:**', '', '```', f.evidence.test, '```'] : []),
    ...(f.fix ? ['', `**Suggested fix:** ${f.fix}`] : []),
    '',
    '_Found by a bug hunt in AI Agent Manager._',
  ].join('\n');
}

/** A GitHub new-issue link for the finding on `repo` (a GitHub URL), or null. */
export function issueLinkFor(repo, f) {
  const m = String(repo ?? '').match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  let body = findingMarkdown(f);
  if (body.length > 6000) body = `${body.slice(0, 5900)}\n\n_(cut short to fit the link)_`;
  return `https://github.com/${m[1]}/${m[2]}/issues/new?${new URLSearchParams({ title: f.title, labels: 'bug', body })}`;
}

export class BugHunts {
  /** `judge` is the AI judge (ask(key, agent, prompt, validate)); `read` gives a hunter's findings (tests). */
  constructor({ manager, store, judge = null, log = () => {}, read = readFindings }) {
    this.read = read;
    this.manager = manager;
    this.store = store;
    this.judge = judge;
    this.log = log;
    this.checking = new Set();
    this.onFinished = (agent) => {
      if (agent?.hunting) this.ingest(agent.id).catch((e) => this.log(`bughunt: ${e.message}`));
    };
    manager.on('finished', this.onFinished);
    this.timer = null;
  }

  close() {
    this.manager.off('finished', this.onFinished);
    clearInterval(this.timer);
  }

  get hunts() {
    return (this.store.data.bugHunts ??= []);
  }

  get findings() {
    return (this.store.data.bugFindings ??= []);
  }

  mustHunt(id) {
    const h = this.hunts.find((x) => x.id === id);
    if (!h) throw err(404, 'No such hunt');
    return h;
  }

  /** A hunt's settings, checked: { project, path, focus, kinds, schedule, maxUsd, name }. */
  settings(input = {}, prev = {}) {
    const project = String(input.project ?? prev.project ?? '').trim().replace(/^@/, '');
    if (!project) throw err(400, 'Pick a project to hunt in');
    if (!this.manager.resolveProject(project)) throw err(400, `No project @${project}; see agentmgr project ls`);
    const focus = input.focus ?? prev.focus ?? 'changes';
    if (!FOCUS[focus]) throw err(400, `The focus is ${Object.keys(FOCUS).join(' or ')}`);
    const kinds = (Array.isArray(input.kinds) ? input.kinds : prev.kinds ?? []).filter((k) => KINDS[k]);
    const schedule = input.schedule ?? prev.schedule ?? 'manual';
    if (!SCHEDULES[schedule]) throw err(400, `The schedule is ${Object.keys(SCHEDULES).join(' or ')}`);
    const raw = input.maxUsd === undefined ? prev.maxUsd ?? 5 : Number(input.maxUsd);
    if (!(Number.isFinite(raw) && raw > 0 && raw <= 500)) throw err(400, 'The cost limit per run is a number of dollars, up to 500');
    const p = cleanPath(input.path ?? prev.path ?? '');
    return { project, path: p, focus, kinds, schedule, maxUsd: Math.round(raw * 100) / 100, name: clip(input.name ?? prev.name ?? '', 80) || `${project}${p ? `/${p}` : ''}` };
  }

  add(input) {
    const h = { id: crypto.randomBytes(3).toString('hex'), ...this.settings(input), createdAt: now(), runs: [], covered: [], lastSha: null };
    this.hunts.push(h);
    this.store.save();
    return this.view(h);
  }

  update(id, input) {
    const h = this.mustHunt(id);
    Object.assign(h, this.settings(input, h));
    this.store.save();
    return this.view(h);
  }

  remove(id) {
    const i = this.hunts.findIndex((x) => x.id === id);
    if (i < 0) throw err(404, 'No such hunt');
    this.hunts.splice(i, 1);
    this.store.save();
    return { removed: id };
  }

  /** The hunt agent running now, if any (one at a time, so hunts never crowd out your own work). */
  runningAgent() {
    return this.store.list().find((a) => a.hunting && a.desired === 'running' && !a.hunting.ingestedAt) ?? null;
  }

  /** Start a run: a read-only agent on the hunt's project, capped at the hunt's cost limit. */
  run(id, { by = 'you' } = {}) {
    const h = this.mustHunt(id);
    const busy = this.runningAgent();
    if (busy) throw err(409, `A hunt is running already (${busy.name}); one at a time`);
    const hunting = { huntId: h.id, path: h.path, focus: h.focus, kinds: h.kinds, since: h.focus === 'changes' ? h.lastSha : null, covered: h.focus === 'module' ? h.covered : [], by };
    const agent = this.manager.create({
      project: h.project,
      intent: `Bug hunt: ${h.name} (${h.focus === 'changes' ? 'recent changes' : 'whole module'})`,
      name: `hunt-${h.name}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40),
      hunting,
    });
    this.manager.patch(agent.id, { budgetUsd: h.maxUsd });
    h.runs.unshift({ agentId: agent.id, at: now(), by, status: 'running' });
    h.runs.splice(MAX_RUNS);
    this.store.save();
    this.log(`bughunt: ${h.name}: started ${agent.name}`);
    return { hunt: this.view(h), agent: { id: agent.id, name: agent.name } };
  }

  /**
   * Take in what a hunter found: each new finding is checked by the judge, kept or dropped, and
   * the hunter is stopped. Safe to call more than once.
   */
  async ingest(agentId) {
    const agent = this.store.get(agentId);
    if (!agent?.hunting || agent.hunting.ingestedAt || this.checking.has(agentId)) return null;
    this.checking.add(agentId);
    try {
      const h = this.hunts.find((x) => x.id === agent.hunting.huntId) ?? null;
      const got = this.read(agentId);
      const huntKey = h ? `${h.project}|${h.path}` : agent.hunting.huntId;
      let found = 0;
      let kept = 0;
      for (const f of got?.findings ?? []) {
        const id = fingerprint(huntKey, f);
        // Already on the list, or you said it isn't a bug: not again.
        if (this.findings.some((x) => x.id === id)) continue;
        found += 1;
        const check = this.judge
          ? await this.judge.ask(`hunt:${id}`, agent, checkPrompt(f, snippetOf(agent.workdir, f.file, f.line)), (d) => typeof d.real === 'boolean').catch(() => null)
          : null;
        const ok = keep(f, check);
        if (ok) kept += 1;
        this.findings.unshift({
          id,
          huntId: agent.hunting.huntId,
          project: h?.project ?? agent.project ?? null,
          ...f,
          severity: check?.real && SEVERITIES.includes(check.severity) ? check.severity : f.severity,
          check: check ? { real: check.real, confidence: check.confidence, reason: clip(check.reason, 600) } : null,
          status: ok ? 'open' : 'dropped',
          foundBy: agent.id,
          at: now(),
        });
      }
      this.findings.splice(MAX_FINDINGS);
      if (h) {
        if (got?.headSha) h.lastSha = got.headSha;
        if (got?.covered?.length) h.covered = [...new Set([...h.covered, ...got.covered])].slice(-200);
        const r = h.runs.find((x) => x.agentId === agentId);
        if (r) Object.assign(r, { status: 'done', doneAt: now(), found, kept, dropped: found - kept, notes: got?.notes ?? null, wrote: Boolean(got) });
      }
      this.manager.patch(agentId, { hunting: { ...agent.hunting, ingestedAt: now() } });
      this.store.save();
      // Its work is in the list now: the session needn't stay open.
      try {
        this.manager.stop(agentId);
      } catch {}
      this.log(`bughunt: ${agent.name}: ${kept} kept of ${found} new`);
      return { found, kept };
    } finally {
      this.checking.delete(agentId);
    }
  }

  /** Runs that ended without saying done (stopped, out of budget): their findings are taken in too. */
  async sweep() {
    for (const a of this.store.list()) {
      if (!a.hunting || a.hunting.ingestedAt) continue;
      const rt = this.manager.runtimes?.get(a.id);
      if (a.brief?.status === 'done' || (a.desired !== 'running' && !rt?.pty)) await this.ingest(a.id).catch(() => {});
    }
  }

  /** Nightly hunts: between 1 and 5 in the morning, once a day, one at a time. */
  async tick(at = new Date()) {
    await this.sweep();
    const hour = at.getHours();
    if (hour < 1 || hour >= 5 || this.runningAgent()) return null;
    const due = this.hunts.find((h) => h.schedule === 'nightly' && !(h.runs[0] && at.getTime() - Date.parse(h.runs[0].at) < 20 * 3_600_000));
    if (!due) return null;
    try {
      return this.run(due.id, { by: 'schedule' });
    } catch (e) {
      this.log(`bughunt: ${due.name}: ${e.message}`);
      return null;
    }
  }

  startTimer(ms = 10 * 60_000) {
    this.timer = setInterval(() => this.tick().catch(() => {}), ms);
    this.timer.unref?.();
  }

  /** Your decision on findings: open, notbug, snoozed (until a time), filed. */
  set(ids = [], status, { until = null } = {}) {
    if (!['open', 'notbug', 'snoozed', 'filed'].includes(status)) throw err(400, 'The decision is open, notbug, snoozed or filed');
    let snoozeUntil = null;
    if (status === 'snoozed') {
      const t = Date.parse(until ?? '');
      if (!Number.isFinite(t) || t <= Date.now()) throw err(400, 'Snooze until a time to come');
      snoozeUntil = new Date(t).toISOString();
    }
    const set = [];
    for (const id of new Set(ids)) {
      const f = this.findings.find((x) => x.id === id);
      if (!f) continue;
      f.prev = f.status;
      f.status = status;
      f.snoozeUntil = snoozeUntil;
      f.decidedAt = now();
      set.push(id);
    }
    this.store.save();
    return { set };
  }

  /** Start an agent to fix a finding, in the hunt's project. */
  fix(id) {
    const f = this.findings.find((x) => x.id === id);
    if (!f) throw err(404, 'No such finding');
    const prev = f.fixAgentId ? this.store.get(f.fixAgentId) : null;
    if (prev) return { agent: { id: prev.id, name: prev.name }, existing: true };
    const [agent] = this.manager.createMany([fixIntent(f)], { project: f.project, name: `fix-${f.title}`.slice(0, 40) });
    f.fixAgentId = agent.id;
    f.status = 'fixing';
    f.decidedAt = now();
    this.store.save();
    return { agent: { id: agent.id, name: agent.name }, existing: false };
  }

  /** The finding as an issue: a GitHub link when the project is on GitHub, and the Markdown. */
  issue(id) {
    const f = this.findings.find((x) => x.id === id);
    if (!f) throw err(404, 'No such finding');
    const repo = f.project ? this.manager.resolveProject(f.project)?.repo : null;
    return { title: f.title, markdown: findingMarkdown(f), url: issueLinkFor(repo, f) };
  }

  view(h) {
    const agent = h.runs[0] ? this.store.get(h.runs[0].agentId) : null;
    const open = this.findings.filter((f) => f.huntId === h.id && f.status === 'open').length;
    return { ...h, covered: undefined, coveredCount: h.covered.length, open, running: Boolean(agent?.hunting && !agent.hunting.ingestedAt && agent.desired === 'running'), last: h.runs[0] ?? null };
  }

  /** Findings, snoozed ones back once their time comes; the hunts; what's running. */
  list() {
    const t = Date.now();
    for (const f of this.findings) {
      if (f.status === 'snoozed' && f.snoozeUntil && Date.parse(f.snoozeUntil) <= t) {
        f.status = 'open';
        f.snoozeUntil = null;
      }
      if (f.status === 'fixing' && f.fixAgentId && !this.store.get(f.fixAgentId)) f.status = 'open';
    }
    const running = this.runningAgent();
    const rank = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
    return {
      hunts: this.hunts.map((h) => this.view(h)),
      findings: [...this.findings].sort((a, b) => rank[a.severity] - rank[b.severity] || String(b.at).localeCompare(String(a.at))).map((f) => ({ ...f, hunt: this.hunts.find((h) => h.id === f.huntId)?.name ?? null })),
      running: running ? { id: running.id, name: running.name, huntId: running.hunting.huntId } : null,
      focus: FOCUS,
      kinds: KINDS,
      schedules: SCHEDULES,
    };
  }
}
