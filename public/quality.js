// Quality: what happened to the agents' pull requests after they merged, by day, week, month,
// quarter and year: the share that held up, the ones reverted, fixed afterwards or with failed
// checks, and from before the merge how often a reviewer asked for changes. A follow-up fix is a
// guess, so each pull request can be marked as not a problem, or as one.

import { expandButton, expandable } from './expand.js';
import { initStandards } from './standards.js';

const PERIODS = [
  ['day', 'Day'],
  ['week', 'Week'],
  ['month', 'Month'],
  ['quarter', 'Quarter'],
  ['year', 'Year'],
];
const SAVED = 'agentmgr.qualityPeriod';
const WORD = { incident: 'Incident in production', reverted: 'Reverted', fixed: 'Fixed afterwards', broke: 'Checks failed', problem: 'A problem', clean: 'Held up', watching: 'Fine so far', unchecked: 'Not looked at' };
const BAD = new Set(['incident', 'reverted', 'fixed', 'broke', 'problem']);

export function initQuality({ api, $, esc, toast, ago, openAgent }) {
  const dialog = $('#quality-dialog');
  const body = $('#quality-body');
  let data = null;
  let period = 'week';
  let selected = null; // a period key; null is the current one
  let only = false; // only the ones that did not hold up
  let again = null;
  let mode = 'after'; // or 'standards': what every change in a repository has to meet (standards.js); or 'record': what was said against what held (record.js)
  let record = null;
  const std = initStandards({
    api,
    esc,
    toast,
    rerender: (force) => {
      if (force) document.activeElement?.blur();
      render();
    },
  });
  try {
    period = localStorage.getItem(SAVED) || 'week';
  } catch {}

  async function loadRecord() {
    try {
      record = await api('GET', '/quality/record');
    } catch (e) {
      toast?.(e.message, 5000);
    }
    render();
  }

  async function load() {
    try {
      data = await api('GET', `/quality?period=${period}`);
    } catch (e) {
      toast?.(e.message, 5000);
    }
    render();
  }

  // A lower share of problems is the better direction, so the arrow's color follows the meaning.
  function card(label, value, sub, delta, goodUp) {
    const d = Number.isFinite(delta) && delta !== 0 ? `<div class="value-delta ${delta > 0 === goodUp ? 'up' : 'down'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)} points vs before</div>` : '';
    return `<div class="value-card"><div class="hint">${esc(label)}</div><div class="value-big">${value}</div>${sub ? `<div class="hint">${sub}</div>` : ''}${d}</div>`;
  }

  const shortLabel = (p) => {
    const d = new Date(p.start);
    if (period === 'day') return d.toLocaleDateString(undefined, { weekday: 'narrow', day: 'numeric' });
    if (period === 'week') return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    if (period === 'month') return d.toLocaleDateString(undefined, { month: 'short' });
    return period === 'year' ? p.label : p.label.split(' ')[0];
  };

  function bars(periods) {
    const max = Math.max(1, ...periods.map((p) => p.totals.prs));
    return `<div class="value-bars" role="list">${[...periods]
      .reverse()
      .map((p) => {
        const t = p.totals;
        const on = (selected ?? periods[0].key) === p.key;
        return `<button class="value-bar ${on ? 'on' : ''}" role="listitem" data-quality-pick="${esc(p.key)}" title="${esc(`${p.label}: ${t.prs} merged, ${t.problems} with a problem${t.heldPct == null ? '' : `, ${t.heldPct}% held up`}`)}">
            <span class="stack"><span class="bad" style="height:${(t.problems / max) * 100}%"></span><span class="val" style="height:${((t.prs - t.problems) / max) * 100}%"></span></span>
            <span class="lbl">${esc(shortLabel(p))}</span>
          </button>`;
      })
      .join('')}</div>`;
  }

  const link = (x) => (x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.number ? `#${x.number} ` : '')}${esc(x.title)}</a>` : esc(x.title));

  function why(it) {
    const a = it.after;
    if (it.mark) return `You said so${it.mark.note ? `: ${esc(it.mark.note)}` : ''}`;
    if (it.verdict === 'incident') return it.incidents.map((x) => `${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)} <span class="hint">matched by ${esc(x.by)}${x.source ? ` · ${esc(x.source)}` : ''}</span>`).join('<br>');
    if (it.verdict === 'reverted') return `Reverted by ${link(a.reverted)}`;
    if (it.verdict === 'fixed') return a.fixes.map((f) => `${link(f)}${f.shared.length ? ` <span class="hint">same file${f.shared.length === 1 ? '' : 's'}: ${esc(f.shared.join(', '))}</span>` : ' <span class="hint">names it</span>'}`).join('<br>');
    if (it.verdict === 'broke') return `Failed on the merged commit: ${esc(a.checks.failed.join(', '))}`;
    if (it.verdict === 'unchecked') return it.error ? `GitHub: ${esc(it.error)}` : data.github ? 'Waiting its turn' : 'GitHub is not asked here';
    if (it.verdict === 'watching') return `Nothing found; watched until ${esc(new Date(Date.parse(it.mergedAt) + data.settings.watchDays * 86_400_000).toLocaleDateString())}`;
    return 'Nothing found';
  }

  function itemRow(it) {
    const f = it.facts;
    const hours = it.openedAt ? Math.round(((Date.parse(it.mergedAt) - Date.parse(it.openedAt)) / 3_600_000) * 10) / 10 : null;
    return `<tr>
        <td class="hint nowrap">${esc(new Date(it.mergedAt).toLocaleDateString())}</td>
        <td><a href="${esc(it.url)}" target="_blank" rel="noopener">#${esc(it.number ?? '?')} ${esc(it.title)}</a><div class="hint">${esc([it.project, it.agentName].filter(Boolean).join(' · '))}</div></td>
        <td><span class="quality-chip ${esc(it.verdict)}">${esc(WORD[it.verdict])}</span>${it.mark ? ' <span class="hint" title="Marked by you">✎</span>' : ''}</td>
        <td>${why(it)}</td>
        <td class="nowrap">${f ? `${f.changesRequested ? `${f.changesRequested} change request${f.changesRequested === 1 ? '' : 's'}` : 'no change requests'}<div class="hint">${f.lines} lines${hours != null ? ` · ${hours}h to merge` : ''}</div>` : '<span class="hint">—</span>'}</td>
        <td class="nowrap">
          ${it.mark ? `<button class="link" data-quality-mark="" data-url="${esc(it.url)}" title="Back to what was found">Undo</button>` : BAD.has(it.verdict) ? `<button class="link" data-quality-mark="clean" data-url="${esc(it.url)}" title="What was found is not about this pull request">Not a problem</button>` : `<button class="link" data-quality-mark="problem" data-url="${esc(it.url)}" title="It caused a problem that was not found here">It was a problem</button>`}
          <div><button class="link" data-quality-check="${esc(it.url)}" ${data.github ? '' : 'disabled'} title="Look at GitHub again now${it.checkedAt ? `; last looked ${esc(ago(it.checkedAt))}` : ''}">Look again</button>${it.gone ? '' : ` · <button class="link" data-quality-agent="${esc(it.agentId)}">Agent</button>`}</div>
        </td>
      </tr>`;
  }

  /** Track record: what was said at the merge against what held up. */
  function recordHtml() {
    const r = record;
    if (!r) return '<p class="hint">Loading…</p>';
    const LEVEL = { ask: 'Ask me', run: 'Agree, then run', pr: 'Run to pull request', merge: 'Run to merge' };
    const intro = '<p class="hint">Was the confidence right? For each merged pull request the app keeps what was said about it as it merged, and compares that with what happened after: held up, or reverted, fixed afterwards, failed its checks. One counts once it is settled.</p>';
    if (!r.settled) return `${intro}<p class="hint issues-empty">No merged pull request is settled yet${r.open ? ` (${r.open} still watched or not looked at)` : ''}. The record fills as the watch days pass.</p>`;
    const cls = (x) => (x.read === 'said more than held up' ? 'rec-bad' : x.read === 'about right' || x.read === 'held up better than said' ? 'rec-ok' : '');
    const rows = (list, said) => list.map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${x.held} of ${x.n}</td><td class="num">${x.heldPct}%</td>${said ? `<td class="num">${x.said == null ? '—' : `${x.said}%`}</td>` : ''}<td class="${cls(x)}">${esc(x.read)}</td></tr>`).join('');
    const table = (title, hint, list, said = false) =>
      list.length
        ? `<h3 class="rec-head">${title}</h3><p class="hint">${hint}</p><div class="issues-scroll"><table class="issues rec-table"><thead><tr><th></th><th class="num">Held up</th><th class="num">Share</th>${said ? '<th class="num">Said, on average</th>' : ''}<th></th></tr></thead><tbody>${rows(list, said)}</tbody></table></div>`
        : '';
    const project = (p) => `<tr>
        <td>${esc(p.label)}</td><td class="num">${p.held} of ${p.n}</td><td class="num">${p.heldPct}%</td>
        <td>${LEVEL[p.current]}${p.level ? '' : ' <span class="hint">(the default)</span>'}</td>
        <td>${p.suggestion ? `<span class="${p.suggestion.direction === 'up' ? 'rec-ok' : 'rec-bad'}">The record supports <b>${LEVEL[p.suggestion.level]}</b></span><div class="hint">${esc(p.suggestion.why)}</div>` : `<span class="hint">${p.n < 5 ? 'too few to say' : 'keep it'}</span>`}</td>
        <td class="nowrap">${p.suggestion ? `<button class="small" data-record-level="${p.suggestion.level}" data-project="${esc(p.label)}" title="New agents in this project get this level when none is named. Agents that run now keep theirs.">Set ${LEVEL[p.suggestion.level]}</button>` : ''}${p.level ? ` <button class="link" data-record-level="default" data-project="${esc(p.label)}" title="Back to the level every other project gets">Use the default</button>` : ''}</td>
      </tr>`;
    return `${intro}
      <div class="value-cards">
        ${card('Held up', `${r.heldPct}%`, `${r.held} of ${r.settled} settled pull requests`, null)}
        ${r.confidence ? card('Said by the agents', `${r.confidence.said}%`, `their own confidence, on average; ${r.confidence.heldPct}% of those held up`, null) : ''}
        ${card('Not settled yet', String(r.open), 'still watched, or not looked at', null)}
      </div>
      ${table("The agent's own confidence", `What the agent wrote as its confidence, against the share that held up.${r.noConfidence ? ` ${r.noConfidence} had none written.` : ''}`, [...(r.confidence ? [r.confidence] : []), ...r.bands], true)}
      ${table('The review scorecard', 'What the scorecard recommended as it merged.', r.scorecard)}
      ${table('Tests tested', 'Whether the tests were tested before the merge (Test the tests), and how that went.', r.tests)}
      ${table('Model', 'The engine and model that did the work.', r.models)}
      ${r.delegation.rows.length ? `<h3 class="rec-head">Delegation map</h3><p class="hint">By kind of work, read from the words of each request: how it held up and how much of it ran without you. A kind that held up 9 times in 10 over at least 5 settled pull requests while most of it still asked you is worth handing over more of; under 7 in 10 is worth keeping close. It sees only the work given to agents, not what you do by hand.</p>
        <div class="issues-scroll"><table class="issues rec-table"><thead><tr><th>Kind of work</th><th class="num">Held up</th><th class="num">Share</th><th class="num">Without you</th><th></th></tr></thead><tbody>${r.delegation.rows.map((d) => `<tr><td>${esc(d.label)}</td><td class="num">${d.held} of ${d.n}</td><td class="num">${d.heldPct}%</td><td class="num">${d.withoutYou} of ${d.n}</td><td class="${d.advice === 'hand over more' ? 'rec-ok' : d.advice ? 'rec-bad' : 'hint'}">${d.advice ?? (d.n < 5 ? 'too few to say' : 'keep as is')}</td></tr>`).join('')}</tbody></table></div>
        ${r.delegation.next ? `<p class="rec-ok">Next to hand over more of: <b>${esc(r.delegation.next.label)}</b> (${r.delegation.next.heldPct}% held up over ${r.delegation.next.n}, most of it still asking you). Set its projects' level above, or start that kind of work with <i>Agree, then run</i>.</p>` : ''}` : ''}
      ${r.fit.rows.length > 1 ? `<h3 class="rec-head">Model fit</h3><p class="hint">Which model held up as well as the most used one at a lower cost. Cost is shown against the most used model's, per piece of work. A suggestion needs 5 settled pull requests for both, a share that held up within 5 points of the most used model's, and at most three quarters of its cost.</p>
        <div class="issues-scroll"><table class="issues rec-table"><thead><tr><th>Model</th><th class="num">Held up</th><th class="num">Share</th><th class="num">Scorecard</th><th class="num">Cost</th></tr></thead><tbody>${r.fit.rows.map((m, i) => `<tr><td>${esc(m.model)}</td><td class="num">${m.held} of ${m.n}</td><td class="num">${m.heldPct}%</td><td class="num">${m.score ?? '—'}</td><td class="num">${i === 0 ? 'the most used' : m.costVsMain == null ? '—' : `${m.costVsMain}×`}</td></tr>`).join('')}</tbody></table></div>
        ${r.fit.suggestion ? `<p class="rec-ok"><b>${esc(r.fit.suggestion.model)}</b> held up as well as ${esc(r.fit.suggestion.main)} (${r.fit.suggestion.heldPct}% against ${r.fit.suggestion.mainHeldPct}%) at ${r.fit.suggestion.costVsMain}× the cost, over ${r.fit.suggestion.n} settled pull requests: worth trying for more of the work.</p>` : ''}` : ''}
      ${table('Without you', 'How far the agent ran without you.', r.levels)}
      <h3 class="rec-head">Projects: the level the record supports</h3>
      <p class="hint">Up one step after at least 5 settled pull requests with 9 in 10 held up and none of the last 5 a problem (10, and all of the last 10, before Run to merge). Down one step when one of the last 3 did not hold up. It is a suggestion: the level changes only when you set it.</p>
      <div class="issues-scroll"><table class="issues rec-table"><thead><tr><th>Project</th><th class="num">Held up</th><th class="num">Share</th><th>New agents</th><th>Record</th><th></th></tr></thead><tbody>${r.projects.map(project).join('')}</tbody></table></div>`;
  }

  function render() {
    if (!dialog.open) return;
    if (!data) {
      body.innerHTML = '<p class="hint">Loading…</p>';
      return;
    }
    if (body.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) return;
    const n = std.proposed();
    const modes = `<div class="chips" role="tablist" aria-label="Quality">
        <button class="chip ${mode === 'after' ? 'active' : ''}" role="tab" aria-selected="${mode === 'after'}" data-quality-mode="after">After the merge</button>
        <button class="chip ${mode === 'standards' ? 'active' : ''}" role="tab" aria-selected="${mode === 'standards'}" data-quality-mode="standards" title="What every change in a repository has to meet: lessons from what went wrong, high-risk paths, and the checks the app runs itself">Standards${n ? ` <span class="badge">${n}</span>` : ''}</button>
        <button class="chip ${mode === 'record' ? 'active' : ''}" role="tab" aria-selected="${mode === 'record'}" data-quality-mode="record" title="What was said when each pull request merged, against what held up; and the level of Without you each project's record supports">Track record</button>
      </div>`;
    if (mode === 'standards') {
      body.innerHTML = `
      <div class="issues-head">
        <h2>Quality</h2>
        ${modes}
        <span class="spacer"></span>
        ${expandButton(dialog)}
        <button class="small" data-quality="close" title="Close (Esc)">Close</button>
      </div>
      ${std.html()}`;
      return;
    }
    if (mode === 'record') {
      body.innerHTML = `
      <div class="issues-head">
        <h2>Quality</h2>
        ${modes}
        <span class="spacer"></span>
        <button class="small" data-quality="copy-record" title="Copy the track record as Markdown">Copy</button>
        ${expandButton(dialog)}
        <button class="small" data-quality="close" title="Close (Esc)">Close</button>
      </div>
      ${recordHtml()}`;
      return;
    }
    const ps = data.periods;
    const i = Math.max(0, ps.findIndex((p) => p.key === selected));
    const p = ps[i];
    const prev = ps[i + 1]?.totals.checked ? ps[i + 1].totals : null;
    const t = p.totals;
    const inside = data.items.filter((it) => p.items.includes(it.url));
    const items = only ? inside.filter((it) => BAD.has(it.verdict)) : inside;
    const pct = (n) => (n == null ? '—' : `${n}%`);
    const s = data.settings;
    body.innerHTML = `
      <div class="issues-head">
        <h2>Quality</h2>
        ${modes}
        <div class="chips" role="tablist">${PERIODS.map(([k, label]) => `<button class="chip ${k === period ? 'active' : ''}" role="tab" aria-selected="${k === period}" data-quality-period="${k}">${label}</button>`).join('')}</div>
        <span class="spacer"></span>
        <button class="small" data-quality="copy" title="Copy this period's report as Markdown">Copy report</button>
        ${expandButton(dialog)}
        <button class="small" data-quality="close" title="Close (Esc)">Close</button>
      </div>
      <p class="value-period"><b>${esc(p.label)}</b>${p.current ? ' <span class="hint">so far</span>' : ''} · ${t.prs} pull request${t.prs === 1 ? '' : 's'} from agents merged${t.unchecked ? ` · <span class="hint">${t.unchecked} not looked at yet</span>` : ''}</p>
      ${data.github ? '' : '<p class="hint">GitHub is not asked on this computer, so merged pull requests are listed but not looked at.</p>'}
      <div class="value-cards">
        ${card('Held up', pct(t.heldPct), `${t.held} of ${t.checked} looked at${t.watching ? `; ${t.watching} still watched` : ''}`, prev && t.heldPct != null ? t.heldPct - prev.heldPct : null, true)}
        ${card('Problems after the merge', String(t.problems), `${pct(t.failurePct)} of those looked at`, prev && t.failurePct != null ? t.failurePct - prev.failurePct : null, false)}
        ${t.incident ? card('Incidents in production', String(t.incident), 'reported by a monitoring tool or by you', null) : ''}
        ${card('Reverted', String(t.reverted), 'taken back out', null)}
        ${card('Fixed afterwards', String(t.fixed), `a fix to the same files within ${s.watchDays} days`, null)}
        ${card('Checks failed', String(t.broke), 'on the commit it merged as', null)}
        ${card('Changes requested', pct(t.changesPct), `by a reviewer, before the merge (${t.changesRequested})`, prev && t.changesPct != null && prev.changesPct != null ? t.changesPct - prev.changesPct : null, false)}
        ${card('Opened to merged', t.hoursToMerge == null ? '—' : `${t.hoursToMerge}h`, 'median', null)}
      </div>
      ${bars(ps)}
      <div class="value-legend hint"><span class="sw val"></span> held up <span class="sw bad"></span> a problem after the merge · pick a bar to see that ${esc(period)}
        <span class="spacer"></span><label class="check"><input type="checkbox" data-quality-only ${only ? 'checked' : ''} /> Only the ones with a problem</label></div>
      ${items.length
        ? `<div class="issues-scroll"><table class="issues quality-items">
            <thead><tr><th>Merged</th><th>Pull request</th><th>After the merge</th><th>Why</th><th>Before the merge</th><th></th></tr></thead>
            <tbody>${items.map(itemRow).join('')}</tbody></table></div>`
        : `<p class="hint issues-empty">${inside.length ? 'None of them had a problem.' : data.items.length ? `No pull request from an agent merged in ${esc(p.label)}.` : "No pull request from an agent has merged yet. Each one is looked at here once it has."}</p>`}
      <details class="value-settings"><summary>Settings and how it is worked out</summary>
        <form data-quality-settings>
          <label class="check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''} /> Look at merged pull requests on GitHub, for <input type="number" class="inline" name="watchDays" min="1" max="90" value="${s.watchDays}" /> days after each merge</label>
          <p class="hint">Asked through the gh CLI as you, a few pull requests every two minutes and each again every six hours while it is watched. <b>Reverted</b>: a pull request titled Revert that names it, or a commit that reverts the one it merged as. <b>Fixed afterwards</b>: a later pull request whose title says it fixes something and that changes one of the same files, or names it; this one is a guess, so say <b>Not a problem</b> where it is wrong. <b>Checks failed</b>: a check on the merged commit failed or timed out. No model is called.</p>
          <div class="actions"><span class="spacer"></span><button class="small primary">Save settings</button></div>
        </form></details>`;
  }

  body.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-quality-mode]');
    if (m) {
      mode = m.dataset.qualityMode;
      render();
      return mode === 'standards' ? std.load() : mode === 'record' ? loadRecord() : load();
    }
    if (mode === 'standards' && std.click(e)) return;
    const lvl = e.target.closest('[data-record-level]');
    if (lvl) {
      try {
        await api('PUT', '/autonomy', { project: lvl.dataset.project, level: lvl.dataset.recordLevel });
        toast?.(lvl.dataset.recordLevel === 'default' ? `${lvl.dataset.project}: new agents get the default again` : `${lvl.dataset.project}: set for its new agents`);
      } catch (err) {
        toast?.(err.message, 6000);
      }
      return loadRecord();
    }
    if (e.target.closest('[data-quality="copy-record"]')) {
      try {
        await navigator.clipboard.writeText((await api('GET', '/quality/record?format=md')).markdown);
        toast?.('Copied the track record');
      } catch (err) {
        toast?.(err.message, 6000);
      }
      return;
    }
    const per = e.target.closest('[data-quality-period]');
    if (per) {
      period = per.dataset.qualityPeriod;
      selected = null;
      try {
        localStorage.setItem(SAVED, period);
      } catch {}
      return load();
    }
    const pick = e.target.closest('[data-quality-pick]');
    if (pick) {
      selected = pick.dataset.qualityPick;
      return render();
    }
    const mark = e.target.closest('[data-quality-mark]');
    const check = e.target.closest('[data-quality-check]');
    if (mark || check) {
      try {
        if (mark) await api('POST', '/quality/mark', { url: mark.dataset.url, verdict: mark.dataset.qualityMark || null });
        else {
          toast?.('Looking at GitHub…');
          await api('POST', '/quality/check', { url: check.dataset.qualityCheck });
        }
      } catch (err) {
        toast?.(err.message, 6000);
      }
      return load();
    }
    const agent = e.target.closest('[data-quality-agent]');
    if (agent) {
      dialog.close();
      return openAgent(agent.dataset.qualityAgent);
    }
    const b = e.target.closest('[data-quality]')?.dataset.quality;
    if (b === 'close') return dialog.close();
    if (b === 'copy') {
      const p = data?.periods.find((x) => x.key === selected) ?? data?.periods[0];
      if (p && !p.current && p !== data.periods[1]) return toast?.('Reports are for the current period or the one just ended: pick one of those bars', 5000);
      try {
        const r = await api('GET', `/quality/report?kind=${period}${p?.current ? '&current=1' : ''}`);
        await navigator.clipboard.writeText(r.markdown);
        toast?.(`Copied the report for ${r.period.label}`);
      } catch (err) {
        toast?.(err.message, 6000);
      }
    }
  });

  body.addEventListener('change', (e) => {
    if (mode === 'standards' && std.change(e)) return;
    if (!e.target.matches('[data-quality-only]')) return;
    only = e.target.checked;
    e.target.blur();
    render();
  });

  body.addEventListener('submit', async (e) => {
    if (mode === 'standards' && std.submit(e)) return;
    e.preventDefault();
    const f = e.target;
    try {
      data = await api('PUT', `/quality?period=${period}`, { enabled: f.enabled.checked, watchDays: Number(f.watchDays.value) });
      toast?.('Saved');
    } catch (err) {
      return toast?.(err.message, 6000);
    }
    document.activeElement?.blur();
    render();
  });

  function open() {
    if (dialog.open) return dialog.close();
    dialog.showModal();
    render();
    load();
    std.load();
  }

  /** The daemon says something changed: look again, while open. */
  function changed() {
    if (!dialog.open) return;
    clearTimeout(again);
    again = setTimeout(() => (load(), std.load(), mode === 'record' && loadRecord()), 800);
  }

  expandable(dialog, render);
  return { open, changed, isOpen: () => dialog.open };
}
