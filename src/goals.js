// Goals: a work order of outcomes for today, this week or no deadline, across one or more
// projects, taken to completion by agents. Each goal is
//   planned  - a model breaks the outcome into tasks, one per agent, each in one of its projects
//   queued   - the tasks go to the backlog (its limits start the agents; autopilot ships them
//              where it's on), right away or after you look at the plan
//   checked  - when every task is finished, the model checks the outcome against what was done
//              and queues what's still missing, a couple of rounds at most; then it's done
// Its summary is kept current: completed, pending, and follow-ups (what needs you: blocked or
// held work, work waiting for your review, agents waiting on you or gone quiet).
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { parseJsonReply } from './brief.js';

export const GOAL_PERIODS = ['day', 'week', 'none'];
const CHECK_ROUNDS = 2; // extra rounds for what the check finds missing
const MAX_TASKS = 12;
const OPEN = new Set(['queued', 'active', 'review', 'blocked']);

const now = () => new Date().toISOString();
const err = (status, message) => Object.assign(new Error(message), { status });

/** The end of today or of this week (Sunday), local time; null for no deadline. */
export function dueFor(period, t = Date.now()) {
  if (period === 'none') return null;
  const d = new Date(t);
  d.setHours(23, 59, 59, 999);
  if (period === 'week') d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return d.toISOString();
}

export function planPrompt({ text, projects, due, done = [], round = 0 }) {
  const list = projects.map((p) => `- ${p.shortcut}: ${p.name}${p.repo ? ` (${p.repo})` : p.dir ? ` (${p.dir})` : ''}`);
  if (!round) {
    return [
      'You plan a work order for AI coding agents. Each task you list becomes one agent, working on its own branch in one of the',
      'projects below, ending in a pull request or another concrete result. Break the outcome into the fewest independent tasks that',
      'together achieve it, at most 12. Write each task as a self-contained request: what to change and where, and how to verify it.',
      'Use only the projects listed, by their shortcut. Leave out anything outside them, and say so in the note.',
      'Reply with JSON only: {"tasks": [{"project": "<shortcut>", "title": "<the request>"}], "note": "<one line, or empty>"}',
      '',
      `<outcome${due ? ` due="${due}"` : ''}>`,
      text,
      '</outcome>',
      '<projects>',
      ...list,
      '</projects>',
    ].join('\n');
  }
  return [
    'You check a work order for AI coding agents. The tasks below were done to achieve the outcome. Decide whether the outcome',
    'is met from what each task delivered. If it is not, list only the remaining tasks needed (the same rules: one agent each, one',
    'project each by its shortcut, a self-contained request with how to verify it, at most 6). Do not repeat work already delivered.',
    'Reply with JSON only: {"met": true | false, "reason": "<one line>", "tasks": [{"project": "<shortcut>", "title": "<the request>"}]}',
    '',
    `<outcome${due ? ` due="${due}"` : ''}>`,
    text,
    '</outcome>',
    '<projects>',
    ...list,
    '</projects>',
    '<done>',
    ...done.map((d) => `- (${d.project}) ${d.title}\n  outcome: ${d.outcome ?? 'unknown'}${d.delivered.length ? `\n  delivered: ${d.delivered.join('; ')}` : ''}${d.prs.length ? `\n  pull requests: ${d.prs.join(', ')}` : ''}`),
    '</done>',
  ].join('\n');
}

/** Tasks from a reply, kept to the goal's projects. */
function tasksFrom(reply, projects, max = MAX_TASKS) {
  const known = new Map(projects.map((p) => [p.shortcut, p]));
  return (Array.isArray(reply?.tasks) ? reply.tasks : [])
    .map((t) => ({ project: String(t?.project ?? '').trim().replace(/^@/, '').toLowerCase(), title: String(t?.title ?? '').trim().slice(0, 2000) }))
    .filter((t) => t.title && known.has(t.project))
    .slice(0, max);
}

export class Goals extends EventEmitter {
  constructor({ manager, store, backlog, config = {}, log = (m) => console.log(`[agentmgr] ${m}`) }) {
    super();
    Object.assign(this, { manager, store, backlog, config, log });
    store.data.goals ??= {};
    this.data = store.data.goals;
    this.checking = new Set();
    this.kick = () => this.schedule();
    backlog.on('change', this.kick);
    manager.on('change', this.kick);
    this.timer = setInterval(this.kick, 60_000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
    clearTimeout(this.queued);
    this.backlog.off('change', this.kick);
    this.manager.off('change', this.kick);
  }

  changed() {
    this.store.save();
    this.emit('change', this.list());
  }

  get(id) {
    const g = this.data[id];
    if (!g) throw err(404, `No goal "${id}"`);
    return g;
  }

  /** A goal's projects as the backlog knows them (shortcut, name, repo or folder). */
  projectsOf(g) {
    return g.projects.map((s) => this.manager.resolveProject(s)).filter(Boolean);
  }

  /** New goal: plans it now; queues the tasks at once unless `review`. */
  async create({ text, period = 'week', projects = [], review = false, priority = 2 } = {}) {
    text = String(text ?? '').trim();
    if (!text) throw err(400, 'Say what the goal is');
    if (!GOAL_PERIODS.includes(period)) throw err(400, `period must be one of ${GOAL_PERIODS.join(', ')}`);
    const list = (Array.isArray(projects) ? projects : String(projects).split(',')).map((p) => this.manager.resolveProject(p));
    if (!list.length) throw err(400, 'Pick at least one project');
    if (list.some((p) => !p)) throw err(400, `Unknown project: ${(Array.isArray(projects) ? projects : String(projects).split(','))[list.findIndex((p) => !p)]}`);
    const g = {
      id: crypto.randomBytes(3).toString('hex'),
      text,
      title: text.split('\n')[0].slice(0, 120),
      period,
      due: dueFor(period),
      projects: [...new Set(list.map((p) => p.shortcut))],
      review: Boolean(review),
      priority: Number(priority) >= 0 && Number(priority) <= 3 ? Number(priority) : 2,
      status: 'planning',
      round: 0,
      plan: [],
      note: '',
      items: [],
      checks: [],
      createdAt: now(),
      doneAt: null,
      error: null,
    };
    this.data[g.id] = g;
    this.changed();
    this.plan(g).catch(() => {});
    return this.view(g);
  }

  /** Ask the model for the tasks (round 0), or what's still missing (later rounds). */
  async plan(g, done = []) {
    const projects = this.projectsOf(g);
    const writer = this.manager.writerFor({});
    try {
      const reply = parseJsonReply(await this.manager.oneShot(null, planPrompt({ text: g.text, projects, due: g.due, done, round: g.round }), writer));
      if (g.round) {
        const tasks = tasksFrom(reply, projects, 6);
        g.checks.push({ at: now(), round: g.round, met: Boolean(reply?.met) || !tasks.length, reason: String(reply?.reason ?? '').slice(0, 300), tasks: tasks.length });
        if (reply?.met || !tasks.length) return this.finish(g);
        this.queue(g, tasks);
        return;
      }
      const tasks = tasksFrom(reply, projects);
      if (!tasks.length) throw new Error(`no tasks for these projects${reply?.note ? `: ${reply.note}` : ''}`);
      g.plan = tasks;
      g.note = String(reply?.note ?? '').slice(0, 300);
      g.error = null;
      if (g.review) {
        g.status = 'review';
        this.changed();
      } else this.queue(g, tasks);
    } catch (e) {
      g.status = g.round ? 'running' : 'error';
      g.error = `Couldn't plan it: ${e.message}`;
      this.log(`goal "${g.title}": ${g.error}`);
      this.changed();
    }
  }

  /** The tasks go to the backlog, tagged with the goal. */
  queue(g, tasks) {
    for (const t of tasks) {
      const [it] = this.backlog.add([t.title], { project: t.project, priority: g.priority });
      it.goalId = g.id;
      g.items.push(it.id);
    }
    g.status = 'running';
    g.error = null;
    this.backlog.changed();
    this.changed();
  }

  finish(g) {
    g.status = 'done';
    g.doneAt = now();
    this.log(`goal done: "${g.title}"`);
    this.changed();
  }

  /** Review: start the plan, with your edits (`tasks`: [{ project, title }]) if any. */
  approve(id, { tasks } = {}) {
    const g = this.get(id);
    if (g.status !== 'review') throw err(409, `The goal is ${g.status}`);
    const list = tasks ? tasksFrom({ tasks }, this.projectsOf(g)) : g.plan;
    if (!list.length) throw err(400, 'No tasks to start');
    g.plan = list;
    this.queue(g, list);
    return this.view(g);
  }

  /** Plan again (after an error, or to get a different plan before starting). */
  replan(id) {
    const g = this.get(id);
    if (!['error', 'review'].includes(g.status)) throw err(409, `The goal is ${g.status}`);
    g.status = 'planning';
    g.error = null;
    this.changed();
    this.plan(g).catch(() => {});
    return this.view(g);
  }

  /** Carry an unfinished goal over to the next day or week. */
  extend(id) {
    const g = this.get(id);
    if (g.period === 'none') throw err(409, 'This goal has no deadline');
    const from = Math.max(Date.now(), Date.parse(g.due ?? '') || 0) + 1000;
    g.due = dueFor(g.period, from);
    this.changed();
    return this.view(g);
  }

  /** Stop: its queued tasks are cancelled; work in progress goes on as ordinary backlog items. */
  stop(id) {
    const g = this.get(id);
    for (const itemId of g.items) {
      const it = this.backlog.data.items[itemId];
      if (it?.status === 'queued') this.backlog.cancel(itemId);
    }
    g.status = 'stopped';
    this.changed();
    return this.view(g);
  }

  remove(id) {
    const g = this.get(id);
    if (g.status === 'running' || g.status === 'planning') throw err(409, 'Stop the goal first');
    delete this.data[id];
    this.changed();
    return { id };
  }

  schedule() {
    if (this.queued) return;
    this.queued = setTimeout(() => {
      this.queued = null;
      this.tick();
    }, 1000);
    this.queued.unref?.();
  }

  /** A running goal whose tasks are all finished: check it against the outcome. */
  tick() {
    for (const g of Object.values(this.data)) {
      if (g.status !== 'running' || this.checking.has(g.id) || !g.items.length) continue;
      const items = g.items.map((id) => this.backlog.data.items[id]).filter(Boolean);
      if (items.some((it) => OPEN.has(it.status))) continue;
      const done = items.filter((it) => it.status === 'done');
      if (!done.length) continue; // all cancelled: leave it to the person
      if (g.round >= CHECK_ROUNDS) {
        g.checks.push({ at: now(), round: g.round + 1, met: null, reason: `Stopped checking after ${CHECK_ROUNDS} extra rounds`, tasks: 0 });
        this.finish(g);
        continue;
      }
      g.round += 1;
      g.status = 'checking';
      this.changed();
      this.checking.add(g.id);
      const projects = this.projectsOf(g);
      this.plan(g, done.map((it) => this.doneFacts(it, projects)))
        .catch(() => {})
        .finally(() => this.checking.delete(g.id));
    }
  }

  doneFacts(it, projects = []) {
    const agent = it.agentId && this.store.get(it.agentId);
    const r = agent?.brief?.results;
    return {
      title: it.title,
      project: projects.find((p) => p.key === it.projectKey)?.shortcut ?? it.projectName,
      outcome: r?.outcome ?? (agent?.brief?.status === 'done' ? 'done' : null),
      delivered: (r?.delivered ?? []).slice(0, 8),
      prs: Object.values(agent?.prs ?? {})
        .filter((p) => p.source !== 'mentioned')
        .map((p) => `${p.url} (${String(p.state ?? '').toLowerCase()})`),
    };
  }

  /** Completed, pending and follow-ups, from the goal's backlog items and their agents. */
  summary(g) {
    const completed = [];
    const pending = [];
    const followUps = [];
    for (const id of g.items) {
      const it = this.backlog.data.items[id];
      if (!it) continue;
      const agent = it.agentId ? this.store.get(it.agentId) : null;
      const v = agent ? this.manager.view(agent) : null;
      const prs = (v?.prs ?? []).filter((p) => p.source !== 'mentioned').map((p) => ({ url: p.url, state: p.state }));
      const row = { itemId: it.id, title: it.title, project: it.projectName, status: it.status, agentId: it.agentId, agentName: agent?.name ?? null, prs };
      if (it.status === 'done') {
        completed.push({ ...row, at: it.doneAt });
        continue;
      }
      if (it.status === 'cancelled') continue;
      const why =
        (it.status === 'blocked' && (it.notes || 'Setup failed')) ||
        (it.autopilot?.state === 'held' && it.autopilot.round === it.reviewAt && `Autopilot held: ${it.autopilot.note ?? ''}`) ||
        (it.status === 'review' && this.backlog.autopilotFor(it.projectKey) === 'off' && !it.autopilot?.ship && 'Waiting for your review (Accept or Reopen)') ||
        (v?.runtime.attention && `Needs input: ${v.runtime.attention}`) ||
        (v?.runtime.waiting && `Waiting on you: ${v.runtime.waiting.question || v.runtime.waiting.summary}`) ||
        (v?.questions?.some((q) => !q.answer) && 'Asked a question') ||
        (v?.stuck?.length && `Stuck? ${v.stuck[0].title}`) ||
        (v?.followUp && v.followUp.title) ||
        null;
      if (why) followUps.push({ ...row, why: String(why).slice(0, 300) });
      else pending.push({ ...row, state: it.status === 'review' ? (it.autopilot?.state ? `autopilot: ${it.autopilot.state}` : 'in review') : it.status === 'active' ? 'agent working' : 'queued' });
    }
    return { completed, pending, followUps };
  }

  view(g) {
    const s = this.summary(g);
    const total = s.completed.length + s.pending.length + s.followUps.length;
    return { ...g, summary: s, counts: { completed: s.completed.length, pending: s.pending.length, followUps: s.followUps.length, total }, overdue: Boolean(g.due && g.status !== 'done' && g.status !== 'stopped' && Date.parse(g.due) < Date.now()) };
  }

  list() {
    return Object.values(this.data)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((g) => this.view(g));
  }
}

/** A goal's summary as Markdown: for a stand-up, a status update or a review. */
export function goalMarkdown(v) {
  const s = v.summary;
  const pr = (r) => (r.prs.length ? ` ${r.prs.map((p) => `[#${p.url.split('/').pop()}](${p.url})${p.state && p.state !== 'OPEN' ? ` ${p.state.toLowerCase()}` : ''}`).join(', ')}` : '');
  const due = v.due ? ` (due ${v.due.slice(0, 10)}${v.overdue ? ', overdue' : ''})` : '';
  return [
    `# Goal: ${v.title}${due}`,
    `${v.counts.completed} completed, ${v.counts.pending} pending, ${v.counts.followUps} follow-up${v.counts.followUps === 1 ? '' : 's'} · ${v.status}`,
    '',
    '## Completed',
    ...(s.completed.length ? s.completed.map((r) => `- ${r.title.split('\n')[0]} (${r.project})${pr(r)}`) : ['- nothing yet']),
    '',
    '## Pending',
    ...(s.pending.length ? s.pending.map((r) => `- ${r.title.split('\n')[0]} (${r.project}): ${r.state}${pr(r)}`) : ['- nothing']),
    '',
    '## Follow-ups',
    ...(s.followUps.length ? s.followUps.map((r) => `- ${r.title.split('\n')[0]} (${r.project}): ${r.why}${pr(r)}`) : ['- none']),
  ].join('\n');
}
