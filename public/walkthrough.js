// An agent's changes explained one by one (the "walkthrough" document): shared by the review
// screen, which shows each explanation above its hunk, and the Changes pane of the split view.

const RISK = { high: 'fail', medium: '', low: 'open' };

/** The walkthrough of an agent and whether it still matches the changes (diffHash from /changes). */
export function walkthroughOf(agent, diffHash) {
  const w = agent?.docs?.walkthrough;
  return {
    doc: w?.data ? w : null,
    pending: Boolean(w?.pending),
    error: w?.error ?? null,
    stale: Boolean(w?.data && diffHash && w.diffHash !== diffHash),
  };
}

/** Index of the explanation for a hunk (file + header), or -1. */
export const stepOf = (doc, file, head) => doc?.data.changes.findIndex((c) => c.file === file && c.head === head) ?? -1;

/** One explanation: title, risk, what / why / check. */
export function cardHtml(c, i, total, esc) {
  if (c.unexplained) return `<div class="wt-card"><div class="wt-head"><span class="wt-n">${i + 1}/${total}</span><span class="hint">Not explained (the model skipped it)</span></div></div>`;
  return `<div class="wt-card">
    <div class="wt-head"><span class="wt-n">${i + 1}/${total}</span><b>${esc(c.title)}</b><span class="tag ${RISK[c.risk] ?? ''}">${esc(c.risk)} risk</span></div>
    ${c.what ? `<div><span class="wt-k">What</span> ${esc(c.what)}</div>` : ''}
    ${c.why ? `<div><span class="wt-k">Why</span> ${esc(c.why)}</div>` : ''}
    ${c.check ? `<div><span class="wt-k">Check</span> ${esc(c.check)}</div>` : ''}
  </div>`;
}

/** The button that writes (or rewrites) the walkthrough, with its state. */
export function explainButton(w, attrs = 'data-wt-explain') {
  const label = w.pending ? 'Explaining…' : w.doc ? (w.stale ? 'Explain again (changed)' : 'Explain again') : '✨ Explain changes';
  return `<button type="button" class="small ${w.doc && !w.stale ? 'ghost' : 'primary'}" ${attrs} ${w.pending ? 'disabled' : ''}
    title="Explain each change one by one: what, why, the risk and what to check, in the order to read them (a separate one-off call; the agent isn't interrupted)">${label}</button>`;
}
