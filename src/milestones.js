// Dates: a project's commitments (code complete, release candidate, GA) and what stands between
// now and each. For every date it plans the reminders (14, 7, 3 and 1 days before, and the day)
// and keeps a checklist: what the app can see for itself (agents still working, backlog not done,
// pull requests open or failing, serious bugs open) and what only you can tick (release notes, the
// RC cut, docs), each of which an agent can be asked to do. A date close with work still open is
// "at risk"; one that has passed is "late". Reminders go to Slack (when alerts are on) and the
// dates show in Today as they come near.

const DAY = 86_400_000;
export const STAGES = [
  ['codeComplete', 'Code complete'],
  ['rc', 'Release candidate'],
  ['ga', 'GA'],
];
export const REMIND_DAYS = [14, 7, 3, 1, 0];
const OPEN_BACKLOG = new Set(['queued', 'active', 'review', 'blocked']);

const err = (status, message) => Object.assign(new Error(message), { status });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2026-12-01" as that local day, or null. */
export function dayOf(s) {
  const m = String(s ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}
const dayIndex = (d) => Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY);
/** Whole days from `now` to the date: 0 today, negative once it has passed. */
export const daysLeft = (date, now = new Date()) => dayIndex(dayOf(date)) - dayIndex(now);

/** "in 12 days", "tomorrow", "today", "3 days late". */
export function leftWords(n) {
  if (n < 0) return `${plural(-n, 'day')} late`;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

/** The reminders planned for a date: [{ offset, on: "YYYY-MM-DD", label }], soonest last. */
export function remindersFor(date) {
  const d = dayOf(date);
  if (!d) return [];
  return REMIND_DAYS.map((offset) => {
    const on = new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
    const iso = `${on.getFullYear()}-${String(on.getMonth() + 1).padStart(2, '0')}-${String(on.getDate()).padStart(2, '0')}`;
    return { offset, on: iso, label: offset === 0 ? 'the day' : offset === 1 ? 'the day before' : `${offset} days before` };
  });
}

/**
 * A stage's checklist from the project's facts. `auto` items are counted by the app (ok at 0);
 * the others are yours to tick, and `task` is what an agent is asked when you hand one over.
 */
export function checklistFor(stage, f, { name = 'the project', date = '' } = {}) {
  const auto = (key, n, text, zero, names = [], go = null) => ({ key, auto: true, count: n, ok: n === 0, text: n ? text : zero, names: names.slice(0, 6), go });
  const manual = (key, text, task) => ({ key, auto: false, text, task });
  const serious = auto('bugs', f.bugs.length, `${plural(f.bugs.length, 'critical or high bug')} open`, 'No critical or high bugs open', f.bugs.map((b) => b.title), 'bugs');
  if (stage === 'codeComplete') {
    return [
      auto('working', f.working.length, `${plural(f.working.length, 'agent')} still working`, 'No agent still working', f.working.map((a) => a.name), 'agents'),
      auto('backlog', f.backlog.length, `${plural(f.backlog.length, 'backlog item')} not finished`, 'The backlog is finished', f.backlog.map((b) => b.title), 'backlog'),
      auto('waiting', f.waiting.length, `${plural(f.waiting.length, 'thing')} waiting on you (plans, questions, prompts)`, 'Nothing waiting on you', f.waiting.map((a) => a.name), 'inbox'),
      manual('scope', 'Scope agreed: what is in and what moved out', null),
    ];
  }
  if (stage === 'rc') {
    return [
      auto('prs', f.prs.length, `${plural(f.prs.length, 'pull request')} still open`, 'No pull requests open', f.prs.map((p) => `#${p.number ?? '?'} ${p.title ?? ''}`.trim()), 'land'),
      auto('checks', f.failing.length, `${plural(f.failing.length, 'pull request')} with failing checks`, 'No failing checks', f.failing.map((p) => `#${p.number ?? '?'} ${p.title ?? ''}`.trim()), 'land'),
      serious,
      manual('notes', 'Release notes and changelog drafted', `Draft the release notes and the changelog entry for the ${name} release candidate${date ? ` (RC on ${date})` : ''}: read what was merged since the last release, group it by what users will notice, and call out breaking changes and upgrade steps. Open a pull request with the changelog.`),
      manual('cut', 'Release candidate cut and smoke-tested', null),
    ];
  }
  return [
    serious,
    auto('prs', f.prs.length, `${plural(f.prs.length, 'pull request')} still open`, 'No pull requests open', f.prs.map((p) => `#${p.number ?? '?'} ${p.title ?? ''}`.trim()), 'land'),
    manual('docs', 'Docs and upgrade notes up to date', `Bring the docs of ${name} up to date for the GA release${date ? ` on ${date}` : ''}: compare the README and docs with what changed since the last release, fix what is out of date, and add upgrade notes for anything that changes behaviour. Open a pull request.`),
    manual('final-notes', 'Release notes final', `Finish the release notes of ${name} for GA${date ? ` on ${date}` : ''}: check every entry against what was actually merged, in the words a user would use, with the breaking changes first. Open a pull request.`),
    manual('publish', 'Version bumped, tagged and published', null),
  ];
}

/** Where a date stands: reached, late, at-risk (a week or less with counted work open) or on-track. */
export function stageStatus({ n, reached, open }) {
  if (reached) return 'reached';
  if (n < 0) return 'late';
  if (n <= 7 && open > 0) return 'at-risk';
  return 'on-track';
}

/** The reminder that is due now: the nearest offset the date is within, or "late"; null when none yet. */
export function dueReminder(n) {
  if (n < 0) return 'late';
  const o = [...REMIND_DAYS].sort((a, b) => a - b).find((x) => n <= x);
  return o === undefined ? null : String(o);
}

export class Milestones {
  /** `facts(project)` gathers what's open in a project; `notify(text, plain)` sends a reminder; `queue(project, title)` hands a task to an agent. */
  constructor({ store, projects, facts, notify = null, queue = null, onChange = () => {}, log = (m) => console.log(`[agentmgr] ${m}`), now = () => new Date(), timer = true }) {
    Object.assign(this, { store, projects, facts, notify, queue, onChange, log, now });
    if (timer) {
      this.timer = setInterval(() => this.tick().catch((e) => this.log(`dates: ${e.message}`)), 30 * 60_000);
      this.first = setTimeout(() => this.tick().catch(() => {}), 45_000);
      this.timer.unref?.();
      this.first.unref?.();
    }
  }

  close() {
    clearInterval(this.timer);
    clearTimeout(this.first);
  }

  get all() {
    return (this.store.data.milestones ??= {});
  }

  project(ref) {
    const r = String(ref ?? '').trim().replace(/^@/, '').toLowerCase();
    const p = this.projects().find((x) => x.shortcut === r || x.key === ref || x.name.toLowerCase() === r);
    if (!p) throw err(404, `No project matches "${ref}"`);
    return p;
  }

  /** Set (or with null, clear) a project's dates: { codeComplete, rc, ga } as "YYYY-MM-DD", in that order. */
  set(ref, dates = {}) {
    const p = this.project(ref);
    const rec = (this.all[p.key] ??= { dates: {}, done: {}, reached: {}, sent: {} });
    const next = { ...rec.dates };
    for (const [id, label] of STAGES) {
      if (!(id in dates)) continue;
      const v = dates[id];
      if (v === null || v === '') delete next[id];
      else if (!dayOf(v)) throw err(400, `${label}: a date like 2026-12-01`);
      else next[id] = v;
    }
    const order = STAGES.map(([id]) => next[id]).filter(Boolean);
    if (order.some((d, i) => i && d < order[i - 1])) throw err(400, 'The dates go in order: code complete, then the release candidate, then GA');
    // A date that moved gets its reminders again.
    for (const [id] of STAGES) if (next[id] !== rec.dates[id]) delete rec.sent[id];
    rec.dates = next;
    if (!Object.keys(next).length) delete this.all[p.key];
    this.store.save();
    this.onChange();
    return this.view();
  }

  /** Tick (or untick) one of your checklist items. */
  check(ref, stage, key, done = true) {
    const rec = this.rec(ref, stage);
    rec.done[`${stage}:${key}`] = done ? this.now().toISOString() : undefined;
    this.store.save();
    this.onChange();
    return this.view();
  }

  /** The date was met (or, with false, not after all): no more reminders for it. */
  reach(ref, stage, reached = true) {
    const rec = this.rec(ref, stage);
    rec.reached[stage] = reached ? this.now().toISOString() : undefined;
    this.store.save();
    this.onChange();
    return this.view();
  }

  rec(ref, stage) {
    const p = this.project(ref);
    const rec = this.all[p.key];
    if (!rec?.dates?.[stage]) throw err(404, 'That date is not set for this project');
    return rec;
  }

  /** Hand one of your checklist items to an agent (through the backlog). */
  task(ref, stage, key) {
    const p = this.project(ref);
    const rec = this.rec(ref, stage);
    const item = checklistFor(stage, this.facts(p), { name: p.name, date: rec.dates[stage] }).find((i) => i.key === key);
    if (!item?.task) throw err(400, 'That item has nothing an agent can do');
    if (!this.queue) throw err(409, 'The backlog is not available');
    const added = this.queue(p, item.task);
    rec.tasks = { ...rec.tasks, [`${stage}:${key}`]: { at: this.now().toISOString(), id: added?.id ?? null } };
    this.store.save();
    this.onChange();
    return this.view();
  }

  stages(p, now = this.now()) {
    const rec = this.all[p.key];
    if (!rec) return [];
    const f = this.facts(p);
    return STAGES.filter(([id]) => rec.dates[id]).map(([id, label]) => {
      const date = rec.dates[id];
      const n = daysLeft(date, now);
      const reached = rec.reached?.[id] ?? null;
      const checklist = checklistFor(id, f, { name: p.name, date }).map((i) => (i.auto ? i : { ...i, done: Boolean(rec.done?.[`${id}:${i.key}`]), asked: rec.tasks?.[`${id}:${i.key}`]?.at ?? null, task: Boolean(i.task) }));
      const open = checklist.filter((i) => i.auto && !i.ok).reduce((s, i) => s + i.count, 0);
      const todo = checklist.filter((i) => !i.auto && !i.done).length;
      return {
        id,
        label,
        date,
        daysLeft: n,
        words: reached ? 'reached' : leftWords(n),
        status: stageStatus({ n, reached, open }),
        reached,
        open,
        todo,
        checklist,
        reminders: remindersFor(date).map((r) => ({ ...r, sent: Boolean(rec.sent?.[id]?.[String(r.offset)]), past: daysLeft(r.on, now) < 0 })),
      };
    });
  }

  view() {
    const now = this.now();
    const list = this.projects();
    const projects = list
      .filter((p) => this.all[p.key])
      .map((p) => {
        const stages = this.stages(p, now);
        return { key: p.key, shortcut: p.shortcut, name: p.name, stages, next: stages.find((s) => !s.reached) ?? null };
      })
      .sort((a, b) => (a.next?.daysLeft ?? 1e9) - (b.next?.daysLeft ?? 1e9) || a.name.localeCompare(b.name));
    return { projects, others: list.filter((p) => !this.all[p.key]).map((p) => ({ key: p.key, shortcut: p.shortcut, name: p.name })), stages: STAGES.map(([id, label]) => ({ id, label })), remindDays: REMIND_DAYS };
  }

  /** What's open for a date, in a few words: "2 agents still working, 3 pull requests still open". */
  openWords(s) {
    const parts = s.checklist.filter((i) => i.auto && !i.ok).map((i) => i.text);
    const mine = s.checklist.filter((i) => !i.auto && !i.done).map((i) => i.text);
    return [...parts, ...(mine.length ? [`yours: ${mine.join('; ')}`] : [])].join(', ');
  }

  /** For Today: the dates within two weeks, and the late ones. */
  todayItems() {
    const out = [];
    for (const p of this.view().projects) {
      for (const s of p.stages) {
        if (s.reached || s.daysLeft > 14) continue;
        const score = s.daysLeft < 0 ? 12 : s.daysLeft <= 1 ? 18 : s.daysLeft <= 3 ? 30 : s.daysLeft <= 7 ? 46 : 58;
        const open = this.openWords(s);
        out.push({ id: `milestone:${p.key}:${s.id}`, kind: 'milestone', label: s.status === 'late' ? 'Late' : s.status === 'at-risk' ? 'At risk' : 'Date', title: `${p.name}: ${s.label} ${s.words} (${s.date})`, why: open || 'Nothing open that the app can see', score, at: null, due: dayOf(s.date).toISOString(), project: p.shortcut, stage: s.id });
      }
    }
    return out;
  }

  /** Send the reminders that are due: one per date, for the nearest offset it has come within. */
  async tick() {
    const now = this.now();
    if (now.getHours() < 8 || now.getHours() >= 20) return [];
    const sent = [];
    for (const p of this.projects()) {
      const rec = this.all[p.key];
      if (!rec) continue;
      for (const s of this.stages(p, now)) {
        if (s.reached) continue;
        const due = dueReminder(s.daysLeft);
        const had = (rec.sent[s.id] ??= {});
        if (!due || had[due]) continue;
        // Being within a nearer offset covers the further ones: they aren't sent late.
        for (const o of REMIND_DAYS) if (due === 'late' || o >= Number(due)) had[String(o)] ??= now.toISOString();
        had[due] = now.toISOString();
        this.store.save();
        const open = this.openWords(s);
        const head = `${p.name}: ${s.label} ${s.words} (${s.date})`;
        const mark = s.status === 'late' ? ':rotating_light:' : s.status === 'at-risk' ? ':warning:' : ':calendar:';
        sent.push({ project: p.shortcut, stage: s.id, reminder: due });
        try {
          await this.notify?.(`${mark} *${head}*${open ? `\n${open}` : '\nNothing open that the app can see.'}`, `${head}${open ? `\n${open}` : ''}`);
        } catch (e) {
          this.log(`dates: ${head}: not sent: ${e.message}`);
        }
      }
    }
    if (sent.length) this.onChange();
    return sent;
  }
}
