// Acceptance: what "done" means for an agent's task, agreed with the person before the work is
// judged against it. The agent drafts a few checkable points in SPEC.md (it has read the code);
// the person edits them and agrees; from then on the points are kept by the app, not by the
// agent, and the review scorecard reports each one as met, not met or not verified.
//
// Everything here is pure: reading the points out of a spec, cleaning what the person sends,
// the messages to the agent, and matching the scorecard's answers back to the agreed points.

export const MAX_POINTS = 12;
export const MAX_POINT_CHARS = 300;

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const norm = (s) => tidy(s).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s+/g, ' ').trim();

/** The points under "## Acceptance criteria" in a spec: one per list item, wrapped lines joined. */
export function parseCriteria(spec) {
  const block = /^##\s*Acceptance criteria\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(String(spec ?? ''))?.[1] ?? '';
  const out = [];
  for (const line of block.split('\n')) {
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX~!]\]\s*)?(.*)$/.exec(line);
    if (item) out.push(item[1]);
    // A wrapped line of the item above (indented), not a new paragraph.
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += ` ${line}`;
  }
  return out.map((t) => tidy(t).slice(0, MAX_POINT_CHARS)).filter((t) => /\p{L}|\p{N}/u.test(t)).slice(0, MAX_POINTS);
}

/**
 * The points the person sent (texts, or { text }), cleaned: no empty ones, no repeats, numbered
 * A1.. in their order. `draft` is what the agent wrote: a point with its wording is "agent", any
 * other is "you". Throws with a status when there is nothing to agree on, or too much.
 */
export function cleanPoints(list, draft = []) {
  if (!Array.isArray(list)) throw Object.assign(new Error('points must be a list'), { status: 400 });
  const drafted = new Set(draft.map(norm));
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const text = tidy(typeof p === 'string' ? p : p?.text);
    if (!text || seen.has(norm(text))) continue;
    if (text.length > MAX_POINT_CHARS) throw Object.assign(new Error(`A point is at most ${MAX_POINT_CHARS} characters; split it`), { status: 400 });
    seen.add(norm(text));
    out.push({ id: `A${out.length + 1}`, text, from: drafted.has(norm(text)) ? 'agent' : 'you' });
  }
  if (!out.length) throw Object.assign(new Error('Give at least one point that says what done means'), { status: 400 });
  if (out.length > MAX_POINTS) throw Object.assign(new Error(`At most ${MAX_POINTS} points: keep the ones you would check`), { status: 400 });
  return out;
}

export const pointsBlock = (points) => points.map((p) => `${p.id}: ${p.text}`).join('\n');

/** The agent's instructions when the person agrees on the points before anything is changed. */
export const acceptancePrompt = (specFile, { planReview = false } = {}) =>
  'The user agrees with you on what "done" means before you change anything. First investigate as much as you need ' +
  `(reading code, docs and running read-only commands is fine), then write ${specFile} with three to six points under ` +
  '"## Acceptance criteria": each one a single sentence a person can check without reading the code (a behavior they can see, ' +
  'a command and its result, a test that passes), specific to this task, and none that only restates the request. ' +
  'Then stop and wait. Until a message starting with "Acceptance agreed" or "Acceptance review skipped" arrives, do not edit, ' +
  'create or delete files in the repository, commit, or run commands that change anything' +
  (planReview ? ', and do not write your implementation plan yet: the plan comes after the points are agreed' : '') +
  '. The agreed points may differ from yours: they are the ones the work is checked against.';

/** For a session started after the points were agreed (a restart, a resume). */
export const acceptanceAgreedPrompt = (points) =>
  `The user agreed on what "done" means for this task. The work is checked against these points, as written:\n${pointsBlock(points)}\n` +
  'Keep them under "## Acceptance criteria" in your spec as they are; you cannot change them. If one cannot be met, say so in the brief and why.';

/**
 * What the agent is told when the points are agreed. `waiting`: it was stopped until now.
 * `planNext`: its plan is reviewed too, and comes next. `changed`: they had been agreed before.
 */
export function agreedMessage(points, { waiting = false, planNext = false, changed = false } = {}) {
  const head = waiting || !changed ? 'Acceptance agreed.' : 'Acceptance agreed again: the user changed the points.';
  const next = waiting
    ? planNext
      ? 'Now write your implementation plan and wait for its approval, as instructed.'
      : 'Go ahead with the work.'
    : 'Check the work you have done against them and fix what does not meet them; say in the brief what you changed.';
  return `${head} The work is done when all of these are true, and it is checked against them as written:\n${pointsBlock(points)}\n` +
    `Replace the points under "## Acceptance criteria" in your spec with these, word for word. ${next}`;
}

export const SKIPPED_MESSAGE = 'Acceptance review skipped. Go ahead with the work, against the criteria in your own spec.';

/**
 * The agreed points with what the scorecard found for each. `criteria` is the scorecard's list
 * ({ id, criterion, status, evidence }); a point it has no answer for is "unchecked".
 */
export function results(points, criteria = null) {
  const byId = new Map((criteria ?? []).filter((c) => c.id).map((c) => [String(c.id).toUpperCase(), c]));
  const byText = new Map((criteria ?? []).map((c) => [norm(c.criterion), c]));
  return points.map((p) => {
    const c = byId.get(p.id) ?? byText.get(norm(p.text));
    return { ...p, status: c ? c.status : 'unchecked', evidence: c?.evidence ?? '' };
  });
}

export const STATUS_LABEL = { met: 'Met', not_met: 'Not met', unverified: 'Not verified', unchecked: 'Not checked yet' };

export function counts(res) {
  const n = (s) => res.filter((r) => r.status === s).length;
  return { total: res.length, met: n('met'), notMet: n('not_met'), unverified: n('unverified'), unchecked: n('unchecked') };
}

/** "3 of 5 met, 1 not met, 1 not verified", or what is left to do before there is a result. */
export function countsLine(c) {
  if (!c.total) return 'no points';
  if (c.unchecked === c.total) return `${c.total} point${c.total === 1 ? '' : 's'}, not checked yet`;
  return [`${c.met} of ${c.total} met`, c.notMet ? `${c.notMet} not met` : '', c.unverified ? `${c.unverified} not verified` : '', c.unchecked ? `${c.unchecked} not checked yet` : ''].filter(Boolean).join(', ');
}

const MARK = { met: '✅', not_met: '❌', unverified: '❔', unchecked: '⏳' };

/** The acceptance of an agent as Markdown (the CLI prints it). `v` is what Manager.acceptanceOf returns. */
export function acceptanceMarkdown(v, name) {
  const out = [`# What done means: ${name}`, ''];
  if (v.status === 'none') return [...out, v.draft.length ? 'Not agreed. The agent wrote these in its spec:' : 'Not agreed, and the agent wrote no acceptance criteria.', '', ...v.draft.map((t, i) => `${i + 1}. ${t}`), ''].join('\n');
  if (v.status === 'writing') return [...out, 'The agent is writing its points; it waits for you before changing anything.', ''].join('\n');
  if (v.status === 'review') return [...out, 'Waiting for you. The agent wrote these and changes nothing until you agree:', '', ...v.draft.map((t, i) => `${i + 1}. ${t}`), ''].join('\n');
  out.push(`Agreed ${v.agreedAt}: ${countsLine(v.counts)}${v.stale ? ' (the work changed or the points changed since the last check)' : ''}`, '');
  for (const r of v.results) out.push(`- ${MARK[r.status]} **${r.id}** ${r.text}${r.from === 'you' ? ' _(yours)_' : ''}${r.evidence ? `\n  ${STATUS_LABEL[r.status]}: ${r.evidence}` : ''}`);
  return [...out, ''].join('\n');
}
