// Decide: help with the decisions, not only the tasks.
//   brief     - a plan waiting for review or an agent's question arrives with its options, the one
//               recommended, why, the evidence, the risk and how hard it is to undo.
//   standing  - a call you keep making becomes a standing decision: offered once it is seen three
//               times, and from then on handled for you and reported afterwards.
//   autonomy  - per project, how much may be decided without you.
//   impact    - the backlog ranked by what each item is worth now (the nearest date, what it
//               unblocks, its priority), with the reason beside it.
//   tradeoff  - a date at risk laid out as choices (cut, move the date, add agents), one
//               recommended; picking one carries it out and logs it.
//   evidence  - "Try both": the options of a question run as a race, so you decide from results.
//   lookback  - what followed each past decision; the ones worth another look, and what they teach.
// The reasoning is the AI judge's (one tool-less call each, on your own plan, within its daily
// budget). With the judge off, plain rules stand in and say so.

import crypto from 'node:crypto';

export const LEVELS = ['ask', 'standing', 'safe', 'most'];
export const LEVEL_LABEL = {
  ask: 'Ask me everything',
  standing: 'Only my standing decisions',
  safe: 'Also what is sure and easy to undo',
  most: 'Most things; ask when unsure',
};
export const SURE = 0.85;
export const LIKELY = 0.7;
export const OFFER_AFTER = 3;
const DAY = 86_400_000;
const err = (status, message) => Object.assign(new Error(message), { status });
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const JSON_ONLY = 'Reply with one JSON object and nothing else.';

/** Whether a brief may be carried out without asking, at this level of autonomy. */
export function mayAct(level, b) {
  if (!b || level === 'ask' || !LEVELS.includes(level)) return false;
  const opt = b.options?.[b.recommend];
  if (!opt || !['approve', 'changes', 'answer'].includes(opt.action)) return false;
  if ((opt.action === 'changes' || opt.action === 'answer') && !opt.text) return false;
  const c = Number(b.confidence) || 0;
  if (b.standing && c >= LIKELY) return true;
  if (level === 'safe') return c >= SURE && b.undo === 'easy';
  if (level === 'most') return c >= LIKELY && b.undo === 'easy';
  return false;
}

const standingLines = (rules) =>
  rules.length
    ? `Standing decisions the person has made (apply one only when it clearly fits; then name its id in "standing"):\n${rules.map((r) => `- [${r.id}] when ${r.when} -> ${r.action}${r.text ? `: ${r.text}` : ''}`).join('\n')}`
    : 'The person has no standing decisions for this yet ("standing": null).';
const pastLines = (past) =>
  past.length ? `How the person decided similar things lately:\n${past.map((h) => `- ${clip(h.title, 120)}: recommended "${clip(h.recommended, 60)}", they chose "${clip(h.chose, 80)}"${h.note ? ` (${clip(h.note, 100)})` : ''}`).join('\n')}` : '';
const lessonLines = (lessons) => (lessons.length ? `What earlier decisions taught:\n${lessons.map((l) => `- ${clip(l, 200)}`).join('\n')}` : '');

/** The prompt for one thing waiting on the person: a plan to review, or an agent's question. */
export function briefPrompt(item, { standing = [], past = [], lessons = [], dates = '' } = {}) {
  const head =
    'You advise a senior engineer who supervises AI coding agents. Something waits for their decision. ' +
    'Lay out the real options, recommend one, and say why in terms of this project. Be concrete and brief; do not flatter; when the evidence is thin, say so with a low confidence.';
  const shape =
    item.kind === 'plan'
      ? '{"options":[{"label":"Approve","action":"approve","text":"","consequence":"..."},{"label":"Send back","action":"changes","text":"exactly what to change, as you would tell the agent","consequence":"..."}],"recommend":0,"why":"...","evidence":["what in the plan or the project supports it"],"risk":"what could go wrong with the recommendation","undo":"easy|hard","confidence":0.0,"standing":null}'
      : '{"options":[{"label":"short name","action":"answer","text":"the answer to send the agent","consequence":"..."}],"recommend":0,"why":"...","evidence":["..."],"risk":"...","undo":"easy|hard","confidence":0.0,"standing":null}';
  const body =
    item.kind === 'plan'
      ? `The agent "${item.agentName}" wrote an implementation plan and waits for approval before changing anything.\nWhat it was asked: ${clip(item.intent, 1200)}\n\nThe plan:\n${String(item.markdown ?? '').slice(0, 7000)}\n\nCheck it against the ask: scope (too much, too little), order, tests and how it will be verified, what it could break, and how it is rolled back.`
      : `The agent "${item.agentName}" asks a question and goes on with its default until answered.\nWhat it was asked to do: ${clip(item.intent, 1200)}\nThe question: ${item.question}\n${item.context ? `Context: ${item.context}\n` : ''}${item.options?.length ? `Its options: ${item.options.join(' | ')}\n` : ''}${item.default ? `Its default: ${item.default}\n` : ''}Give two to four options (its own when it named them).`;
  return [
    head,
    `Project: ${item.project}.${dates ? ` ${dates}` : ''}`,
    body,
    standingLines(standing),
    pastLines(past),
    lessonLines(lessons),
    '"undo" is "hard" when the choice is costly to reverse once acted on (data, public interfaces, releases, money, a large rewrite), else "easy". "confidence" is how sure you are that the person would agree, 0 to 1.',
    `${JSON_ONLY} Shape: ${shape}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A reply made safe to keep and show; null when it isn't usable. */
export function normalizeBrief(d, item, standing = []) {
  if (!d || !Array.isArray(d.options)) return null;
  const allowed = item.kind === 'plan' ? ['approve', 'changes'] : ['answer'];
  const options = d.options
    .filter((o) => o && allowed.includes(o.action))
    .slice(0, 4)
    .map((o) => ({ label: clip(o.label || o.action, 60), action: o.action, text: clip(o.text, 1200), consequence: clip(o.consequence, 300) }))
    .filter((o) => o.action === 'approve' || o.text);
  if (!options.length) return null;
  const recommend = Number.isInteger(d.recommend) && options[d.recommend] ? d.recommend : 0;
  return {
    options,
    recommend,
    why: clip(d.why, 600),
    evidence: (Array.isArray(d.evidence) ? d.evidence : []).map((e) => clip(e, 240)).filter(Boolean).slice(0, 4),
    risk: clip(d.risk, 300),
    undo: d.undo === 'hard' ? 'hard' : 'easy',
    confidence: Math.max(0, Math.min(1, Number(d.confidence) || 0)),
    standing: standing.some((r) => r.id === d.standing) ? d.standing : null,
  };
}

/** Asked when three or more recent decisions may share a pattern worth making standing. */
export function standingPrompt(history, rules) {
  return [
    'A senior engineer decides on AI agents\' plans and questions. Below are their recent decisions, numbered. Find calls they keep making that could be made once: a condition and the action they always take when it holds.',
    'Offer one only when at least three of the decisions clearly agree and none contradicts it. Make the condition specific enough to be safe (name the kind of change, the project when it matters), never "always approve".',
    `Decisions:\n${history.map((h, i) => `${i + 1}. [${h.kind}, project ${h.project}] ${clip(h.title, 140)} -> ${clip(h.chose, 100)}${h.note ? ` (${clip(h.note, 120)})` : ''}`).join('\n')}`,
    rules.length ? `Already standing (do not repeat):\n${rules.map((r) => `- when ${r.when} -> ${r.action}`).join('\n')}` : '',
    `${JSON_ONLY} Shape: {"offers":[{"kind":"plan|question","project":"the project's name, or null for every project","when":"the condition, in the person's words","action":"approve|changes|answer","text":"the note or answer to send; empty for approve","basedOn":[1,2,3],"confidence":0.0}]}. An empty list when there is no clear pattern.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Without the judge: the same question answered the same way three times. */
export function standingFallback(history) {
  const groups = new Map();
  for (const h of history) {
    if (h.kind !== 'question') continue;
    const k = `${norm(h.title)}|${norm(h.chose)}`;
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }
  return [...groups.values()]
    .filter((g) => g.length >= OFFER_AFTER)
    .map((g) => ({ kind: 'question', project: new Set(g.map((h) => h.project)).size === 1 ? g[0].project : null, when: `an agent asks "${clip(g[0].title, 160)}"`, action: 'answer', text: g[0].chose, count: g.length, confidence: 0.8 }));
}

/** What a backlog item is worth doing now, by plain rules: { score, reasons }. */
export function impactScore(it, { stage = null, now = Date.now() } = {}) {
  const reasons = [];
  let score = [40, 25, 12, 4][it.priority] ?? 12;
  reasons.push(`P${it.priority}`);
  if (stage && !stage.reached) {
    const n = stage.daysLeft;
    const add = n < 0 ? 30 : n <= 7 ? 25 : n <= 14 ? 15 : n <= 30 ? 5 : 0;
    if (add) {
      score += add;
      reasons.push(n < 0 ? `${stage.label} is ${-n} day${n === -1 ? '' : 's'} late` : `${stage.label} in ${n} day${n === 1 ? '' : 's'}`);
    }
  }
  if (/\b(fix|bug|crash|regression|broken|fail(s|ing|ure)?|security|data loss|leak)\b/i.test(it.title)) {
    score += 10;
    reasons.push('a fix');
  }
  if (/\b(block(s|ed|er|ing)?|unblock|prerequisite|needed (for|by)|before (rc|ga|release))\b/i.test(`${it.title} ${it.notes ?? ''}`)) {
    score += 8;
    reasons.push('unblocks other work');
  }
  const age = Math.floor((now - (Date.parse(it.createdAt) || now)) / DAY);
  if (age >= 7) {
    score += Math.min(8, Math.floor(age / 7) * 2);
    reasons.push(`waiting ${age} days`);
  }
  if (it.status === 'active' || it.status === 'review') score += 5; // nearly there: finishing beats starting
  return { score, reasons };
}

export function impactPrompt(items, { project, dates, bugs = 0, decisions = [] } = {}) {
  return [
    'Rank a project\'s open backlog by impact: what is worth the most to do next. Weigh the nearest commitment date, what an item unblocks, risk removed (bugs, security, data), what users notice, and effort. An item that others depend on comes before them.',
    `Project: ${project}. ${dates || 'No commitment dates set.'}${bugs ? ` Open critical or high bugs: ${bugs}.` : ''}`,
    decisions.length ? `Recent decisions here:\n${decisions.map((d) => `- ${clip(d, 160)}`).join('\n')}` : '',
    `Items:\n${items.map((it) => `- [${it.id}] P${it.priority}, ${it.status}: ${clip(it.title, 300)}`).join('\n')}`,
    `${JSON_ONLY} Shape: {"order":[{"id":"...","impact":"high|medium|low","why":"one line: what it is worth now","unblocks":["ids it should come before"],"priority":0}],"confidence":0.0}. Every id once, most valuable first. "priority" (0 to 3) only when the item's priority is clearly wrong, else leave it out.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Items finished per day lately, from the backlog's own record. */
export function pace(items, { now = Date.now(), days = 14 } = {}) {
  const done = items.filter((it) => it.status === 'done' && it.doneAt && now - Date.parse(it.doneAt) <= days * DAY).length;
  return Math.round((done / days) * 100) / 100;
}

const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * A date at risk as choices. `ranked` is the project's open items, most valuable first (each with
 * its status); `perDay` the pace; `limit` how many agents run at once now.
 */
export function tradeoffOptions({ stage, ranked, perDay, limit = 1 }) {
  const open = ranked.length;
  const left = Math.max(0, stage.daysLeft);
  const need = perDay > 0 ? Math.ceil(open / perDay) : null;
  const fits = perDay > 0 ? Math.floor(perDay * left) : 0;
  const slip = need === null ? Math.max(3, Math.ceil(open / Math.max(1, limit)) - left) : Math.max(0, need - left);
  const queued = ranked.filter((it) => it.status === 'queued');
  const out = [];
  const over = Math.max(0, open - fits);
  const cut = queued.slice(-Math.min(queued.length, over || 0)).reverse();
  if (cut.length) {
    out.push({
      id: 'cut',
      label: `Cut ${cut.length} item${cut.length === 1 ? '' : 's'}`,
      what: `Hold the ${cut.length === 1 ? 'least valuable queued item' : `${cut.length} least valuable queued items`} until after ${stage.label} (${stage.date}).`,
      consequence: over > cut.length ? `Still ${over - cut.length} more than the pace allows: the rest is already started.` : `What is left fits the ${left} day${left === 1 ? '' : 's'} at the current pace.`,
      items: cut.map((it) => ({ id: it.id, title: it.title })),
    });
  }
  const move = Math.max(1, slip);
  out.push({ id: 'move', label: `Move the date ${move} day${move === 1 ? '' : 's'}`, what: `${stage.label} moves from ${stage.date} to ${addDays(stage.date, move)}; later dates move with it when they would no longer be in order.`, consequence: 'Everything planned stays in. Whoever was promised the date has to be told.', days: move, date: addDays(stage.date, move) });
  const extra = Math.min(queued.length, Math.max(1, Math.min(3, Math.ceil(over / Math.max(1, left || 1)))));
  if (queued.length) {
    out.push({ id: 'add', label: `Run ${extra} more agent${extra === 1 ? '' : 's'}`, what: `Raise this project's limit from ${limit} to ${limit + extra} agents at once, so ${extra} more queued item${extra === 1 ? ' starts' : 's start'} now.`, consequence: 'More in parallel: more of your time on reviews and answers, more spend, and more chance of agents overlapping.', extra, limit: limit + extra });
  }
  // Plain rules for the recommendation, when the judge isn't asked.
  const rule = out.find((o) => o.id === 'add') && slip <= 2 ? 'add' : out.find((o) => o.id === 'cut') && cut.length <= Math.max(1, Math.round(open * 0.3)) ? 'cut' : 'move';
  return { options: out, open, perDay, need, slip, recommend: rule, why: rule === 'add' ? 'The gap is a day or two: more in parallel closes it.' : rule === 'cut' ? 'A few of the least valuable items account for the gap.' : 'The gap is too wide to close by cutting a little or adding agents.' };
}

export function tradeoffPrompt({ project, stage, facts, t }) {
  return [
    'A project\'s commitment date is at risk. Recommend one of the choices below, as a senior engineering lead would: protect what the date is for, be honest about what is given up.',
    `Project: ${project}. ${stage.label} is ${stage.date} (${stage.words}). Open work: ${t.open} item${t.open === 1 ? '' : 's'}; pace lately ${t.perDay} finished a day${t.need !== null ? `, so about ${t.need} days are needed` : ''}. ${facts}`,
    `Choices:\n${t.options.map((o) => `- ${o.id}: ${o.what} ${o.consequence}${o.items ? ` Items: ${o.items.map((i) => clip(i.title, 80)).join('; ')}` : ''}`).join('\n')}`,
    `${JSON_ONLY} Shape: {"recommend":"${t.options.map((o) => o.id).join('|')}","why":"two sentences at most","confidence":0.0}`,
  ].join('\n\n');
}

/** What followed a decision, from the agent it was about: { outcome: held|revisit|early, signs }. */
export function lookBackSigns(decision, agent, { stageLate = false, item = null } = {}) {
  const signs = [];
  if (!agent) return { outcome: 'early', signs: ['its agent is gone'] };
  const after = (t) => t && String(t) > String(decision.at);
  if (decision.kind === 'plan' && decision.decision === 'Approved' && agent.planReview?.status === 'changes' && after(agent.planReview.decidedAt)) signs.push('the plan was sent back after it was approved');
  if (agent.aiReview?.verdict && agent.aiReview.verdict !== 'complete') signs.push(`the finished work was judged ${agent.aiReview.verdict.replace('_', ' ')}${agent.aiReview.missing?.length ? `: missing ${clip(agent.aiReview.missing.join('; '), 160)}` : ''}`);
  const prs = Object.values(agent.prs ?? {}).filter((p) => p.source !== 'mentioned');
  if (prs.some((p) => p.checks?.state === 'failed')) signs.push('its pull request has failing checks');
  if (prs.some((p) => p.state === 'CLOSED')) signs.push('its pull request was closed without merging');
  if ((item?.reopened ?? 0) > 0) signs.push(`the work was reopened ${item.reopened === 1 ? 'once' : `${item.reopened} times`}`);
  if (agent.status === 'error') signs.push('the agent ended in an error');
  if (stageLate) signs.push('a date of the project has since been missed');
  if (signs.length) return { outcome: 'revisit', signs };
  const landed = prs.some((p) => p.state === 'MERGED') || agent.status === 'done' || item?.status === 'done';
  return landed ? { outcome: 'held', signs: ['the work landed'] } : { outcome: 'early', signs: [] };
}

export function lookBackPrompt(rows) {
  return [
    'Look back at decisions a senior engineer made about AI agents\' work, with what followed each. For each, say whether the decision itself is worth another look (it likely caused what followed) or held (what followed has another cause), and the lesson in one line the person could apply next time. No blame, no generalities.',
    rows.map((r, i) => `${i + 1}. [${r.id}] ${r.kind} on ${r.project}: ${clip(r.title, 140)} -> ${clip(r.decision, 120)}${r.why ? ` (because: ${clip(r.why, 160)})` : ''}\n   What followed: ${r.signs.join('; ')}`).join('\n'),
    `${JSON_ONLY} Shape: {"items":[{"id":"...","verdict":"revisit|held","lesson":"..."}],"confidence":0.0}`,
  ].join('\n\n');
}

export class Advisor {
  /**
   * manager: the agents (approvePlan, requestPlanChanges, answerQuestion, view, judge, listProjects);
   * backlog, milestones, decisions, races: the other parts it reads and acts through;
   * questions(agent): its questions; projectOf(agent): its project.
   */
  constructor({ store, manager, backlog, milestones, decisions, races, questions, projectOf, bugs = () => 0, enabled = () => true, notify = null, onChange = () => {}, now = () => Date.now(), log = (m) => console.log(`[agentmgr] ${m}`), timer = true }) {
    Object.assign(this, { store, manager, backlog, milestones, decisions, races, questions, projectOf, bugs, enabled, notify, onChange, now, log });
    this.pending = new Set();
    if (timer) {
      this.timer = setInterval(() => this.tick().catch(() => {}), 20_000);
      this.timer.unref?.();
      this.slow = setInterval(() => this.lookBack().catch(() => {}), 60 * 60_000);
      this.slow.unref?.();
    }
  }

  close() {
    clearInterval(this.timer);
    clearInterval(this.slow);
  }

  get judge() {
    return this.manager.judge;
  }

  get state() {
    const s = (this.store.data.advisor ??= {});
    for (const [k, v] of Object.entries({ briefs: {}, standing: {}, offers: {}, dismissed: {}, autonomy: {}, handled: [], history: [], impact: {}, tradeoffs: {}, reviews: {}, lessons: [], learnedAt: 0 })) s[k] ??= v;
    return s;
  }

  save() {
    this.store.save();
    this.onChange();
  }

  iso() {
    return new Date(this.now()).toISOString();
  }

  levelFor(projectKey) {
    return this.state.autonomy[projectKey] ?? 'standing';
  }

  setAutonomy(projectKey, level) {
    if (!LEVELS.includes(level)) throw err(400, `level must be one of ${LEVELS.join(', ')}`);
    if (!projectKey) throw err(400, 'Pick a project');
    this.state.autonomy[projectKey] = level;
    this.save();
    this.tick().catch(() => {});
    return this.view();
  }

  // ------------------------------------------------------------ what waits

  /** Everything a brief is written for, as it stands now. */
  waiting() {
    const out = [];
    for (const a of this.store.list()) {
      const p = this.projectOf(a);
      if (!p || ['general', 'assistant'].includes(p.key) || a.hunting || a.reviewing) continue;
      const base = { agentId: a.id, agentName: a.name, intent: a.intent, project: p.name, projectKey: p.key };
      const pr = a.planReview;
      if (pr?.status === 'review' && pr.markdown) out.push({ ...base, key: `plan:${a.id}`, kind: 'plan', title: pr.markdown.match(/^#\s+(.+)$/m)?.[1] ?? `Plan for ${a.name}`, markdown: pr.markdown, hash: hash(pr.markdown) });
      for (const q of this.questions(a)) {
        if (a.answers?.[q.id]) continue;
        out.push({ ...base, key: `q:${a.id}:${q.id}`, kind: 'question', qid: q.id, title: q.question, question: q.question, context: q.context, options: q.options, default: q.default, hash: hash(`${q.question}|${q.context}|${q.options.join('|')}`) });
      }
    }
    return out;
  }

  rulesFor(item) {
    return Object.values(this.state.standing).filter((r) => r.on !== false && r.kind === item.kind && (!r.project || r.project === item.projectKey));
  }

  datesFor(projectKey) {
    const p = this.manager.listProjects().find((x) => x.key === projectKey);
    const stages = p ? this.milestones.stages(p) : [];
    return { p, stages, next: stages.find((s) => !s.reached) ?? null, words: stages.filter((s) => !s.reached).map((s) => `${s.label}: ${s.date} (${s.words}, ${s.status.replace('-', ' ')})`).join('; ') };
  }

  /** Write the briefs that are missing, settle the ones decided elsewhere, and act where allowed. */
  async tick() {
    if (!this.enabled()) return;
    const st = this.state;
    const items = this.waiting();
    const live = new Map(items.map((i) => [i.key, i]));
    let changed = false;
    // Decided without the brief (in the plan dialog, the inbox, the terminal): learn from it.
    for (const b of Object.values(st.briefs)) {
      if (live.has(b.key)) continue;
      if (b.status === 'open') {
        this.settle(b);
        changed = true;
      }
      if (this.now() - Date.parse(b.at) > 14 * DAY) {
        delete st.briefs[b.key];
        changed = true;
      }
    }
    if (changed) this.save();
    const jobs = [];
    for (const item of items) {
      const have = st.briefs[item.key];
      if (have?.hash === item.hash && have.status !== 'stale') {
        if (have.status === 'open' && mayAct(this.levelFor(item.projectKey), have)) jobs.push(this.apply(item.key, have.recommend, { by: 'auto' }).catch((e) => this.log(`decide: ${e.message}`)));
        continue;
      }
      if (this.pending.has(item.key)) continue;
      this.pending.add(item.key);
      jobs.push(this.write(item).finally(() => this.pending.delete(item.key)));
    }
    await Promise.all(jobs);
    this.learn().catch(() => {});
  }

  async write(item) {
    const standing = this.rulesFor(item);
    const past = this.state.history.filter((h) => h.kind === item.kind).slice(-6);
    const prompt = briefPrompt(item, { standing, past, lessons: this.state.lessons.slice(-5), dates: this.datesFor(item.projectKey).words });
    const agent = this.store.get(item.agentId) ?? null;
    const d = normalizeBrief(await this.judge.ask(`advise:${item.key}:${item.hash}`, agent, prompt, (x) => Array.isArray(x.options)), item, standing);
    const still = this.waiting().find((i) => i.key === item.key);
    if (!still || still.hash !== item.hash) return;
    const base = { key: item.key, kind: item.kind, agentId: item.agentId, agentName: item.agentName, project: item.project, projectKey: item.projectKey, title: clip(item.title, 300), qid: item.qid ?? null, hash: item.hash, at: this.iso(), status: 'open' };
    // No judge (off, over budget, or no usable reply): the card says so instead of guessing.
    this.state.briefs[item.key] = d ? { ...base, ...d } : { ...base, options: [], recommend: null, why: '', evidence: [], risk: '', undo: 'easy', confidence: 0, standing: null, none: this.judge.enabled ? 'No recommendation could be written (the AI judge gave no usable answer, or is over its daily budget).' : 'The AI judge is off, so there is no recommendation.' };
    this.save();
    const b = this.state.briefs[item.key];
    if (mayAct(this.levelFor(item.projectKey), b)) await this.apply(item.key, b.recommend, { by: 'auto' }).catch((e) => this.log(`decide: ${e.message}`));
  }

  /** Ask for the brief again (the judge was off, or you want a second look). */
  refresh(key) {
    const b = this.state.briefs[key];
    if (b) b.status = 'stale';
    this.tick().catch(() => {});
    return this.view();
  }

  /** Carry out one option of a brief. `by`: 'you' or 'auto'. */
  async apply(key, option, { by = 'you', text = null } = {}) {
    const b = this.state.briefs[key];
    if (!b || b.status !== 'open') throw err(409, 'That is no longer waiting');
    const opt = b.options[option];
    if (!opt) throw err(400, 'No such option');
    const say = clip(text ?? opt.text, 1200);
    const auto = by === 'auto';
    const rule = b.standing ? this.state.standing[b.standing] : null;
    const note = auto ? `${say ? `${say}\n\n` : ''}(Decided for you${rule ? ` by your standing decision "${clip(rule.when, 120)}"` : ' on the recommendation'}: ${b.why})` : say;
    if (opt.action === 'approve') this.manager.approvePlan(b.agentId, note || null);
    else if (opt.action === 'changes') this.manager.requestPlanChanges(b.agentId, note);
    else this.manager.answerQuestion(b.agentId, b.qid, say);
    const followed = option === b.recommend;
    Object.assign(b, { status: auto ? 'auto' : 'applied', chosen: option, decidedAt: this.iso(), by });
    this.remember(b, { chose: opt.action === 'answer' ? say : opt.label, followed, note: opt.action === 'changes' ? say : null, by });
    if (auto) {
      this.state.handled.push({ at: b.decidedAt, key, kind: b.kind, agentId: b.agentId, agentName: b.agentName, project: b.project, projectKey: b.projectKey, title: b.title, did: opt.action === 'answer' ? `Answered: ${clip(say, 200)}` : opt.action === 'approve' ? 'Approved the plan' : `Sent the plan back: ${clip(say, 200)}`, why: b.why, standing: b.standing, standingWhen: rule?.when ?? null, confidence: b.confidence });
      if (this.state.handled.length > 200) this.state.handled.splice(0, this.state.handled.length - 200);
      if (rule) Object.assign(rule, { uses: (rule.uses ?? 0) + 1, lastUsedAt: b.decidedAt });
      this.notify?.(`Decided for you on *${b.project}*: ${clip(b.title, 120)} → ${this.state.handled.at(-1).did}`, `Decided for you on ${b.project}: ${clip(b.title, 120)}: ${this.state.handled.at(-1).did}`)?.catch?.(() => {});
    }
    this.log2decisions(b, { by, followed });
    this.save();
    return this.view();
  }

  /** A brief whose item was decided another way: what was chosen, and whether it matched. */
  settle(b) {
    const a = this.store.get(b.agentId);
    let chose = null;
    let note = null;
    if (a && b.kind === 'plan' && ['approved', 'changes'].includes(a.planReview?.status)) {
      chose = a.planReview.status === 'approved' ? 'Approve' : 'Send back';
      note = a.planReview.note ?? null;
    } else if (a && b.kind === 'question' && a.answers?.[b.qid]) chose = typeof a.answers[b.qid] === 'string' ? a.answers[b.qid] : a.answers[b.qid].text;
    b.status = 'decided';
    b.decidedAt = this.iso();
    if (!chose) return;
    const rec = b.options[b.recommend];
    const followed = rec ? (b.kind === 'plan' ? (rec.action === 'approve') === (chose === 'Approve') : norm(rec.text) === norm(chose) || norm(rec.label) === norm(chose)) : null;
    this.remember(b, { chose, followed, note, by: 'you' });
    this.log2decisions(b, { by: 'you', followed });
  }

  remember(b, { chose, followed, note, by }) {
    const rec = b.options[b.recommend];
    this.state.history.push({ at: this.iso(), kind: b.kind, project: b.project, projectKey: b.projectKey, title: b.title, recommended: rec ? (rec.action === 'answer' ? rec.text : rec.label) : '', chose, followed, note, by });
    if (this.state.history.length > 300) this.state.history.splice(0, this.state.history.length - 300);
    if (rec && by === 'you') this.judge.feedback('advise', { summary: `${b.kind}: ${b.title}`, verdict: `${rec.label} (${b.confidence})`, outcome: followed ? 'they agreed' : `they chose: ${clip(chose, 80)}` });
  }

  /** The decision log's entry for it gets the reasoning, who decided, and whether it was the recommendation. */
  log2decisions(b, { by, followed }) {
    try {
      this.decisions.sync();
      const a = this.store.get(b.agentId);
      const id = b.kind === 'plan' ? `plan:${b.agentId}:${a?.planReview?.decidedAt}` : `answer:${b.agentId}:${b.qid}`;
      if (b.options.length) this.decisions.annotate(id, { reason: b.why, by, followed, recommended: b.options[b.recommend]?.label ?? null, confidence: b.confidence, standing: b.standing });
    } catch {}
  }

  /** Evidence first: the options of a question, each tried by its own agent, compared side by side. */
  race(key) {
    const b = this.state.briefs[key];
    if (!b || b.status !== 'open') throw err(409, 'That is no longer waiting');
    if (b.kind !== 'question' || b.options.length < 2) throw err(400, 'Trying both needs a question with at least two options');
    const a = this.store.get(b.agentId);
    if (!a) throw err(404, 'Its agent is gone');
    const race = this.races.create({
      intent: `${a.intent}\n\nAn open question decides the approach: ${b.title}`,
      variants: b.options.map((o) => ({ label: o.label, instructions: o.text })),
      name: `${a.name}-try`,
      ...(a.repo ? { repo: a.repo, base: a.base ?? undefined } : { dir: a.requestedDir ?? a.workdir }),
    });
    b.raceId = race.id;
    this.save();
    return { race: race.id, view: this.view() };
  }

  // ------------------------------------------------------------ standing decisions

  addStanding({ kind, project = null, when, action, text = '' } = {}, { source = 'you' } = {}) {
    if (!['plan', 'question'].includes(kind)) throw err(400, 'kind must be plan or question');
    const acts = kind === 'plan' ? ['approve', 'changes'] : ['answer'];
    if (!acts.includes(action)) throw err(400, `For a ${kind}, the action is ${acts.join(' or ')}`);
    const w = clip(when, 400);
    const t = clip(text, 1200);
    if (w.length < 8) throw err(400, 'Say when it applies');
    if (action !== 'approve' && !t) throw err(400, action === 'answer' ? 'Say what to answer' : 'Say what to send back');
    const key = project ? this.projects().find((p) => p.key === project || p.shortcut === project || p.name === project)?.key ?? null : null;
    if (project && !key) throw err(400, 'No such project');
    const id = `s${crypto.randomBytes(3).toString('hex')}`;
    this.state.standing[id] = { id, kind, project: key, when: w, action, text: t, source, on: true, uses: 0, createdAt: this.iso(), lastUsedAt: null };
    this.save();
    this.tick().catch(() => {});
    return this.state.standing[id];
  }

  updateStanding(id, { on } = {}) {
    const r = this.state.standing[id];
    if (!r) throw err(404, 'No such standing decision');
    if (typeof on === 'boolean') r.on = on;
    this.save();
    return r;
  }

  removeStanding(id) {
    if (!this.state.standing[id]) throw err(404, 'No such standing decision');
    delete this.state.standing[id];
    for (const b of Object.values(this.state.briefs)) if (b.standing === id) b.standing = null;
    this.save();
    return { ok: true };
  }

  acceptOffer(id) {
    const o = this.state.offers[id];
    if (!o) throw err(404, 'No such offer');
    delete this.state.offers[id];
    this.state.dismissed[id] = this.iso();
    return this.addStanding(o, { source: 'offered' });
  }

  dismissOffer(id) {
    if (!this.state.offers[id]) throw err(404, 'No such offer');
    delete this.state.offers[id];
    this.state.dismissed[id] = this.iso();
    this.save();
    return { ok: true };
  }

  /** Three more decisions of your own since the last look: is there a call you keep making? */
  async learn({ force = false } = {}) {
    const st = this.state;
    const mine = st.history.filter((h) => h.by === 'you');
    if (!force && mine.length - (st.learnedAt ?? 0) < OFFER_AFTER) return [];
    if (this.learning) return [];
    this.learning = true;
    try {
      st.learnedAt = mine.length;
      const recent = mine.slice(-40);
      const rules = Object.values(st.standing);
      const d = await this.judge.ask(`standing:${hash(JSON.stringify(recent.map((h) => [h.title, h.chose])))}`, null, standingPrompt(recent, rules), (x) => Array.isArray(x.offers));
      const found = d
        ? d.offers.filter((o) => Array.isArray(o.basedOn) && new Set(o.basedOn).size >= OFFER_AFTER && (Number(o.confidence) || 0) >= 0.6).map((o) => ({ ...o, count: new Set(o.basedOn).size, project: this.projects().find((p) => p.name === o.project || p.shortcut === o.project)?.key ?? null }))
        : standingFallback(recent).map((o) => ({ ...o, project: this.projects().find((p) => p.name === o.project)?.key ?? null }));
      const added = [];
      for (const o of found) {
        if (!['plan', 'question'].includes(o.kind) || !(o.kind === 'plan' ? ['approve', 'changes'] : ['answer']).includes(o.action)) continue;
        if (o.action !== 'approve' && !clip(o.text, 10)) continue;
        const id = `o${hash(`${o.kind}|${o.project}|${norm(o.when)}`)}`;
        if (st.offers[id] || st.dismissed[id] || rules.some((r) => norm(r.when) === norm(o.when))) continue;
        st.offers[id] = { id, kind: o.kind, project: o.project, when: clip(o.when, 400), action: o.action, text: clip(o.text, 1200), count: o.count, confidence: Number(o.confidence) || 0, at: this.iso(), by: d ? 'judge' : 'rule' };
        added.push(st.offers[id]);
      }
      this.save();
      return added;
    } finally {
      this.learning = false;
    }
  }

  // ------------------------------------------------------------ impact

  openItems(projectKey) {
    return this.backlog.items().filter((it) => it.projectKey === projectKey && ['queued', 'active', 'review', 'blocked'].includes(it.status));
  }

  /** A project's open backlog, most valuable first, each with why. The judge's ranking when it has one for these very items. */
  impact(projectKey, { ask = true } = {}) {
    const items = this.openItems(projectKey);
    const { p, next, words } = this.datesFor(projectKey);
    const scored = items.map((it) => ({ it, ...impactScore(it, { stage: next, now: this.now() }) }));
    const h = hash(JSON.stringify(items.map((it) => [it.id, it.title, it.priority, it.status])) + words);
    const ai = this.state.impact[projectKey];
    const byId = new Map(scored.map((s) => [s.it.id, s]));
    let rows;
    let by = 'rules';
    if (ai?.hash === h && ai.order?.length) {
      by = 'judge';
      const seen = new Set();
      rows = ai.order.filter((o) => byId.has(o.id) && !seen.has(o.id) && seen.add(o.id)).map((o) => ({ ...byId.get(o.id), why: o.why, level: o.impact, unblocks: o.unblocks ?? [], suggest: Number.isInteger(o.priority) && o.priority !== byId.get(o.id).it.priority ? o.priority : null }));
      rows.push(...scored.filter((s) => !seen.has(s.it.id)).sort((a, b) => b.score - a.score));
    } else {
      rows = scored.sort((a, b) => b.score - a.score);
      if (ask && items.length >= 2 && !this.pending.has(`impact:${projectKey}`)) {
        this.pending.add(`impact:${projectKey}`);
        const recent = Object.values(this.decisions.state.items).filter((d) => d.project.key === projectKey).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 5).map((d) => `${d.title}: ${d.decision}`);
        this.judge
          .ask(`impact:${projectKey}:${h}`, null, impactPrompt(items, { project: p?.name ?? projectKey, dates: words, bugs: this.bugs(projectKey), decisions: recent }), (d) => Array.isArray(d.order))
          .then((d) => {
            if (!d) return;
            this.state.impact[projectKey] = { hash: h, at: this.iso(), confidence: d.confidence, order: d.order.filter((o) => o && typeof o.id === 'string').map((o) => ({ id: o.id, impact: ['high', 'medium', 'low'].includes(o.impact) ? o.impact : 'medium', why: clip(o.why, 240), unblocks: (Array.isArray(o.unblocks) ? o.unblocks : []).filter((x) => typeof x === 'string').slice(0, 6), priority: [0, 1, 2, 3].includes(o.priority) ? o.priority : undefined })) };
            this.save();
          })
          .finally(() => this.pending.delete(`impact:${projectKey}`));
      }
    }
    const now = this.backlog.items().filter((it) => it.projectKey === projectKey).map((it) => it.id);
    const queuedNow = now.filter((id) => byId.get(id)?.it.status === 'queued');
    const queuedWant = rows.filter((r) => r.it.status === 'queued').map((r) => r.it.id);
    return {
      project: { key: projectKey, name: p?.name ?? items[0]?.projectName ?? projectKey },
      by,
      thinking: this.pending.has(`impact:${projectKey}`),
      confidence: by === 'judge' ? ai.confidence : null,
      inOrder: queuedNow.join() === queuedWant.join() && !rows.some((r) => r.suggest != null),
      items: rows.map((r, i) => ({ id: r.it.id, title: r.it.title, status: r.it.status, priority: r.it.priority, heldUntil: r.it.heldUntil ?? null, rank: i + 1, score: r.score, level: r.level ?? (r.score >= 55 ? 'high' : r.score >= 30 ? 'medium' : 'low'), why: r.why ?? r.reasons.join(' · '), unblocks: r.unblocks ?? [], suggest: r.suggest ?? null })),
    };
  }

  /** Put the queue in the order of its impact (and the priorities the judge found wrong). */
  applyImpact(projectKey) {
    const v = this.impact(projectKey, { ask: false });
    for (const r of v.items) if (r.suggest != null && r.status === 'queued') this.backlog.update(r.id, { priority: r.suggest });
    this.backlog.reorder(v.items.filter((r) => r.status === 'queued').map((r) => r.id));
    this.backlog.dispatch().catch(() => {});
    this.save();
    return this.impact(projectKey, { ask: false });
  }

  // ------------------------------------------------------------ trade-offs

  /** Every date at risk or late, as choices. */
  tradeoffs({ ask = true } = {}) {
    const out = [];
    for (const p of this.manager.listProjects()) {
      for (const stage of this.milestones.stages(p)) {
        if (!['at-risk', 'late'].includes(stage.status)) continue;
        const ranked = this.impact(p.key, { ask: false }).items;
        if (!ranked.length) continue;
        const all = this.backlog.items().filter((it) => it.projectKey === p.key);
        const t = tradeoffOptions({ stage, ranked, perDay: pace(all, { now: this.now() }), limit: this.backlog.limitFor(p.key) });
        const h = hash(JSON.stringify([stage.id, stage.date, stage.daysLeft, ranked.map((r) => r.id), t.options.map((o) => o.id)]));
        const key = `${p.key}:${stage.id}`;
        const ai = this.state.tradeoffs[key];
        const row = { key, project: { key: p.key, name: p.name }, stage: { id: stage.id, label: stage.label, date: stage.date, words: stage.words, status: stage.status }, ...t, by: 'rules', confidence: null };
        if (ai?.hash === h && t.options.some((o) => o.id === ai.recommend)) Object.assign(row, { recommend: ai.recommend, why: ai.why, confidence: ai.confidence, by: 'judge' });
        else if (ask && !this.pending.has(`tradeoff:${key}`)) {
          this.pending.add(`tradeoff:${key}`);
          const f = stage.checklist.filter((i) => i.auto && !i.ok).map((i) => i.text).join('; ');
          this.judge
            .ask(`tradeoff:${key}:${h}`, null, tradeoffPrompt({ project: p.name, stage, facts: f ? `Also open: ${f}.` : '', t }), (d) => typeof d.recommend === 'string')
            .then((d) => {
              if (!d) return;
              this.state.tradeoffs[key] = { hash: h, at: this.iso(), recommend: d.recommend, why: clip(d.why, 400), confidence: d.confidence };
              this.save();
            })
            .finally(() => this.pending.delete(`tradeoff:${key}`));
        }
        out.push(row);
      }
    }
    return out;
  }

  /** Carry out one choice for a date at risk, and log it as a decision. */
  applyTradeoff(key, option) {
    const t = this.tradeoffs({ ask: false }).find((x) => x.key === key);
    if (!t) throw err(409, 'That date is no longer at risk');
    const o = t.options.find((x) => x.id === option);
    if (!o) throw err(400, 'No such choice');
    if (o.id === 'cut') for (const it of o.items) this.backlog.update(it.id, { heldUntil: addDays(t.stage.date, 1), notes: `${this.backlog.get(it.id).notes ? `${this.backlog.get(it.id).notes}\n` : ''}Held until after ${t.stage.label} (${t.stage.date}).` });
    else if (o.id === 'move') {
      const p = this.manager.listProjects().find((x) => x.key === t.project.key);
      const stages = this.milestones.stages(p);
      const dates = {};
      let from = false;
      for (const s of stages) {
        if (s.id === t.stage.id) from = true;
        if (from && !s.reached) dates[s.id] = addDays(s.date, o.days);
      }
      this.milestones.set(t.project.key, dates);
    } else if (o.id === 'add') this.backlog.settings({ project: t.project.key, limit: o.limit });
    const followed = option === t.recommend;
    this.decisions.record({ kind: 'tradeoff', project: t.project, title: `${t.stage.label} (${t.stage.date}) at risk: ${o.label.toLowerCase()}`, decision: o.what, why: followed ? t.why : `${o.consequence} (The recommendation was to ${t.options.find((x) => x.id === t.recommend)?.label.toLowerCase() ?? t.recommend}.)` });
    this.state.history.push({ at: this.iso(), kind: 'tradeoff', project: t.project.name, projectKey: t.project.key, title: `${t.stage.label} at risk`, recommended: t.recommend, chose: o.id, followed, note: null, by: 'you' });
    delete this.state.tradeoffs[key];
    this.save();
    return this.view();
  }

  // ------------------------------------------------------------ looking back

  /** What followed each decision; the ones worth another look get a lesson from the judge. */
  async lookBack({ force = false } = {}) {
    if (!this.enabled() && !force) return this.lookBackView();
    const st = this.state;
    this.decisions.sync();
    const lateBy = new Map();
    const rows = [];
    for (const d of Object.values(this.decisions.state.items)) {
      if (d.superseded || !d.agentId || !['plan', 'answer', 'design'].includes(d.kind)) continue;
      if (this.now() - Date.parse(d.at) < 2 * DAY && !force) continue;
      const a = this.store.get(d.agentId) ?? null;
      if (!lateBy.has(d.project.key)) {
        const p = this.manager.listProjects().find((x) => x.key === d.project.key);
        lateBy.set(d.project.key, p ? this.milestones.stages(p).some((s) => s.status === 'late' && s.date > String(d.at).slice(0, 10)) : false);
      }
      const item = a ? this.backlog.items().find((it) => it.agentId === a.id) ?? null : null;
      const r = lookBackSigns(d, a, { stageLate: lateBy.get(d.project.key), item });
      const prev = st.reviews[d.id];
      const sig = r.signs.join('|');
      if (prev?.sig === sig && prev.outcome === r.outcome) continue;
      st.reviews[d.id] = { id: d.id, at: this.iso(), outcome: r.outcome, signs: r.signs, sig, lesson: prev?.sig === sig ? prev.lesson : null };
      if (r.outcome === 'revisit') rows.push({ id: d.id, kind: d.kind, project: d.project.name, title: d.title, decision: d.decision, why: d.why ?? d.reason ?? null, signs: r.signs });
      else this.decisions.annotate(d.id, { outcome: r.outcome });
    }
    for (const id of Object.keys(st.reviews)) if (!this.decisions.state.items[id]) delete st.reviews[id];
    if (rows.length) {
      const batch = rows.slice(0, 8);
      const d = await this.judge.ask(`lookback:${hash(JSON.stringify(batch.map((r) => [r.id, r.signs])))}`, null, lookBackPrompt(batch), (x) => Array.isArray(x.items));
      for (const r of batch) {
        const v = d?.items.find((x) => x.id === r.id);
        const rev = st.reviews[r.id];
        // The judge may clear the decision: what followed had another cause.
        if (v?.verdict === 'held') rev.outcome = 'held';
        rev.lesson = v?.lesson ? clip(v.lesson, 300) : null;
        rev.by = v ? 'judge' : 'rules';
        this.decisions.annotate(r.id, { outcome: rev.outcome, lesson: rev.lesson });
        if (rev.outcome === 'revisit' && rev.lesson && !st.lessons.includes(rev.lesson)) st.lessons.push(rev.lesson);
      }
      if (st.lessons.length > 12) st.lessons.splice(0, st.lessons.length - 12);
    }
    st.lookedAt = this.iso();
    this.save();
    return this.lookBackView();
  }

  lookBackView() {
    const items = this.decisions.state.items;
    const rows = Object.values(this.state.reviews)
      .filter((r) => items[r.id])
      .map((r) => ({ ...r, sig: undefined, kind: items[r.id].kind, title: items[r.id].title, decision: items[r.id].decision, project: items[r.id].project, decidedAt: items[r.id].at, agentId: this.store.get(items[r.id].agentId) ? items[r.id].agentId : null, agentName: items[r.id].agentName }));
    const order = { revisit: 0, held: 1, early: 2 };
    rows.sort((a, b) => order[a.outcome] - order[b.outcome] || String(b.decidedAt).localeCompare(String(a.decidedAt)));
    return { items: rows, revisit: rows.filter((r) => r.outcome === 'revisit').length, held: rows.filter((r) => r.outcome === 'held').length, lessons: this.state.lessons, lookedAt: this.state.lookedAt ?? null };
  }

  // ------------------------------------------------------------ the view
  /** The projects there is something to decide for: the ones with a shortcut, and any other an agent works in. */
  projects() {
    const out = new Map(this.manager.listProjects().map((p) => [p.key, { key: p.key, name: p.name, shortcut: p.shortcut }]));
    for (const a of this.store.list()) {
      const p = this.projectOf(a);
      if (p && !['general', 'assistant'].includes(p.key) && !a.hunting && !a.reviewing && !out.has(p.key)) out.set(p.key, { key: p.key, name: p.name, shortcut: p.shortcut ?? null });
    }
    return [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
  }


  seen() {
    this.state.seenAt = this.iso();
    this.save();
    return { ok: true };
  }

  /** `think`: also ask the judge for the rankings and trade-off advice that are missing (the Decide window does; a glance from the inbox doesn't). */
  view({ think = false } = {}) {
    const st = this.state;
    const live = new Set(this.waiting().map((i) => i.key));
    const projects = this.manager.listProjects();
    const everywhere = this.projects();
    const name = (key) => everywhere.find((p) => p.key === key)?.name ?? null;
    const mine = st.history.filter((h) => h.by === 'you' && h.followed !== null && h.recommended);
    const briefs = Object.values(st.briefs).filter((b) => b.status === 'open' && live.has(b.key)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const withWork = projects.filter((p) => this.openItems(p.key).length);
    return {
      enabled: this.enabled(),
      judge: { enabled: this.judge.enabled, ...this.judge.usage() },
      levels: LEVELS.map((id) => ({ id, label: LEVEL_LABEL[id] })),
      briefs: briefs.map((b) => ({ ...b, level: this.levelFor(b.projectKey), canRace: b.kind === 'question' && b.options.length >= 2 && !b.raceId })),
      writing: [...this.pending].filter((k) => k.startsWith('plan:') || k.startsWith('q:')).length,
      handled: [...st.handled].reverse().slice(0, 50).map((h) => ({ ...h, isNew: !st.seenAt || h.at > st.seenAt, agentGone: !this.store.get(h.agentId) })),
      newHandled: st.handled.filter((h) => !st.seenAt || h.at > st.seenAt).length,
      standing: Object.values(st.standing).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((r) => ({ ...r, projectName: r.project ? name(r.project) : null })),
      offers: Object.values(st.offers).map((o) => ({ ...o, projectName: o.project ? name(o.project) : null })),
      autonomy: everywhere.map((p) => ({ ...p, level: this.levelFor(p.key) })),
      agreement: mine.length ? { decided: mine.length, followed: mine.filter((h) => h.followed).length } : null,
      impact: withWork.map((p) => this.impact(p.key, { ask: think })),
      tradeoffs: this.tradeoffs({ ask: think }),
      lookback: this.lookBackView(),
    };
  }
}
