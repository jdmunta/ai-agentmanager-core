// Plan: looking ahead, in three tabs.
//   Dates      a project's commitments (code complete, release candidate, GA): how far each is,
//              whether it is at risk, what is still open for it, and the reminders planned
//   Decisions  what was decided on each project and why, gathered from plan reviews, your answers
//              and design docs, plus your own
//   Debt       where the code costs the most to change, from git history and the files themselves
// What is open can be handed to an agent from each (it goes to the backlog).

import { expandButton, expandable } from './expand.js';

const TABS = [
  ['dates', 'Dates'],
  ['decisions', 'Decisions'],
  ['debt', 'Debt'],
];
const SAVED = 'agentmgr.planTab';
const STATUS = { 'on-track': 'On track', 'at-risk': 'At risk', late: 'Late', reached: 'Reached' };

export function initPlan({ api, $, esc, ago, toast, projects = () => [], openTab = () => {} }) {
  const dialog = $('#plan-dialog');
  const body = $('#plan-body');
  let tab = 'dates';
  let data = {}; // per tab
  let pending = false; // a change arrived while you were typing
  let adding = false; // the "add dates" or "add a decision" form is open
  const filter = { project: '', q: '' };
  try {
    tab = localStorage.getItem(SAVED) || 'dates';
  } catch {}
  if (!TABS.some(([k]) => k === tab)) tab = 'dates';

  const route = () => (tab === 'dates' ? '/milestones' : tab === 'debt' ? '/debt' : `/decisions?project=${encodeURIComponent(filter.project)}&q=${encodeURIComponent(filter.q)}`);
  async function load({ quiet = false } = {}) {
    const t = tab;
    try {
      data[t] = await api('GET', route());
    } catch (e) {
      if (!quiet) toast?.(e.message, 5000);
    }
    if (t === 'dates') badge();
    render();
  }

  /** On the button: the dates that are late or at risk. */
  function badge() {
    const el = $('#plan-count');
    if (!el || !data.dates) return;
    const n = data.dates.projects.flatMap((p) => p.stages).filter((s) => s.status === 'late' || s.status === 'at-risk').length;
    el.textContent = n ? String(n) : '';
    el.title = n ? `${n} date${n === 1 ? '' : 's'} late or at risk` : '';
  }

  const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const typing = () => body.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

  // ------------------------------------------------------------ Dates
  function dateInputs(stages, values = {}) {
    return stages.map((s) => `<label class="plan-date">${esc(s.label)} <input type="date" name="${s.id}" value="${esc(values[s.id] ?? '')}" /></label>`).join('');
  }

  function checkItem(p, s, i) {
    if (i.auto) {
      return `<li class="plan-check ${i.ok ? 'ok' : 'open'}" title="${esc(i.names.join('\n'))}"><span class="plan-mark">${i.ok ? '✓' : i.count}</span><span>${esc(i.text)}</span>${!i.ok && i.go ? ` <button class="link" data-plan-go="${esc(i.go)}">Show</button>` : ''}</li>`;
    }
    return `<li class="plan-check ${i.done ? 'ok' : 'mine'}"><label><input type="checkbox" data-plan-check="${esc(p.shortcut)}|${s.id}|${esc(i.key)}" ${i.done ? 'checked' : ''} /> ${esc(i.text)}</label>${i.task && !i.done ? (i.asked ? ` <span class="hint">asked an agent ${esc(ago(i.asked))}</span>` : ` <button class="small" data-plan-task="${esc(p.shortcut)}|${s.id}|${esc(i.key)}" title="An agent does it: the task goes to this project's backlog">Have an agent do it</button>`) : ''}</li>`;
  }

  function stageHtml(p, s) {
    const reminders = s.reminders.map((r) => `<span class="plan-reminder${r.sent ? ' sent' : r.past ? ' past' : ''}" title="${esc(r.label)}${r.sent ? ': sent' : r.past ? ': passed before it was set' : ''}">${esc(day(r.on))}${r.sent ? ' ✓' : ''}</span>`).join('');
    return `<section class="plan-stage ${esc(s.status)}">
      <div class="plan-stage-head">
        <b>${esc(s.label)}</b> <span class="hint">${esc(day(s.date))}</span>
        <span class="tag plan-${esc(s.status)}">${esc(STATUS[s.status])}</span> <span class="plan-left">${esc(s.words)}</span>
        <span class="spacer"></span>
        <button class="small" data-plan-reach="${esc(p.shortcut)}|${s.id}|${s.reached ? '0' : '1'}" title="${s.reached ? 'Not reached after all: its reminders come back' : 'The date was met: no more reminders for it'}">${s.reached ? 'Not reached' : 'Mark reached'}</button>
      </div>
      <ul class="plan-checks">${s.checklist.map((i) => checkItem(p, s, i)).join('')}</ul>
      ${s.reached ? '' : `<div class="hint plan-reminders">Reminders: ${reminders}</div>`}
    </section>`;
  }

  function datesHtml() {
    const d = data.dates;
    if (!d) return '<p class="hint">Loading…</p>';
    const form = adding
      ? `<form class="plan-form" data-plan-dates="">
          <select name="project" required><option value="">pick a project</option>${d.others.map((p) => `<option value="${esc(p.shortcut)}">${esc(p.name)}</option>`).join('')}</select>
          ${dateInputs(d.stages)}
          <button class="small primary">Save</button> <button type="button" class="small" data-plan="add">Cancel</button>
        </form>`
      : '';
    const cards = d.projects
      .map((p) => `<div class="plan-project">
        <form class="plan-project-head" data-plan-dates="${esc(p.shortcut)}">
          <h3>${esc(p.name)}</h3>
          ${dateInputs(d.stages, Object.fromEntries(p.stages.map((s) => [s.id, s.date])))}
          <button class="small" title="Save the dates. A date that moves gets its reminders again; an emptied one is removed">Save dates</button>
        </form>
        <div class="plan-stages">${p.stages.map((s) => stageHtml(p, s)).join('')}</div>
      </div>`)
      .join('');
    return `<p class="hint">A project's commitments and what stands between now and each. The app counts what it can see (agents still working, backlog, pull requests, serious bugs); you tick the rest, or hand it to an agent. A date a week or less away with counted work open is <b>at risk</b>. Reminders go to Slack ${d.remindDays.filter((n) => n).join(', ')} days before and on the day (Alerts), and the dates show in Today from two weeks out.</p>
      <div class="plan-bar"><button class="small ${d.projects.length ? '' : 'primary'}" data-plan="add" ${d.others.length ? '' : 'disabled'}>+ Dates for a project</button></div>
      ${form}
      ${cards || (adding ? '' : '<p class="hint issues-empty">No dates yet. Add a project\'s code complete, release candidate and GA dates to get its checklists and reminders.</p>')}`;
  }

  // ------------------------------------------------------------ Decisions
  function decisionsList() {
    const d = data.decisions;
    if (!d) return '<p class="hint">Loading…</p>';
    if (!d.items.length) return `<p class="hint issues-empty">${d.total ? 'Nothing matches.' : 'No decisions yet. They are gathered as you approve plans and answer agents\' questions, and from design docs; or add your own.'}</p>`;
    return `<ul class="plan-decisions">${d.items
      .map((i) => `<li class="plan-decision${i.superseded ? ' superseded' : ''}">
        <div class="plan-decision-head"><b>${esc(i.title)}</b><span class="spacer"></span><button class="link" data-plan-remove="${esc(i.id)}" title="Take it off the log">×</button></div>
        <div><span class="hint">Decided:</span> ${esc(i.decision)}</div>
        ${i.why ? `<div><span class="hint">Why:</span> ${esc(i.why)}</div>` : ''}
        <div class="hint">${esc(i.project.name)} · ${esc(i.kindLabel)}${i.agentName ? ` · ${i.agentGone ? esc(i.agentName) : `<button class="link" data-plan-agent="${esc(i.agentId)}">${esc(i.agentName)}</button>`}` : ''} · <span title="${esc(new Date(i.at).toLocaleString())}">${esc(ago(i.at))}</span>${i.superseded ? ' · <b>replaced since</b>' : ''}</div>
      </li>`)
      .join('')}</ul>`;
  }

  function decisionsHtml() {
    const d = data.decisions;
    const all = projects();
    const form = adding
      ? `<form class="plan-form plan-decision-form" data-plan-decision>
          <select name="project" required><option value="">pick a project</option>${all.map((p) => `<option value="${esc(p.key)}" ${p.key === filter.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
          <input name="title" placeholder="What was the question? (Cursor or offset paging)" required />
          <input name="decision" placeholder="What was decided" required />
          <input name="why" placeholder="Why (optional)" />
          <button class="small primary">Add</button> <button type="button" class="small" data-plan="add">Cancel</button>
        </form>`
      : '';
    return `<p class="hint">What was decided on each project and why: the plans you approved or sent back (with your notes), your answers to agents' questions, and the decisions in each design doc. They stay after the agent is deleted.</p>
      <div class="plan-bar">
        <select data-plan-project aria-label="Project"><option value="">All projects${d ? ` (${d.total})` : ''}</option>${(d?.projects ?? []).map((p) => `<option value="${esc(p.key)}" ${p.key === filter.project ? 'selected' : ''}>${esc(p.name)} (${p.count})</option>`).join('')}</select>
        <input type="search" data-plan-find placeholder="Find…" value="${esc(filter.q)}" aria-label="Find a decision" />
        <span class="spacer"></span>
        <button class="small" data-plan="copy" title="The log${filter.project ? ' of this project' : ''} as Markdown, on the clipboard">Copy as Markdown</button>
        <button class="small" data-plan="add" ${all.length ? '' : 'disabled'}>+ Add a decision</button>
      </div>
      ${form}
      <div id="plan-decisions-list">${decisionsList()}</div>`;
  }

  // ------------------------------------------------------------ Debt
  function debtHtml() {
    const d = data.debt;
    if (!d) return '<p class="hint">Loading…</p>';
    const cards = d.projects
      .map((p) => {
        const meta = p.scanning ? 'Scanning…' : p.error ? `<span class="fail">Couldn't scan: ${esc(p.error)}</span>` : p.at ? `Scanned ${esc(ago(p.at))}: ${p.commits} commits in ${p.days} days, ${p.scanned} changed files read${p.dismissed ? `, ${p.dismissed} set aside` : ''}` : p.hasRepo ? 'Not scanned yet' : 'No local repository yet: start an agent in it first';
        const rows = p.spots
          .map((h) => `<tr>
            <td class="plan-score"><span class="plan-bar-fill" style="width:${h.score}%"></span><b>${h.score}</b></td>
            <td><code>${esc(h.file)}</code><div class="hint">${esc(h.reasons.join(' · '))}</div></td>
            <td class="nowrap">${h.queued ? `<span class="hint">handed over ${esc(ago(h.queued))}</span>` : `<button class="small" data-plan-debt="${esc(p.shortcut)}" data-file="${esc(h.file)}" title="An agent covers it with tests, then refactors in small steps: the task goes to this project's backlog">Hand to an agent</button>`} <button class="small" data-plan-notdebt="${esc(p.shortcut)}" data-file="${esc(h.file)}" title="Generated, or meant to be this way: off the list, also after the next scan">Not debt</button></td>
          </tr>`)
          .join('');
        return `<div class="plan-project">
          <div class="plan-project-head"><h3>${esc(p.name)}</h3><span class="hint">${meta}</span><span class="spacer"></span><button class="small" data-plan-scan="${esc(p.shortcut)}" ${p.hasRepo && !p.scanning ? '' : 'disabled'}>${p.at ? 'Scan again' : 'Scan'}</button></div>
          ${rows ? `<table class="issues plan-debt"><tbody>${rows}</tbody></table>` : p.at && !p.error ? '<p class="hint">No hot spots: nothing here is both changed often and hard to read.</p>' : ''}
        </div>`;
      })
      .join('');
    return `<p class="hint">Where the code costs the most to change: files that changed often in the last ${d.settings.days} days (and how many of those changes were fixes) and are tangled (long, branching, deeply nested, with TODOs), plus the open bugs found there. Read from git and the files; no model is called. Scanned again every ${d.settings.autoDays} days.</p>
      ${cards || '<p class="hint issues-empty">No projects yet.</p>'}`;
  }

  function draw() {
    if (!dialog.open) return;
    body.innerHTML = `
      <div class="issues-head">
        <h2>Plan</h2>
        <div class="chips" role="tablist">${TABS.map(([k, label]) => `<button class="chip ${k === tab ? 'active' : ''}" role="tab" aria-selected="${k === tab}" data-plan-tab="${k}">${label}</button>`).join('')}</div>
        <span class="spacer"></span>
        <button class="small" data-plan="refresh" title="Look again">↻</button>
        ${expandButton(dialog)}
        <button class="small" data-plan="close" title="Close (Esc)">Close</button>
      </div>
      <div class="issues-scroll plan-scroll">${tab === 'dates' ? datesHtml() : tab === 'decisions' ? decisionsHtml() : debtHtml()}</div>`;
  }
  // A change from the daemon doesn't take what you are typing: it is drawn when you are done.
  function render() {
    if (typing()) {
      pending = true;
      // The decision list can still follow the search box.
      const list = body.querySelector('#plan-decisions-list');
      if (tab === 'decisions' && list) list.innerHTML = decisionsList();
      return;
    }
    pending = false;
    const top = body.querySelector('.plan-scroll')?.scrollTop ?? 0;
    draw();
    const sc = body.querySelector('.plan-scroll');
    if (sc) sc.scrollTop = top;
  }
  body.addEventListener('focusout', () => setTimeout(() => pending && !typing() && render(), 0));

  const run = async (fn, done) => {
    try {
      const r = await fn();
      if (r && tab !== 'decisions') data[tab] = r;
      if (done) toast?.(done, 2500);
    } catch (e) {
      toast?.(e.message, 6000);
    }
    document.activeElement?.blur?.();
    if (tab === 'decisions') return load();
    if (tab === 'dates') badge();
    render();
  };

  body.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (e.target.matches('[data-plan-dates]')) {
      const project = e.target.dataset.planDates || f.project;
      if (!project) return toast?.('Pick a project', 3000);
      adding = false;
      return run(() => api('PUT', `/milestones/${encodeURIComponent(project)}`, { codeComplete: f.codeComplete || null, rc: f.rc || null, ga: f.ga || null }), 'Dates saved');
    }
    if (e.target.matches('[data-plan-decision]')) {
      adding = false;
      return run(() => api('POST', '/decisions', f), 'Added to the log');
    }
  });

  let finding = null;
  body.addEventListener('input', (e) => {
    if (e.target.dataset.planFind === undefined) return;
    filter.q = e.target.value;
    clearTimeout(finding);
    finding = setTimeout(() => load({ quiet: true }), 200);
  });

  body.addEventListener('change', (e) => {
    const c = e.target.dataset.planCheck;
    if (c) {
      const [project, stage, item] = c.split('|');
      return run(() => api('POST', `/milestones/${encodeURIComponent(project)}/check`, { stage, item, done: e.target.checked }));
    }
    if (e.target.dataset.planProject !== undefined) {
      filter.project = e.target.value;
      e.target.blur();
      load();
    }
  });

  body.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-plan-tab]');
    if (t) return show(t.dataset.planTab);
    const ds = (name) => e.target.closest(`[data-plan-${name}]`)?.dataset;
    const split = (v) => v.split('|');
    if (ds('task')) {
      const [project, stage, item] = split(ds('task').planTask);
      return run(() => api('POST', `/milestones/${encodeURIComponent(project)}/task`, { stage, item }), "In the project's backlog: an agent picks it up");
    }
    if (ds('reach')) {
      const [project, stage, on] = split(ds('reach').planReach);
      return run(() => api('POST', `/milestones/${encodeURIComponent(project)}/reach`, { stage, reached: on === '1' }));
    }
    if (ds('go')) {
      dialog.close();
      return openTab(ds('go').planGo);
    }
    if (ds('agent')) {
      dialog.close();
      return openTab('agent', ds('agent').planAgent);
    }
    if (ds('remove')) return run(() => api('DELETE', `/decisions/${encodeURIComponent(ds('remove').planRemove)}`), 'Removed from the log');
    if (ds('scan')) return run(() => api('POST', `/debt/${encodeURIComponent(ds('scan').planScan)}/scan`, {}), 'Scanning the repository');
    if (ds('debt')) return run(() => api('POST', `/debt/${encodeURIComponent(ds('debt').planDebt)}/queue`, { file: ds('debt').file }), "In the project's backlog: an agent picks it up");
    if (ds('notdebt')) return run(() => api('POST', `/debt/${encodeURIComponent(ds('notdebt').planNotdebt)}/dismiss`, { file: ds('notdebt').file }), 'Set aside');
    const b = e.target.closest('[data-plan]')?.dataset.plan;
    if (b === 'close') return dialog.close();
    if (b === 'refresh') return load();
    if (b === 'add') {
      adding = !adding;
      return draw();
    }
    if (b === 'copy') {
      try {
        const res = await fetch(`/api/decisions?format=markdown&project=${encodeURIComponent(filter.project)}`);
        const ok = await navigator.clipboard?.writeText(await res.text()).then(() => true, () => false);
        toast?.(ok ? 'The decision log is on the clipboard, as Markdown' : "Couldn't copy it", 3000);
      } catch (err) {
        toast?.(err.message, 5000);
      }
    }
  });

  function show(next) {
    tab = TABS.some(([k]) => k === next) ? next : 'dates';
    adding = false;
    try {
      localStorage.setItem(SAVED, tab);
    } catch {}
    draw();
    load();
  }

  function open(which) {
    if (dialog.open && !which) return dialog.close();
    if (!dialog.open) dialog.showModal();
    show(which ?? tab);
  }

  let again = null;
  /** The daemon says something here changed: look again while open; the count now and then. */
  function changed() {
    clearTimeout(again);
    again = setTimeout(() => {
      if (dialog.open) load({ quiet: true });
      else api('GET', '/milestones').then((v) => ((data.dates = v), badge()), () => {});
    }, dialog.open ? 400 : 3000);
  }

  expandable(dialog, draw);
  api('GET', '/milestones').then((v) => ((data.dates = v), badge()), () => {});
  return { open, changed, isOpen: () => dialog.open };
}
