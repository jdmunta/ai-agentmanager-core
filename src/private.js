// Kept private: work that may be patentable is not published by the app until the person says so.
// Publishing before filing can cost the right to a patent, so once part of an agent's work is
// read as possibly new (the agent says so in its brief, Insights reads it as possibly patentable,
// or the person marks it), everything that sends it outside this computer is held: Google Drive,
// updates and Slack, comments on the pull request, and opening the pull request itself. Only the
// person lifts it (an agent's own call is refused in server.js). It is a guard on what the app
// sends, not on what the agent can do in its terminal: the agent is told as well.
import { parseKind } from '../public/valuelens.js';

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Insights' "### Kind" section of an agent, parsed, or null. */
export function insightsKind(agent) {
  const part = String(agent?.insights?.markdown ?? '').split(/^###\s+/m).find((p) => /^kind\b/i.test(p));
  return part ? parseKind(part.split('\n').slice(1).join('\n')) : null;
}

/**
 * Why an agent's work is kept private: { why, from: 'you' | 'agent' | 'insights' }, or null when
 * it is not (nothing was read as new, or the person allowed sharing).
 */
export function keptPrivate(agent) {
  const st = agent?.idea ?? {};
  if (st.allowed) return null;
  if (st.private) return { from: 'you', why: st.note ? `You marked it private: ${clip(st.note, 200)}` : 'You marked it private' };
  const fresh = agent?.brief?.options?.new;
  if (fresh) return { from: 'agent', why: `The agent says part of its design may be new: ${clip(fresh, 200)}` };
  const kind = insightsKind(agent);
  if (kind?.kind === 'patent') return { from: 'insights', why: `Insights reads it as possibly patentable${kind.new ? `: ${clip(kind.new, 200)}` : ''}` };
  return null;
}

/** Refuse a step that sends an agent's work outside this computer while it is kept private. */
export function mustBeShareable(agent, what) {
  const kept = keptPrivate(agent);
  if (kept) throw Object.assign(new Error(`${what} is held: this work is kept private. ${kept.why}. Publishing before filing can cost the right to a patent. To share it anyway: agentmgr private ${agent.id} --allow`), { status: 409, keptPrivate: true });
}

/** What the agent is told when its work is marked private from outside its session. */
export const PRIVATE_MESSAGE =
  'Part of this work may be new enough to protect, so it is kept private for now. Until I say otherwise: do not publish any of it outside this ' +
  'repository. No design doc or artifact published, no Google Doc, no public gist, post, issue or package, and do not open or update a pull request. ' +
  'Keep working locally and keep your documents as files.';

/** The person's own word: `private` true keeps it private, false allows sharing, null goes back to what was read. */
export function ideaPatch(agent, { private: keep = null, note = '' } = {}) {
  if (keep === null) return { idea: agent?.idea?.toldAt ? { toldAt: agent.idea.toldAt } : null };
  return { idea: keep ? { private: true, note: clip(note, 300), at: new Date().toISOString() } : { allowed: true, note: clip(note, 300), at: new Date().toISOString() } };
}
