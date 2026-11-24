// Weekly summary: one page on a week's work and achievements, written for management. It is put
// together from what is already recorded, with no model call:
//   the work record (worklog.js) - pull requests merged and opened, bugs fixed, issues filed
//   Value (value.js)             - what each delivered piece is, and the hours and money estimated
//   Quality (quality.js)         - how the week's merged pull requests held up
//   the agents as they are now   - what is in progress, and what is blocked
// Work that is kept private (private.js) is counted but not described: no title and no link.
// It is a draft for you: shown, copied or saved as a file. Nothing is sent to anyone.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { dayKey } from './budgets.js';
import { keptPrivate } from './private.js';
import { totals as qualityTotals } from './quality.js';
import { itemValue, totals as valueTotals } from './value.js';
import { weekRow, weekStart } from './worklog.js';

const DAY = 86_400_000;
const PRIVATE = '(kept private)';
const clip = (s, n = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (n) => (n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);
const dayLabel = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** The Monday a week's summary starts on: the week before `t`, or the one `t` is in. */
export const weekOf = (t = Date.now(), { current = false } = {}) => (current ? weekStart(t) : weekStart(weekStart(t) - DAY));

/**
 * A week's facts. `events`: the work record's rows; `spend`: the spend ledger's days; `value` and
 * `quality`: { items, settings } of those modules; `agents`: [{ agent, view }] as they are now.
 */
export function weeklyFacts({ start, events = [], spend = {}, value = null, quality = null, agents = [], t = Date.now() }) {
  const end = start + 7 * DAY;
  const inWeek = (iso) => Date.parse(iso) >= start && Date.parse(iso) < end;
  const hidden = new Set(agents.filter((x) => keptPrivate(x.agent)).map((x) => x.agent.id));
  const mine = events.filter((e) => inWeek(e.date));
  const entry = (e) => (hidden.has(e.agent_id) ? { project: e.project || 'Other', title: PRIVATE, link: null, bugs: '', private: true } : { project: e.project || 'Other', title: clip(e.title), link: e.link || null, bugs: e.bugs || '', agentId: e.agent_id });
  const of = (kind) => mine.filter((e) => e.event === kind).map(entry);
  const merged = of('pr_merged');
  // Finished without a merged pull request this week: an answer, a document, a change not merged yet.
  const mergedBy = new Set(mine.filter((e) => e.event === 'pr_merged').map((e) => e.agent_id));
  const finished = mine.filter((e) => e.event === 'agent_finished' && !mergedBy.has(e.agent_id)).map(entry);

  // What each delivered piece is, in Value's words, with its estimate.
  const vItems = (value?.items ?? []).filter((it) => !it.excluded && inWeek(it.deliveredAt));
  const worth = value ? valueTotals(vItems, value.settings) : null;
  const said = new Map(vItems.map((it) => [it.agentId, itemValue(it, value.settings)]));
  for (const e of [...merged, ...finished]) {
    const v = e.agentId && said.get(e.agentId);
    if (v?.summary) e.summary = clip(v.summary, 200);
    if (v?.humanHours != null) e.hours = v.humanHours;
  }
  // The three worth the most, as the week's highlights.
  const highlights = [...merged, ...finished]
    .filter((e) => !e.private && e.hours != null)
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 3);

  const qItems = (quality?.items ?? []).filter((it) => inWeek(it.mergedAt));
  const held = quality && qItems.length ? qualityTotals(qItems, quality.settings, t) : null;

  const open = agents
    .filter(({ agent: a }) => a.kind === 'task' && !a.team && !(a.brief?.status === 'done' || a.brief?.results?.outcome === 'done'))
    .map(({ agent: a, view: v }) => {
      const pr = Object.values(a.prs ?? {}).find((p) => p.state === 'OPEN' && p.source !== 'mentioned');
      const blocked = a.brief?.status === 'blocked' || a.brief?.results?.outcome === 'blocked';
      return {
        project: v?.projectInfo?.name ?? 'Other',
        title: hidden.has(a.id) ? PRIVATE : clip(String(a.intent ?? a.name).split('\n')[0], 120),
        state: blocked ? 'blocked' : pr ? 'in review' : 'in progress',
        link: hidden.has(a.id) ? null : pr?.url ?? null,
        blockers: blocked && !hidden.has(a.id) ? (a.brief?.results?.blockers ?? []).map((b) => clip(b, 160)) : [],
        private: hidden.has(a.id),
      };
    });

  return {
    start: dayKey(start),
    end: dayKey(end - DAY),
    label: `${dayLabel(start)} to ${dayLabel(end - DAY)}, ${new Date(end - DAY).getFullYear()}`,
    complete: t >= end,
    row: weekRow(start, events, spend),
    prev: weekRow(start - 7 * DAY, events, spend),
    merged,
    finished,
    bugs: of('bug_fixed'),
    filed: of('issue_filed'),
    highlights,
    worth,
    quality: held,
    problems: qItems.filter((it) => it.after?.reverted || it.after?.fixes?.length).map((it) => ({ title: hidden.has(it.agentId) ? PRIVATE : clip(it.title), link: hidden.has(it.agentId) ? null : it.url, what: it.after?.reverted ? 'reverted' : 'fixed afterwards' })),
    blocked: open.filter((o) => o.state === 'blocked'),
    open: open.filter((o) => o.state !== 'blocked'),
    keptPrivate: [...merged, ...finished, ...open].filter((e) => e.private).length,
    projects: [...new Set([...merged, ...finished].map((e) => e.project))],
  };
}

const item = (e) => `${e.link ? `[${e.title}](${e.link})` : e.title}${e.bugs ? ` (${e.bugs})` : ''}${e.summary ? `: ${e.summary}` : ''}`;
const byProject = (list, each) => {
  const out = [];
  for (const p of [...new Set(list.map((e) => e.project))]) {
    out.push(`**${p}**`, ...list.filter((e) => e.project === p).map((e) => `- ${each(e)}`), '');
  }
  return out;
};

/** The summary as Markdown: the week in a line, achievements, numbers, quality, what is next, and what is in the way. */
export function weeklyMarkdown(f, { who = '' } = {}) {
  const r = f.row;
  const out = [`# Weekly summary: ${f.label}`, '', `${who ? `${who} · ` : ''}${f.complete ? 'the week as it ended' : 'the week so far'}`, ''];
  const done = f.merged.length + f.finished.length;
  if (!done && !f.bugs.length && !r.prs_opened && !f.open.length && !f.blocked.length) return [...out, 'Nothing was recorded this week.'].join('\n');

  // One line a manager can repeat.
  const parts = [];
  if (r.prs_merged) parts.push(`${plural(r.prs_merged, 'pull request')} merged${f.projects.length > 1 ? ` across ${f.projects.length} projects` : f.projects.length === 1 ? ` in ${f.projects[0]}` : ''}`);
  if (f.finished.length) parts.push(`${plural(f.finished.length, 'more task')} finished`);
  if (r.bugs_fixed) parts.push(`${plural(r.bugs_fixed, 'bug')} fixed`);
  if (f.worth?.humanHours) parts.push(`about ${f.worth.humanHours} hours of engineering delivered${f.worth.yourHours ? ` for ${f.worth.yourHours} of mine` : ''}`);
  out.push('## The week in one line', '', parts.length ? `${parts.join('; ')}.` : 'Work is in progress; nothing was delivered yet.', '');

  if (f.highlights.length) out.push('## Highlights', '', ...f.highlights.map((e) => `- **${e.title}** (${e.project})${e.summary ? `: ${e.summary}` : ''}`), '');

  if (done) {
    out.push('## Achievements', '');
    if (f.merged.length) out.push('### Merged', '', ...byProject(f.merged, item));
    if (f.finished.length) out.push('### Finished, not merged yet or with no pull request', '', ...byProject(f.finished, item));
  }
  if (f.bugs.length) out.push('### Bugs fixed', '', ...f.bugs.map((e) => `- ${item(e)}`), '');
  if (f.filed.length) out.push('### Issues filed', '', ...f.filed.map((e) => `- ${item(e)}`), '');

  const p = f.prev;
  const num = (label, a, b) => `| ${label} | ${a === '' || a == null ? '—' : a} | ${b === '' || b == null ? '—' : b} |`;
  out.push('## Numbers', '', '| | This week | Week before |', '| --- | --- | --- |');
  out.push(num('Pull requests merged', r.prs_merged, p.prs_merged), num('Pull requests opened', r.prs_opened, p.prs_opened), num('Bugs fixed', r.bugs_fixed, p.bugs_fixed), num('Issues filed', r.issues_filed, p.issues_filed), num('Tasks finished', r.agents_finished, p.agents_finished), num('Hours from opened to merged (median)', r.median_hours_to_merge, p.median_hours_to_merge), num('AI cost', money(r.cost_usd), money(p.cost_usd)), '');
  if (f.worth?.estimated) {
    out.push(`Estimated value: about ${f.worth.humanHours} engineering hours (${money(f.worth.laborUsd)})${f.worth.savingsUsd ? `, ${money(f.worth.savingsUsd)} saved beyond that` : ''}${f.worth.roi ? `; ${f.worth.roi} times the AI cost` : ''}. These are estimates for ${f.worth.estimated} of ${plural(f.worth.items, 'delivered piece')}, not measurements.`, '');
  }

  if (f.quality) {
    out.push('## Quality', '', f.quality.checked ? `${f.quality.held} of ${plural(f.quality.checked, 'merged pull request')} looked at held up${f.quality.watching ? ` (${f.quality.watching} still watched)` : ''}.${f.quality.unchecked ? ` ${f.quality.unchecked} not looked at yet.` : ''}` : 'The merged pull requests have not been looked at yet.');
    for (const x of f.problems) out.push(`- ${x.link ? `[${x.title}](${x.link})` : x.title}: ${x.what}`);
    out.push('');
  }

  if (f.open.length) out.push('## In progress', '', ...byProject(f.open, (e) => `${e.link ? `[${e.title}](${e.link})` : e.title} (${e.state})`));
  if (f.blocked.length) out.push('## Blocked: needs a decision or help', '', ...f.blocked.map((e) => `- **${e.project}**: ${e.title}${e.blockers.length ? `. ${e.blockers.join('; ')}` : ''}`), '');
  if (f.keptPrivate) out.push(`${plural(f.keptPrivate, 'item')} above ${f.keptPrivate === 1 ? 'is' : 'are'} kept private and listed without a description.`, '');
  return out.join('\n').trimEnd();
}

export class Weekly {
  /** `worklog`, `value`, `quality`: the daemon's own; `who`: a promise or a name. */
  constructor({ manager, store, worklog, value = null, quality = null, who = null, config = {}, dir = path.join(paths.home, 'reports') }) {
    Object.assign(this, { manager, store, worklog, value, quality, who, config, dir });
    this.timer = setInterval(() => this.rollOver().catch(() => {}), 30 * 60_000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  fileFor(start) {
    return path.join(this.dir, `weekly-${dayKey(start)}.md`);
  }

  async report({ current = false, t = Date.now() } = {}) {
    await this.worklog.record(t).catch(() => {});
    const start = weekOf(t, { current });
    const facts = weeklyFacts({
      start,
      events: this.worklog.state.events,
      spend: this.store.data.spend?.days ?? {},
      value: this.value ? { items: Object.values(this.value.state.items), settings: this.value.settings } : null,
      quality: this.quality ? { items: Object.values(this.quality.state.items), settings: this.quality.settings } : null,
      agents: this.store.list().map((agent) => ({ agent, view: this.manager.view(agent) })),
      t,
    });
    const file = this.fileFor(start);
    return { week: { start: facts.start, end: facts.end, label: facts.label, complete: facts.complete }, facts, markdown: weeklyMarkdown(facts, { who: (await this.who) ?? '' }), file, saved: fs.existsSync(file) };
  }

  /** Write the summary to its file (again: replaced). Nothing is sent. */
  async save(opts = {}) {
    const r = await this.report(opts);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(r.file, `${r.markdown}\n`);
    return { ...r, saved: true };
  }

  /** Once a week is over, its summary is written as a draft file, once. */
  async rollOver(t = Date.now()) {
    if (this.config.weekly?.auto === false) return null;
    const start = weekOf(t);
    const st = (this.store.data.weekly ??= {});
    if (st.drafted === dayKey(start) || fs.existsSync(this.fileFor(start))) return null;
    const r = await this.save({ t });
    st.drafted = dayKey(start);
    this.store.save();
    return r;
  }
}
