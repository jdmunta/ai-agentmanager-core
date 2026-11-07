// My actions: what's asked of you in Slack and in meeting notes (Google Meet's "Notes by Gemini"),
// found by the assistant on its checks and kept in one list, so nothing is missed or has to be
// remembered. Each one has your decision on it, as for Jira issues: assign (an agent does it),
// skip, done or remove, kept in state.json and changeable any time; Discuss opens a conversation
// about it. Nothing is ever sent to Slack or anywhere else from here.

import crypto from 'node:crypto';

export const ACTION_SOURCES = { slack: 'Slack', gemini: 'Meeting notes', other: 'Other' };
export const ACTION_STATES = ['open', 'assign', 'skip', 'done', 'remove'];
const GROUP = { open: 'open', assign: 'assigned', skip: 'skipped', done: 'done', remove: 'removed' };
const MAX = 500;
const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The request an agent gets when you assign an action to one. */
export function actionIntent(a) {
  return [
    a.text,
    a.link ? `\nAsked in ${ACTION_SOURCES[a.source] ?? a.source}${a.from ? ` by ${a.from}` : ''}: ${a.link}` : a.from ? `\nAsked by ${a.from}.` : '',
    a.due ? `Due: ${a.due}.` : '',
    a.context ? `\nContext: ${a.context}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** What Discuss starts with: a conversation to decide what to do about the action. */
export function discussPrompt(a, bin = 'agentmgr') {
  return [
    `Help me decide what to do about something asked of me. Talk it through with me; don't act on your own.`,
    '',
    `The action: ${a.text}`,
    a.from ? `Asked by: ${a.from}` : '',
    a.link ? `Where: ${ACTION_SOURCES[a.source] ?? a.source}, ${a.link}` : `Where: ${ACTION_SOURCES[a.source] ?? a.source}`,
    a.due ? `Due: ${a.due}` : '',
    a.context ? `Context: ${a.context}` : '',
    '',
    `If you can, read the source first (your Slack or Google Drive tools) for the full picture. Then tell me in a few lines what it really asks and suggest one of: do it myself (with the steps), hand it to a coding agent (draft the request), reply or delegate (draft the message for me to send), or drop it (and why).`,
    `Never send a message, comment or email yourself. When we've decided, record it: ${bin} actions set <done|skip|remove> ${a.id}, or ${bin} actions set assign ${a.id} --project <project> to give it to an agent.`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export class MyActions {
  constructor({ store, manager }) {
    this.store = store;
    this.manager = manager;
  }

  get all() {
    return (this.store.data.myActions ??= []);
  }

  find(id) {
    const a = this.all.find((x) => x.id === id);
    if (!a) throw err(404, `No action ${id}`);
    return a;
  }

  /** Add one (the assistant does, on its checks). The same action from the same place is kept once. */
  add({ text, source = 'other', link = null, from = null, when = null, due = null, context = null, by = null } = {}) {
    const t = clip(text, 400);
    if (t.length < 3) throw err(400, 'Say what the action is');
    if (!ACTION_SOURCES[source]) throw err(400, `The source is one of ${Object.keys(ACTION_SOURCES).join(', ')}`);
    const url = link ? String(link).trim() : null;
    if (url && !/^https?:\/\/\S+$/.test(url)) throw err(400, 'The link is an http(s) address');
    const key = `${url ?? ''}#${norm(t).slice(0, 120)}`;
    const prev = this.all.find((x) => x.key === key);
    if (prev) return { ...prev, duplicate: true };
    const a = {
      id: crypto.randomBytes(3).toString('hex'),
      key,
      text: t,
      source,
      link: url,
      from: from ? clip(from, 80) : null,
      when: when && !Number.isNaN(Date.parse(when)) ? new Date(when).toISOString() : new Date().toISOString(),
      due: due ? clip(due, 40) : null,
      context: context ? clip(context, 1000) : null,
      by: by ?? null,
      status: 'open',
      at: new Date().toISOString(),
    };
    this.all.push(a);
    // Old decided ones go first when the list grows long.
    while (this.all.length > MAX) {
      const i = this.all.findIndex((x) => x.status !== 'open');
      this.all.splice(i < 0 ? 0 : i, 1);
    }
    this.store.save();
    return a;
  }

  /** The list, open ones first, newest first within: rows with their group and agents. */
  rows() {
    const order = Object.fromEntries(Object.values(GROUP).map((g, i) => [g, i]));
    return this.all
      .map((a) => {
        const agent = a.agentId ? this.manager.store?.get?.(a.agentId) ?? null : null;
        const talk = a.discussId ? this.manager.store?.get?.(a.discussId) ?? null : null;
        return {
          id: a.id,
          text: a.text,
          source: a.source,
          sourceLabel: ACTION_SOURCES[a.source] ?? a.source,
          link: a.link,
          from: a.from,
          when: a.when,
          due: a.due,
          context: a.context,
          status: a.status,
          group: GROUP[a.status] ?? 'open',
          agent: agent ? { id: agent.id, name: agent.name } : null,
          discussion: talk ? { id: talk.id, name: talk.name } : null,
          updatedAt: a.updatedAt ?? a.at,
        };
      })
      .sort((x, y) => order[x.group] - order[y.group] || String(y.when).localeCompare(String(x.when)));
  }

  /**
   * Your decision on actions: open (undecided again), assign (starts an agent; `project` picks
   * where), skip, done or remove. { set: [ids], started: [{ id, agent }], failed: [{ id, reason }] }.
   */
  set(ids = [], state, { project = null } = {}) {
    if (!ACTION_STATES.includes(state)) throw err(400, `The decision is one of ${ACTION_STATES.join(', ')}`);
    const set = [];
    const started = [];
    const failed = [];
    for (const id of new Set(ids)) {
      const a = this.all.find((x) => x.id === id);
      if (!a) {
        failed.push({ id, reason: 'no such action' });
        continue;
      }
      if (state === 'assign' && !(a.agentId && this.manager.store?.get?.(a.agentId))) {
        try {
          const proj = project ? String(project).replace(/^@/, '') : null;
          const [agent] = this.manager.createMany([actionIntent(a)], proj ? { project: proj } : {});
          a.agentId = agent.id;
          started.push({ id, agent: { id: agent.id, name: agent.name } });
        } catch (e) {
          failed.push({ id, reason: e.message });
          continue;
        }
      }
      a.status = state;
      a.updatedAt = new Date().toISOString();
      set.push(id);
    }
    this.store.save();
    return { set, started, failed };
  }

  /** A conversation about the action (a general session), or the one already started. */
  discuss(id, bin) {
    const a = this.find(id);
    const prev = a.discussId ? this.manager.store?.get?.(a.discussId) : null;
    if (prev) return { agent: { id: prev.id, name: prev.name }, existing: true };
    const agent = this.manager.createGeneral({ question: discussPrompt(a, bin), name: `About: ${clip(a.text, 40)}` });
    a.discussId = agent.id;
    this.store.save();
    return { agent: { id: agent.id, name: agent.name }, existing: false };
  }
}
