// Night watch: does merged work still hold on the latest main? An agent's proof (proof.js) shows
// its checks passed on its own branch. Later merges can break that without any one review seeing
// it. So, for work merged in the last days, the recorded commands are run again against the latest
// main, in a checkout of its own (the agent's folder is left alone), and each is compared with
// what was recorded. A proof that no longer holds names the commits since its merge that changed
// the same files: where to look first. Off until you turn it on (it runs agents' commands on this
// computer); run by hand any time. A command that changes things is never run (proof.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from './git.js';
import { changesThings, compareRun, parseProof, proofPath } from './proof.js';

export const NIGHT_DEFAULTS = { enabled: false, hour: 3, days: 14, maxAgents: 12 };
const MAX_COMMANDS = 6;
// Installed dependencies are not part of git: the agent's own are lent to the checkout.
const DEPS = ['node_modules', '.venv', 'venv', 'vendor'];

export function nightSettings(config = {}) {
  const n = config.nightWatch ?? {};
  const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return { enabled: n.enabled === true, hour: num(n.hour, NIGHT_DEFAULTS.hour, 0, 23), days: num(n.days, NIGHT_DEFAULTS.days, 1, 90), maxAgents: num(n.maxAgents, NIGHT_DEFAULTS.maxAgents, 1, 50) };
}

/** Whether a scheduled run is due: on, at its hour or after, and not yet run today. */
export function due(settings, lastRunAt, t = new Date()) {
  if (!settings.enabled || t.getHours() < settings.hour) return false;
  const last = lastRunAt ? new Date(lastRunAt) : null;
  return !last || last.toDateString() !== t.toDateString();
}

/** The merged work to watch: merged in the last `days`, its agent still known, newest first. */
export function watchList(items, { days, maxAgents }, t = Date.now()) {
  return items
    .filter((it) => it.agentId && it.facts?.mergeCommit && Date.parse(it.mergedAt) >= t - days * 86_400_000)
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    .slice(0, maxAgents);
}

/** One merged piece of work: { status: 'holds' | 'broken' | 'skipped', why?, results, suspects }. */
export function verdictOf(results) {
  const ran = results.filter((r) => r.status !== 'skipped');
  if (!ran.length) return 'skipped';
  return ran.some((r) => r.status === 'differs') ? 'broken' : 'holds';
}

export class NightWatch {
  constructor({ manager, store, quality, run, config = {}, log = () => {}, readProof = (id) => fs.readFileSync(proofPath(id), 'utf8') }) {
    Object.assign(this, { manager, store, quality, run, config, log, readProof });
    store.data.nightWatch ??= { lastRunAt: null, runs: {} };
    this.state = store.data.nightWatch;
    this.running = null;
  }

  get settings() {
    return nightSettings(this.config);
  }

  view() {
    const runs = Object.values(this.state.runs).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
    return { settings: this.settings, lastRunAt: this.state.lastRunAt, running: Boolean(this.running), runs, broken: runs.filter((r) => r.status === 'broken').length };
  }

  /** Called on a timer: runs when due. */
  tick(t = new Date()) {
    if (this.running || !due(this.settings, this.state.lastRunAt, t)) return null;
    return this.runAll().catch((e) => this.log(`night watch: ${e.message}`));
  }

  /** Watch every piece of merged work in the list now. The person's call, or the schedule's. */
  async runAll() {
    if (this.running) return this.running;
    this.running = (async () => {
      const list = watchList(this.quality.view().items, this.settings);
      for (const it of list) {
        const r = await this.watch(it).catch((e) => ({ status: 'skipped', why: e.message, results: [], suspects: [] }));
        this.state.runs[it.url] = { url: it.url, number: it.number ?? null, title: it.title ?? null, agentId: it.agentId, mergedAt: it.mergedAt, at: new Date().toISOString(), ...r };
        const a = this.store.get(it.agentId);
        if (a) this.manager.patch(a.id, { nightWatch: { at: new Date().toISOString(), status: r.status, mainSha: r.mainSha ?? null, broken: (r.results ?? []).filter((x) => x.status === 'differs').map((x) => x.title), suspects: (r.suspects ?? []).slice(0, 3), url: it.url } });
      }
      // Kept for the work still watched, and a little after (twice its days).
      const keep = Date.now() - 2 * this.settings.days * 86_400_000;
      for (const [url, r] of Object.entries(this.state.runs)) if (Date.parse(r.mergedAt) < keep) delete this.state.runs[url];
      this.state.lastRunAt = new Date().toISOString();
      this.store.save();
      return this.view();
    })().finally(() => (this.running = null));
    return this.running;
  }

  /** One merged piece of work against the latest main. */
  async watch(it) {
    const agent = this.store.get(it.agentId);
    let entries = [];
    try {
      entries = parseProof(this.readProof(it.agentId)).filter((e) => e.command);
    } catch {}
    if (!entries.length) return { status: 'skipped', why: 'It recorded no commands', results: [], suspects: [] };
    const repoDir = agent?.sourceDir;
    if (!repoDir || !(await git.isGitRepo(repoDir))) return { status: 'skipped', why: 'Its repository is not on this computer', results: [], suspects: [] };
    await git.fetch(repoDir).catch(() => {});
    const base = it.facts.base || 'main';
    const ref = await git.run('git', ['rev-parse', '--verify', '--quiet', `origin/${base}`], { cwd: repoDir }).catch(() => git.run('git', ['rev-parse', '--verify', base], { cwd: repoDir }));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmgr-night-'));
    try {
      await git.run('git', ['worktree', 'add', '--detach', '--force', dest, ref], { cwd: repoDir, timeout: 5 * 60_000 });
      for (const d of DEPS) {
        const from = agent.workdir && path.join(agent.workdir, d);
        if (from && fs.existsSync(from) && !fs.existsSync(path.join(dest, d))) fs.symlinkSync(from, path.join(dest, d));
      }
      const results = [];
      let ran = 0;
      for (const e of entries) {
        const why = changesThings(e.command) ?? (ran >= MAX_COMMANDS ? `only the first ${MAX_COMMANDS} are run` : null);
        if (why) {
          results.push({ title: e.title, command: e.command, status: 'skipped', why });
          continue;
        }
        ran++;
        this.log(`night watch: ${it.title ?? it.url}: ${e.command}`);
        const r = await this.run(e.command, { cwd: dest, timeoutMs: 180_000 });
        results.push({ title: e.title, command: e.command, code: r.code, tail: String(r.tail ?? '').split('\n').slice(-8).join('\n').slice(-800), ...compareRun(e, r) });
      }
      const status = verdictOf(results);
      // Where to look first: the commits since its merge that changed the files it changed.
      let suspects = [];
      if (status === 'broken') {
        const files = (it.facts.files ?? []).slice(0, 100);
        const out = await git.run('git', ['log', '--format=%h%x09%s%x09%cI', '-n', '8', `${it.facts.mergeCommit}..${ref}`, '--', ...files], { cwd: repoDir }).catch(() => '');
        suspects = out.split('\n').filter(Boolean).map((l) => {
          const [sha, subject, at] = l.split('\t');
          return { sha, subject, at };
        });
      }
      return { status, mainSha: ref.slice(0, 9), results, suspects };
    } finally {
      await git.run('git', ['worktree', 'remove', '--force', dest], { cwd: repoDir }).catch(async () => {
        fs.rmSync(dest, { recursive: true, force: true });
        await git.run('git', ['worktree', 'prune'], { cwd: repoDir }).catch(() => {});
      });
    }
  }
}

export function nightMarkdown(v) {
  const out = ['# Night watch', '', v.lastRunAt ? `Last run ${v.lastRunAt}. ${v.broken} of ${v.runs.length} no longer hold on main.` : 'Not run yet.', ''];
  for (const r of v.runs) {
    out.push(`## ${r.status === 'broken' ? 'No longer holds' : r.status === 'holds' ? 'Holds' : 'Not checked'}: ${r.number ? `#${r.number} ` : ''}${r.title ?? r.url}`, '');
    if (r.why) out.push(r.why, '');
    for (const x of r.results ?? []) out.push(`- ${x.status === 'differs' ? 'Differs' : x.status === 'same' ? 'Same' : 'Skipped'}: ${x.title} \`${x.command}\`${x.status === 'differs' ? ` (exit ${x.code})` : ''}`);
    if (r.suspects?.length) out.push('', 'Changed the same files since it merged:', ...r.suspects.map((s) => `- ${s.sha} ${s.subject}`));
    out.push('');
  }
  return out.join('\n').trimEnd();
}
