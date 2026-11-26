// Agent races: one intent, N agents with different models or approaches, compared side by
// side (outcome, checks, size of change, cost, a test command run in each worktree) so the
// user can pick a winner. Races live in the state file next to the agents.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as git from './git.js';
import { cleanRuns, repeatRuns } from './eval.js';

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();

export class Races extends EventEmitter {
  constructor({ manager, store }) {
    super();
    this.manager = manager;
    this.store = store;
    store.data.races ??= {};
    this.running = new Map(); // `${raceId}:${agentId}` -> child process
    // Interrupted test runs can't be finished after a restart.
    for (const race of Object.values(store.data.races)) {
      for (const t of Object.values(race.tests ?? {})) if (t.status === 'running') Object.assign(t, { status: 'error', output: 'Interrupted by a daemon restart' });
    }
    manager.on('change', (a) => a.raceId && this.emit('change', a.raceId));
    manager.on('removed', (id) => {
      for (const race of Object.values(store.data.races)) {
        if (race.members.includes(id)) {
          race.members = race.members.filter((m) => m !== id);
          if (race.winner === id) race.winner = null;
          this.save(race);
        }
      }
    });
  }

  save(race) {
    this.store.save();
    if (race) this.emit('change', race.id);
  }

  /**
   * variants: [{ label?, model?, instructions? }] (at least 2). Everything else is passed to
   * agent creation (repo / dir / project / base / permissionMode ...). Each variant gets its
   * own worktree, so a repo URL or a git folder is required.
   */
  create({ intent, variants, testCommand, ...opts }) {
    intent = String(intent ?? '').trim();
    if (!intent) throw err(400, 'Intent is required');
    if (!Array.isArray(variants) || variants.length < 2) throw err(400, 'A race needs at least two variants');
    if (variants.length > 6) throw err(400, 'At most six variants');
    if (!opts.repo && !opts.dir && !opts.project) throw err(400, 'A race needs a repository URL, a git folder or a project');
    const id = `r${crypto.randomBytes(3).toString('hex')}`;
    const race = { id, intent, testCommand: testCommand?.trim() || null, createdAt: now(), members: [], tests: {}, winner: null };
    this.store.data.races[id] = race;
    variants.forEach((v, i) => {
      const label = (v.label?.trim() || v.model?.trim() || `v${i + 1}`).replace(/[^\w.-]+/g, '-').slice(0, 20);
      const a = this.manager.create({
        ...opts,
        intent: v.instructions?.trim() ? `${intent}\n\nApproach for this attempt: ${v.instructions.trim()}` : intent,
        name: `${opts.name || intent.split(/\s+/).slice(0, 4).join('-').toLowerCase().replace(/[^\w-]+/g, '')}-${label}`,
        model: v.model?.trim() || opts.model,
        worktree: true,
        race: { id, variant: { label, model: v.model?.trim() || opts.model || null, instructions: v.instructions?.trim() || null } },
      });
      race.members.push(a.id);
    });
    this.save(race);
    return this.view(id);
  }

  /**
   * Try the other path: an agent wrote down the ways it weighed (## Options, its preferred one
   * first, the one it takes). Path `n` is started as a second agent from the same base commit,
   * told to take that path, and the two are raced: the scoreboard, a test command run in both,
   * and picking the one to keep. A path already being tried is not started twice.
   */
  tryPath(agentId, n) {
    const src = this.manager.mustGet(agentId);
    const paths = src.brief?.options?.paths ?? [];
    n = Number(n);
    if (!paths.length) throw err(409, 'It has not written the paths it weighed (## Options in its brief)');
    if (!Number.isInteger(n) || n < 2 || n > paths.length) throw err(400, `Pick a path from 2 to ${paths.length}: path 1 is the one it takes`);
    if (src.kind !== 'task' || src.team) throw err(409, 'Only a task agent of its own can try another path');
    // In a race: only the one its own Try this path started (not a race of variants, nor one where it is the other path).
    if (src.raceId && this.store.data.races[src.raceId] && this.store.data.races[src.raceId].tryOf !== src.id) throw err(409, 'It is already in a race');
    const repoDir = src.sourceDir ?? src.workdir;
    if (!src.repo && !repoDir) throw err(409, 'It has no repository to start another agent in');
    const label = `path-${n}`;
    let race = src.raceId ? this.store.data.races[src.raceId] : null;
    if (race && race.members.some((m) => this.manager.get(m)?.variant?.label === label)) throw err(409, `Path ${n} is already being tried`);
    const p = paths[n - 1];
    const first = paths[0];
    const say = (x) => `"${x.name}"${x.what ? ` (${x.what})` : ''}`;
    const raceId = race?.id ?? `r${crypto.randomBytes(3).toString('hex')}`;
    const instructions = `Take path ${n}, ${say(p)}. Another agent is taking path 1, ${say(first)}: do not take that one. In ## Options, put the path you take first.`;
    const a = this.manager.create({
      intent: `${src.intent}\n\nApproach for this attempt: ${instructions}`,
      name: `${src.name}-path${n}`,
      ...(src.repo ? { repo: src.repo } : { dir: repoDir }),
      worktree: true,
      // The commit the first agent started from (its branch would carry its own path).
      base: src.baseRef?.split(' @ ')[1] ?? undefined,
      permissionMode: src.permissionMode ?? undefined,
      model: src.model ?? undefined,
      engine: src.engine ?? undefined,
      project: src.project ?? undefined,
      priority: src.priority,
      autonomy: src.autonomy?.level ?? undefined,
      designDoc: src.designDoc ?? undefined,
      // (It starts at once: what done means was agreed for the task with the first agent.)
      acceptance: false,
      race: { id: raceId, variant: { label, model: src.model ?? null, instructions: `Path ${n}: ${p.name}` } },
    });
    // The race is made once the agent is: a refused one leaves none behind.
    if (!race) {
      race = { id: raceId, intent: src.intent, testCommand: null, createdAt: now(), members: [src.id], tests: {}, winner: null, tryOf: src.id };
      this.store.data.races[raceId] = race;
      this.manager.patch(src.id, { raceId, variant: { label: 'path-1', model: src.model ?? null, instructions: `Path 1: ${first.name}` } });
    }
    race.members.push(a.id);
    this.save(race);
    return this.view(race.id);
  }

  get(id) {
    const race = this.store.data.races[id];
    if (!race) throw err(404, `No race ${id}`);
    return race;
  }

  list() {
    return Object.values(this.store.data.races).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => this.view(r.id));
  }

  /** Scoreboard: one row per attempt. */
  view(id) {
    const race = this.get(id);
    const rows = race.members
      .map((mid) => this.manager.get(mid))
      .filter(Boolean)
      .map((a) => {
        const files = this.manager.changeSets.get(a.id)?.files ?? {};
        const counted = Object.values(files);
        const checks = a.brief?.checks ?? [];
        const started = Date.parse(a.lastStartedAt ?? a.createdAt);
        const last = Date.parse(a.runtime.lastOutputAt ?? a.sessions.at(-1)?.lastActivity ?? a.updatedAt);
        return {
          id: a.id,
          name: a.name,
          variant: a.variant ?? null,
          status: a.status,
          working: a.runtime.busy,
          outcome: a.results?.outcome ?? null,
          briefStatus: a.brief?.status ?? null,
          checks: { passed: checks.filter((c) => c.state === 'passed').length, failed: checks.filter((c) => c.state === 'failed').length, total: checks.length },
          files: counted.length,
          added: counted.reduce((n, f) => n + (f.added ?? 0), 0),
          removed: counted.reduce((n, f) => n + (f.removed ?? 0), 0),
          costUsd: a.costUsd,
          tokens: a.usage?.io ?? 0,
          minutes: Number.isFinite(last - started) && last > started ? Math.round((last - started) / 60_000) : null,
          prs: a.prs.map((p) => ({ url: p.url, number: p.number, state: p.state })),
          tests: race.tests[a.id] ?? null,
        };
      });
    return { ...race, rows };
  }

  /** Run the race's test command in every attempt's worktree (two at a time). */
  async runTests(id, { command, runs } = {}) {
    const race = this.get(id);
    if (command !== undefined) race.testCommand = command.trim() || null;
    if (runs !== undefined) race.testRuns = cleanRuns(runs);
    if (!race.testCommand) throw err(400, 'Set a test command first');
    const queue = race.members.map((m) => this.manager.store.get(m)).filter((a) => a?.workdir);
    for (const a of queue) race.tests[a.id] = { status: 'queued', at: now() };
    this.save(race);
    const worker = async () => {
      for (let a = queue.shift(); a; a = queue.shift()) await this.runOne(race, a);
    };
    Promise.all([worker(), worker()]).catch(() => {});
    return this.view(id);
  }

  /**
   * The test command in one attempt's folder, as many times as the race asks (eval.js: one run
   * that fails is run once more). Passed in some runs and failed in others is "flaky".
   */
  async runOne(race, agent) {
    race.tests[agent.id] = { status: 'running', at: now() };
    this.save(race);
    const started = Date.now();
    const all = await repeatRuns(() => this.runOnce(race, agent), race.testRuns);
    const { exitCode, output, at, status } = all.shown;
    race.tests[agent.id] = { status: status === 'error' ? 'error' : all.passed ? 'passed' : all.flaky ? 'flaky' : 'failed', exitCode, runs: all.runs, passes: all.passes, seconds: Math.round((Date.now() - started) / 1000), output, at };
    this.save(race);
  }

  /** One run: { status, exitCode, output, at, passed, timedOut }. */
  runOnce(race, agent) {
    return new Promise((resolve) => {
      const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', race.testCommand], { cwd: agent.workdir, env: this.manager.childEnv(agent), detached: true });
      this.running.set(`${race.id}:${agent.id}`, child);
      let out = '';
      const keep = (d) => (out = (out + d).slice(-6000));
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, (this.manager.config.raceTestTimeoutSec ?? 900) * 1000);
      const finish = (code, error) => {
        clearTimeout(timer);
        this.running.delete(`${race.id}:${agent.id}`);
        // A command that could not be started is not run again.
        resolve({ status: error ? 'error' : code === 0 ? 'passed' : 'failed', exitCode: code, output: (error ? `${error}\n` : '') + out.slice(-4000), at: now(), passed: !error && code === 0, timedOut: timedOut || Boolean(error) });
      };
      child.on('error', (e) => finish(null, e.message));
      child.on('close', (code) => finish(code));
    });
  }

  async diff(id, agentId) {
    const race = this.get(id);
    if (!race.members.includes(agentId)) throw err(404, 'Not part of this race');
    const a = this.manager.store.get(agentId);
    const baseSha = a?.baseRef?.split(' @ ')[1];
    if (!a?.workdir || !baseSha) return { diff: '' };
    return { diff: await git.fullDiff(a.workdir, baseSha) };
  }

  /** Pick the winner. With cleanup, the other attempts are closed and deleted with their worktrees. */
  async pick(id, agentId, { cleanup = false } = {}) {
    const race = this.get(id);
    if (!race.members.includes(agentId)) throw err(404, 'Not part of this race');
    race.winner = agentId;
    race.decidedAt = now();
    this.save(race);
    if (cleanup) {
      for (const m of race.members.filter((x) => x !== agentId)) await this.manager.remove(m, { deleteWorkspace: true }).catch(() => {});
    }
    return this.view(id);
  }

  remove(id) {
    this.get(id);
    delete this.store.data.races[id];
    this.save();
    this.emit('removed', id);
    return { ok: true };
  }
}
