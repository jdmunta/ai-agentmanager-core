// Autonomy: how far an agent goes without the person. One level per agent:
//   ask   - today's flow: questions, stuck findings and follow-ups wait in the inbox.
//   run   - "agree, then run": the person agrees on what done means (acceptance.js), and the middle
//           is handled for them. A question in QUESTIONS.md or a plan waiting for review is decided
//           by Decide (advisor.js) at its "most things" level, whatever the project's level is; a
//           question the agent stopped on in its terminal is answered here from what is already
//           decided (the request, the agreed points, the ground rules, the repository's lessons,
//           earlier answers); a nudge the judge is sure of is sent; a quiet, unfinished agent is
//           told to carry on. Each is recorded, and an answer shows in the inbox as "Answered for
//           you", where the person can change it.
//   pr    - and its pull request is opened when the work is ready (review rounds for an agent,
//           autopilot for a backlog item), also when that is turned off in general.
//   merge - and the pull request is merged when its checks pass, the review found it ready and it
//           touches no high-risk path.
// What never happens here: a permission prompt is never answered by a model, a question about
// deleting, publishing, money, credentials or scope is left for the person, and an agent cannot
// raise its own level (server.js refuses its calls).
//
// The model calls made here run on a list of models, best first ("fable", "opus", "sonnet" by
// default): the first one that answers is used, and one that fails is skipped for a while.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseJsonReply, specPath } from './brief.js';
import { FREE_CHOICE } from './inbox.js';
import { memoryKey, memoryText } from './memory.js';
import { landState } from './tracker.js';

export const LEVELS = ['ask', 'run', 'pr', 'merge'];
export const LEVEL_LABEL = { ask: 'Ask me', run: 'Agree, then run', pr: 'Run to pull request', merge: 'Run to merge' };
export const AUTONOMY_DEFAULTS = {
  level: 'ask', // for new agents that name none
  models: ['fable', 'opus', 'sonnet'], // best first; the next one when a call fails
  answers: true,
  nudges: true,
  followUps: true,
  minConfidence: 0.7, // of the model, to act on its answer or its nudge
  minBuildConfidence: 70, // of the agent in its own work (its brief), to merge without the person
  maxAnswers: 12, // per agent
  maxNudges: 3,
  maxFollowUps: 2,
  dailyCalls: 80,
  retryMin: 15, // a model that failed is skipped this long
};
const LOG_KEEP = 40;
const SEEN_KEEP = 200;

const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const err = (status, message) => Object.assign(new Error(message), { status });
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A level by its name ("pr", "Run to pull request", "off"); null when it is none of them. */
export function parseLevel(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t) return null;
  if (LEVELS.includes(t)) return t;
  if (['off', 'none', 'no', 'false'].includes(t)) return 'ask';
  if (['on', 'true', 'yes'].includes(t)) return 'run';
  return LEVELS.find((l) => LEVEL_LABEL[l].toLowerCase() === t) ?? null;
}

export const levelOf = (agent) => (LEVELS.includes(agent?.autonomy?.level) ? agent.autonomy.level : 'ask');
export const atLeast = (level, min) => LEVELS.indexOf(level) >= LEVELS.indexOf(min);

/** Settings from config.json's "autonomy", with defaults. `models`: names, or { engine, model }. */
export function autonomySettings(config = {}) {
  const c = config.autonomy ?? {};
  const n = (v, d, lo, hi) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, Number(v))) : d);
  const models = cleanModels(c.models);
  const d = AUTONOMY_DEFAULTS;
  return {
    level: parseLevel(c.level) ?? d.level,
    models: models.length ? models : d.models,
    answers: c.answers !== false,
    nudges: c.nudges !== false,
    followUps: c.followUps !== false,
    minConfidence: n(c.minConfidence, d.minConfidence, 0.5, 1),
    minBuildConfidence: n(c.minBuildConfidence, d.minBuildConfidence, 0, 100),
    maxAnswers: n(c.maxAnswers, d.maxAnswers, 0, 100),
    maxNudges: n(c.maxNudges, d.maxNudges, 0, 20),
    maxFollowUps: n(c.maxFollowUps, d.maxFollowUps, 0, 20),
    dailyCalls: n(c.dailyCalls, d.dailyCalls, 0, 2000),
    retryMin: n(c.retryMin, d.retryMin, 1, 1440),
  };
}

/** A list of models as given ("fable, opus", ["fable", { engine, model }]), cleaned: no empty ones, no repeats, six at most. */
export function cleanModels(input) {
  const list = typeof input === 'string' ? input.split(/[,\s>]+/) : Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const m of list) {
    const item = typeof m === 'string' ? m.trim() : m && typeof m.model === 'string' ? { ...(m.engine ? { engine: String(m.engine) } : {}), model: m.model.trim() } : null;
    const name = typeof item === 'string' ? item : item?.model;
    if (!name || !/^[\w.:\/\[\]-]{1,80}$/.test(name)) continue;
    const key = typeof item === 'string' ? item : `${item.engine ?? ''}/${item.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 6);
}

export const modelName = (m) => (typeof m === 'string' ? m : m?.model ? `${m.engine?.label ?? m.engine ?? ''}${m.engine ? ' ' : ''}${m.model}`.trim() : m?.engine?.label ?? 'the default model');

/**
 * Run `call(model)` on the first model that answers, best first. A model that failed within
 * `retryMs` is tried only after the others. `down` (model name -> when it failed) is kept by the
 * caller between calls. Resolves to { text, model, tried: [{ model, error }] }; rejects when none answered.
 */
export async function callLadder(models, call, { down = new Map(), retryMs = 15 * 60_000, t = Date.now() } = {}) {
  const isDown = (m) => t - (down.get(modelName(m)) ?? -Infinity) < retryMs;
  const order = [...models.filter((m) => !isDown(m)), ...models.filter(isDown)];
  const tried = [];
  for (const model of order) {
    try {
      const text = await call(model);
      down.delete(modelName(model));
      return { text, model, tried };
    } catch (e) {
      down.set(modelName(model), Date.now());
      tried.push({ model: modelName(model), error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  throw Object.assign(new Error(`No model answered (${tried.map((x) => x.model).join(', ') || 'none configured'})${tried.length ? `: ${tried.at(-1).error}` : ''}`), { tried });
}

// Questions that are the person's whatever the sources say: the words that go with what cannot be
// taken back, costs money, or reaches outside the repository.
const SENSITIVE = [
  [/\b(delet\w*|drop(?:ping)?\s+(?:the\s+)?(?:table|database|column|index)|truncat\w*|wip\w+|eras\w+|rm\s+-rf|overwrit\w+)\b/i, 'deleting or overwriting'],
  [/\b(force[- ]?push\w*|rewrit\w+\s+(?:the\s+)?history|reset\s+--hard|rebase\s+(?:onto\s+)?(?:main|master))\b/i, 'rewriting history'],
  [/\b(deploy\w*|publish\w*|releas\w+|ship\s+to|go\s+live|production|prod\b|merge\s+(?:it|this|the\s+(?:pull\s+request|pr|branch))|npm\s+publish)\b/i, 'publishing, deploying or merging'],
  [/\b(password|credential\w*|secret\w*|api[- ]?keys?|private\s+keys?|access\s+tokens?|auth\s+tokens?)\b/i, 'credentials'],
  [/\b(pay(?:ment|ing)?|purchas\w+|billing|invoice\w*|subscription|pricing|paid\s+plan|cost\s+money|licen[cs]e\w*|legal)\b/i, 'money, licences or legal matters'],
  [/\b(personal\s+data|pii|customer\s+data|user\s+data|gdpr|privacy)\b/i, 'personal data'],
  [/\b(send\s+(?:an?\s+)?(?:email|message)|email\s+(?:the|to)|post\s+(?:to|in|on)\s+(?:slack|the\s+channel)|notify\s+(?:the\s+)?(?:customer|client|team))\b/i, 'sending something to other people'],
  [/\b(scope|out\s+of\s+scope|drop\s+(?:the\s+)?(?:feature|requirement)|skip\s+(?:the\s+)?(?:tests?|requirement|acceptance))\b/i, 'the scope of the task'],
];

/** Why a question is the person's to answer (a short phrase), or null when a model may look at it. */
export function sensitive(text) {
  const t = String(text ?? '');
  return SENSITIVE.find(([re]) => re.test(t))?.[1] ?? null;
}

const PERMISSION_ASK = /\bdo you want to (?:proceed|allow|make this edit|create|run|overwrite)\b|\b(?:allow|grant|approve)\b.{0,60}\b(?:access|permission|command|tool|edit|read|write)|\bpermission (?:prompt|request|to)\b|\bwaiting for (?:approval|permission)\b|\btrust (?:the files in )?this folder\b/i;
const PERMISSION_CHOICE = /don'?t ask again|switch to auto mode|\ballow (?:reading|writing|all edits|this|it)\b|\balways allow\b|\bfor this (?:session|project)\b/i;

/**
 * Whether what the screen judge read as a question is the engine's own permission prompt (run this
 * command? allow this read?). Those are never answered for the person, and no model is asked: a
 * numbered Yes/No menu counts, so does the wording of the prompt or of what the judge saw.
 */
export function permissionPrompt({ question, options = [], summary } = {}) {
  const opts = options.map((o) => String(o).replace(/^\s*\d+[.)]\s*/, ''));
  if (opts.some((o) => /^yes\b/i.test(o)) && opts.some((o) => /^no\b/i.test(o))) return true;
  if (opts.some((o) => PERMISSION_CHOICE.test(o))) return true;
  return PERMISSION_ASK.test(`${question ?? ''}\n${summary ?? ''}`);
}

const block = (tag, body) => (String(body ?? '').trim() ? [`<${tag}>`, String(body).trim(), `</${tag}>`] : []);

/**
 * The call that stands in for the person on one question. `ctx`: { question, options, default,
 * context, intent, spec, points, groundRules, lessons, memory, answers: [{ question, answer }],
 * past: [{ question, answer, outcome }] }.
 */
export function answerPrompt(ctx) {
  return [
    'You stand in for a person who is away, for ONE question an AI coding agent asked while working on their task.',
    'Answer it only when one of these holds:',
    '- the answer is already decided by what the person wrote or agreed: the request, the agreed points for what done means, their ground rules, the lessons of the repository, or an earlier answer of theirs;',
    '- it is a routine implementation detail the request leaves to the implementer and that is cheap to change later (a name, where a file goes, which existing helper to use, a default the agent itself proposes).',
    'Leave it for the person ("ask": true) when it changes what is built or how much; when it trades off cost, security, privacy, data or compatibility;',
    'when it would delete, overwrite, publish, deploy, merge, spend money, touch credentials or reach outside the repository; when the request itself says to ask the person about this choice;',
    'when the sources disagree or do not cover it; or when you are not sure.',
    'Never invent a preference the person has not shown. When nothing decides it and the choice is cheap to change, the agent\'s own stated default is the answer.',
    'Reply with one JSON object only, no prose around it. confidence is a number from 0 to 1.',
    'Shape: {"ask": true|false, "answer": "what to tell the agent, one to three sentences, or empty", "basis": "the source that decides it, quoted briefly, or: routine detail, cheap to change", "confidence": 0.0}',
    '',
    '<question>',
    ctx.question,
    ctx.menu?.length ? `The agent shows a menu and takes one of these, by its number:\n${ctx.menu.map((c) => `${c.key}. ${c.label}${c.hint ? ` (${c.hint})` : ''}`).join('\n')}` : ctx.options?.length ? `Options: ${ctx.options.join(' | ')}` : '',
    ctx.menu?.length ? 'When you answer, add "option": the number of the one to pick, and give its label as the answer. If none of them is right, leave it for the person.' : '',
    ctx.default ? `The agent's default until answered: ${ctx.default}` : '',
    ctx.context ? `Context from the agent: ${ctx.context}` : '',
    '</question>',
    ...block('request', clip(ctx.intent, 3000)),
    ...block('agreed_points_for_done', (ctx.points ?? []).map((p) => `${p.id}: ${p.text}`).join('\n')),
    ...block('ground_rules', (ctx.groundRules ?? []).map((r) => `- ${r}`).join('\n')),
    ...block('lessons_of_the_repository', (ctx.lessons ?? []).map((l) => `- ${l}`).join('\n')),
    ...block('earlier_answers_from_the_person', (ctx.answers ?? []).map((a) => `- Q: ${clip(a.question, 200)}\n  A: ${clip(a.answer, 300)}`).join('\n')),
    ...block('spec_written_by_the_agent', String(ctx.spec ?? '').slice(0, 5000)),
    ...block('repository_memory', String(ctx.memory ?? '').slice(0, 2500)),
    ...(ctx.past?.length
      ? ['<how_the_person_took_earlier_answers_given_for_them>', ...ctx.past.map((p) => `- Q: ${clip(p.question, 160)} → answered: ${clip(p.answer, 160)}; the person ${p.outcome}`), '</how_the_person_took_earlier_answers_given_for_them>', 'Calibrate to these: where they changed an answer, be slower to answer that kind of question.']
      : []),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** The model's reply as { ask, answer, basis, confidence }, or null when it is unusable. */
export function parseAnswer(text) {
  let d;
  try {
    d = parseJsonReply(text);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object' || typeof d.ask !== 'boolean') return null;
  const answer = clip(d.answer, 600);
  const option = /^\d$/.test(String(d.option ?? '')) ? String(d.option) : null;
  return { ask: d.ask || !answer, answer, option, basis: clip(d.basis, 300), confidence: Math.max(0, Math.min(1, Number(d.confidence) || 0)) };
}

/** What the agent is told: the answer, and that it was given for the person, not by them. */
export const autoAnswerMessage = (question, e) =>
  `Answer to your question "${question}": ${e.answer}\n(Given for the user by AI Agent Manager while they are away, from what is already decided${e.basis ? `: ${e.basis}` : ''}. The user sees it and may change it; record it in your brief as an assumption.)`;

export const correctionMessage = (e, text) => `Correction from the user: your question "${e.question}" was answered for them with "${e.answer}". Their own answer is: ${text}\nApply it, and undo what you did on the earlier answer where it differs.`;

export const nudgeNote = '\n(Sent by AI Agent Manager while the user is away. If this does not help, set your brief to blocked and say what you need.)';

export const followUpMessage = (v) =>
  `You have been quiet for a while and the task is not finished${v?.detail ? ` (${v.detail})` : ''}. Carry on from where you stopped: check your brief and plan, do the next step, and keep the brief current. ` +
  'If you are waiting for something only the user can give, set the brief to blocked and say exactly what you need.';

/** "2 answered, 1 nudge, 1 left for you", from an agent's log. */
export function logLine(log = []) {
  const n = (k) => log.filter((e) => e.kind === k).length;
  const parts = [
    n('answer') ? `${n('answer')} answered` : '',
    n('nudge') ? `${n('nudge')} nudge${n('nudge') === 1 ? '' : 's'}` : '',
    n('followup') ? `${n('followup')} follow-up${n('followup') === 1 ? '' : 's'}` : '',
    n('plan') ? 'plan decided' : '',
    n('merge') ? 'merged' : '',
    n('left') ? `${n('left')} left for you` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

/** An agent this can work for: a task with changes of its own, not a team member, reviewer, hunter or builder. */
/**
 * The agent's own question shown as a menu (not a permission prompt, not one that takes several
 * ticks): { key, question, options, menu: [{ key, label, hint }] }, or null.
 */
export function menuOf(view) {
  const p = view?.runtime?.attention === 'Question' ? view.runtime.prompt : null;
  const menu = (p?.choices ?? []).filter((c) => !FREE_CHOICE.test(c.label));
  if (!p?.question || menu.length < 2 || p.multi) return null;
  return { key: `m:${hash(`${p.question}\n${menu.map((c) => c.label).join('\n')}`)}`, question: p.question, options: menu.map((c) => c.label), menu };
}

/** Why a merge is the person's: the agent says it left something out, or its proof did not hold when run again. */
export function leftOut(agent, view) {
  const nd = view?.results?.notDone ?? [];
  if (nd.length) return `The agent lists as not done: ${clip(nd.join('; '), 240)}.`;
  const rerun = agent.proof && agent.proof.proofAt === (agent.proofDoc?.updatedAt ?? null) ? agent.proof.results.filter((r) => r.status === 'differs') : [];
  if (rerun.length) return `${rerun.length} of its recorded commands gave a different result when run again: ${clip(rerun.map((r) => r.title).join('; '), 200)}.`;
  return null;
}

export const eligible = (agent) => agent?.kind === 'task' && !agent.team && !agent.builds && !agent.reviewing && !agent.hunting && !agent.fixing && !agent.raceId;

export class Autonomy {
  /**
   * `review.get(id)` gives an agent's changes ({ files, diffHash }); `landing` merges; `backlog`
   * says which agents are a backlog item's (autopilot ships those).
   */
  constructor({ manager, store, config = {}, review = null, landing = null, backlog = null, log = (m) => console.log(`[agentmgr] ${m}`) }) {
    Object.assign(this, { manager, store, config, review, landing, backlog, log });
    this.working = new Set(); // agent ids with a step in progress
    this.queued = null;
    this.kick = () => this.schedule();
    manager.autonomy = this;
    manager.on('change', this.kick);
    manager.on('prs', this.kick);
    this.timer = setInterval(this.kick, 30_000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
    clearTimeout(this.queued);
    this.manager.off('change', this.kick);
    this.manager.off('prs', this.kick);
  }

  get settings() {
    return autonomySettings(this.config);
  }

  schedule() {
    if (this.queued) return;
    this.queued = setTimeout(() => {
      this.queued = null;
      this.tick();
    }, 500);
    this.queued.unref?.();
  }

  /** One look at every agent that runs without the person. Steps of different agents run side by side. */
  tick() {
    const runs = [];
    for (const agent of this.store.list()) {
      const level = levelOf(agent);
      if (level === 'ask' || !eligible(agent) || this.working.has(agent.id)) continue;
      this.working.add(agent.id);
      runs.push(
        this.step(agent.id, level)
          .catch((e) => this.log(`autonomy: ${agent.name}: ${e.message}`))
          .finally(() => this.working.delete(agent.id)),
      );
    }
    return Promise.all(runs);
  }

  // ------------------------------------------------------------ the record

  state(agent) {
    return { log: [], seen: {}, ...agent.autonomy };
  }

  /** Change an agent's record, from the stored one (a step can take a while). */
  put(id, fn) {
    const agent = this.store.get(id);
    if (!agent?.autonomy) return null;
    const st = this.state(agent);
    fn(st);
    if (st.log.length > LOG_KEEP) st.log = st.log.slice(-LOG_KEEP);
    // What was looked at, newest kept: a question or finding seen long ago does not come back.
    const seen = Object.entries(st.seen);
    if (seen.length > SEEN_KEEP) st.seen = Object.fromEntries(seen.sort((a, b) => String(a[1]).localeCompare(String(b[1]))).slice(-SEEN_KEEP));
    return this.manager.patch(id, { autonomy: st });
  }

  record(id, entry) {
    const e = { id: crypto.randomBytes(4).toString('hex'), at: now(), ...entry };
    this.put(id, (st) => st.log.push(e));
    return e;
  }

  usage() {
    const u = (this.store.data.autonomy ??= {});
    if (u.day !== today()) Object.assign(u, { day: today(), calls: 0 });
    return u;
  }

  status() {
    const s = this.settings;
    const u = this.usage();
    const agents = this.store.list().filter((a) => levelOf(a) !== 'ask');
    return { ...s, labels: LEVEL_LABEL, levels: LEVELS, calls: u.calls, lastModel: u.lastModel ?? null, lastError: u.lastError ?? null, agents: agents.length };
  }

  /** Changes from the API: `level` (for new agents), `models` (best first), the switches and the limits. */
  change(b = {}) {
    const next = { ...this.config.autonomy };
    if ('level' in b) {
      const level = parseLevel(b.level);
      if (!level) throw err(400, `level is one of ${LEVELS.join(', ')}`);
      next.level = level;
    }
    if ('models' in b) {
      const models = cleanModels(b.models);
      if (!models.length) throw err(400, 'Name at least one model, best first: fable, opus, sonnet');
      next.models = models;
    }
    for (const k of ['answers', 'nudges', 'followUps']) if (k in b) next[k] = b[k] === true || b[k] === 'on';
    for (const k of ['minConfidence', 'minBuildConfidence', 'maxAnswers', 'maxNudges', 'maxFollowUps', 'dailyCalls']) {
      if (!(k in b)) continue;
      if (!Number.isFinite(Number(b[k])) || Number(b[k]) < 0) throw err(400, `${k} must be a number`);
      next[k] = Number(b[k]);
    }
    this.config.autonomy = next;
    return next;
  }

  // ------------------------------------------------------------ one agent

  /** Set an agent's level. Its record (what was answered and sent for you) is kept. */
  setLevel(ref, value) {
    const agent = this.manager.mustGet(ref);
    const level = parseLevel(value);
    if (!level) throw err(400, `autonomy is one of ${LEVELS.join(', ')}`);
    if (level !== 'ask' && !eligible(agent)) throw err(400, 'Only a task agent with changes of its own can run without you (not a team member, a reviewer, a bug hunt or a general session)');
    if (level === levelOf(agent)) return this.manager.view(agent);
    const st = this.state(agent);
    const next = level === 'ask' && !st.log.length ? null : { ...st, level, hold: null };
    const v = this.manager.view(this.manager.patch(agent.id, { autonomy: next }));
    this.schedule();
    return v;
  }

  async step(id, level) {
    const agent = this.store.get(id);
    if (!agent || agent.status === 'preparing' || agent.desktop) return;
    const s = this.settings;
    const v = this.manager.view(agent);
    const st = this.state(agent);
    const count = (k) => st.log.filter((e) => e.kind === k).length;
    // While what done means or the plan waits for the person, the agent is asking for exactly that:
    // nothing is answered or nudged for them.
    const theirs = this.manager.acceptanceWaits(agent) || Boolean(agent.planReview && agent.planReview.status !== 'approved');

    if (s.answers && !theirs) {
      // Questions in QUESTIONS.md and plans are Decide's (advisor.js); the one it stopped on in its terminal is ours.
      const w = v.runtime?.waiting;
      const asked = w?.state === 'question' ? w.question || w.summary : null;
      // A permission prompt the app itself sees is in the inbox already, as a prompt.
      const prompted = v.runtime?.prompt || v.runtime?.attention;
      if (asked && !prompted && !st.seen[`w:${hash(asked)}`]) return this.answer(agent, { key: `w:${hash(asked)}`, question: asked, options: w.choices ?? [], summary: w.summary });
      // Its question as a menu: one option is picked by its key (a typed message would not be read).
      const menu = menuOf(v);
      if (menu && !st.seen[menu.key]) return this.answer(agent, menu);
    }

    if (s.nudges && !theirs) {
      for (const f of v.stuck ?? []) {
        const key = `s:${f.key}:${f.since}`;
        if (st.seen[key] || f.ai?.verdict !== 'stuck' || !(f.ai.confidence >= s.minConfidence) || !f.nudge) continue;
        if (count('nudge') >= s.maxNudges) {
          this.put(id, (x) => (x.seen[key] = now()));
          continue; // it stays in the inbox, for the person
        }
        this.put(id, (x) => (x.seen[key] = now()));
        this.manager.tell(id, `${f.nudge}${nudgeNote}`, { source: 'autonomy' });
        this.manager.dismissStuck(id, f.key, { feedback: null });
        this.record(id, { kind: 'nudge', title: f.title, text: f.nudge, confidence: f.ai.confidence, model: f.ai.by ?? null });
        this.log(`autonomy: nudged ${agent.name}: ${f.title}`);
        return;
      }
    }

    const fu = v.followUp;
    if (s.followUps && fu?.kind === 'followup' && !st.seen[`f:${fu.since}`]) {
      const waitsOnPerson = theirs || v.results?.outcome === 'blocked';
      if (!waitsOnPerson) {
        this.put(id, (x) => (x.seen[`f:${fu.since}`] = now()));
        if (count('followup') < s.maxFollowUps) {
          this.manager.tell(id, followUpMessage(fu), { source: 'autonomy' });
          this.record(id, { kind: 'followup', title: fu.title, text: fu.detail ?? '' });
          this.log(`autonomy: told ${agent.name} to carry on (${fu.title})`);
          return;
        }
      }
    }

    if (level === 'merge' && this.landing && !this.backlogItem(id)) await this.land(agent, v);
  }

  /** The backlog item an agent works on, if any: autopilot ships those (autopilot.js). */
  backlogItem(id) {
    return this.backlog?.items().find((it) => it.agentId === id) ?? null;
  }

  // -------------------------------------------------------------- answers

  context(agent) {
    let spec = '';
    try {
      spec = fs.readFileSync(specPath(agent.id), 'utf8');
    } catch {}
    const questions = new Map((this.manager.questionsView(agent) ?? []).map((q) => [q.id, q.question]));
    const answers = Object.entries(agent.answers ?? {})
      .filter(([, a]) => a.by !== 'autonomy')
      .map(([qid, a]) => ({ question: questions.get(qid) ?? '(an earlier question)', answer: a.text }))
      .slice(-8);
    const past = [];
    for (const a of this.store.list()) {
      for (const e of a.autonomy?.log ?? []) if (e.kind === 'answer' && (e.ack || e.corrected)) past.push({ at: e.at, question: e.question, answer: e.answer, outcome: e.corrected ? `changed it to: ${clip(e.corrected, 160)}` : 'kept it' });
    }
    past.sort((x, y) => x.at.localeCompare(y.at));
    return {
      intent: agent.intent,
      spec,
      points: agent.acceptance?.status === 'agreed' ? agent.acceptance.points : [],
      groundRules: this.manager.groundRules?.list() ?? [],
      lessons: (this.manager.standards?.forAgent(agent).lessons ?? []).map((l) => l.text).filter(Boolean),
      memory: this.config.memory === false ? '' : memoryText(memoryKey(agent)),
      answers,
      past: past.slice(-8),
    };
  }

  /** One question: leave it for the person, or answer it from what is already decided. */
  async answer(agent, q) {
    const id = agent.id;
    const s = this.settings;
    const st = this.state(agent);
    const left = (why) => {
      this.put(id, (x) => (x.seen[q.key] = now()));
      this.record(id, { kind: 'left', key: q.key, question: clip(q.question, 300), why });
    };
    if (permissionPrompt(q)) return left('It is a permission prompt: only you answer those.');
    const touchy = sensitive([q.question, ...(q.options ?? []), q.default, q.context].filter(Boolean).join('\n'));
    if (touchy) return left(`It is about ${touchy}: yours to answer.`);
    if (st.log.filter((e) => e.kind === 'answer').length >= s.maxAnswers) return left(`${s.maxAnswers} questions were already answered for you on this agent.`);
    const u = this.usage();
    if (u.calls >= s.dailyCalls) return left("Today's calls for answering are used up.");
    u.calls++;
    // Seen before the call: a second look while it runs must not ask again.
    this.put(id, (x) => (x.seen[q.key] = now()));
    let r;
    try {
      r = await this.manager.ladderShot(agent, answerPrompt({ ...q, ...this.context(agent) }), { timeoutMs: 120_000 });
    } catch (e) {
      u.lastError = { at: now(), message: String(e.message).slice(0, 300) };
      this.store.save();
      this.record(id, { kind: 'left', key: q.key, question: clip(q.question, 300), why: 'No model could be reached to look at it.' });
      return;
    }
    u.lastModel = r.by;
    this.store.save();
    const d = parseAnswer(r.text);
    if (!d || d.ask || d.confidence < s.minConfidence) {
      this.record(id, { kind: 'left', key: q.key, question: clip(q.question, 300), why: d ? (d.ask ? d.basis || 'Nothing already decided covers it.' : `Not sure enough (${Math.round(d.confidence * 100)}%).`) : 'The reply could not be read.', model: r.by });
      return;
    }
    // The person may have answered while the model was thinking: theirs stands.
    const cur = this.store.get(id);
    if (!cur || levelOf(cur) === 'ask') return;
    if (q.qid) {
      if (cur.answers?.[q.qid]) return;
      this.manager.patch(id, { answers: { ...cur.answers, [q.qid]: { text: d.answer, at: now(), by: 'autonomy', model: r.by, basis: d.basis } } });
    } else if (q.menu) {
      const c = q.menu.find((x) => x.key === d.option);
      if (!c || menuOf(this.manager.view(cur))?.key !== q.key) {
        if (!c) this.record(id, { kind: 'left', key: q.key, question: clip(q.question, 300), why: 'The reply did not pick one of the choices.' });
        return; // or the menu was answered, or changed, meanwhile
      }
      const e = this.record(id, { kind: 'answer', key: q.key, qid: null, question: clip(q.question, 300), answer: c.label, basis: d.basis, confidence: d.confidence, model: r.by, ack: false });
      this.manager.answerPrompt(id, c.key);
      this.log(`autonomy: picked "${c.label}" for ${agent.name} (${r.by}): ${clip(q.question, 80)}`);
      return e;
    } else {
      const rt = this.manager.runtimes.get(id);
      const w = rt?.waiting;
      if (!w || (w.question || w.summary) !== q.question) return;
      rt.waiting = null;
    }
    const e = this.record(id, { kind: 'answer', key: q.key, qid: q.qid ?? null, question: clip(q.question, 300), answer: d.answer, basis: d.basis, confidence: d.confidence, model: r.by, ack: false });
    this.manager.tell(id, autoAnswerMessage(q.question, e), { source: 'autonomy' });
    this.log(`autonomy: answered for ${agent.name} (${r.by}): ${clip(q.question, 80)}`);
  }

  // ---------------------------------------------- with Decide (advisor.js)

  /** For Decide: does this agent run without the person? */
  autonomous(agentId) {
    const agent = this.store.get(agentId);
    return Boolean(agent) && eligible(agent) && levelOf(agent) !== 'ask' && this.settings.answers;
  }

  /** For Decide: why an item is the person's whatever is recommended, or null. */
  guard(item) {
    return sensitive([item.question, ...(item.options ?? []), item.default, item.context].filter(Boolean).join('\n'));
  }

  /** For Decide: what its recommendation should know of this agent's task. */
  briefContext(item) {
    const agent = this.store.get(item.agentId);
    if (!agent) return {};
    const c = this.context(agent);
    return { points: c.points, groundRules: c.groundRules, repoLessons: c.lessons };
  }

  /** Decide carried something out for an agent that runs without the person: it goes on that agent's record. */
  decided(h) {
    const agent = this.store.get(h.agentId);
    if (!agent?.autonomy || levelOf(agent) === 'ask') return;
    if (h.action === 'answer') this.record(agent.id, { kind: 'answer', via: 'decide', qid: h.qid ?? null, question: clip(h.title, 300), answer: clip(h.text, 600), basis: clip(h.why, 300), confidence: h.confidence ?? null, model: null, ack: false });
    else this.record(agent.id, { kind: 'plan', via: 'decide', title: h.did, text: clip(h.why, 300) });
  }

  entry(agent, entryId) {
    const e = (agent.autonomy?.log ?? []).find((x) => x.id === entryId);
    if (!e) throw err(404, 'No such entry');
    return e;
  }

  /** "OK": the person has seen what was done for them (an answer, a held merge). */
  ack(ref, entryId) {
    const agent = this.manager.mustGet(ref);
    if (entryId === 'hold') return this.manager.view(this.put(agent.id, (st) => st.hold && (st.hold.ack = true)) ?? agent);
    this.entry(agent, entryId);
    return this.manager.view(this.put(agent.id, (st) => (st.log.find((x) => x.id === entryId).ack = true)));
  }

  /** The person's own answer to a question that was answered for them: the agent is told to apply it. */
  correct(ref, entryId, text) {
    const agent = this.manager.mustGet(ref);
    const e = this.entry(agent, entryId);
    if (e.kind !== 'answer') throw err(400, 'Only an answer can be changed');
    text = String(text ?? '').trim();
    if (!text) throw err(400, 'Your answer is empty');
    if (e.qid) this.manager.patch(agent.id, { answers: { ...agent.answers, [e.qid]: { text, at: now() } } });
    this.put(agent.id, (st) => Object.assign(st.log.find((x) => x.id === entryId), { ack: true, corrected: clip(text, 600) }));
    return this.manager.tell(agent.id, correctionMessage(e, text), { source: 'answer' });
  }

  // ---------------------------------------------------------------- merge

  /** Stop and wait for the person on this state of the pull request; shown once in the inbox. */
  hold(id, key, note) {
    const cur = this.store.get(id)?.autonomy?.hold;
    if (cur?.key === key && cur.note === note) return;
    this.log(`autonomy: holding ${this.store.get(id)?.name}: ${note}`);
    this.put(id, (st) => (st.hold = { key, note: clip(note, 500), at: now(), ack: false }));
  }

  /** "Run to merge" for an agent that is not a backlog item: merge its pull request when everything says ready. */
  async land(agent, v) {
    const id = agent.id;
    const s = this.settings;
    for (const pr of this.landing.openPrs(agent)) {
      const state = landState(pr);
      const key = `${pr.url}@${pr.head ?? ''}`;
      const st = this.state(this.store.get(id) ?? agent);
      if (st.hold?.key === key || st.merged === key) continue;
      if (state === 'behind' && st.updated !== key) {
        this.put(id, (x) => (x.updated = key));
        await this.landing.updateBranch(id).catch((e) => this.hold(id, key, `Its branch is behind and could not be updated: ${e.message}`));
        return;
      }
      if (state === 'draft') return this.hold(id, key, 'Its pull request is a draft.');
      if (state !== 'ready') continue; // waiting for checks; failing ones go back to the agent through Landing
      if (v.runtime?.busy) return;
      // Reviewed in rounds: only what the critics approved is merged.
      const pre = agent.preReview;
      if (['reviewing', 'fixing'].includes(pre?.status)) return;
      if (pre && pre.status !== 'approved') return this.hold(id, key, pre.status === 'stalled' ? `The review rounds did not approve its changes (${pre.round} ${pre.round === 1 ? 'round' : 'rounds'}).` : 'Its changes were not approved by the review rounds.');
      if (this.manager.acceptanceWaits(agent)) return this.hold(id, key, 'What done means is not agreed yet.');
      const own = v.results?.confidence;
      if (own && own.percent < s.minBuildConfidence) return this.hold(id, key, `The agent's own confidence in this is ${own.percent}%${own.why ? `: ${own.why}` : ''}.`);
      const left = leftOut(agent, v);
      if (left) return this.hold(id, key, left);
      const changes = this.review ? await this.review.get(id) : null;
      const risk = changes ? this.manager.standards?.riskIn(agent, changes.files ?? []) ?? [] : [];
      if (risk.length) return this.hold(id, key, `It changes high-risk paths (${risk.slice(0, 3).map((r) => r.path).join(', ')}${risk.length > 3 ? ` and ${risk.length - 3} more` : ''}): yours to merge.`);
      const card = this.store.get(id)?.docs?.scorecard;
      if (card?.pending) return;
      if (!card?.data || (changes?.diffHash && card.diffHash !== changes.diffHash)) {
        if (st.scored === key) return this.hold(id, key, card?.error ? `Couldn't score the changes: ${card.error}` : "Couldn't score the changes.");
        this.put(id, (x) => (x.scored = key));
        await this.manager.summarize(id, 'scorecard').catch(() => {});
        return this.schedule();
      }
      const sc = card.data;
      if (sc.recommendation !== 'ready') return this.hold(id, key, `The review scorecard says ${sc.recommendation === 'look' ? 'to look first' : 'it is not ready'} (${sc.overall ?? '?'}/100)${sc.reasons?.length ? `: ${sc.reasons.join('; ')}` : ''}.`);
      this.put(id, (x) => (x.merged = key));
      try {
        await this.landing.merge(id, { url: pr.url });
      } catch (e) {
        this.put(id, (x) => (x.merged = null));
        return this.hold(id, key, `The merge failed: ${e.message}`);
      }
      this.record(id, { kind: 'merge', title: `Merged ${pr.url}`, text: `Checks passed, the scorecard said ready (${sc.overall ?? '?'}/100)${own ? `, its own confidence ${own.percent}%` : ''}.`, url: pr.url });
      this.log(`autonomy: merged ${pr.url}`);
      return;
    }
  }

  // ---------------------------------------------------------------- inbox

  /** What was decided for the person and they have not seen: answers given, a merge held. */
  inbox() {
    const items = [];
    for (const agent of this.store.list()) {
      const st = agent.autonomy;
      if (!st) continue;
      const base = { kind: 'auto', agentId: agent.id, agentName: agent.name, priority: agent.priority ?? 2 };
      for (const e of st.log ?? []) if (e.kind === 'answer' && !e.ack) items.push({ ...base, key: `auto:${agent.id}:${e.id}`, title: `Answered for you: ${e.question}`, entry: e, at: e.at });
      if (st.hold && !st.hold.ack && levelOf(agent) === 'merge') items.push({ ...base, key: `auto:${agent.id}:hold`, title: `Not merged: ${st.hold.note}`, entry: { id: 'hold', kind: 'hold', ...st.hold }, at: st.hold.at });
    }
    return items;
  }
}
