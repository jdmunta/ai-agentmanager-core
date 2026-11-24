// Weekly summary: one page on a week's work and achievements, written for management. It is put
// together from what is already recorded, with no model call:
//   the work record (worklog.js) - pull requests merged and opened, bugs fixed, issues filed
//   Value (value.js)             - what each delivered piece is, and the engineering hours estimated
//   the agents' own briefs       - how each piece was done, how it was checked, the risks named
//   Quality (quality.js)         - how the week's merged pull requests held up
//   the agents as they are now   - what is in progress, and what is blocked
// It is a technical summary: what was built and how it was verified. No money amounts are shown.
// Work that is kept private (private.js) is counted but not described: no title and no link.
// It is a draft for you: shown, copied or saved as a file. Nothing is sent to anyone.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { dayKey } from './budgets.js';
import { keptPrivate } from './private.js';
import { totals as qualityTotals } from './quality.js';
import { PERIODS, itemValue } from './value.js';
import { weekStart } from './worklog.js';

const DAY = 86_400_000;
const PRIVATE = '(kept private)';
const clip = (s, n = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayLabel = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** The first sentence or two of a text, cut to size: how a piece of work was done, from its brief's Solution. */
export function gist(text, max = 240) {
  const t = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/^\s*#.*$/gm, ' ').replace(/^[>*\-\s]+/gm, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const two = /^(.+?[.!?])(\s+.+?[.!?])?(?=\s|$)/.exec(t);
  return clip(two ? two[0] : t, max);
}

/** The part of the code a file is in: its first two folders ("src/engines"), or "(top level)". */
export const areaOf = (file) => {
  const parts = String(file).split('/');
  return parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '(top level)';
};

/**
 * The technical side of one piece of work, from the agent as it is now and from Quality's record
 * of its merged pull request: how it was done, what it touched, and how it was checked.
 */
export function techOf(agent, q = null) {
  const b = agent?.brief ?? {};
  const checks = b.checks ?? [];
  const sc = agent?.docs?.scorecard?.data;
  const br = agent?.breaks?.baseline?.ok ? agent.breaks.breaks ?? [] : null;
  const n = (st) => br.filter((x) => x.status === st).length;
  const risks = b.risks ?? [];
  const files = q?.facts?.files ?? [];
  const areas = {};
  for (const f of files) areas[areaOf(f)] = (areas[areaOf(f)] ?? 0) + 1;
  return {
    how: gist(b.solution),
    files: files.length || null,
    lines: q?.facts?.lines ?? null,
    areas: Object.entries(areas).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k]) => k),
    testFiles: files.filter((f) => /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)\.[a-z]+$|_test\.go$/i.test(f)).length,
    checksPassed: checks.filter((c) => c.state === 'passed').length,
    checksFailed: checks.filter((c) => c.state === 'failed').length,
    proof: agent?.proofDoc?.commands ?? 0,
    breaks: br && n('caught') + n('missed') ? { caught: n('caught'), tried: n('caught') + n('missed') } : q?.said?.breaks ?? null,
    score: Number.isFinite(sc?.overall) ? sc.overall : q?.said?.score ?? null,
    risks: risks.length ? { named: risks.length, avoided: risks.filter((r) => r.state === 'avoided').length, happened: risks.filter((r) => r.state === 'happened').length } : null,
    reviews: q?.facts?.reviews ?? null,
    changesRequested: q?.facts?.changesRequested ?? null,
    engine: agent?.engine ?? q?.said?.engine ?? null,
    model: agent?.model ?? q?.said?.model ?? null,
  };
}

/** How one piece was checked, in a line: "4 checks passed, 3 with recorded runs; tests tested: 5 of 6 breaks caught; scorecard 86". */
export function checkedLine(t) {
  if (!t) return '';
  const out = [];
  if (t.checksPassed || t.checksFailed) out.push(`${plural(t.checksPassed, 'check')} passed${t.checksFailed ? `, ${t.checksFailed} failed` : ''}`);
  if (t.proof) out.push(`${plural(t.proof, 'command')} recorded with ${t.proof === 1 ? 'its' : 'their'} output`);
  if (t.breaks) out.push(`tests tested: ${t.breaks.caught} of ${plural(t.breaks.tried, 'break')} caught`);
  if (t.score != null) out.push(`scorecard ${t.score}`);
  if (t.risks) out.push(`${t.risks.avoided} of ${plural(t.risks.named, 'named risk')} avoided${t.risks.happened ? `, ${t.risks.happened} happened` : ''}`);
  if (t.reviews) out.push(`${plural(t.reviews, 'review')}${t.changesRequested ? `, ${plural(t.changesRequested, 'change request')}` : ''}`);
  return out.join('; ');
}

/** The Monday a week's summary starts on: the week before `t`, or the one `t` is in. */
export const weekOf = (t = Date.now(), { current = false } = {}) => (current ? weekStart(t) : weekStart(weekStart(t) - DAY));

export const KINDS = { week: 'Weekly', month: 'Monthly', quarter: 'Quarterly' };

/**
 * The period a summary covers: a week (Monday to Sunday), a calendar month or a quarter; the one
 * that just ended, or the one `t` is in. { kind, start, end, prevStart, label, key }.
 */
export function periodOf(kind = 'week', t = Date.now(), { current = false } = {}) {
  if (!KINDS[kind]) throw Object.assign(new Error(`kind is one of ${Object.keys(KINDS).join(', ')}`), { status: 400 });
  if (kind === 'week') {
    const start = weekOf(t, { current });
    const end = start + 7 * DAY;
    return { kind, start, end: weekStart(end + DAY), prevStart: weekStart(start - DAY), label: `${dayLabel(start)} to ${dayLabel(end - DAY)}, ${new Date(end - DAY).getFullYear()}`, key: dayKey(start) };
  }
  const P = PERIODS[kind];
  const here = P.start(t);
  const start = current ? here : P.start(here - DAY);
  return { kind, start, end: P.next(start), prevStart: P.start(start - DAY), label: P.label(start), key: P.key(start) };
}

const median = (list) => {
  const a = list.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** The work record's counts between two moments. */
export function countRow(start, end, events) {
  const mine = events.filter((e) => Date.parse(e.date) >= start && Date.parse(e.date) < end);
  const n = (k) => mine.filter((e) => e.event === k).length;
  const hours = median(mine.filter((e) => e.event === 'pr_merged' && e.hours !== '' && e.hours != null).map((e) => Number(e.hours)));
  return { prs_opened: n('pr_opened'), prs_merged: n('pr_merged'), bugs_fixed: n('bug_fixed'), issues_filed: n('issue_filed'), agents_finished: n('agent_finished'), median_hours_to_merge: hours == null ? '' : Math.round(hours * 10) / 10 };
}

/**
 * A week's facts. `events`: the work record's rows; `spend`: the spend ledger's days; `value` and
 * `quality`: { items, settings } of those modules; `agents`: [{ agent, view }] as they are now.
 */
export function weeklyFacts({ start, end = start + 7 * DAY, prevStart = start - 7 * DAY, kind = 'week', label = null, events = [], value = null, quality = null, agents = [], t = Date.now() }) {
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
  const said = new Map(vItems.map((it) => [it.agentId, itemValue(it, value.settings)]));
  for (const e of [...merged, ...finished]) {
    const v = e.agentId && said.get(e.agentId);
    if (v?.summary) e.summary = clip(v.summary, 200);
    if (v?.humanHours != null) e.hours = v.humanHours;
  }
  // The technical side of each: how it was done, what it touched, how it was checked.
  const byId = new Map(agents.map((x) => [x.agent.id, x.agent]));
  const qBy = new Map((quality?.items ?? []).map((it) => [it.url, it]));
  for (const e of [...merged, ...finished]) {
    if (e.private || !e.agentId) continue;
    const q = (e.link && qBy.get(e.link)) || null;
    if (byId.get(e.agentId) || q) e.tech = techOf(byId.get(e.agentId), q);
  }
  const techs = [...merged, ...finished].map((e) => e.tech).filter(Boolean);
  const sum = (f) => techs.reduce((n, t) => n + (f(t) || 0), 0);
  const areaCount = {};
  for (const e of merged) for (const f of (e.link && qBy.get(e.link)?.facts?.files) || []) if (!e.private) areaCount[areaOf(f)] = (areaCount[areaOf(f)] ?? 0) + 1;
  const scores = techs.map((t) => t.score).filter(Number.isFinite);
  const tested = techs.filter((t) => t.breaks);
  const models = {};
  for (const t of techs) if (t.engine) models[`${t.engine}${t.model ? ` · ${t.model}` : ''}`] = (models[`${t.engine}${t.model ? ` · ${t.model}` : ''}`] ?? 0) + 1;
  const technical = techs.length
    ? {
        pieces: techs.length,
        files: sum((t) => t.files),
        lines: sum((t) => t.lines),
        testFiles: sum((t) => t.testFiles),
        areas: Object.entries(areaCount).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([area, files]) => ({ area, files })),
        checksPassed: sum((t) => t.checksPassed),
        checksFailed: sum((t) => t.checksFailed),
        proof: sum((t) => t.proof),
        tested: tested.length,
        breaksCaught: tested.reduce((n, t) => n + t.breaks.caught, 0),
        breaksTried: tested.reduce((n, t) => n + t.breaks.tried, 0),
        score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
        scored: scores.length,
        risksNamed: sum((t) => t.risks?.named),
        risksAvoided: sum((t) => t.risks?.avoided),
        risksHappened: sum((t) => t.risks?.happened),
        changesRequested: sum((t) => t.changesRequested),
        models: Object.entries(models).sort((x, y) => y[1] - x[1]).map(([name, n]) => ({ name, n })),
      }
    : null;

  // The size of the week, over the pieces listed: the hours a person would have needed, as Value estimates them.
  const listed = [...merged, ...finished].filter((e) => !e.private);
  const sized = listed.filter((e) => e.hours != null);
  const size = sized.length ? { hours: Math.round(sized.reduce((n, e) => n + e.hours, 0) * 10) / 10, estimated: sized.length, pieces: listed.length } : null;
  // The three worth the most, as the week's highlights.
  const highlights = [...merged, ...finished]
    .filter((e) => !e.private && e.hours != null)
    .sort((a, b) => b.hours - a.hours)
    .slice(0, kind === 'week' ? 3 : 5);

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
    kind,
    label: label ?? `${dayLabel(start)} to ${dayLabel(end - DAY)}, ${new Date(end - DAY).getFullYear()}`,
    complete: t >= end,
    row: countRow(start, end, events),
    prev: countRow(prevStart, start, events),
    merged,
    finished,
    bugs: of('bug_fixed'),
    filed: of('issue_filed'),
    highlights,
    technical,
    size,
    quality: held,
    problems: qItems.filter((it) => it.incidents?.length || it.after?.reverted || it.after?.fixes?.length).map((it) => ({ title: hidden.has(it.agentId) ? PRIVATE : clip(it.title), link: hidden.has(it.agentId) ? null : it.url, what: it.incidents?.length ? `caused ${it.incidents.length === 1 ? 'an incident' : `${it.incidents.length} incidents`} in production` : it.after?.reverted ? 'reverted' : 'fixed afterwards' })),
    blocked: open.filter((o) => o.state === 'blocked'),
    open: open.filter((o) => o.state !== 'blocked'),
    keptPrivate: [...merged, ...finished, ...open].filter((e) => e.private).length,
    projects: [...new Set([...merged, ...finished].map((e) => e.project))],
  };
}

const item = (e) => `${e.link ? `[${e.title}](${e.link})` : e.title}${e.bugs ? ` (${e.bugs})` : ''}${e.summary ? `: ${e.summary}` : ''}`;
/** A delivered piece with its technical side under it: how it was done, what it touched, how it was checked. */
const piece = (e) => {
  const t = e.tech;
  if (!t) return item(e);
  const touched = t.files ? `${plural(t.files, 'file')}${t.lines ? `, ${plural(t.lines, 'line')}` : ''}${t.areas.length ? ` in ${t.areas.join(', ')}` : ''}${t.testFiles ? `; ${plural(t.testFiles, 'test file')}` : ''}` : '';
  const checked = checkedLine(t);
  return [item(e), ...(t.how ? [`  - How: ${t.how}`] : []), ...(touched ? [`  - Changed: ${touched}`] : []), ...(checked ? [`  - Checked: ${checked}`] : [])].join('\n');
};
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
  const word = f.kind ?? 'week';
  const out = [`# ${KINDS[word]} summary: ${f.label}`, '', `${who ? `${who} · ` : ''}${f.complete ? `the ${word} as it ended` : `the ${word} so far`}`, ''];
  const done = f.merged.length + f.finished.length;
  if (!done && !f.bugs.length && !r.prs_opened && !f.open.length && !f.blocked.length) return [...out, `Nothing was recorded this ${word}.`].join('\n');

  // One line a manager can repeat.
  const parts = [];
  if (r.prs_merged) parts.push(`${plural(r.prs_merged, 'pull request')} merged${f.projects.length > 1 ? ` across ${f.projects.length} projects` : f.projects.length === 1 ? ` in ${f.projects[0]}` : ''}`);
  if (f.finished.length) parts.push(`${plural(f.finished.length, 'more task')} finished`);
  if (r.bugs_fixed) parts.push(`${plural(r.bugs_fixed, 'bug')} fixed`);
  if (f.size) parts.push(`about ${f.size.hours} hours of engineering work delivered (an estimate)`);
  out.push(`## The ${word} in one line`, '', parts.length ? `${parts.join('; ')}.` : 'Work is in progress; nothing was delivered yet.', '');

  if (f.highlights.length) out.push('## Highlights', '', ...f.highlights.map((e) => `- **${e.title}** (${e.project})${e.summary ? `: ${e.summary}` : ''}${e.tech?.how ? ` ${e.tech.how}` : ''}`), '');

  if (done) {
    out.push('## Achievements', '');
    if (f.merged.length) out.push('### Merged', '', ...byProject(f.merged, piece));
    if (f.finished.length) out.push('### Finished, not merged yet or with no pull request', '', ...byProject(f.finished, piece));
  }
  if (f.bugs.length) out.push('### Bugs fixed', '', ...f.bugs.map((e) => `- ${item(e)}`), '');
  if (f.filed.length) out.push('### Issues filed', '', ...f.filed.map((e) => `- ${item(e)}`), '');

  const p = f.prev;
  const num = (label, a, b) => `| ${label} | ${a === '' || a == null ? '—' : a} | ${b === '' || b == null ? '—' : b} |`;
  out.push('## Numbers', '', `| | This ${word} | The ${word} before |`, '| --- | --- | --- |');
  out.push(num('Pull requests merged', r.prs_merged, p.prs_merged), num('Pull requests opened', r.prs_opened, p.prs_opened), num('Bugs fixed', r.bugs_fixed, p.bugs_fixed), num('Issues filed', r.issues_filed, p.issues_filed), num('Tasks finished', r.agents_finished, p.agents_finished), num('Hours from opened to merged (median)', r.median_hours_to_merge, p.median_hours_to_merge), '');
  if (f.size) out.push(`Estimated size: about ${f.size.hours} hours of engineering work for ${f.size.estimated} of the ${plural(f.size.pieces, 'piece')} listed. An estimate of what a person would have needed, not a measurement.`, '');

  const k = f.technical;
  if (k) {
    out.push('## Technical summary', '');
    if (k.files) out.push(`- **Code:** ${plural(k.files, 'file')} and ${plural(k.lines, 'line')} changed in merged pull requests${k.testFiles ? `, ${plural(k.testFiles, 'test file')} among them` : ''}.`);
    if (k.areas.length) out.push(`- **Areas touched:** ${k.areas.map((a) => `${a.area} (${a.files})`).join(', ')}.`);
    if (k.checksPassed || k.checksFailed) out.push(`- **Verification:** ${plural(k.checksPassed, 'check')} passed${k.checksFailed ? `, ${k.checksFailed} failed` : ''} across ${plural(k.pieces, 'piece')} of work${k.proof ? `; ${plural(k.proof, 'command')} recorded with ${k.proof === 1 ? 'its' : 'their'} output, so ${k.proof === 1 ? 'it' : 'they'} can be run again` : ''}.`);
    if (k.tested) out.push(`- **Tests tested:** on ${plural(k.tested, 'piece')}, ${k.breaksCaught} of ${plural(k.breaksTried, 'deliberate break')} in the changed code ${k.breaksCaught === 1 ? 'was' : 'were'} caught by the tests.`);
    if (k.scored) out.push(`- **Review scorecard:** ${k.score} of 100 on average over ${plural(k.scored, 'piece')}.`);
    if (k.risksNamed) out.push(`- **Risks named before starting:** ${k.risksNamed}; ${k.risksAvoided} avoided${k.risksHappened ? `, ${k.risksHappened} happened` : ''}${k.risksNamed - k.risksAvoided - k.risksHappened ? `, ${k.risksNamed - k.risksAvoided - k.risksHappened} not checked` : ''}.`);
    if (k.changesRequested) out.push(`- **Review:** changes were requested ${plural(k.changesRequested, 'time')} before merging.`);
    if (k.models.length) out.push(`- **Done with:** ${k.models.map((m) => `${m.name} (${m.n})`).join(', ')}.`);
    out.push('');
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

  fileFor(p) {
    return path.join(this.dir, `${KINDS[p.kind].toLowerCase()}-${String(p.key).replace(/[^\w-]+/g, '-')}.md`);
  }

  /** A week's, a month's or a quarter's summary: the one just ended, or the current one so far. */
  async report({ kind = 'week', current = false, t = Date.now() } = {}) {
    await this.worklog.record(t).catch(() => {});
    const p = periodOf(kind, t, { current });
    const facts = weeklyFacts({
      ...p,
      events: this.worklog.state.events,
      value: this.value ? { items: Object.values(this.value.state.items), settings: this.value.settings } : null,
      quality: this.quality ? { items: Object.values(this.quality.state.items), settings: this.quality.settings } : null,
      agents: this.store.list().map((agent) => ({ agent, view: this.manager.view(agent) })),
      t,
    });
    const file = this.fileFor(p);
    return { week: { kind, start: facts.start, end: facts.end, label: facts.label, complete: facts.complete }, facts, markdown: weeklyMarkdown(facts, { who: (await this.who) ?? '' }), file, saved: fs.existsSync(file) };
  }

  /** Write the summary to its file (again: replaced). Nothing is sent. */
  async save(opts = {}) {
    const r = await this.report(opts);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(r.file, `${r.markdown}\n`);
    return { ...r, saved: true };
  }

  /** Once a week, a month or a quarter is over, its summary is written as a draft file, once. */
  async rollOver(t = Date.now()) {
    if (this.config.weekly?.auto === false) return null;
    const st = (this.store.data.weekly ??= {});
    st.draftedBy ??= {};
    let first = null;
    for (const kind of Object.keys(KINDS)) {
      const p = periodOf(kind, t);
      if (st.draftedBy[kind] === p.key || fs.existsSync(this.fileFor(p))) continue;
      const r = await this.save({ kind, t });
      st.draftedBy[kind] = p.key;
      first ??= r;
    }
    if (first) this.store.save();
    return first;
  }
}
