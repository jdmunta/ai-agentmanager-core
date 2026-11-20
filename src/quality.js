// Quality: what happened to the agents' pull requests after they merged. For each one it looks,
// for some days after the merge, at what GitHub shows: whether it was reverted, whether a fix to
// the same files followed, and whether the checks failed on the commit it merged as; and, from
// before the merge, whether a reviewer asked for changes and how long it took. By day, week,
// month, quarter and year that gives the share of merged work that held up, next to how much was
// merged (value.js counts that). A follow-up fix is a guess from titles and files, so you can
// say a pull request was not a problem, or that it was one nothing here saw. No model is called.

import { PERIODS } from './value.js';
import { repoOf } from './landing.js';
import { ghBin } from './tracker.js';
import { run } from './git.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Like Value: a first run goes back about a quarter.
const BACKFILL_DAYS = 100;
const RECHECK_MS = 6 * HOUR;
const RETRY_MS = HOUR;
const PER_TICK = 3;

export const QUALITY_DEFAULTS = { enabled: true, watchDays: 14 };
export const VERDICTS = ['reverted', 'fixed', 'broke', 'problem', 'clean', 'watching', 'unchecked'];
const PROBLEMS = new Set(['reverted', 'fixed', 'broke', 'problem']);

const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Settings from config.json's "quality", with defaults and sane bounds. */
export function qualitySettings(config = {}) {
  const c = { ...QUALITY_DEFAULTS, ...config.quality };
  const days = Number(c.watchDays);
  return { enabled: c.enabled !== false, watchDays: Number.isFinite(days) ? Math.min(90, Math.max(1, Math.round(days))) : QUALITY_DEFAULTS.watchDays };
}

/** A title that says the change repairs something. */
export const looksLikeFix = (title) => /^\s*(fix|hotfix|bugfix|revert)\b|\b(fix(es|ed)?|hotfix|regression|broke[n]?|repair)\b/i.test(String(title ?? ''));

const mentions = (text, number) => new RegExp(`(^|[^\\w/])#${number}(?!\\d)|/pull/${number}(?!\\d)`).test(String(text ?? ''));

/**
 * What followed a merged pull request, from the repository's later merged pull requests and the
 * later commits on its base branch: { reverted, fixes }.
 *   reverted - a pull request titled Revert "…" that names this one, or a commit that says it
 *              reverts the commit this one merged as.
 *   fixes    - pull requests merged within the watch days whose title says they fix something and
 *              that change a file this one changed, or name it. A guess: you can overrule it.
 */
export function followUps(it, { later = [], commits = [] } = {}, s = QUALITY_DEFAULTS) {
  const merged = Date.parse(it.mergedAt);
  const until = merged + s.watchDays * DAY;
  const files = new Set(it.facts?.files ?? []);
  let reverted = null;
  const fixes = [];
  for (const p of later) {
    const at = Date.parse(p.mergedAt);
    if (p.url === it.url || !(at > merged)) continue;
    const named = mentions(p.title, it.number) || mentions(p.body, it.number);
    if (/^\s*revert\b/i.test(p.title ?? '') && (named || (it.title && String(p.title).includes(it.title)))) {
      if (!reverted || at < Date.parse(reverted.at)) reverted = { number: p.number ?? null, title: clip(p.title, 160), url: p.url ?? null, at: new Date(at).toISOString() };
      continue;
    }
    if (at > until || !looksLikeFix(p.title)) continue;
    const shared = (p.files ?? []).map((f) => f.path ?? f).filter((f) => files.has(f));
    if (!shared.length && !named) continue;
    fixes.push({ number: p.number ?? null, title: clip(p.title, 160), url: p.url ?? null, at: new Date(at).toISOString(), shared: shared.slice(0, 5), named });
  }
  const sha = it.facts?.mergeCommit;
  if (!reverted && sha) {
    for (const c of commits) {
      const at = Date.parse(c.at);
      if (!(at > merged) || !String(c.message ?? '').includes(`This reverts commit ${sha}`)) continue;
      if (!reverted || at < Date.parse(reverted.at)) reverted = { number: null, title: clip(String(c.message).split('\n')[0], 160), url: c.url ?? null, at: new Date(at).toISOString() };
    }
  }
  fixes.sort((a, b) => a.at.localeCompare(b.at));
  return { reverted, fixes: fixes.slice(0, 5) };
}

/** GitHub's check runs on a commit -> { state: passed|failed|running|none, failed: [names] }. */
export function commitChecks(runs) {
  const list = Array.isArray(runs) ? runs : [];
  // A cancelled run was replaced by a newer one, or stopped by a person: not a failure of the change.
  const failed = list.filter((r) => ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)).map((r) => r.name ?? 'check');
  const running = list.filter((r) => r.status && r.status !== 'completed').length;
  return { state: !list.length ? 'none' : failed.length ? 'failed' : running ? 'running' : 'passed', failed: [...new Set(failed)].slice(0, 10) };
}

/** Where a merged pull request stands: one of VERDICTS. What you said wins. */
export function verdictOf(it, s = QUALITY_DEFAULTS, t = Date.now()) {
  if (it.mark?.verdict === 'clean') return 'clean';
  if (it.mark?.verdict === 'problem') return 'problem';
  if (!it.after) return 'unchecked';
  if (it.after.reverted) return 'reverted';
  if (it.after.fixes?.length) return 'fixed';
  if (it.after.checks?.state === 'failed') return 'broke';
  return t < Date.parse(it.mergedAt) + s.watchDays * DAY ? 'watching' : 'clean';
}

const median = (list) => {
  const a = list.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const round = (n, d = 0) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

/** Totals for a set of merged pull requests. */
export function totals(items, s = QUALITY_DEFAULTS, t = Date.now()) {
  const out = { prs: items.length, reverted: 0, fixed: 0, broke: 0, problem: 0, clean: 0, watching: 0, unchecked: 0, changesRequested: 0 };
  for (const it of items) {
    out[verdictOf(it, s, t)] += 1;
    if ((it.facts?.changesRequested ?? 0) > 0) out.changesRequested += 1;
  }
  out.problems = out.reverted + out.fixed + out.broke + out.problem;
  // Of the ones looked at: the share that held up, and the share that didn't.
  out.checked = out.prs - out.unchecked;
  out.held = out.clean + out.watching;
  out.heldPct = out.checked ? round((out.held / out.checked) * 100) : null;
  out.failurePct = out.checked ? round((out.problems / out.checked) * 100) : null;
  const known = items.filter((it) => it.facts);
  out.changesPct = known.length ? round((out.changesRequested / known.length) * 100) : null;
  out.hoursToMerge = round(median(items.map((it) => (Date.parse(it.mergedAt) - Date.parse(it.openedAt)) / HOUR)), 1);
  return out;
}

/** The last `count` periods of a kind, newest first, each with its totals and pull requests. */
export function aggregate(items, s = QUALITY_DEFAULTS, { period = 'week', count, t = Date.now() } = {}) {
  const P = PERIODS[period];
  if (!P) throw err(400, `period is one of ${Object.keys(PERIODS).join(', ')}`);
  const out = [];
  let start = P.start(t);
  for (let i = 0; i < (count ?? P.count); i++) {
    const end = P.next(start);
    const from = start;
    const inside = items.filter((it) => {
      const at = Date.parse(it.mergedAt);
      return at >= from && at < end;
    });
    out.push({ key: P.key(start), label: P.label(start), start: new Date(start).toISOString(), end: new Date(end).toISOString(), current: i === 0, totals: totals(inside, s, t), items: inside.map((it) => it.url) });
    start = P.start(start - 1);
  }
  return out;
}

const VERDICT_TEXT = { reverted: 'reverted', fixed: 'fixed afterwards', broke: 'checks failed after the merge', problem: 'a problem (marked by me)', clean: 'held up', watching: 'no problem so far', unchecked: 'not looked at yet' };

/** A period's report as Markdown. */
export function qualityMarkdown(p, items, s = QUALITY_DEFAULTS, { who = '', prev = null, t = Date.now() } = {}) {
  const x = p.totals;
  const was = prev?.totals.checked ? ` (${prev.totals.heldPct}% the period before)` : '';
  const lines = [
    `# Quality of merged work: ${p.label}${who ? `, ${who}` : ''}`,
    '',
    `${x.prs} pull request${x.prs === 1 ? '' : 's'} from AI agents merged.`,
    '',
    `- **Held up**: ${x.heldPct == null ? 'n/a' : `${x.heldPct}%`}${was}: ${x.held} of ${x.checked} looked at${x.watching ? `, ${x.watching} still within the ${s.watchDays} days watched` : ''}`,
    `- **Problems after the merge**: ${x.problems}: ${x.reverted} reverted, ${x.fixed} fixed afterwards, ${x.broke} with failed checks${x.problem ? `, ${x.problem} marked by me` : ''}`,
    `- **Before the merge**: a reviewer asked for changes on ${x.changesRequested}${x.changesPct == null ? '' : ` (${x.changesPct}%)`}; ${x.hoursToMerge == null ? 'n/a' : `${x.hoursToMerge} hours`} from opened to merged (median)`,
    '',
  ];
  const bad = items.filter((it) => PROBLEMS.has(verdictOf(it, s, t)));
  if (bad.length) {
    lines.push('## What did not hold up', '');
    for (const it of bad.slice(0, 25)) {
      const v = verdictOf(it, s, t);
      const by = v === 'reverted' ? it.after?.reverted : v === 'fixed' ? it.after?.fixes?.[0] : null;
      const why = v === 'broke' ? `: ${(it.after?.checks?.failed ?? []).join(', ')}` : by ? `: ${by.url ? `[${by.title}](${by.url})` : by.title}` : it.mark?.note ? `: ${it.mark.note}` : '';
      lines.push(`- [#${it.number ?? '?'} ${clip(it.title, 100)}](${it.url}): ${VERDICT_TEXT[v]}${why}`);
    }
    lines.push('');
  }
  lines.push(`_From what GitHub shows for ${s.watchDays} days after each merge. "Fixed afterwards" is a later fix to the same files, which is a guess. Made with AI Agent Manager._`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- GitHub, through the gh CLI

/** owner/repo (and the host, when it isn't github.com) for gh api. */
const apiArgs = (repo) => {
  const parts = String(repo).split('/');
  return parts.length === 3 ? { host: ['--hostname', parts[0]], path: `repos/${parts[1]}/${parts[2]}` } : { host: [], path: `repos/${repo}` };
};
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** What Quality asks GitHub, each returning plain data (swapped out in the tests). */
export const github = {
  /** The facts of a merged pull request that don't change after the merge. */
  async facts(url) {
    const p = JSON.parse(await run(ghBin(), ['pr', 'view', url, '--json', 'number,title,mergeCommit,baseRefName,files,reviews,additions,deletions,createdAt,mergedAt'], { timeout: 30_000 }));
    return {
      mergeCommit: p.mergeCommit?.oid ?? null,
      base: p.baseRefName ?? null,
      files: (p.files ?? []).map((f) => f.path).filter(Boolean).slice(0, 300),
      lines: (p.additions ?? 0) + (p.deletions ?? 0),
      changesRequested: (p.reviews ?? []).filter((r) => r.state === 'CHANGES_REQUESTED').length,
      reviews: (p.reviews ?? []).length,
    };
  },
  /** Pull requests merged in a repository since a time. */
  async mergedSince(repo, since) {
    const out = await run(ghBin(), ['pr', 'list', '--repo', repo, '--state', 'merged', '--search', `merged:>=${day(since)}`, '--limit', '200', '--json', 'number,title,url,mergedAt,body,files'], { timeout: 60_000 });
    return JSON.parse(out || '[]').map((p) => ({ number: p.number, title: p.title, url: p.url, mergedAt: p.mergedAt, body: clip(p.body, 2000), files: (p.files ?? []).map((f) => f.path).filter(Boolean) }));
  },
  /** Commits on a branch since a time, for reverts pushed without a pull request. */
  async commitsSince(repo, base, since) {
    const { host, path } = apiArgs(repo);
    const out = await run(ghBin(), ['api', ...host, `${path}/commits?sha=${encodeURIComponent(base)}&since=${new Date(since).toISOString()}&per_page=100`], { timeout: 60_000 });
    return JSON.parse(out || '[]').map((c) => ({ sha: c.sha, message: c.commit?.message ?? '', at: c.commit?.committer?.date ?? c.commit?.author?.date ?? null, url: c.html_url ?? null }));
  },
  /** The check runs on a commit. */
  async checkRuns(repo, sha) {
    const { host, path } = apiArgs(repo);
    const out = await run(ghBin(), ['api', ...host, `${path}/commits/${sha}/check-runs?per_page=100`], { timeout: 30_000 });
    return (JSON.parse(out || '{}').check_runs ?? []).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
  },
};

export class Quality {
  constructor({ manager, store, config = {}, who = null, gh = github, onChange = () => {}, log = (m) => console.log(`[agentmgr] ${m}`) }) {
    Object.assign(this, { manager, store, config, who, gh, onChange, log });
    this.repoCache = new Map(); // repo -> { at, since, later, commits: Map(base -> list) }
    this.busy = false;
    this.timer = setInterval(() => this.tick().catch((e) => this.log(`quality: ${e.message}`)), 120_000);
    this.timer.unref?.();
    this.first = setTimeout(() => this.tick().catch((e) => this.log(`quality: ${e.message}`)), config.qualityFirstMs ?? 20_000);
    this.first.unref?.();
  }

  close() {
    clearInterval(this.timer);
    clearTimeout(this.first);
  }

  get settings() {
    return qualitySettings(this.config);
  }

  get state() {
    return (this.store.data.quality ??= { items: {} });
  }

  /** Add the agents' newly merged pull requests; keep names current. */
  scan(t = Date.now()) {
    const st = this.state;
    let added = 0;
    for (const a of this.store.list()) {
      if (a.kind !== 'task') continue;
      for (const p of Object.values(a.prs ?? {})) {
        if (p.source === 'mentioned' || p.state !== 'MERGED' || !p.url || !Number.isFinite(Date.parse(p.mergedAt))) continue;
        const cur = st.items[p.url];
        if (!cur && Date.parse(p.mergedAt) < t - BACKFILL_DAYS * DAY) continue;
        const fields = {
          url: p.url,
          number: p.number ?? (Number(/\/pull\/(\d+)/.exec(p.url)?.[1]) || null),
          title: clip(p.title ?? a.name, 160),
          repo: repoOf(p.url),
          agentId: a.id,
          agentName: a.name,
          project: this.manager.view(a).projectInfo?.name ?? null,
          openedAt: p.openedAt ?? null,
          mergedAt: new Date(p.mergedAt).toISOString(),
        };
        if (!cur) {
          st.items[p.url] = { ...fields, facts: null, after: null, addedAt: new Date(t).toISOString() };
          added++;
        } else Object.assign(cur, fields);
      }
    }
    if (added) this.store.save();
    return added;
  }

  /** A repository's later pull requests and commits, asked once for all its watched pull requests. */
  async repoAfter(repo, base, since, t) {
    let c = this.repoCache.get(repo);
    if (!c || t - c.at > 10 * 60_000 || c.since > since) {
      c = { at: t, since, later: await this.gh.mergedSince(repo, since), commits: new Map() };
      this.repoCache.set(repo, c);
    }
    if (base && !c.commits.has(base)) c.commits.set(base, await this.gh.commitsSince(repo, base, c.since).catch(() => []));
    return { later: c.later, commits: (base && c.commits.get(base)) || [] };
  }

  /** Look at one pull request now: its facts once, then what followed it (`fresh`: ask GitHub again, not what was asked minutes ago). */
  async check(url, { t = Date.now(), fresh = false } = {}) {
    const it = this.state.items[url];
    if (!it) throw err(404, 'No merged pull request with that link');
    if (process.env.AGENTMGR_NO_GH) throw err(409, 'GitHub is not asked here (AGENTMGR_NO_GH is set)');
    if (!it.repo) throw err(400, 'Not a GitHub pull request link');
    const s = this.settings;
    if (fresh) this.repoCache.delete(it.repo);
    try {
      it.facts ??= await this.gh.facts(url);
      const merged = Date.parse(it.mergedAt);
      // The oldest pull request of this repository still watched: one list serves them all.
      const since = Math.min(merged, ...Object.values(this.state.items).filter((o) => o.repo === it.repo && !o.final).map((o) => Date.parse(o.mergedAt)));
      const { later, commits } = await this.repoAfter(it.repo, it.facts.base, since, t);
      const after = followUps(it, { later, commits }, s);
      // Checks once they have all finished: they don't change after.
      const had = it.after?.checks;
      after.checks = had && had.state !== 'running' && had.state !== 'none' ? had : it.facts.mergeCommit ? commitChecks(await this.gh.checkRuns(it.repo, it.facts.mergeCommit).catch(() => [])) : { state: 'none', failed: [] };
      it.after = after;
      it.checkedAt = new Date(t).toISOString();
      delete it.error;
      // A revert can come any time, but nothing is looked for after the watch days.
      it.final = t > merged + s.watchDays * DAY && after.checks.state !== 'running';
    } catch (e) {
      it.error = clip(e.message, 200);
      it.triedAt = new Date(t).toISOString();
      throw err(502, `GitHub: ${it.error}`);
    } finally {
      this.store.save();
      this.onChange();
    }
    return this.itemView(it, t);
  }

  /** The pull requests due a look: never looked at first, then the ones not looked at for longest. */
  due(t = Date.now()) {
    return Object.values(this.state.items)
      .filter((it) => it.repo && !it.final && !(it.error && t - Date.parse(it.triedAt) < RETRY_MS) && !(it.checkedAt && t - Date.parse(it.checkedAt) < RECHECK_MS))
      .sort((a, b) => (a.checkedAt ?? '').localeCompare(b.checkedAt ?? '') || b.mergedAt.localeCompare(a.mergedAt));
  }

  /** What you say about a pull request: 'clean' (not a problem), 'problem', or null for what was found. */
  mark(url, { verdict = null, note = '' } = {}) {
    const it = this.state.items[url];
    if (!it) throw err(404, 'No merged pull request with that link');
    if (verdict !== null && verdict !== 'clean' && verdict !== 'problem') throw err(400, 'verdict is clean, problem or null');
    if (verdict === null) delete it.mark;
    else it.mark = { verdict, note: clip(note, 300), at: new Date().toISOString() };
    this.store.save();
    this.onChange();
    return this.itemView(it);
  }

  update(patch = {}) {
    if (patch.watchDays !== undefined && !Number.isFinite(Number(patch.watchDays))) throw err(400, 'watchDays must be a number');
    this.config.quality = qualitySettings({ quality: { ...this.config.quality, ...patch } });
    // Longer watch days: look again at the ones that were done.
    for (const it of Object.values(this.state.items)) if (it.final && Date.now() < Date.parse(it.mergedAt) + this.config.quality.watchDays * DAY) it.final = false;
    this.onChange();
    return this.config.quality;
  }

  itemView(it, t = Date.now()) {
    return { ...it, verdict: verdictOf(it, this.settings, t), gone: !this.store.get(it.agentId) };
  }

  view({ period = 'week', t = Date.now() } = {}) {
    this.scan(t);
    const s = this.settings;
    const all = Object.values(this.state.items).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
    return { settings: s, period, periods: aggregate(all, s, { period, t }), items: all.map((it) => this.itemView(it, t)), github: !process.env.AGENTMGR_NO_GH };
  }

  /** A period's report: the latest complete one of a kind, or the current one so far. */
  async report(kind = 'week', { current = false, t = Date.now() } = {}) {
    if (!PERIODS[kind]) throw err(400, `kind is one of ${Object.keys(PERIODS).join(', ')}`);
    this.scan(t);
    const s = this.settings;
    const start = current ? PERIODS[kind].start(t) : PERIODS[kind].start(PERIODS[kind].start(t) - 1);
    // Verdicts as of now, for the period that started then.
    const [p, prev] = aggregate(Object.values(this.state.items), s, { period: kind, count: 2, t: start }).map((x) => ({ ...x, totals: totals(x.items.map((u) => this.state.items[u]), s, t) }));
    return { period: p, markdown: qualityMarkdown(p, p.items.map((u) => this.state.items[u]), s, { who: (await this.who) ?? '', prev, t }) };
  }

  async tick(t = Date.now()) {
    if (!this.settings.enabled || this.busy) return;
    this.busy = true;
    try {
      if (this.scan(t)) this.onChange();
      if (process.env.AGENTMGR_NO_GH) return;
      for (const it of this.due(t).slice(0, PER_TICK)) await this.check(it.url, { t }).catch(() => {});
    } finally {
      this.busy = false;
    }
  }
}
