// Work record: what the agents got done, appended to a spreadsheet as it happens, for your own
// productivity notes and performance reviews. Two CSV files (they open in Excel or Numbers, or
// File → Import in Google Sheets), in ~/.agentmanager or "worklog": { "dir": ... } in config.json:
//   worklog.csv         one row per event: pull request opened, merged or closed, bug fixed (a
//                       linked bug whose agent's pull request merged), issue filed (a "Filed:" line
//                       in the agent's brief), agent finished (its brief says done)
//   worklog-weekly.csv  one row per week (Monday to Sunday), added once the week is over
// Rows are only ever appended. On first run, the history already recorded is written too, with
// the dates it happened on. Everything comes from what agentmgr already tracks.
import fs from 'node:fs';
import path from 'node:path';
import { costOf, dayKey } from './budgets.js';
import { paths } from './config.js';

export const EVENT_COLUMNS = ['date', 'event', 'project', 'agent', 'agent_id', 'title', 'link', 'bugs', 'engine', 'model', 'cost_usd', 'hours', 'by'];
export const WEEK_COLUMNS = ['week_start', 'week_end', 'prs_opened', 'prs_merged', 'prs_closed', 'merge_rate', 'bugs_fixed', 'issues_filed', 'agents_finished', 'median_hours_to_merge', 'cost_usd'];
export const EVENT_LABEL = { pr_opened: 'Pull request opened', pr_merged: 'Pull request merged', pr_closed: 'Pull request closed', bug_fixed: 'Bug fixed', issue_filed: 'Issue filed', agent_finished: 'Agent finished' };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);

/** One CSV field: quoted when it has a comma, quote or line break. */
export const csvField = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvRow = (cols, row) => cols.map((c) => csvField(row[c])).join(',');

/** Monday 00:00 (local time) of the week holding t. */
export function weekStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** "Filed: <link> <title>" → { link, title }. */
function filedRef(line) {
  const url = line.match(/https?:\/\/\S+/)?.[0]?.replace(/[)>\].,]+$/, '') ?? null;
  const title = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/^[\s:–—-]+|[\s:–—-]+$/g, '').trim();
  return { link: url, title: title || url || line.trim() };
}

/**
 * The events an agent's record holds now: [{ key, at, event, title, link, bugs, hours, cost }].
 * `at` is when it happened when that's recorded (pull request dates, brief updates), else null.
 */
export function agentEvents(a) {
  if (a.kind === 'assistant' || a.kind === 'general') return [];
  const out = [];
  const created = Date.parse(a.createdAt);
  const prs = Object.values(a.prs ?? {}).filter((p) => p.source !== 'mentioned' && p.url);
  const bugs = Object.values(a.bugs ?? {});
  const bugKeys = bugs.map((b) => b.key).join(' ');
  for (const p of prs) {
    const opened = Date.parse(p.openedAt);
    const title = p.title ?? p.url;
    out.push({ key: `pr_opened:${p.url}`, at: iso(opened), event: 'pr_opened', title, link: p.url, bugs: bugKeys, hours: created && opened >= created ? round((opened - created) / HOUR, 1) : null });
    if (p.state === 'MERGED') {
      const merged = Date.parse(p.mergedAt);
      out.push({ key: `pr_merged:${p.url}`, at: iso(merged), event: 'pr_merged', title, link: p.url, bugs: bugKeys, hours: opened && merged >= opened ? round((merged - opened) / HOUR, 1) : null });
    }
    if (p.state === 'CLOSED') out.push({ key: `pr_closed:${p.url}`, at: null, event: 'pr_closed', title, link: p.url, bugs: bugKeys, hours: null });
  }
  // A linked bug is fixed when the agent's pull request merged (the first one, if several).
  const firstMerge = prs.filter((p) => p.state === 'MERGED').sort((x, y) => (Date.parse(x.mergedAt) || 0) - (Date.parse(y.mergedAt) || 0))[0];
  if (firstMerge) {
    for (const b of bugs) out.push({ key: `bug_fixed:${a.id}:${b.key}`, at: iso(Date.parse(firstMerge.mergedAt)), event: 'bug_fixed', title: b.title ? `${b.key} ${b.title}` : b.key, link: b.url ?? null, bugs: b.key, hours: null });
  }
  for (const line of a.brief?.results?.filed ?? []) {
    const ref = filedRef(line);
    out.push({ key: `issue_filed:${ref.link ?? `${a.id}:${ref.title}`}`, at: null, event: 'issue_filed', title: ref.title, link: ref.link, bugs: '', hours: null });
  }
  const done = a.brief?.status === 'done' || a.brief?.results?.outcome === 'done';
  if (done) {
    const at = Date.parse(a.brief?.updatedAt);
    out.push({ key: `agent_finished:${a.id}`, at: iso(at), event: 'agent_finished', title: String(a.intent ?? a.name ?? '').split('\n')[0].slice(0, 200), link: prs[0]?.url ?? null, bugs: bugKeys, hours: created && at >= created ? round((at - created) / HOUR, 1) : null, cost: round(costOf(a)) });
  }
  return out;
}

/** A week's summary row from its events (and the spend ledger's days). */
export function weekRow(start, events, spendDays = {}) {
  const end = start + 7 * DAY;
  const inWeek = events.filter((e) => {
    const t = Date.parse(e.date);
    return t >= start && t < end;
  });
  const n = (k) => inWeek.filter((e) => e.event === k).length;
  const merged = n('pr_merged');
  const closed = n('pr_closed');
  let cost = 0;
  for (let t = start; t < end; t += DAY) cost += Number(spendDays[dayKey(t)]?.total) || 0;
  return {
    week_start: dayKey(start),
    week_end: dayKey(end - DAY),
    prs_opened: n('pr_opened'),
    prs_merged: merged,
    prs_closed: closed,
    merge_rate: merged + closed ? round(merged / (merged + closed), 3) : '',
    bugs_fixed: n('bug_fixed'),
    issues_filed: n('issue_filed'),
    agents_finished: n('agent_finished'),
    median_hours_to_merge: round(median(inWeek.filter((e) => e.event === 'pr_merged' && e.hours !== '' && e.hours != null).map((e) => Number(e.hours))), 1) ?? '',
    cost_usd: round(cost) ?? 0,
  };
}

export class WorkLog {
  constructor({ manager, store, config = {}, who = null, log = (m) => console.log(`[agentmgr] ${m}`) }) {
    Object.assign(this, { manager, store, config, log });
    this.who = who; // a promise or a name: who the record is about
    store.data.worklog ??= { seen: {}, events: [], weeksUntil: null };
    this.kick = () => this.schedule();
    manager.on('change', this.kick);
    manager.on('prs', this.kick);
    // Week roll-over and anything a change event missed.
    this.timer = setInterval(this.kick, (config.worklogEveryMin ?? 10) * 60_000);
    this.timer.unref?.();
    this.schedule(config.worklogFirstMs ?? 3000);
  }

  close() {
    clearInterval(this.timer);
    clearTimeout(this.queued);
    this.manager.off('change', this.kick);
    this.manager.off('prs', this.kick);
  }

  get state() {
    return this.store.data.worklog;
  }

  get dir() {
    const d = this.config.worklog?.dir;
    return d ? path.resolve(d.replace(/^~(?=$|\/)/, process.env.HOME ?? '')) : paths.home;
  }

  get files() {
    return { events: path.join(this.dir, 'worklog.csv'), weekly: path.join(this.dir, 'worklog-weekly.csv') };
  }

  schedule(ms = 5000) {
    if (this.queued) return;
    this.queued = setTimeout(() => {
      this.queued = null;
      this.record().catch((e) => this.log(`work record: ${e.message}`));
    }, ms);
    this.queued.unref?.();
  }

  append(file, cols, rows) {
    if (!rows.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const head = fs.existsSync(file) && fs.statSync(file).size > 0 ? '' : `${cols.join(',')}\n`;
    fs.appendFileSync(file, head + rows.map((r) => `${csvRow(cols, r)}\n`).join(''));
  }

  /** Append what happened since last time, and the summary of each week that has ended. */
  async record(t = Date.now()) {
    if (this.config.worklog?.enabled === false) return { added: 0, weeks: 0 };
    if (this.recording) return this.recording;
    this.recording = (async () => {
      const by = (await this.who) ?? '';
      const st = this.state;
      const fresh = [];
      for (const a of this.store.list()) {
        const v = this.manager.view(a);
        for (const e of agentEvents(a)) {
          if (st.seen[e.key] || fresh.some((x) => x.key === e.key)) continue; // a pull request two agents share: once
          fresh.push({
            date: e.at ?? iso(t),
            event: e.event,
            project: v.projectInfo?.name ?? '',
            agent: a.name,
            agent_id: a.id,
            title: e.title,
            link: e.link ?? '',
            bugs: e.bugs ?? '',
            engine: a.engine ?? 'claude',
            model: a.model ?? '',
            cost_usd: e.cost ?? '',
            hours: e.hours ?? '',
            by,
            key: e.key,
          });
        }
      }
      fresh.sort((x, y) => x.date.localeCompare(y.date));
      this.append(this.files.events, EVENT_COLUMNS, fresh);
      for (const e of fresh) {
        st.seen[e.key] = e.date;
        st.events.push(Object.fromEntries(['date', 'event', 'project', 'agent', 'agent_id', 'title', 'link', 'bugs', 'hours', 'cost_usd'].map((k) => [k, e[k]])));
      }
      // Weeks that ended: from the first event's week (or the week after the last one written).
      const thisWeek = weekStart(t);
      const first = st.weeksUntil ? Date.parse(`${st.weeksUntil}T00:00:00`) : st.events.length ? weekStart(Math.min(...st.events.map((e) => Date.parse(e.date)))) : thisWeek;
      const weeks = [];
      for (let w = weekStart(first); w < thisWeek; w = weekStart(w + 8 * DAY)) weeks.push(weekRow(w, st.events, this.store.data.spend?.days));
      this.append(this.files.weekly, WEEK_COLUMNS, weeks);
      st.weeksUntil = dayKey(thisWeek);
      if (fresh.length || weeks.length) this.store.save?.();
      return { added: fresh.length, weeks: weeks.length };
    })();
    try {
      return await this.recording;
    } finally {
      this.recording = null;
    }
  }

  /** For the Work record view: a period's totals, its events, and the weeks (this one so far included). */
  view({ days = 30, t = Date.now() } = {}) {
    const st = this.state;
    const since = days ? t - days * DAY : 0;
    const events = st.events.filter((e) => Date.parse(e.date) >= since).sort((x, y) => y.date.localeCompare(x.date));
    const n = (k) => events.filter((e) => e.event === k).length;
    const merged = n('pr_merged');
    const closed = n('pr_closed');
    const weeks = [];
    for (let w = weekStart(t), i = 0; i < 12; i++, w = weekStart(w - 3 * DAY)) weeks.push({ ...weekRow(w, st.events, this.store.data.spend?.days), current: i === 0 });
    return {
      days,
      totals: {
        prs_opened: n('pr_opened'),
        prs_merged: merged,
        prs_closed: closed,
        merge_rate: merged + closed ? round(merged / (merged + closed), 3) : null,
        bugs_fixed: n('bug_fixed'),
        issues_filed: n('issue_filed'),
        agents_finished: n('agent_finished'),
        median_hours_to_merge: round(median(events.filter((e) => e.event === 'pr_merged' && e.hours !== '' && e.hours != null).map((e) => Number(e.hours))), 1),
      },
      events: events.slice(0, 500),
      weeks: weeks.filter((w, i) => i === 0 || w.prs_opened || w.prs_merged || w.bugs_fixed || w.issues_filed || w.agents_finished || w.cost_usd),
      files: this.files,
    };
  }
}

/** A period's record as Markdown, for a review document or a status update. */
export function summaryMarkdown(v, { who = '', from = null, to = null } = {}) {
  const t = v.totals;
  const list = (k) => v.events.filter((e) => e.event === k);
  const line = (e) => `- ${e.link ? `[${e.title}](${e.link})` : e.title}${e.project ? ` (${e.project})` : ''}, ${e.date.slice(0, 10)}`;
  const period = from && to ? `${from} to ${to}` : v.days ? `the last ${v.days} days` : 'all time';
  const parts = [
    `# Work record${who ? `: ${who}` : ''}, ${period}`,
    `- Pull requests: ${t.prs_merged} merged, ${t.prs_opened} opened${t.prs_closed ? `, ${t.prs_closed} closed unmerged` : ''}${t.merge_rate != null ? ` (merge rate ${Math.round(t.merge_rate * 100)}%)` : ''}${t.median_hours_to_merge != null ? `; median ${t.median_hours_to_merge} h from opening to merge` : ''}`,
    `- Bugs fixed: ${t.bugs_fixed}; issues filed: ${t.issues_filed}; agents finished: ${t.agents_finished}`,
  ];
  for (const [k, title] of [['pr_merged', 'Merged'], ['bug_fixed', 'Bugs fixed'], ['issue_filed', 'Issues filed']]) {
    const xs = list(k);
    if (xs.length) parts.push('', `## ${title}`, ...xs.slice(0, 50).map(line), ...(xs.length > 50 ? [`- …and ${xs.length - 50} more`] : []));
  }
  return parts.join('\n');
}
