// Micro benchmarks per module, for the Jira issues that change them. You mark the modules of a
// project where speed matters (on the Map's Speed view), each with the Jira components or labels
// that mean it. An agent working a Jira issue benchmarks a module when its issue names it (a
// component or label, or the folder in the request), or when its change touches the module: if it
// says it's done without having measured one, it's asked to before it counts as done.
//
// The benchmarks of a module are kept on this computer, outside the repository (bench/ in the home
// folder), and reused: the next issue on the module runs the same ones again, before and after its
// change, and adds its own cases, so the numbers line up from one issue to the next. Each run
// leaves its numbers in BENCH.json next to the agent's brief; they are kept here per module and
// issue, and a case more than 5% slower is shown in Today.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { briefDir } from './brief.js';
import { cleanPath } from './bughunt.js';
import { paths } from './config.js';

export const RESULTS_FILE = 'BENCH.json';
export const resultsPath = (agentId) => path.join(briefDir(agentId), RESULTS_FILE);
// Slower than this (in percent) and the run shows in Today.
export const SLOWER_PCT = 5;
const MAX_RUNS = 500;
const MAX_CASES = 40;
const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const now = () => new Date().toISOString();

/** Where a module's benchmarks are kept: bench/<project>-<hash>/<module> in the home folder. */
export function moduleDir(projectKey, modulePath, home = paths.home) {
  const name = String(projectKey).split(/[/:]/).filter(Boolean).pop()?.replace(/[^\w.-]+/g, '-').slice(0, 40) || 'project';
  const hash = crypto.createHash('sha1').update(String(projectKey)).digest('hex').slice(0, 8);
  return path.join(home, 'bench', `${name}-${hash}`, (modulePath || '_root').replace(/\//g, '__'));
}

/** Whether a repository file is in the module (a folder; '' is the whole repository). */
export const inModule = (file, modulePath) => !modulePath || file === modulePath || file.startsWith(`${modulePath}/`);

/** Component or label names: trimmed, no duplicates (case aside), at most 20. */
function names(list) {
  const out = [];
  for (const n of (Array.isArray(list) ? list : String(list ?? '').split(',')).map((x) => clip(x, 80)).filter(Boolean)) {
    if (!out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out.slice(0, 20);
}

/**
 * The watched modules a Jira issue is about: a component or label of the issue is one of the
 * module's (or its folder's name), or the request names the folder ("src/storage").
 */
export function matchModules(modules, { components = [], labels = [], text = '' } = {}) {
  const tags = new Set([...components, ...labels].map((x) => String(x).trim().toLowerCase()).filter(Boolean));
  const body = String(text ?? '');
  return modules.filter((m) => {
    const own = [...(m.components ?? []), m.path.split('/').pop()].map((x) => String(x).toLowerCase()).filter(Boolean);
    if (own.some((x) => tags.has(x))) return true;
    // The folder by its path, not its last name alone: "api" in a sentence says little.
    return m.path.includes('/') && new RegExp(`(^|[\\s\`'"(])${m.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|[\\s\`'".,)]|$)`).test(body);
  });
}

/**
 * A case's numbers, checked: { name, unit, before, after, better, change, note }. `change` is how
 * much worse it got in percent (negative is faster), whichever way is better for the unit.
 */
export function normalizeCase(c) {
  if (!c || typeof c !== 'object') return null;
  const before = Number(c.before);
  const after = Number(c.after);
  const name = clip(c.name, 120);
  if (!name || !Number.isFinite(after) || after < 0) return null;
  const unit = clip(c.unit, 20) || null;
  // Throughput (ops/s, MB/s) is better higher; time is better lower.
  const better = c.better === 'higher' || c.better === 'lower' ? c.better : /\/s(ec)?$|ops|per sec|throughput/i.test(unit ?? '') ? 'higher' : 'lower';
  const has = Number.isFinite(before) && before > 0;
  const change = has ? Math.round(((better === 'lower' ? after / before : before / after) - 1) * 1000) / 10 : null;
  return { name, unit, before: has ? before : null, after, better, change, ...(c.note ? { note: clip(c.note, 300) } : {}) };
}

/** An agent's BENCH.json, checked: { runs: [{ module, command, cases }], env } (null when missing or unreadable). */
export function readResults(agentId) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resultsPath(agentId), 'utf8'));
  } catch {
    return null;
  }
  return normalizeResults(raw);
}

export function normalizeResults(raw) {
  // One module's results on their own, or a list of them.
  const list = Array.isArray(raw?.modules) ? raw.modules : Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const runs = [];
  for (const r of list) {
    const cases = (Array.isArray(r?.cases) ? r.cases : []).map(normalizeCase).filter(Boolean).slice(0, MAX_CASES);
    if (!cases.length) continue;
    let module = '';
    try {
      module = cleanPath(r.module ?? '');
    } catch {
      continue;
    }
    runs.push({ module, command: clip(r.command, 300) || null, cases });
  }
  return runs.length ? { runs, env: clip(raw?.env ?? list[0]?.env, 300) || null } : null;
}

/** The agent's instructions for the modules it benchmarks: [{ path, dir, existing }]. */
export function moduleBenchPrompt(file, json, modules) {
  const list = modules
    .map((m) => `- ${m.path || '(the whole repository)'}: the benchmarks are kept in ${m.dir}${m.existing ? ' (earlier issues left benchmarks there: read its README.md and run them as they are, then add cases for your change)' : ' (none yet: start them there, with a README.md that says what each measures and the one command that runs them)'}`)
    .join('\n');
  return (
    'Measure the speed of these modules with micro benchmarks, once your change works (tests pass):\n' +
    `${list}\n` +
    "Each module's benchmarks are kept outside the repository in the folder named, and reused from one issue to the next, " +
    'so the numbers can be compared: keep the existing cases and their names as they are (fix one only if your change breaks it, and say so), ' +
    'and add cases for the code you changed, with realistic inputs at two or three sizes. Never copy them into the repository or commit them. ' +
    'Warm up, run enough iterations for stable numbers, and take the median. Run every case on the base commit ' +
    '(check it out in a temporary git worktree) and on your change, back to back on this machine. ' +
    `Write the results to ${file} (Markdown: what was measured and the command, a table case | before | after | change, the environment, notes), and the numbers to ${json} as JSON:\n` +
    '{"modules": [{"module": "<folder as listed>", "command": "<how to run them>", "cases": [{"name": "<case>", "unit": "ns/op", "before": 1234, "after": 1100, "note": "<only when it got slower>"}]}], "env": "<CPU, OS, runtime>"}\n' +
    `A case more than ${SLOWER_PCT}% slower needs a note on why, or a fix. If you open a pull request, put the table in its description. ` +
    'Only real measurements: never estimate a number. Run them again if you change the code afterwards.'
  );
}

/** What the agent is told when it says it's done but changed a module without measuring it. */
export function askMessage(file, json, modules) {
  return `Before this is done: your change touches ${modules.map((m) => m.path || 'the repository').join(', ')}, where speed matters, and there are no benchmark results for it yet. ${moduleBenchPrompt(file, json, modules)} Then mark the brief done again.`;
}

export class ModuleBenchmarks {
  /**
   * `changedFiles(agent)` gives the files an agent's branch changed (repository paths), and
   * `read(agentId)` its results (both for tests); `home` is where the benchmarks are kept.
   */
  constructor({ manager, store, changedFiles = async () => [], read = readResults, home = paths.home, log = () => {} }) {
    this.manager = manager;
    this.store = store;
    this.changedFiles = changedFiles;
    this.read = read;
    this.home = home;
    this.log = log;
    this.onFinished = (agent) => {
      if (agent) this.finished(agent.id).catch((e) => this.log(`benchmarks: ${e.message}`));
    };
    manager.on('finished', this.onFinished);
    // The manager asks which modules an agent benchmarks, and how to tell it (manager.js).
    manager.benchModules = this;
  }

  close() {
    this.manager.off('finished', this.onFinished);
    if (this.manager.benchModules === this) this.manager.benchModules = null;
  }

  get modules() {
    return (this.store.data.benchModules ??= []);
  }

  get runs() {
    return (this.store.data.benchRuns ??= []);
  }

  /** Mark a module of a project for benchmarks, or change its components: { project, path, components }. */
  watch({ project, path: p, components } = {}) {
    const key = String(project ?? '').trim();
    if (!key) throw err(400, 'Which project?');
    const folder = cleanPath(p ?? '');
    let m = this.modules.find((x) => x.project === key && x.path === folder);
    if (!m) this.modules.push((m = { id: crypto.randomBytes(3).toString('hex'), project: key, path: folder, components: [], addedAt: now() }));
    if (components !== undefined) m.components = names(components);
    this.store.save();
    return this.view(m);
  }

  unwatch(id) {
    const i = this.modules.findIndex((x) => x.id === id);
    if (i < 0) throw err(404, 'No such module');
    this.modules.splice(i, 1);
    this.store.save();
    return { ok: true };
  }

  view(m) {
    const dir = moduleDir(m.project, m.path, this.home);
    return { ...m, dir, existing: fs.existsSync(dir) && fs.readdirSync(dir).length > 0 };
  }

  /** The watched modules of a project (by key). */
  of(projectKey) {
    return this.modules.filter((m) => m.project === projectKey);
  }

  /** An agent this applies to: a task with a Jira issue, not a hunter, fixer, reviewer or team member. */
  eligible(agent) {
    return Boolean(agent && agent.kind === 'task' && !agent.hunting && !agent.fixing && !agent.reviewing && !agent.team && !agent.builds && this.manager.issueKey(agent));
  }

  /** The modules an agent should benchmark from its issue: { components, labels } and its request. */
  forIssue(agent, fields = {}) {
    if (!this.eligible(agent)) return [];
    const key = this.manager.projectInfo(agent)?.key;
    return matchModules(this.of(key), { ...fields, text: agent.intent }).map((m) => this.view(m));
  }

  /** The modules an agent was given to benchmark, as it should be told them. */
  forAgent(agent) {
    const key = this.manager.projectInfo(agent)?.key;
    return (agent.benchModules ?? []).map((p) => this.view(this.of(key).find((m) => m.path === p) ?? { project: key, path: p }));
  }

  /** It says it's done: keep its numbers, or ask for them when its change touched a watched module. */
  async finished(agentId) {
    const agent = this.store.get(agentId);
    if (!agent) return null;
    const recorded = this.record(agent);
    if (!this.eligible(agent)) return { recorded, asked: [] };
    const key = this.manager.projectInfo(agent)?.key;
    const watched = this.of(key);
    if (!watched.length) return { recorded, asked: [] };
    const changed = await this.changedFiles(agent).catch(() => []);
    const measured = new Set((this.read(agent.id)?.runs ?? []).map((r) => r.module));
    const asked = new Set(agent.benchAsked ?? []);
    const missing = watched.filter((m) => changed.some((f) => inModule(f, m.path)) && !measured.has(m.path) && !asked.has(m.path)).map((m) => this.view(m));
    if (!missing.length) return { recorded, asked: [] };
    // Asked once per module: a second "done" without numbers stands.
    this.manager.addBenchModules(agent.id, missing, { asked: true });
    return { recorded, asked: missing.map((m) => m.path) };
  }

  /** Keep an agent's numbers, one run per module (a new run of the same agent replaces its last). */
  record(agent) {
    const res = this.read(agent.id);
    if (!res) return 0;
    const projectKey = this.manager.projectInfo(agent)?.key ?? null;
    const issue = this.manager.issueKey(agent);
    let n = 0;
    for (const r of res.runs) {
      const at = this.runs.findIndex((x) => x.agentId === agent.id && x.module === r.module);
      const prev = at >= 0 ? this.runs[at] : null;
      const worst = r.cases.reduce((w, c) => (c.change !== null && (w === null || c.change > w) ? c.change : w), null);
      const run = {
        id: prev?.id ?? crypto.randomBytes(3).toString('hex'),
        agentId: agent.id,
        agent: agent.name,
        issue,
        project: projectKey,
        module: r.module,
        command: r.command,
        env: res.env,
        cases: r.cases,
        worst,
        at: now(),
        ...(prev?.accepted ? { accepted: prev.accepted } : {}),
      };
      if (prev && JSON.stringify(prev.cases) === JSON.stringify(run.cases)) continue;
      if (at >= 0) this.runs.splice(at, 1);
      this.runs.unshift(run);
      n++;
    }
    if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;
    if (n) this.store.save();
    return n;
  }

  /** Slower than it should be, and nobody has said it's fine. */
  slower() {
    return this.runs.filter((r) => r.worst !== null && r.worst > SLOWER_PCT && !r.accepted);
  }

  /** "It's fine" for a slower run (Undo: `accepted` false). */
  accept(runId, accepted = true) {
    const r = this.runs.find((x) => x.id === runId);
    if (!r) throw err(404, 'No such benchmark run');
    if (accepted) r.accepted = now();
    else delete r.accepted;
    this.store.save();
    return r;
  }

  /** Ask the agent that made it slower to fix it, or explain. */
  askToFix(runId) {
    const r = this.runs.find((x) => x.id === runId);
    if (!r) throw err(404, 'No such benchmark run');
    const cases = r.cases.filter((c) => c.change !== null && c.change > SLOWER_PCT);
    const lines = cases.map((c) => `- ${c.name}: ${c.before} → ${c.after}${c.unit ? ` ${c.unit}` : ''} (${c.change}% slower)`).join('\n');
    this.manager.tell(r.agentId, `Your change made ${r.module || 'the repository'} slower in the micro benchmarks:\n${lines}\nFind out why and make it at least as fast as before, or, if it can't be, say why in the benchmark notes. Then run the benchmarks again and update the results.`, { source: 'benchmarks' });
    return { ok: true };
  }

  /** For the Map's Speed view: the project's watched modules, each with its issues' runs, newest first. */
  speed(projectKey) {
    const runs = this.runs.filter((r) => r.project === projectKey);
    return {
      modules: this.of(projectKey).map((m) => ({ ...this.view(m), runs: runs.filter((r) => r.module === m.path).slice(0, 20) })),
      // Measured in modules nobody marked (an agent with benchmarks on).
      other: runs.filter((r) => !this.of(projectKey).some((m) => m.path === r.module)).slice(0, 20),
      slowerPct: SLOWER_PCT,
    };
  }
}
