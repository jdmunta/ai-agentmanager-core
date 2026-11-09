// Eval on the page: the confidence for an agent's Jira change, what was run and verified, and
// what's pending. Shared by the agent's Eval document, its strip, the Jira list and Today.

const MARK = { ok: '✅', partial: '🟡', pending: '⏳', failed: '❌', na: '—' };
const tone = (n) => (n === 100 ? 'good' : n >= 70 ? 'mid' : 'bad');

/** A small chip: "✔ 100%" / "87%" (or "Testing…"); `attr` makes it a button. */
export function evalChip(ev, esc, attr = '') {
  if (!ev?.items && !ev?.rerun?.running) return '';
  if (ev.rerun?.running && !ev.items) return `<span class="eval-chip" title="Running the tests again">Testing…</span>`;
  const tip = ev.confidence === 100 ? 'Eval: every check holds up' : `Eval: ${ev.pending.length} pending: ${ev.pending.slice(0, 3).join('; ')}`;
  const inner = `${ev.confidence === 100 ? '✔ ' : ''}${ev.confidence}%${ev.rerun?.running ? ' ↻' : ''}`;
  return attr ? `<button class="eval-chip ${tone(ev.confidence)}" ${attr} title="${esc(tip)}">${inner}</button>` : `<span class="eval-chip ${tone(ev.confidence)}" title="${esc(tip)}">${inner}</span>`;
}

/** The whole Eval: confidence, each verification, the criteria, the tests run, what's pending, and actions. */
export function evalHtml(ev, esc, { canPost = false } = {}) {
  if (!ev?.items) return `<p class="hint">${ev?.rerun?.running ? `Running <code>${esc(ev.rerun.command)}</code> on the change…` : 'Working the Eval out…'}</p>`;
  const last = new Map();
  for (const r of ev.runs) last.set(r.command, r);
  const rerun = ev.rerun;
  const counts = (c) => (c ? ` <span class="hint">${c.passed} passed${c.failed ? `, ${c.failed} failed` : ''}${c.unit ? ` (${esc(c.unit)})` : ''}</span>` : '');
  return `<div class="eval">
    <div class="eval-head"><span class="eval-score ${tone(ev.confidence)}">${ev.confidence}%</span> <b>${ev.confidence === 100 ? 'Confident: every check holds up' : `confident · ${ev.pending.length} pending`}</b>
      <span class="eval-acts">
        <button class="small" data-eval="verify" ${rerun?.running ? 'disabled' : ''} title="Run the tests again on the change as it is now">${rerun?.running ? 'Running tests…' : 'Run tests again'}</button>
        ${ev.pending.length ? '<button class="small primary" data-eval="gaps" title="Send what is pending to the agent, to bring it to 100%">Close the gaps</button>' : ''}
        ${canPost ? '<button class="small" data-eval="post" title="Post it as a comment on the pull request (edited in place next time)">Post to PR</button>' : ''}
        <button class="small" data-eval="copy" title="Copy as Markdown, to paste in the Jira issue">Copy for Jira</button>
      </span></div>
    <table class="eval-items"><tbody>${ev.items.map((i) => `<tr class="eval-${i.state}"><td>${MARK[i.state]}</td><td>${esc(i.label)}</td><td>${esc(i.detail)}</td></tr>`).join('')}</tbody></table>
    ${ev.criteria.length ? `<h4>Acceptance criteria</h4><ul class="eval-list">${ev.criteria.map((c) => `<li>${c.status === 'met' ? '✅' : c.status === 'not_met' ? '❌' : '⏳'} ${esc(c.criterion)}${c.evidence ? ` <span class="hint">— ${esc(c.evidence)}</span>` : ''}</li>`).join('')}</ul>` : ''}
    <h4>Tests run</h4>
    <ul class="eval-list">
      ${rerun && !rerun.running ? `<li>${rerun.passed ? '✅' : '❌'} <code>${esc(rerun.command)}</code> run again by AI Agent Manager${counts(rerun.counts)} <span class="hint">${esc(new Date(rerun.at).toLocaleString())}${rerun.ms ? ` · ${Math.round(rerun.ms / 1000)}s` : ''}</span>${rerun.passed ? '' : `<pre class="eval-tail">${esc(rerun.tail ?? '')}</pre>`}</li>` : ''}
      ${[...last.values()].map((r) => `<li>${r.passed ? '✅' : '❌'} <code>${esc(r.command)}</code> by the agent${counts(r.counts)} ${ev.runs.filter((x) => x.command === r.command).length > 1 ? `<span class="hint">· ran ${ev.runs.filter((x) => x.command === r.command).length}×, last shown</span>` : ''}</li>`).join('') || '<li class="hint">The agent ran no tests in its session.</li>'}
    </ul>
    <form class="eval-command" data-eval-command><label class="hint">Test command for this project <input name="command" value="${esc(ev.testCommand ?? '')}" placeholder="e.g. npm test" autocomplete="off" /></label> <button class="small">Save</button></form>
    ${ev.pending.length ? `<h4>Pending</h4><ul class="eval-list">${ev.pending.map((p) => `<li>⏳ ${esc(p)}</li>`).join('')}</ul>` : '<p class="hint">Nothing pending.</p>'}
    <p class="hint">Confidence comes from fixed rules over these, not from a model: it is 100% only when the tests pass when run again on the code as it is now, every acceptance criterion is met, CI and the AI judge agree, and nothing is pending.</p>
  </div>`;
}
