// Actions: what's asked of you in Slack and in meeting notes (Notes by Gemini), found by the
// assistant on its checks, in one list so nothing is missed. Your decision on the left of each
// (assign to an agent, skip, done, remove) is kept by the daemon and can be changed any time;
// Discuss talks one through with Claude in a session of its own.

import { holdWhilePicking, rowKeys } from './rowkeys.js';
import { expandButton, expandable } from './expand.js';

const SAVED = 'agentmgr.actionsFilter';
const PROJECT = 'agentmgr.actionsProject';
const FILTERS = [
  ['open', 'Open'],
  ['due', 'Due'],
  ['assigned', 'Assigned'],
  ['questions', 'Questions'],
  ['skipped', 'Skipped'],
  ['snoozed', 'Snoozed'],
  ['done', 'Done'],
  ['all', 'All'],
  ['removed', 'Removed'],
];
const STATES = [
  ['open', '—', 'Not decided yet'],
  ['assign', 'Assign', 'An agent does it (in the project picked above)'],
  ['skip', 'Skip', 'Not now'],
  ['snooze', 'Snooze', 'Until tomorrow 9am: then open again'],
  ['done', 'Done', 'Handled (or answered)'],
  ['remove', 'Remove', 'Not mine, or not needed: off the list (under Removed)'],
];
const ICON = { slack: '💬', gemini: '📝', other: '•' };
// Still yours to handle: what the Due list shows (done and removed ones are off it).
const PENDING = new Set(['open', 'assigned', 'skipped', 'snoozed']);
const late = (r) => Boolean(r.dueAt) && /^overdue/.test(r.dueWords ?? '');
// Soonest first, overdue at the top; a due date that can't be told ("next sprint") after the dated ones.
const byDue = (x, y) => (x.dueAt ? 0 : 1) - (y.dueAt ? 0 : 1) || String(x.dueAt ?? '').localeCompare(String(y.dueAt ?? '')) || String(y.when).localeCompare(String(x.when));

export function initActions({ api, $, esc, ago, toast, openAgent, projects = () => [] }) {
  let editing = null; // the question whose answer is being edited
  const dialog = $('#actions-dialog');
  const body = $('#actions-body');
  let data = null;
  let filter = 'open';
  let busy = false;
  let project = '';
  try {
    filter = localStorage.getItem(SAVED) || 'open';
    project = localStorage.getItem(PROJECT) || '';
  } catch {}

  async function load({ quiet = false } = {}) {
    try {
      data = await api('GET', '/actions');
    } catch (e) {
      if (!quiet) toast?.(e.message, 5000);
    }
    badge();
    render();
  }

  function badge() {
    const n = data ? data.rows.filter((r) => r.group === 'open').length : 0;
    const el = $('#actions-count');
    if (el) {
      el.textContent = n ? String(n) : '';
      el.title = n ? `${n} to decide on` : '';
    }
    const f = data?.features;
    const btn = $('#actions-btn');
    if (btn && f) btn.hidden = !f.slack && !f.gemini;
  }

  /** A question's drafted answer: shown, copied, edited, or asked for. */
  function answerHtml(r) {
    if (editing === r.id) return `<form class="today-draft-edit" data-act-edit="${esc(r.id)}"><textarea rows="4">${esc(r.answer?.text ?? '')}</textarea><div><button class="small primary">Save</button> <button type="button" class="small" data-act-answer="cancel">Cancel</button></div></form>`;
    if (!r.answer) return `<div class="today-draft"><button class="small" data-act-answer="draft" title="A session reads the thread, finds the answer in your code, Jira and docs, and drafts it">Draft an answer</button> <button class="link" data-act-answer="edit">Write one</button></div>`;
    return `<div class="today-draft"><div class="today-draft-text">${esc(r.answer.text)}</div><div class="hint">${r.answer.by === 'you' ? 'Your edit' : 'Drafted by the assistant'}${r.answer.sources ? ` · from ${esc(r.answer.sources)}` : ''} · <button class="link" data-act-answer="copy">Copy</button> · <button class="link" data-act-answer="edit">Edit</button> · <button class="link" data-act-answer="draft">Draft again</button></div></div>`;
  }

  function row(r) {
    const opts = STATES.map(([v, label, title]) => `<option value="${v}" title="${esc(title)}" ${r.status === v ? 'selected' : ''}>${label}</option>`).join('');
    const where = r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener" title="Open where it was asked">${esc(r.sourceLabel)} ↗</a>` : esc(r.sourceLabel);
    const meta = [`${ICON[r.source] ?? '•'} ${where}`, r.from && `from <b>${esc(r.from)}</b>`, r.due && `<span class="action-due${late(r) ? ' late' : ''}" title="${esc(`Said: ${r.due}${r.dueAt ? ` (${new Date(r.dueAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })})` : ''}`)}">${esc(r.dueWords ?? `due ${r.due}`)}</span>`, `<span title="${esc(new Date(r.when).toLocaleString())}">${esc(ago(r.when))}</span>`].filter(Boolean).join(' · ');
    const agent = r.agent ? `<button class="link" data-act-open="${esc(r.agent.id)}" title="Open the agent doing it">${esc(r.agent.name)}</button>` : '';
    const talk = r.discussion
      ? `<button class="small" data-act-open="${esc(r.discussion.id)}" title="Open the conversation about it">💬 Open talk</button>`
      : `<button class="small" data-act-discuss="${esc(r.id)}" title="Talk it through with Claude: what it asks, and what to do (c)">💬 Discuss</button>`;
    return `<tr data-row-id="${esc(r.id)}" class="action-${esc(r.status)}">
      <td class="issue-action"><select data-act-state="${esc(r.id)}" class="act-${esc(r.status === 'assign' ? 'none' : r.status)}" aria-label="Your decision">${opts}</select></td>
      <td>${r.kind === 'question' ? `<span class="tag">${r.cc ? "CC'd" : 'Asked you'}</span> ` : ''}<div class="action-text">${esc(r.kind === 'question' ? r.question : r.text)}</div>${r.context ? `<div class="issue-synopsis" title="${esc(r.context)}">${esc(r.context)}</div>` : ''}<div class="hint action-meta">${meta}${r.snoozeUntil ? ` · until ${esc(new Date(r.snoozeUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}` : ''}</div>${r.kind === 'question' ? answerHtml(r) : ''}</td>
      <td class="nowrap">${talk}${agent ? `<div class="hint">Agent: ${agent}</div>` : ''}</td>
    </tr>`;
  }

  function draw() {
    if (!dialog.open) return;
    if (!data) {
      body.innerHTML = '<p class="hint">Loading…</p>';
      return;
    }
    const inGroup = (r, g) => (g === 'all' ? r.group !== 'removed' : g === 'questions' ? r.kind === 'question' && r.group === 'open' : g === 'due' ? Boolean(r.due) && PENDING.has(r.group) : r.group === g);
    const count = (g) => data.rows.filter((r) => inGroup(r, g)).length;
    const rows = data.rows.filter((r) => inGroup(r, filter));
    if (filter === 'due') rows.sort(byDue);
    const overdue = data.rows.filter((r) => inGroup(r, 'due') && late(r)).length;
    const f = data.features ?? {};
    const from = [f.slack && 'Slack', f.gemini && 'meeting notes (Notes by Gemini)'].filter(Boolean).join(' and ');
    const list = projects();
    body.innerHTML = `
      <div class="issues-head">
        <h2>Actions</h2>
        <div class="chips" role="tablist">${FILTERS.map(([k, label]) => `<button class="chip ${k === filter ? 'active' : ''}${k === 'due' && overdue ? ' late' : ''}" role="tab" aria-selected="${k === filter}" data-act-filter="${k}"${k === 'due' ? ` title="With a due date and not done yet, soonest first${overdue ? `: ${overdue} overdue` : ''}"` : ''}>${label} <span class="count">${count(k)}</span></button>`).join('')}</div>
        <span class="spacer"></span>
        <label class="hint" title="Where an agent works when you assign an action to one">Agents in <select data-act-project class="small">
          <option value="">pick a project</option>
          ${list.map((p) => `<option value="${esc(p.key)}" ${p.key === project ? 'selected' : ''}>${esc(p.name ?? p.key)}</option>`).join('')}
        </select></label>
        ${['skipped', 'snoozed', 'done', 'removed'].includes(filter) && rows.length ? `<button class="small" data-act="back-all" title="Every one here back to open, undecided">Bring all ${rows.length} back</button>` : ''}
        <button class="small" data-act="refresh" title="Look again (r)">↻</button>
        ${expandButton(dialog)}
        <button class="small" data-act="close" title="Close (Esc)">Close</button>
      </div>
      <p class="hint">What's asked of you in ${esc(from || 'Slack and meeting notes')}, found by the assistant on its checks. Decide on the left; <b>Discuss</b> talks one through with Claude. Questions put to you come with a drafted answer to edit, copy and send yourself. Keys: j/k move, a assign, s skip, z snooze, d done, x remove, o open again, c discuss, Enter opens the source, f bigger.</p>
      ${rows.length
        ? `<div class="issues-scroll"><table class="issues actions-table">
            <thead><tr><th class="issue-action">Decision</th><th>Action</th><th></th></tr></thead>
            <tbody>${rows.map(row).join('')}</tbody>
          </table></div>`
        : `<p class="hint issues-empty">${esc(
            !data.rows.length
              ? `Nothing yet. With the Assistant running and "Things asked of me in Slack and in meeting notes" on, what's asked of you shows up here after its next check (or: agentmgr actions add).`
              : filter === 'open'
                ? 'Nothing left to decide.'
                : filter === 'due'
                  ? 'Nothing with a due date is waiting on you.'
                  : 'None here.',
          )}</p>`}`;
    keys.redraw();
  }
  const render = holdWhilePicking(body, draw);
  expandable(dialog, draw);

  async function set(ids, state, { undoing = false } = {}) {
    if (busy) return;
    busy = true;
    // What each was before, to take the change back.
    const before = new Map(ids.map((id) => [id, data?.rows.find((x) => x.id === id)?.status ?? 'open']));
    try {
      const r = await api('POST', '/actions/set', { ids, state, project: project || null, ...(state === 'snooze' ? { until: tomorrow9() } : {}) });
      const bad = r.failed.map((x) => x.reason).join('; ');
      const label = STATES.find(([v]) => v === state)?.[1] ?? state;
      const msg = r.started.length ? `Agent ${r.started.map((x) => x.agent.name).join(', ')} started` : bad ? `Not changed: ${bad}` : state === 'open' ? (ids.length > 1 ? `${r.set.length} open again` : 'Open again') : label;
      // An agent once started stays; anything else can be taken back.
      const undo = !undoing && r.set.length && !r.started.length ? { label: 'Undo', run: () => undoTo(r.set.map((id) => [id, before.get(id)])) } : null;
      toast?.(msg, bad ? 8000 : undo ? 6000 : 2500, undo);
    } catch (err) {
      toast?.(err.message, 6000);
    } finally {
      busy = false;
    }
    load();
  }

  /** Tomorrow at 9 in the morning. */
  function tomorrow9() {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(9, 0, 0, 0);
    return t.toISOString();
  }

  async function answerAct(id, what) {
    const r = data?.rows.find((x) => x.id === id);
    if (!r) return;
    try {
      if (what === 'edit') return (editing = id), render();
      if (what === 'cancel') return (editing = null), render();
      if (what === 'copy') {
        const ok = await navigator.clipboard?.writeText(r.answer?.text ?? '').then(() => true, () => false);
        return toast?.(ok ? 'Copied: paste it in the thread' : "Couldn't copy: select the text instead", 3000, r.link ? { label: 'Open thread', run: () => window.open(r.link, '_blank', 'noopener') } : undefined);
      }
      if (what === 'draft') {
        const x = await api('POST', `/actions/${id}/draft`, {});
        toast?.(x.existing ? 'A session is drafting it already' : 'Drafting: a session reads the thread and finds the answer', 5000, { label: 'Watch', run: () => (dialog.close(), openAgent(x.agent.id)) });
      }
    } catch (e) {
      toast?.(e.message, 6000);
    }
    load();
  }

  /** Set each action back to what it was: [[id, status]]. */
  async function undoTo(pairs) {
    for (const state of new Set(pairs.map(([, st]) => st))) {
      await set(pairs.filter(([, st]) => st === state).map(([id]) => id), state, { undoing: true });
    }
  }

  async function discuss(id) {
    try {
      const r = await api('POST', `/actions/${id}/discuss`, {});
      dialog.close();
      openAgent(r.agent.id);
    } catch (err) {
      toast?.(err.message, 6000);
    }
  }

  const keys = rowKeys(dialog, {
    rows: () => [...body.querySelectorAll('tbody tr[data-row-id]')],
    filters: () => [...body.querySelectorAll('[data-act-filter]')],
    keys: {
      a: (r) => set([r.dataset.rowId], 'assign'),
      s: (r) => set([r.dataset.rowId], 'skip'),
      d: (r) => set([r.dataset.rowId], 'done'),
      x: (r) => set([r.dataset.rowId], 'remove'),
      z: (r) => set([r.dataset.rowId], 'snooze'),
      o: (r) => set([r.dataset.rowId], 'open'),
      c: (r) => discuss(r.dataset.rowId),
      Enter: (r) => r.querySelector('.action-meta a')?.click(),
      r: Object.assign(() => load(), { needsRow: false }),
    },
  });

  body.addEventListener('change', (e) => {
    const id = e.target.dataset.actState;
    if (id) {
      e.target.blur();
      return set([id], e.target.value);
    }
    if (e.target.dataset.actProject !== undefined) {
      project = e.target.value;
      try {
        localStorage.setItem(PROJECT, project);
      } catch {}
    }
  });

  body.addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-act-edit]');
    if (!f) return;
    e.preventDefault();
    document.activeElement?.blur?.();
    try {
      await api('PUT', `/actions/${f.dataset.actEdit}/answer`, { text: f.querySelector('textarea').value });
      editing = null;
      toast?.('Answer saved', 2000);
    } catch (err) {
      return toast?.(err.message, 6000);
    }
    load();
  });

  body.addEventListener('click', (e) => {
    const an = e.target.closest('[data-act-answer]');
    if (an) return answerAct(e.target.closest('tr[data-row-id]')?.dataset.rowId, an.dataset.actAnswer);
    const o = e.target.closest('[data-act-open]');
    if (o) {
      dialog.close();
      return openAgent(o.dataset.actOpen);
    }
    const t = e.target.closest('[data-act-discuss]');
    if (t) return discuss(t.dataset.actDiscuss);
    const f = e.target.closest('[data-act-filter]');
    if (f) {
      filter = f.dataset.actFilter;
      try {
        localStorage.setItem(SAVED, filter);
      } catch {}
      return render();
    }
    const b = e.target.closest('[data-act]')?.dataset.act;
    if (b === 'close') return dialog.close();
    if (b === 'refresh') return load();
    if (b === 'back-all') return set(data.rows.filter((r) => r.group === filter).map((r) => r.id), 'open');
  });

  function open() {
    if (dialog.open) return dialog.close();
    dialog.showModal();
    render();
    load();
  }

  load({ quiet: true });
  // The assistant adds them on its checks: look now and then for the count.
  setInterval(() => load({ quiet: true }), 2 * 60_000);
  return { open, load, isOpen: () => dialog.open };
}
