// Tech debt radar: where a project's code costs the most to change. For each source file it
// weighs how often it changed lately (git history), how many of those changes were fixes, and
// how tangled it is (size, branching, deep nesting, TODO/FIXME notes), plus the open bugs the bug
// hunts found there. Files that are both changed a lot and hard to read come first: that is where
// paying debt down pays back. Each hot spot says why it is one, and can be handed to an agent
// through the backlog. All from git and the files themselves: no model is called, nothing is sent.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { run } from './git.js';

export const DEBT_DEFAULTS = { enabled: true, days: 90, autoDays: 7, top: 30 };
const MAX_FILES = 300; // read at most this many (the most changed)
const MAX_BYTES = 400_000;
const CODE = /\.(js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|kt|kts|rb|php|cs|c|h|cc|cpp|hpp|swift|scala|m|mm|sh|sql|vue|svelte|lua|dart|ex|exs|clj|pl)$/i;
const SKIP = /(^|\/)(node_modules|vendor|third_party|dist|build|out|target|coverage|\.git|__generated__|generated|migrations|fixtures|testdata|snapshots|__snapshots__)\/|\.min\.|\.generated\.|\.pb\.|_pb2?\.|\.lock$|-lock\./i;
// Tests change with every feature: that churn says less about debt.
const TEST = /(^|\/)(tests?|__tests__|specs?|e2e)\/|[._-](test|spec)\./i;
const FIX = /\b(fix(es|ed)?|bug|hotfix|revert|regression|crash|broken|patch)\b/i;

const err = (status, message) => Object.assign(new Error(message), { status });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `git log --name-only --format=%x01%s`: [{ subject, files }]. */
export function parseLog(text) {
  return String(text ?? '')
    .split('\x01')
    .slice(1)
    .map((c) => {
      const [subject, ...files] = c.split('\n');
      return { subject: subject.trim(), files: files.map((f) => f.trim()).filter(Boolean) };
    });
}

/** `git ls-tree -r -l`: Map of path -> size, blobs only. */
export function parseTree(text) {
  const out = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/);
    if (m) out.set(m[2], Number(m[1]));
  }
  return out;
}

/** How tangled a file is: its lines, branch points, lines nested 5 levels or deeper, and TODO-like notes. */
export function metricsOf(source) {
  const lines = String(source ?? '').split('\n');
  let code = 0;
  let branches = 0;
  let deep = 0;
  let todos = 0;
  // The indent step: the smallest indent in use (2, 4, 8 spaces or a tab).
  const widths = lines.map((l) => l.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length).filter((w) => w > 0);
  const step = Math.max(2, Math.min(8, widths.length ? Math.min(...widths) : 4));
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    code++;
    if (/\b(TODO|FIXME|HACK|XXX)\b/.test(t)) todos++;
    branches += (t.match(/\b(if|else if|elif|for|while|case|catch|except|when|unless)\b|&&|\|\||\?(?=[^.:?])/g) ?? []).length;
    if (l.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length / step >= 5) deep++;
  }
  return { lines: code, branches, deep, todos };
}

/**
 * The hot spots: [{ file, score (0-100), churn, fixes, lines, branches, deep, todos, bugs, reasons }],
 * worst first. `files`: Map of path -> metrics; `commits` from parseLog; `bugs`: paths with open bugs.
 */
export function hotSpots({ commits = [], files = new Map(), bugs = [], days = 90, top = 30 } = {}) {
  const churn = new Map();
  const fixes = new Map();
  for (const c of commits) {
    // A sweeping commit (a rename, a formatter) says little about any one file.
    if (c.files.length > 40) continue;
    for (const f of c.files) {
      churn.set(f, (churn.get(f) ?? 0) + 1);
      if (FIX.test(c.subject)) fixes.set(f, (fixes.get(f) ?? 0) + 1);
    }
  }
  const bugCount = new Map();
  for (const f of bugs) if (f) bugCount.set(f, (bugCount.get(f) ?? 0) + 1);
  const rows = [...files].map(([file, m]) => ({ file, ...m, churn: churn.get(file) ?? 0, fixes: fixes.get(file) ?? 0, bugs: bugCount.get(file) ?? 0 }));
  const maxChurn = Math.max(1, ...rows.map((r) => r.churn));
  const tangle = (r) => r.branches + r.deep * 2 + r.lines / 20;
  const maxTangle = Math.max(1, ...rows.map(tangle));
  for (const r of rows) {
    const c = r.churn / maxChurn;
    const t = Math.log1p(tangle(r)) / Math.log1p(maxTangle);
    const fixShare = r.churn ? r.fixes / r.churn : 0;
    r.score = Math.min(100, Math.round(100 * Math.sqrt(c * t) * (0.75 + 0.5 * fixShare) * (TEST.test(r.file) ? 0.6 : 1)) + Math.min(8, r.todos) + Math.min(12, r.bugs * 6));
    r.reasons = [
      r.churn >= 3 && `changed ${plural(r.churn, 'time')} in ${days} days`,
      r.fixes >= 2 && `${r.fixes} of them fixes`,
      r.lines >= 400 && `${r.lines.toLocaleString('en-US')} lines`,
      r.deep >= 15 && `${r.deep} lines nested 5 deep or more`,
      r.branches >= 80 && `${r.branches} branch points`,
      r.todos >= 3 && `${r.todos} TODO/FIXME notes`,
      r.bugs && `${plural(r.bugs, 'open bug')} found here`,
    ].filter(Boolean);
  }
  return rows
    .filter((r) => r.score >= 20 && r.reasons.length >= 2)
    .sort((a, b) => b.score - a.score || b.churn - a.churn || a.file.localeCompare(b.file))
    .slice(0, top);
}

/** What an agent is asked when a hot spot is handed over. */
export const debtTask = (h) =>
  `Pay down tech debt in ${h.file} (${h.reasons.join('; ')}). First find what makes it hard to change: long functions, deep nesting, ` +
  'mixed responsibilities, duplicated logic, stale TODOs. Cover its current behaviour with tests where they are missing, then refactor in small steps ' +
  'without changing behaviour, running the tests after each. Keep the pull request small and reviewable; if more is needed, list what is left in the description.';

/** The contents of many files at a ref, through one `git cat-file --batch`: Map of path -> text. */
function readBlobs(dir, ref, paths) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', reject);
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      const out = new Map();
      let at = 0;
      for (const p of paths) {
        const nl = buf.indexOf(10, at);
        if (nl < 0) break;
        const head = buf.toString('utf8', at, nl);
        at = nl + 1;
        const size = Number(head.match(/^[0-9a-f]+ blob (\d+)$/)?.[1]);
        if (!Number.isFinite(size)) continue; // "missing": no content follows
        const body = buf.subarray(at, at + size);
        at += size + 1;
        // Binary files (a NUL in the first bytes) aren't code.
        if (!body.subarray(0, 4000).includes(0)) out.set(p, body.toString('utf8'));
      }
      resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(paths.map((p) => `${ref}:${p}\n`).join(''));
  });
}

/** Read a repository's history and files: { commits, files (path -> metrics), scanned }. */
export async function scanRepo(dir, { days = 90, ref = 'HEAD' } = {}) {
  const [log, tree] = await Promise.all([
    run('git', ['log', `--since=${days}.days.ago`, '--no-merges', '--name-only', '--format=%x01%s', ref], { cwd: dir, timeout: 120_000 }),
    run('git', ['ls-tree', '-r', '-l', ref], { cwd: dir, timeout: 120_000 }),
  ]);
  const commits = parseLog(log);
  const sizes = parseTree(tree);
  const churn = new Map();
  for (const c of commits) for (const f of c.files) churn.set(f, (churn.get(f) ?? 0) + 1);
  const paths = [...sizes]
    .filter(([p, size]) => CODE.test(p) && !SKIP.test(p) && size > 0 && size <= MAX_BYTES && (churn.get(p) ?? 0) >= 2)
    .sort((a, b) => churn.get(b[0]) - churn.get(a[0]))
    .slice(0, MAX_FILES)
    .map(([p]) => p);
  const blobs = paths.length ? await readBlobs(dir, ref, paths) : new Map();
  return { commits, files: new Map([...blobs].map(([p, text]) => [p, metricsOf(text)])), scanned: paths.length };
}

export class Debt {
  /**
   * `projects()` lists the projects; `dirOf(project)` is its local repository (or null);
   * `bugs(project)` the files with open bugs; `queue(project, title)` hands a task to an agent.
   */
  constructor({ store, config = {}, projects, dirOf, bugs = () => [], queue = null, scan = scanRepo, onChange = () => {}, log = (m) => console.log(`[agentmgr] ${m}`), now = () => Date.now(), timer = true }) {
    Object.assign(this, { store, config, projects, dirOf, bugs, queue, scanFn: scan, onChange, log, now });
    this.running = new Map();
    if (timer && this.settings.enabled) {
      this.timer = setInterval(() => this.tick(), 30 * 60_000);
      this.first = setTimeout(() => this.tick(), 3 * 60_000);
      this.timer.unref?.();
      this.first.unref?.();
    }
  }

  get settings() {
    const s = { ...DEBT_DEFAULTS, ...this.config.debt };
    const num = (v, d, min) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d);
    return { enabled: s.enabled !== false, days: num(s.days, 90, 7), autoDays: num(s.autoDays, 7, 0), top: Math.min(100, num(s.top, 30, 5)) };
  }

  get state() {
    return (this.store.data.debt ??= { projects: {} });
  }

  close() {
    clearInterval(this.timer);
    clearTimeout(this.first);
  }

  project(ref) {
    const r = String(ref ?? '').trim().replace(/^@/, '').toLowerCase();
    const p = this.projects().find((x) => x.shortcut === r || x.key === ref || x.name.toLowerCase() === r);
    if (!p) throw err(404, `No project matches "${ref}"`);
    return p;
  }

  /** Scan a project's repository now (one scan of a project at a time). */
  scan(ref) {
    const p = this.project(ref);
    const dir = this.dirOf(p);
    if (!dir || !fs.existsSync(dir)) return Promise.reject(err(409, `${p.name} has no local repository yet: start an agent in it first`));
    if (!this.running.has(p.key)) {
      const s = this.settings;
      const job = (async () => {
        const rec = (this.state.projects[p.key] ??= { dismissed: {}, queued: {} });
        try {
          const r = await this.scanFn(dir, { days: s.days });
          const spots = hotSpots({ ...r, bugs: this.bugs(p), days: s.days, top: s.top + Object.keys(rec.dismissed ?? {}).length });
          Object.assign(rec, { at: new Date(this.now()).toISOString(), error: null, days: s.days, commits: r.commits.length, scanned: r.scanned, spots });
        } catch (e) {
          Object.assign(rec, { at: new Date(this.now()).toISOString(), error: String(e.message).slice(0, 300) });
          this.log(`debt: ${p.name}: ${e.message}`);
        }
        this.store.save();
      })().finally(() => {
        this.running.delete(p.key);
        this.onChange();
      });
      this.running.set(p.key, job);
      this.onChange();
    }
    return this.running.get(p.key).then(() => this.view());
  }

  /** The oldest scan that is due again (or a project never scanned that has a repository here): one per tick. */
  tick() {
    const s = this.settings;
    if (!s.enabled || !s.autoDays || this.running.size) return;
    const due = this.projects()
      .map((p) => ({ p, at: Date.parse(this.state.projects[p.key]?.at ?? '') || 0, dir: this.dirOf(p) }))
      .filter((x) => x.dir && fs.existsSync(x.dir) && this.now() - x.at >= s.autoDays * 86_400_000)
      .sort((a, b) => a.at - b.at)[0];
    if (due) this.scan(due.p.key).catch(() => {});
  }

  /** Hand a hot spot to an agent (through the backlog). */
  queueSpot(ref, file) {
    const p = this.project(ref);
    const rec = this.state.projects[p.key];
    const h = rec?.spots?.find((x) => x.file === file);
    if (!h) throw err(404, 'No such hot spot (scan again?)');
    if (!this.queue) throw err(409, 'The backlog is not available');
    const added = this.queue(p, debtTask(h));
    rec.queued = { ...rec.queued, [file]: { at: new Date(this.now()).toISOString(), id: added?.id ?? null } };
    this.store.save();
    this.onChange();
    return this.view();
  }

  /** Not debt (generated, or meant to be that way): off the list, also after the next scan. */
  dismiss(ref, file, dismissed = true) {
    const p = this.project(ref);
    const rec = (this.state.projects[p.key] ??= { dismissed: {}, queued: {} });
    rec.dismissed ??= {};
    if (dismissed) rec.dismissed[file] = new Date(this.now()).toISOString();
    else delete rec.dismissed[file];
    this.store.save();
    this.onChange();
    return this.view();
  }

  view() {
    const s = this.settings;
    const projects = this.projects().map((p) => {
      const rec = this.state.projects[p.key] ?? {};
      const dir = this.dirOf(p);
      const spots = (rec.spots ?? []).filter((h) => !rec.dismissed?.[h.file]).slice(0, s.top).map((h) => ({ ...h, queued: rec.queued?.[h.file]?.at ?? null }));
      return { key: p.key, shortcut: p.shortcut, name: p.name, hasRepo: Boolean(dir && fs.existsSync(dir)), scanning: this.running.has(p.key), at: rec.at ?? null, error: rec.error ?? null, days: rec.days ?? s.days, commits: rec.commits ?? 0, scanned: rec.scanned ?? 0, dismissed: Object.keys(rec.dismissed ?? {}).length, spots };
    });
    return { projects: projects.sort((a, b) => (b.spots[0]?.score ?? -1) - (a.spots[0]?.score ?? -1) || a.name.localeCompare(b.name)), settings: s };
  }
}
