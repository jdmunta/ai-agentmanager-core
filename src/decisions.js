// Decisions: what was decided on each project and why, in one log, so "why did we do it this way"
// has an answer later. It is gathered from what already happens here: plans you approved or sent
// back (with your notes), the answers you gave agents' questions, and the "Decisions and risks"
// of each agent's design doc; and you can add your own. Entries stay after their agent is deleted.
// Nothing is sent anywhere, and no model is called.

import crypto from 'node:crypto';

const MAX = 2000;
export const DECISION_KINDS = { plan: 'Plan review', answer: 'Your answer', design: 'Design', manual: 'Added by you' };
const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
const plain = (s) => String(s ?? '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();

/** The bullets under "## Decisions and risks" (or "## Decisions") of a design doc. */
export function designDecisions(markdown) {
  const out = [];
  let on = false;
  let cur = null;
  const flush = () => {
    if (cur?.trim()) out.push(cur.replace(/\s+/g, ' ').trim());
    cur = null;
  };
  for (const line of String(markdown ?? '').split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      flush();
      on = /^#{2,3}\s+(key\s+)?decisions\b/i.test(line);
      continue;
    }
    if (!on) continue;
    const b = line.match(/^\s{0,3}[-*]\s+(.*)$/);
    if (b) {
      flush();
      cur = b[1];
    } else if (cur !== null && line.trim()) cur += ` ${line.trim()}`;
    else flush();
  }
  flush();
  // A line that only names a risk isn't a decision.
  return out.filter((t) => t.length > 8 && !/^\**risks?\b[^:]*:/i.test(t));
}

/** A decision bullet as { title, decision }: its bold lead or first clause, then the whole of it. */
function splitBullet(text) {
  const bold = text.match(/^\*\*([^*]{3,120})\*\*[:.]?\s*(.*)$/);
  if (bold) return { title: plain(bold[1]), decision: plain(bold[2]) || plain(bold[1]) };
  const t = plain(text);
  const lead = t.match(/^(.{12,110}?)(?::\s|\s[–—-]\s|;\s|\.\s)(.+)$/);
  return lead ? { title: lead[1], decision: t } : { title: clip(t, 110), decision: t };
}

export class Decisions {
  /**
   * `agents()` lists the agent records; `projectOf(agent)` names its project; `questions(agent)`
   * its questions ([{ id, question }]); `designDoc(id)` its design doc ({ markdown, updatedAt }).
   */
  constructor({ store, agents, projectOf, questions = () => [], designDoc = () => null, onChange = () => {}, now = () => new Date().toISOString(), timer = true }) {
    Object.assign(this, { store, agents, projectOf, questions, designDoc, onChange, now });
    if (timer) {
      // Gathered now and then too, so an agent deleted between two looks still leaves its decisions.
      this.timer = setInterval(() => this.sync(), 5 * 60_000);
      this.timer.unref?.();
    }
  }

  close() {
    clearInterval(this.timer);
  }

  get state() {
    return (this.store.data.decisions ??= { items: {}, removed: {} });
  }

  /** Gather what's new from the agents; true when something was added or changed. */
  sync() {
    const st = this.state;
    let changed = false;
    const put = (id, rec) => {
      if (st.removed[id]) return;
      const prev = st.items[id];
      if (prev && prev.decision === rec.decision && prev.why === rec.why && !prev.superseded) return;
      st.items[id] = { ...prev, id, ...rec, superseded: false };
      changed = true;
    };
    for (const a of this.agents()) {
      const p = this.projectOf(a);
      if (!p || ['general', 'assistant'].includes(p.key)) continue;
      const base = { project: { key: p.key, name: p.name }, agentId: a.id, agentName: a.name };
      const pr = a.planReview;
      if (pr?.decidedAt && ['approved', 'changes'].includes(pr.status)) {
        put(`plan:${a.id}:${pr.decidedAt}`, { ...base, kind: 'plan', at: pr.decidedAt, title: `Plan for ${a.name}`, decision: pr.status === 'approved' ? 'Approved' : 'Sent back for changes', why: clip(pr.note, 1000) || null });
      }
      const answers = a.answers ?? {};
      if (Object.keys(answers).length) {
        const qs = new Map(this.questions(a).map((q) => [q.id, q]));
        for (const [qid, ans] of Object.entries(answers)) {
          const text = typeof ans === 'string' ? ans : ans?.text;
          if (!text) continue;
          put(`answer:${a.id}:${qid}`, { ...base, kind: 'answer', at: ans?.at ?? this.now(), title: clip(qs.get(qid)?.question ?? `A question from ${a.name}`, 300), decision: clip(text, 1000), why: qs.get(qid)?.why ? clip(qs.get(qid).why, 500) : null });
        }
      }
      const doc = this.designDoc(a.id);
      if (doc?.markdown) {
        const seen = new Set();
        for (const b of designDecisions(doc.markdown)) {
          const { title, decision } = splitBullet(b);
          const id = `design:${a.id}:${hash(b)}`;
          seen.add(id);
          if (!st.items[id]) put(id, { ...base, kind: 'design', at: doc.updatedAt ?? this.now(), title: clip(title, 300), decision: clip(decision, 1000), why: null });
        }
        // The design moved on: what it no longer says is kept, marked as replaced.
        for (const it of Object.values(st.items)) {
          if (it.kind === 'design' && it.agentId === a.id && !seen.has(it.id) && !it.superseded) {
            it.superseded = true;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      const all = Object.values(st.items).sort((x, y) => String(y.at).localeCompare(String(x.at)));
      if (all.length > MAX) st.items = Object.fromEntries(all.slice(0, MAX).map((i) => [i.id, i]));
      this.store.save();
      this.onChange();
    }
    return changed;
  }

  /** Add one of your own: { project (a known project's key and name), title, decision, why }. */
  add({ project, title, decision, why = null } = {}) {
    if (!project?.key) throw err(400, 'Pick the project it belongs to');
    const t = clip(title, 300);
    const d = clip(decision, 1000);
    if (t.length < 3 || d.length < 2) throw err(400, 'Say what was decided: a title and the decision');
    const id = `manual:${crypto.randomBytes(4).toString('hex')}`;
    this.state.items[id] = { id, kind: 'manual', at: this.now(), project: { key: project.key, name: project.name }, agentId: null, agentName: null, title: t, decision: d, why: clip(why, 1000) || null, superseded: false };
    this.store.save();
    this.onChange();
    return this.state.items[id];
  }

  /** Take one off the log (it isn't gathered again). */
  remove(id) {
    const st = this.state;
    if (!st.items[id]) throw err(404, 'No such decision');
    delete st.items[id];
    st.removed[id] = this.now();
    this.store.save();
    this.onChange();
    return { ok: true };
  }

  /** The log, newest first: all of it, or one project's, or what matches `q`. */
  view({ project = null, q = '' } = {}) {
    this.sync();
    const all = Object.values(this.state.items).sort((x, y) => String(y.at).localeCompare(String(x.at)));
    const counts = new Map();
    for (const i of all) counts.set(i.project.key, { key: i.project.key, name: i.project.name, count: (counts.get(i.project.key)?.count ?? 0) + 1 });
    const words = String(q ?? '').trim().toLowerCase();
    const live = new Set(this.agents().map((a) => a.id));
    const items = all
      .filter((i) => (!project || i.project.key === project) && (!words || `${i.title} ${i.decision} ${i.why ?? ''} ${i.agentName ?? ''} ${i.project.name}`.toLowerCase().includes(words)))
      .map((i) => ({ ...i, kindLabel: DECISION_KINDS[i.kind] ?? i.kind, agentGone: Boolean(i.agentId) && !live.has(i.agentId) }));
    return { items, total: all.length, projects: [...counts.values()].sort((a, b) => a.name.localeCompare(b.name)), kinds: DECISION_KINDS };
  }

  /** The log as Markdown, a project a section, newest first. */
  markdown({ project = null } = {}) {
    const { items } = this.view({ project });
    const by = new Map();
    for (const i of items) by.set(i.project.name, [...(by.get(i.project.name) ?? []), i]);
    const out = ['# Decision log', ''];
    if (!items.length) out.push('No decisions recorded yet.', '');
    for (const [name, list] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`## ${name}`, '');
      for (const i of list) {
        out.push(`### ${i.title}`, '', `- **Decided:** ${i.decision}`);
        if (i.why) out.push(`- **Why:** ${i.why}`);
        out.push(`- **When:** ${String(i.at).slice(0, 10)} · ${i.kindLabel}${i.agentName ? ` · agent ${i.agentName}` : ''}${i.superseded ? ' · replaced since' : ''}`, '');
      }
    }
    return out.join('\n');
  }
}
