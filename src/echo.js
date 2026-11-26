// Bug echo: one mistake, found in every agent at once. When a lesson is accepted in a repository's
// standards (often the one proposed from an incident or a revert), later agents are given it, but
// the ones already at work are not. So each of them with changes in that repository is checked now:
// a model reads its diff against the lesson and says whether it makes the same mistake, and where.
// One that does is flagged (Glance: to fix; its Results), and you can tell it, or say it is not
// the same. A diff already checked against a lesson is not checked again until it changes.
import crypto from 'node:crypto';
import { NO_REPO } from './manager.js';

const MAX_DIFF = 40_000;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function echoPrompt({ lesson, diff, intent }) {
  return [
    'A lesson was learned in this repository from a change that went wrong. Decide whether the diff below makes the same mistake.',
    'Reply with JSON only: {"repeats": true or false, "where": "file:line of the place, or empty", "why": "one sentence: what in the diff repeats it, or why it does not"}.',
    'Say true only when the diff itself does what the lesson warns against; not for code that merely is near the same subject, and not for what the diff does not touch.',
    '',
    `<lesson>${lesson}</lesson>`,
    `<task>${clip(intent, 600)}</task>`,
    '<diff>',
    diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[cut: the diff is longer]` : diff,
    '</diff>',
  ].join('\n');
}

/** The model's answer, or null when it can't be read. */
export function parseEcho(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j.repeats !== 'boolean') return null;
    return { repeats: j.repeats, where: clip(j.where, 200) || null, why: clip(j.why, 400) || null };
  } catch {
    return null;
  }
}

/** What the agent is told when you send it the echo. */
export const echoMessage = (e) =>
  `A lesson was learned in this repository from a change that went wrong: "${e.lesson}". Your changes look like they repeat it${e.where ? ` at ${e.where}` : ''}${e.why ? `: ${e.why}` : ''}. Check, and fix it if so; if it is not the same, say why in your brief.`;

/** Agents whose open work could repeat a lesson: task agents with a folder, not merged yet. */
export function openWork(agents, except = null) {
  return agents.filter((a) => {
    if (a.id === except || NO_REPO.has(a.kind) || a.kind !== 'task' || a.reviewing || a.hunting || !a.workdir) return false;
    const prs = Object.values(a.prs ?? {}).filter((p) => p.source !== 'mentioned');
    return !prs.some((p) => p.state === 'MERGED' || p.state === 'CLOSED');
  });
}

export class Echo {
  constructor({ manager, standards, review, log = () => {} }) {
    this.manager = manager;
    this.standards = standards;
    this.review = review;
    this.log = log;
    this.running = new Set();
  }

  /** Check the open work in repository `key` against `lesson` (accepted). Returns how many were checked. */
  async run(key, lesson) {
    if (!lesson?.text || lesson.state !== 'accepted') return 0;
    const agents = openWork(this.standards.agentsOf(key), lesson.source?.agentId ?? null);
    let n = 0;
    for (const a of agents) {
      if (await this.check(a.id, lesson).catch((e) => this.log(`bug echo: ${a.name}: ${e.message}`))) n++;
    }
    return n;
  }

  /** One agent against one lesson; kept on the agent as echoes[lessonId]. */
  async check(id, lesson) {
    const k = `${id}:${lesson.id}`;
    if (this.running.has(k)) return false;
    this.running.add(k);
    try {
      const { diff } = await this.review.get(id);
      if (!diff?.trim()) return false;
      const hash = crypto.createHash('sha1').update(`${lesson.text}\n${diff}`).digest('hex').slice(0, 12);
      const agent = this.manager.get(id);
      const prev = agent?.echoes?.[lesson.id];
      if (!agent || prev?.hash === hash) return false;
      const r = await this.manager.ladderShot(agent, echoPrompt({ lesson: lesson.text, diff, intent: agent.intent }), { timeoutMs: 180_000 });
      const found = parseEcho(r.text);
      if (!found) return false;
      const now = this.manager.get(id);
      if (!now) return false;
      this.manager.patch(id, { echoes: { ...now.echoes, [lesson.id]: { lesson: lesson.text, ...found, hash, by: r.by ?? null, at: new Date().toISOString(), state: found.repeats ? 'open' : 'clear' } } });
      return true;
    } finally {
      this.running.delete(k);
    }
  }

  /** You on a flagged one: 'tell' (it is sent the echo) or 'dismiss' (not the same). */
  act(id, lessonId, what) {
    const agent = this.manager.mustGet(id);
    const e = agent.echoes?.[lessonId];
    if (!e || !e.repeats) throw Object.assign(new Error('Nothing flagged for that lesson'), { status: 404 });
    if (what === 'tell') this.manager.tell(id, echoMessage(e), { source: 'echo' });
    else if (what !== 'dismiss') throw Object.assign(new Error('tell or dismiss'), { status: 400 });
    this.manager.patch(id, { echoes: { ...agent.echoes, [lessonId]: { ...e, state: what === 'tell' ? 'told' : 'dismissed', doneAt: new Date().toISOString() } } });
    return this.manager.view(this.manager.get(id));
  }
}

/** The flagged ones still to act on, for Glance and the Results. */
export const openEchoes = (a) => Object.entries(a.echoes ?? {}).filter(([, e]) => e.repeats && e.state === 'open').map(([id, e]) => ({ id, ...e }));
