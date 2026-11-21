// Board: which column an agent's card is in, why it needs the person, and what a drag does. No
// page needed, so it is tested by itself (board.js draws it).

export const BOARD_COLUMNS = [
  { id: 'starting', label: 'Starting', hint: 'Its workspace is being prepared, or it is planning' },
  { id: 'working', label: 'Working', hint: 'Producing output now' },
  { id: 'needs', label: 'Needs you', hint: 'A prompt, a question, a plan to approve, a limit, an error, or it may be stuck' },
  { id: 'idle', label: 'Waiting', hint: 'Its session is open and waits for its next instruction' },
  { id: 'review', label: 'In review', hint: 'It has an open pull request' },
  { id: 'done', label: 'Done', hint: 'Its pull request merged, or it reported its work done' },
  { id: 'closed', label: 'Closed', hint: 'Its session is closed and can be resumed' },
];

export const openPrs = (a) => (a.prs ?? []).filter((p) => p.land && p.land !== 'merged' && p.land !== 'closed');

/** Why an agent needs the person, in a few words, or null. */
export function needOf(a) {
  const rt = a.runtime ?? {};
  if (rt.attention) return 'a prompt to answer';
  if (a.status === 'error') return 'an error';
  if (rt.limited) return 'stopped at a limit';
  if (a.planReview?.status === 'review') return 'a plan to approve';
  if (a.acceptance?.status === 'review' && a.acceptance.wait) return 'what done means, to agree';
  const q = (a.questions ?? []).filter((x) => !x.answer).length;
  if (q) return q === 1 ? 'a question' : `${q} questions`;
  if (rt.waiting) return rt.waiting.kind === 'error' ? 'an error on its screen' : 'a question on its screen';
  if (a.stuck?.length) return 'may be stuck';
  return null;
}

/** The column an agent's card is in. */
export function columnOf(a) {
  const rt = a.runtime ?? {};
  if (needOf(a)) return 'needs';
  if (a.status === 'preparing' || rt.planning) return 'starting';
  if (rt.running && rt.busy) return 'working';
  if (openPrs(a).length) return 'review';
  if ((a.prs ?? []).some((p) => p.land === 'merged') || a.results?.outcome === 'done') return 'done';
  return rt.running ? 'idle' : 'closed';
}

/** What a card dropped on a column does: { act: 'stop' | 'start' } or { why } when it does nothing. */
export function dropAction(a, to) {
  const from = columnOf(a);
  const rt = a.runtime ?? {};
  if (from === to) return { why: null };
  if (to === 'closed') {
    if (!rt.running) return { why: 'Its session is already closed' };
    if (rt.busy) return { why: 'It is working. Close its session from its detail if you mean to stop it' };
    return { act: 'stop' };
  }
  if (to === 'idle' && !rt.running && a.workdir && a.status !== 'preparing') return { act: 'start' };
  const col = BOARD_COLUMNS.find((c) => c.id === to);
  return { why: `An agent moves to ${col?.label ?? to} by itself. Drag onto Closed to close a session, or from Closed onto Waiting to resume it` };
}
