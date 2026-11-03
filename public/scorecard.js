// The review scorecard on the page: an overall readiness, a bar per score with why, the acceptance
// criteria, and where to look. Shared by Review changes, the Scorecard document and Land's badges.

const DIMENSIONS = [
  ['intent', 'Intent'],
  ['spec', 'Spec'],
  ['tests', 'Tests'],
  ['safety', 'Safety'],
  ['scope', 'Scope'],
  ['plan', 'Plan'],
];
export const RECOMMENDATION = { ready: 'Ready to approve', look: 'Look at these first', not_ready: 'Not ready' };
const tone = (n) => (n == null ? '' : n >= 80 ? 'good' : n >= 50 ? 'mid' : 'bad');
const recTone = { ready: 'good', look: 'mid', not_ready: 'bad' };

/** The scorecard of an agent and whether it still matches the changes (diffHash from /changes). */
export function scorecardOf(agent, diffHash) {
  const d = agent?.docs?.scorecard;
  return { doc: d?.data ? d : null, pending: Boolean(d?.pending), error: d?.error ?? null, stale: Boolean(d?.data && diffHash && d.diffHash !== diffHash) };
}

/** How far Improve moved the score: "↑18" (from 64), or nothing. */
const delta = (doc) => {
  const from = doc.improvedFrom;
  const to = doc.data?.overall;
  if (from == null || to == null || from === to) return '';
  return `<span class="sc-delta ${to > from ? 'up' : 'down'}" title="After Improve: was ${from}">${to > from ? '↑' : '↓'}${Math.abs(to - from)}</span>`;
};

/** A small badge: "82 · Ready to approve". Pass the agent's `improving` to show it being improved. */
export function badgeHtml(doc, esc, { improving = null } = {}) {
  if (improving) return `<span class="sc-badge" title="Sent back to improve its ${improving.from ?? '—'}/100; scored again when it is done">↻ Improving from ${improving.from ?? '—'}</span>`;
  if (!doc?.data) return '';
  const sc = doc.data;
  return `<span class="sc-badge ${recTone[sc.recommendation]}" title="Review scorecard: ${esc(RECOMMENDATION[sc.recommendation])}${sc.reasons.length ? ` (${esc(sc.reasons.join('; '))})` : ''}">${sc.overall ?? '—'}${delta(doc)} · ${esc(RECOMMENDATION[sc.recommendation])}</span>`;
}

/** Just the number, for a list row: "82", "82↑18" or "↻" while being improved. */
export function chipHtml(agent, esc) {
  const doc = agent?.docs?.scorecard;
  if (agent?.improving) return `<span class="sc-chip" title="Being improved from ${agent.improving.from ?? '—'}/100">↻ ${agent.improving.from ?? ''}</span>`;
  if (!doc?.data) return '';
  return `<span class="sc-chip ${recTone[doc.data.recommendation]}" title="Review scorecard: ${doc.data.overall ?? '—'}/100, ${esc(RECOMMENDATION[doc.data.recommendation])}">📊 ${doc.data.overall ?? '—'}${delta(doc)}</span>`;
}

/** Improve: send the agent its scorecard to fix before review (POST /agents/:id/scorecard/improve). */
export function improveHtml(agent) {
  const doc = agent?.docs?.scorecard;
  if (!doc?.data) return '';
  if (agent.improving) return '<button type="button" class="small ghost" disabled title="Scored again when the agent updates its brief">Improving…</button>';
  const ready = doc.data.recommendation === 'ready';
  return `<button type="button" class="small ${ready ? 'ghost' : 'primary'}" data-sc-improve="${agent.id}" title="Send the agent its low scores, unmet criteria and where a reviewer would look, to fix before you review; it is scored again when it is done">✨ Improve</button>`;
}

/**
 * The full card. `actions` is extra HTML for the head (buttons); look items carry
 * data-sc-look="<file>\t<head>" for the page to jump to.
 */
export function scorecardHtml(doc, esc, { stale = false, actions = '' } = {}) {
  const sc = doc.data;
  const rows = DIMENSIONS.map(([k, label]) => {
    const d = sc.scores[k];
    if (!d) return `<div class="sc-row na"><span class="sc-label">${label}</span><span class="sc-bar"></span><span class="sc-n">—</span><span class="sc-why hint">${k === 'spec' ? 'No spec written' : 'Not scored'}</span></div>`;
    return `<div class="sc-row"><span class="sc-label">${label}</span><span class="sc-bar"><span class="${tone(d.score)}" style="width:${d.score}%"></span></span><span class="sc-n">${d.score}</span><span class="sc-why">${esc(d.why)}${d.notes.length ? ` <span class="sc-note">${esc(d.notes.join('; '))}</span>` : ''}</span></div>`;
  }).join('');
  const crit = sc.criteria.length
    ? `<details class="sc-crit" ${sc.criteria.some((c) => c.status !== 'met') ? 'open' : ''}><summary>Acceptance criteria: ${sc.criteria.filter((c) => c.status === 'met').length} of ${sc.criteria.length} met</summary><ul>${sc.criteria.map((c) => `<li class="${c.status}"><span class="sc-mark">${c.status === 'met' ? '✓' : c.status === 'not_met' ? '✗' : '?'}</span>${esc(c.criterion)}${c.evidence ? ` <span class="hint">${esc(c.evidence)}</span>` : ''}</li>`).join('')}</ul></details>`
    : '';
  const look = sc.look.length
    ? `<div class="sc-look"><b>Where to look</b><ol>${sc.look.map((l) => `<li><button type="button" class="link" data-sc-look="${esc(`${l.file}\t${l.head}`)}"><code>${esc(l.file)}</code></button> ${esc(l.reason)}</li>`).join('')}</ol></div>`
    : '';
  const f = sc.facts;
  return `<div class="scorecard">
    <div class="sc-head">
      <span class="sc-overall ${recTone[sc.recommendation]}"><b>${sc.overall ?? '—'}</b><small>/100</small>${delta(doc)}</span>
      <div class="sc-verdict"><b>${esc(RECOMMENDATION[sc.recommendation])}</b>${sc.reasons.length ? `<div class="hint">${esc(sc.reasons.join(' · '))}</div>` : ''}<div class="hint">${esc(sc.summary)}</div></div>
      <span class="spacer"></span>${actions}
    </div>
    ${stale ? '<p class="hint sc-stale"><b>The changes moved since this was scored.</b> Score again for the latest.</p>' : ''}
    <div class="sc-rows">${rows}</div>
    ${crit}${look}
    <div class="hint sc-facts">Measured: ${f.files} files (+${f.added} −${f.removed}) · ${f.testFiles} test files · CI ${esc(f.ci ?? 'n/a')} · checks ${f.checks.passed}✓ ${f.checks.failed}✗${f.plan ? ` · plan ${f.plan.done}/${f.plan.steps}` : ''}${doc.writer ? ` · scored by ${esc(doc.writer)}` : ''}</div>
  </div>`;
}

/** What Listen reads: the verdict, then each score with why. */
export function scorecardSpeech(doc) {
  const sc = doc.data;
  return [
    `${RECOMMENDATION[sc.recommendation]}. Overall ${sc.overall ?? 'not scored'} out of 100. ${sc.reasons.join('. ')} ${sc.summary}`,
    ...DIMENSIONS.filter(([k]) => sc.scores[k]).map(([k, label]) => `${label}: ${sc.scores[k].score}. ${sc.scores[k].why} ${sc.scores[k].notes.join('. ')}`),
    ...(sc.look.length ? [`Where to look: ${sc.look.map((l) => `${l.file.split('/').pop()}: ${l.reason}`).join('. ')}`] : []),
  ];
}
