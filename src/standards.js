// Standards: what every change in a repository has to meet, set by you per repository.
//   lessons - one line each, from what went wrong before (a revert, a fix afterwards, failed checks,
//             a reviewer's change request: proposed from Quality, yours to word and accept). Every
//             later agent in the repository is given them, and the scorecard checks each one.
//   risk    - paths that are high risk (auth, payments, migrations, public APIs). A change that
//             touches one is never shipped or merged without you, is reviewed by another model,
//             and can't be scored "ready".
//   bar     - checks the app runs itself on the agent's changes before they are scored: your
//             commands (lint, types, tests, a dependency scan), tests changed along with the code,
//             and no secrets in the diff. A failed one means "not ready", whatever the agent says.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { NO_REPO, projectOf } from './manager.js';
import { memoryKey } from './memory.js';
import { run } from './git.js';
import { ghBin } from './tracker.js';

const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const now = () => new Date().toISOString();

export const MAX_LESSONS = 40; // accepted per repository: every agent reads them all
export const MAX_RULES = 50;
export const MAX_CHECKS = 12;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)\.[a-z]+$|_test\.go$|Test\.java$/i;
const NOT_CODE = /\.(md|txt|rst|adoc|json|ya?ml|toml|lock|css|svg|png|jpe?g|gif)$|(^|\/)docs?\//i;

// ---------------------------------------------------------------- high-risk paths

/**
 * A path pattern as a test. `*` stays inside a folder, `**` crosses folders, a pattern without a
 * slash matches at any depth, and a folder matches everything under it.
 */
export function pathMatcher(pattern) {
  const p = String(pattern ?? '').trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (!p) return () => false;
  const body = p
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((tok) => (tok === '**/' ? '(?:.*/)?' : tok === '**' ? '.*' : tok === '*' ? '[^/]*' : tok === '?' ? '[^/]' : tok.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  const re = new RegExp(`^${p.includes('/') ? '' : '(?:.*/)?'}${body}(?:/.*)?$`);
  return (file) => re.test(String(file));
}

/** The changed files under a high-risk path: [{ path, pattern, why }], each file once. */
export function riskOf(files = [], rules = []) {
  const tests = rules.map((r) => ({ ...r, test: pathMatcher(r.pattern) }));
  const out = [];
  for (const f of files) {
    const file = typeof f === 'string' ? f : f?.path;
    const hit = file && tests.find((r) => r.test(file));
    if (hit) out.push({ path: file, pattern: hit.pattern, why: hit.why ?? '' });
  }
  return out.slice(0, 100);
}

const riskRules = (list) => {
  if (!Array.isArray(list)) throw err(400, 'risk is a list of { pattern, why }');
  const out = [];
  for (const r of list) {
    const pattern = clip(typeof r === 'string' ? r : r?.pattern, 200);
    if (!pattern || out.some((o) => o.pattern === pattern)) continue;
    out.push({ pattern, why: clip(r?.why, 200) });
  }
  if (out.length > MAX_RULES) throw err(400, `At most ${MAX_RULES} high-risk paths per repository`);
  return out;
};

// ---------------------------------------------------------------- the quality bar

const SECRETS = [
  ['a private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['a Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{24,}/],
  ['an OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Stripe live key', /\b[sr]k_live_[0-9a-zA-Z]{20,}/],
];

/** What looks like a secret on the added lines of a diff: [{ file, line, kind }]. The text itself is never kept. */
export function findSecrets(diff = '') {
  const out = [];
  let file = null;
  let line = 0;
  for (const l of String(diff).split('\n')) {
    if (l.startsWith('+++ ')) {
      file = l.slice(4).replace(/^b\//, '').trim();
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) {
      line = Number(hunk[1]) - 1;
      continue;
    }
    if (l.startsWith('-')) continue;
    line++;
    if (!l.startsWith('+') || !file || file === '/dev/null') continue;
    for (const [kind, re] of SECRETS) {
      if (re.test(l)) {
        out.push({ file, line, kind });
        break;
      }
    }
    if (out.length >= 20) break;
  }
  return out;
}

export const BAR_DEFAULTS = { tests: false, secrets: true, checks: [] };

export function barSettings(bar = {}) {
  const list = bar.checks ?? [];
  if (!Array.isArray(list)) throw err(400, 'checks is a list of { name, command }');
  const checks = [];
  for (const c of list) {
    const command = String(c?.command ?? '').trim().slice(0, 500);
    if (!command) continue;
    const name = clip(c?.name, 60) || command.split(/\s+/).slice(0, 3).join(' ');
    if (checks.some((o) => o.name === name)) throw err(400, `Two checks are named "${name}"`);
    checks.push({ name, command });
  }
  if (checks.length > MAX_CHECKS) throw err(400, `At most ${MAX_CHECKS} checks per repository`);
  return { tests: bar.tests === true, secrets: bar.secrets !== false, checks };
}

/** Checks a repository most likely has, from the files in a folder of it. */
export function suggestChecks(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const out = [];
  try {
    if (has('package.json')) {
      const scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {};
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
      for (const [name, script] of [['Lint', 'lint'], ['Types', 'typecheck'], ['Types', 'type-check'], ['Types', 'tsc'], ['Tests', 'test']]) {
        if (scripts[script] && !out.some((o) => o.name === name)) out.push({ name, command: script === 'test' ? `${pm} test` : `${pm} run ${script}` });
      }
      if (has('package-lock.json')) out.push({ name: 'Dependencies', command: 'npm audit --audit-level=high' });
    }
    if (has('go.mod')) out.push({ name: 'Vet', command: 'go vet ./...' }, { name: 'Tests', command: 'go test ./...' });
    if (has('Cargo.toml')) out.push({ name: 'Lint', command: 'cargo clippy -- -D warnings' }, { name: 'Tests', command: 'cargo test' });
    if (has('pyproject.toml') || has('setup.py')) out.push({ name: 'Lint', command: 'ruff check .' }, { name: 'Tests', command: 'pytest -q' });
  } catch {}
  return out.filter((c, i) => out.findIndex((o) => o.name === c.name) === i);
}

/** Run one command in a folder: { ok, code, ms, tail } (the end of what it printed). */
export function runCheck(command, { cwd, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    let timedOut = false;
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const add = (d) => (out = (out + d).slice(-8000));
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const done = (code, extra = '') => {
      clearTimeout(timer);
      const tail = (out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim() + extra).slice(-1500);
      resolve({ ok: code === 0 && !timedOut, code: timedOut ? null : code, ms: Date.now() - started, tail: timedOut ? `${tail}\n(stopped after ${Math.round(timeoutMs / 1000)} seconds)`.trim() : tail });
    };
    child.on('error', (e) => done(127, `\n${e.message}`));
    child.on('close', (code) => done(code ?? 1));
  });
}

/** The bar's own checks, from the changed files and the diff alone. */
export function builtInChecks(bar, { files = [], diff = '' } = {}) {
  const out = [];
  if (bar.tests) {
    const paths = files.map((f) => f.path);
    const code = paths.filter((p) => !TEST_FILE.test(p) && !NOT_CODE.test(p));
    const tests = paths.filter((p) => TEST_FILE.test(p));
    out.push({ name: 'Tests changed with the code', builtIn: 'tests', ok: !code.length || tests.length > 0, tail: !code.length ? 'No code files changed' : tests.length ? `${tests.length} test file${tests.length === 1 ? '' : 's'} changed` : `${code.length} code file${code.length === 1 ? '' : 's'} changed and no test file` });
  }
  if (bar.secrets) {
    const found = findSecrets(diff);
    out.push({ name: 'No secrets in the changes', builtIn: 'secrets', ok: !found.length, tail: found.length ? found.map((s) => `${s.file}:${s.line} looks like ${s.kind}`).join('\n') : 'Nothing that looks like a key or token on the added lines' });
  }
  return out;
}

// ---------------------------------------------------------------- lessons

const SOURCE_TEXT = {
  reverted: 'was reverted',
  fixed: 'needed a fix afterwards',
  broke: 'failed its checks once merged',
  problem: 'was a problem after it merged',
  review: 'had changes requested by a reviewer',
};

/** One line, without Markdown that could break a list. */
export function cleanLesson(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').replace(/^[-*#>\s]+/, '').trim();
  if (!t) throw err(400, 'A lesson is one line of text');
  if (t.length > 300) throw err(400, 'Keep a lesson to one short line (300 characters at most)');
  return t;
}

/** What a merged pull request in Quality could teach: { kind, detail } or null. */
export function lessonSource(it) {
  const a = it.after ?? {};
  const name = (x) => clip(`${x?.number ? `#${x.number} ` : ''}${x?.title ?? ''}`, 140);
  if (it.verdict === 'reverted') return { kind: 'reverted', detail: a.reverted ? `Reverted by ${name(a.reverted)}` : 'Reverted' };
  if (it.verdict === 'fixed') return { kind: 'fixed', detail: `Fixed afterwards by ${(a.fixes ?? []).map(name).join('; ')}` };
  if (it.verdict === 'broke') return { kind: 'broke', detail: `Checks failed on the commit it merged as: ${(a.checks?.failed ?? []).join(', ')}` };
  if (it.verdict === 'problem') return { kind: 'problem', detail: it.mark?.note ? `You marked it a problem: ${it.mark.note}` : 'You marked it a problem' };
  if (it.facts?.changesRequested && !it.mark) return { kind: 'review', detail: `A reviewer asked for changes before it merged (${it.facts.changesRequested})` };
  return null;
}

export function lessonPrompt({ source, pr = null, repo = '' }) {
  return [
    'Write one lesson for AI coding agents working in a repository, from something that went wrong with an earlier change there.',
    'Reply with the lesson alone: one imperative sentence of at most 200 characters, about how to work in this repository so it does not happen again.',
    'Make it specific to what went wrong and checkable in a later change (a reviewer must be able to say whether a change follows it). Not a general virtue like "test more carefully".',
    'If the material does not show what went wrong, reply with the single word UNKNOWN.',
    '',
    `<repository>${repo}</repository>`,
    '<what_happened>',
    `Pull request ${source.number ? `#${source.number} ` : ''}"${source.title}" ${SOURCE_TEXT[source.kind] ?? 'had a problem'}.`,
    source.detail,
    '</what_happened>',
    pr ? `<pull_request>\n${pr}\n</pull_request>` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** What an agent is told at its start: the lessons to follow and the paths to be careful in. */
export function standardsPrompt({ lessons = [], risk = [] } = {}) {
  const out = [];
  if (lessons.length) {
    out.push(
      `Lessons from earlier work in this repository, set by the person you work for. Follow each one; your changes are checked against them before review:\n${lessons.map((l) => `- ${l.text}`).join('\n')}`,
    );
  }
  if (risk.length) {
    out.push(
      `High-risk parts of this repository, marked by the person you work for:\n${risk.map((r) => `- ${r.pattern}${r.why ? ` (${r.why})` : ''}`).join('\n')}\n` +
        'If your task needs a change there: before you edit, write in your brief (or the plan, if you have one) what you will change there, what could go wrong and how you will verify it. Keep the change there as small as the task allows, add or update tests for it, and name the files in your brief. Such a change is reviewed by another model and is not merged without the person. Do not touch these parts for anything the task does not need.',
    );
  }
  return out.join('\n\n');
}

// ---------------------------------------------------------------- per repository, in the store

export class Standards {
  constructor({ manager, store, config = {}, quality = null, onChange = () => {}, log = (m) => console.log(`[agentmgr] ${m}`) }) {
    Object.assign(this, { manager, store, config, quality, onChange, log });
    this.running = new Map(); // agentId -> the bar being run for it
    manager.standards = this;
  }

  get state() {
    const st = (this.store.data.standards ??= {});
    st.repos ??= {};
    st.seen ??= {};
    return st;
  }

  get checkTimeoutMs() {
    const n = Number(this.config.standards?.checkTimeoutMs);
    return Number.isFinite(n) && n >= 1000 ? Math.min(n, 3_600_000) : 600_000;
  }

  /** The repository an agent works in, or null (a session with none). */
  keyOf(agent) {
    if (!agent || NO_REPO.has(agent.kind)) return null;
    const key = memoryKey(agent);
    return key === 'other' ? null : key;
  }

  repo(key) {
    return this.state.repos[key] ?? null;
  }

  ensure(key, name) {
    if (!key) throw err(400, 'Which repository? Give its key (see the list)');
    const r = (this.state.repos[key] ??= { name: name ?? this.nameOf(key) ?? key, risk: [], bar: { ...BAR_DEFAULTS }, lessons: [] });
    return r;
  }

  agentsOf(key) {
    return this.store.list().filter((a) => this.keyOf(a) === key);
  }

  nameOf(key) {
    const a = this.agentsOf(key)[0];
    if (!a) return null;
    const p = projectOf({ ...a, projectMove: null, project: null });
    return p.full ?? p.name;
  }

  /** What applies to an agent's changes. */
  forAgent(agent) {
    const r = this.repo(this.keyOf(agent));
    return { lessons: (r?.lessons ?? []).filter((l) => l.state === 'accepted'), risk: r?.risk ?? [], bar: barSettings(r?.bar ?? BAR_DEFAULTS) };
  }

  prompt(agent) {
    if (this.config.standards?.enabled === false) return '';
    const { lessons, risk } = this.forAgent(agent);
    return standardsPrompt({ lessons, risk });
  }

  /** The changed files of an agent that are under a high-risk path. */
  riskIn(agent, files) {
    if (this.config.standards?.enabled === false) return [];
    return riskOf(files, this.forAgent(agent).risk);
  }

  async risk(ref) {
    const agent = this.manager.mustGet(ref);
    if (!this.forAgent(agent).risk.length || !this.manager.changesSource) return [];
    const changes = await this.manager.changesSource(agent.id);
    return this.riskIn(agent, changes.files ?? []);
  }

  /**
   * An agent's changes against its repository's standards: the high-risk files touched, and the bar
   * (run once per state of the changes; `fresh` runs it again). Kept on the agent as `standards`.
   */
  async assess(ref, data = null, { fresh = false } = {}) {
    const agent = this.manager.mustGet(ref);
    if (this.config.standards?.enabled === false) return null;
    const std = this.forAgent(agent);
    data ??= await this.manager.changesSource(agent.id);
    const risk = riskOf(data.files ?? [], std.risk);
    const diffHash = data.diffHash ?? crypto.createHash('sha1').update(data.diff ?? '').digest('hex');
    const cur = this.store.get(agent.id)?.standards;
    const want = JSON.stringify(std.bar);
    let bar = null;
    if (std.bar.tests || std.bar.secrets || std.bar.checks.length) {
      if (!fresh && cur?.bar && cur.diffHash === diffHash && cur.bar.of === want) bar = cur.bar;
      else if (this.running.has(agent.id)) bar = await this.running.get(agent.id);
      else {
        const p = this.runBar(agent, std.bar, data).then((results) => ({ of: want, at: now(), ok: results.every((r) => r.ok), results }));
        this.running.set(agent.id, p);
        try {
          bar = await p;
        } finally {
          this.running.delete(agent.id);
        }
      }
    }
    const out = { diffHash, at: bar?.at ?? now(), risk, bar, lessons: std.lessons.map((l) => ({ id: l.id, text: l.text })) };
    if (this.store.get(agent.id)) {
      const { lessons, ...kept } = out;
      if (JSON.stringify({ ...cur, at: 0 }) !== JSON.stringify({ ...kept, at: 0 })) this.manager.patch(agent.id, { standards: kept });
    }
    return out;
  }

  async runBar(agent, bar, data) {
    const results = builtInChecks(bar, data);
    for (const c of bar.checks) {
      if (!agent.workdir || !fs.existsSync(agent.workdir)) {
        results.push({ name: c.name, command: c.command, ok: false, code: null, ms: 0, tail: "The agent's folder is not on this computer" });
        continue;
      }
      this.log(`standards: ${agent.name}: ${c.name} (${c.command})`);
      results.push({ name: c.name, command: c.command, ...(await runCheck(c.command, { cwd: agent.workdir, timeoutMs: this.checkTimeoutMs })) });
    }
    return results;
  }

  /**
   * When an agent says it is done: a change under a high-risk path is reviewed by another model,
   * also where review rounds are off (the pull request stays yours to open).
   */
  async finished(agent) {
    const pre = this.manager.preReview;
    if (!pre || !this.forAgent(agent).risk.length) return false;
    const risk = await this.risk(agent.id);
    const cur = this.store.get(agent.id);
    if (!risk.length || !cur || !pre.can(cur) || ['reviewing', 'fixing'].includes(cur.preReview?.status)) return false;
    this.log(`standards: ${cur.name} touches high-risk paths (${risk.slice(0, 3).map((r) => r.path).join(', ')}): reviewed by another model`);
    pre.begin(cur.id, { forced: 'risk' });
    return true;
  }

  // -------------------------------------------------------------- settings

  update(key, patch = {}) {
    const r = this.ensure(key);
    if (patch.risk !== undefined) r.risk = riskRules(patch.risk);
    if (patch.bar !== undefined) r.bar = barSettings({ ...r.bar, ...patch.bar });
    this.saved();
    return this.repoView(key);
  }

  addLesson(key, text, { source = null } = {}) {
    const r = this.ensure(key);
    const line = cleanLesson(text);
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (r.lessons.some((l) => l.state === 'accepted' && norm(l.text) === norm(line))) throw err(409, 'That lesson is already there');
    if (r.lessons.filter((l) => l.state === 'accepted').length >= MAX_LESSONS) throw err(409, `A repository keeps at most ${MAX_LESSONS} lessons, since every agent reads them all: remove one first`);
    const lesson = { id: crypto.randomBytes(4).toString('hex'), text: line, state: 'accepted', source, at: now() };
    r.lessons.push(lesson);
    this.saved();
    return lesson;
  }

  lesson(key, id) {
    const l = this.repo(key)?.lessons.find((x) => x.id === id);
    if (!l) throw err(404, 'No such lesson');
    return l;
  }

  /** Accept (with its wording), dismiss, reword, or put back as proposed. */
  setLesson(key, id, { state, text } = {}) {
    const l = this.lesson(key, id);
    if (text !== undefined) l.text = state === 'dismissed' ? clip(text, 300) : cleanLesson(text);
    if (state !== undefined) {
      if (!['accepted', 'dismissed', 'proposed'].includes(state)) throw err(400, 'state is accepted, dismissed or proposed');
      if (state === 'accepted') {
        l.text = cleanLesson(l.text);
        if (l.state !== 'accepted' && this.repo(key).lessons.filter((x) => x.state === 'accepted').length >= MAX_LESSONS) throw err(409, `A repository keeps at most ${MAX_LESSONS} lessons: remove one first`);
      }
      l.state = state;
      l.at = now();
    }
    this.saved();
    return l;
  }

  removeLesson(key, id) {
    const r = this.repo(key);
    const l = this.lesson(key, id);
    // One that came from a pull request stays dismissed, so it is not proposed again.
    if (l.source?.url) l.state = 'dismissed';
    else r.lessons.splice(r.lessons.indexOf(l), 1);
    this.saved();
    return { ok: true };
  }

  /** A model's wording for a proposed lesson, from the pull request and what followed it. */
  async draft(key, id) {
    const l = this.lesson(key, id);
    if (!l.source) throw err(400, 'This lesson did not come from a pull request');
    const agent = this.store.get(l.source.agentId) ?? this.agentsOf(key)[0];
    if (!agent) throw err(409, 'No agent of this repository is left to ask a model with: write the lesson yourself');
    let pr = null;
    if (!process.env.AGENTMGR_NO_GH && l.source.url) {
      // The description and what reviewers wrote, as far as GitHub gives them.
      pr = await run(ghBin(), ['pr', 'view', l.source.url, '--json', 'title,body,reviews,comments'], { timeout: 30_000 })
        .then((out) => {
          const p = JSON.parse(out);
          const said = [...(p.reviews ?? []), ...(p.comments ?? [])].map((c) => clip(c.body, 600)).filter(Boolean);
          return [`Description: ${clip(p.body, 1500)}`, ...said.slice(0, 12).map((s) => `A reviewer wrote: ${s}`)].join('\n');
        })
        .catch(() => null);
    }
    const said = clip(await this.manager.oneShot(agent, lessonPrompt({ source: l.source, pr, repo: this.repo(key).name }), { ...this.manager.writerFor(agent), timeoutMs: 120_000 }), 600);
    // Quotes around the whole reply go; ones inside it are the lesson's own.
    const reply = /^(["'`])[\s\S]*\1$/.test(said) ? said.slice(1, -1).trim() : said;
    if (!reply || /^UNKNOWN\b/i.test(reply)) throw err(422, 'The model could not tell what went wrong from what GitHub shows: write the lesson yourself');
    l.text = reply.slice(0, 300);
    this.saved();
    return l;
  }

  /** Propose a lesson for each merged pull request that had a problem (once each); drop untouched ones that turned out fine. */
  scan() {
    if (!this.quality) return 0;
    const st = this.state;
    let changed = 0;
    for (const it of this.quality.view().items) {
      const src = lessonSource(it);
      const seen = st.seen[it.url];
      if (!src) {
        if (!seen) continue;
        const r = st.repos[seen];
        const i = r?.lessons.findIndex((l) => l.source?.url === it.url && l.state === 'proposed' && !l.text) ?? -1;
        if (i >= 0) {
          r.lessons.splice(i, 1);
          delete st.seen[it.url];
          changed++;
        }
        continue;
      }
      if (seen) {
        // What followed it can change (fixed, then reverted): a proposal not yet worded follows.
        const l = st.repos[seen]?.lessons.find((x) => x.source?.url === it.url && x.state === 'proposed');
        if (l && (l.source.kind !== src.kind || l.source.detail !== src.detail)) {
          Object.assign(l.source, src);
          changed++;
        }
        continue;
      }
      const agent = this.store.get(it.agentId);
      const key = this.keyOf(agent);
      if (!key) continue;
      this.ensure(key).lessons.push({ id: crypto.randomBytes(4).toString('hex'), text: '', state: 'proposed', source: { ...src, url: it.url, number: it.number, title: it.title, agentId: it.agentId }, at: now() });
      st.seen[it.url] = key;
      changed++;
    }
    if (changed) this.store.save();
    return changed;
  }

  saved() {
    this.store.save();
    this.onChange();
  }

  // -------------------------------------------------------------- views

  repoView(key) {
    const r = this.repo(key);
    const agents = this.agentsOf(key);
    const dir = agents.map((a) => a.workdir).find((d) => d && fs.existsSync(d));
    const bar = barSettings(r?.bar ?? BAR_DEFAULTS);
    const lessons = r?.lessons ?? [];
    return {
      key,
      name: r?.name ?? this.nameOf(key) ?? key,
      agents: agents.length,
      risk: r?.risk ?? [],
      bar,
      suggested: dir ? suggestChecks(dir).filter((c) => !bar.checks.some((o) => o.command === c.command)) : [],
      lessons: lessons.filter((l) => l.state === 'accepted'),
      proposed: lessons.filter((l) => l.state === 'proposed'),
      dismissed: lessons.filter((l) => l.state === 'dismissed').length,
    };
  }

  view() {
    this.scan();
    const keys = new Set(Object.keys(this.state.repos));
    for (const a of this.store.list()) {
      const k = a.kind === 'task' ? this.keyOf(a) : null;
      if (k) keys.add(k);
    }
    const repos = [...keys].map((k) => this.repoView(k)).sort((a, b) => b.proposed.length - a.proposed.length || a.name.localeCompare(b.name));
    return { enabled: this.config.standards?.enabled !== false, repos, limits: { lessons: MAX_LESSONS, checks: MAX_CHECKS, checkSeconds: Math.round(this.checkTimeoutMs / 1000) } };
  }

  /** Which repository: its key, or a name that fits just one. */
  find(ref) {
    const v = this.view().repos;
    const hit = v.find((r) => r.key === ref) ?? (() => {
      const m = v.filter((r) => r.name === ref || r.name.split('/').at(-1) === ref);
      if (m.length > 1) throw err(409, `"${ref}" fits ${m.length} repositories: give the key`);
      return m[0];
    })();
    if (!hit) throw err(404, `No repository "${ref}" here: agents have to have worked in it`);
    return hit.key;
  }

  /** Lessons proposed and not yet accepted or dismissed, over all repositories. */
  pending() {
    return Object.values(this.state.repos).reduce((n, r) => n + r.lessons.filter((l) => l.state === 'proposed').length, 0);
  }
}
