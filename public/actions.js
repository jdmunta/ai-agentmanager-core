// Actions: what's asked of you in Slack and in meeting notes (Notes by Gemini), found by the
// assistant on its checks, in one list so nothing is missed. Your decision on the left of each
// (assign to an agent, skip, done, remove) is kept by the daemon and can be changed any time;
// Discuss talks one through with Claude in a session of its own.

import { rowKeys } from './rowkeys.js';

const SAVED = 'agentmgr.actionsFilter';
const PROJECT = 'agentmgr.actionsProject';
const FILTERS = [
  ['open', 'Open'],
  ['assigned', 'Assigned'],
  ['skipped', 'Skipped'],
  ['done', 'Done'],
  ['all', 'All'],
  ['removed', 'Removed'],
];
const STATES = [
  ['open', '—', 'Not decided yet'],
  ['assign', 'Assign', 'An agent does it (in the project picked above)'],
  ['skip', 'Skip', 'Not now'],
  ['done', 'Done', 'Handled'],
  ['remove', 'Remove', 'Not mine, or not needed: off the list (under Removed)'],
];
const ICON = { slack: '💬', gemini: '📝', other: '•' };

export function initActions({ api, $, esc, ago, toast, openAgent, projects = () => [] }) {
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

  function row(r) {
    const opts = STATES.map(([v, label, title]) => `<option value="${v}" title="${esc(title)}" ${r.status === v ? 'selected' : ''}>${label}</option>`).join('');
    const where = r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener" title="Open where it was asked">${esc(r.sourceLabel)} ↗</a>` : esc(r.sourceLabel);
    const meta = [`${ICON[r.source] ?? '•'} ${where}`, r.from && `from <b>${esc(r.from)}</b>`, r.due && `<span class="action-due">due ${esc(r.due)}</span>`, `<span title="${esc(new Date(r.when).toLocaleString())}">${esc(ago(r.when))}</span>`].filter(Boolean).join(' · ');
    const agent = r.agent ? `<button class="link" data-act-open="${esc(r.agent.id)}" title="Open the agent doing it">${esc(r.agent.name)}</button>` : '';
    const talk = r.discussion
      ? `<button class="small" data-act-open="${esc(r.discussion.id)}" title="Open the conversation about it">💬 Open talk</button>`
      : `<button class="small" data-act-discuss="${esc(r.id)}" title="Talk it through with Claude: what it asks, and what to do (c)">💬 Discuss</button>`;
    return `<tr data-row-id="${esc(r.id)}" class="action-${esc(r.status)}">
      <td class="issue-action"><select data-act-state="${esc(r.id)}" class="act-${esc(r.status === 'assign' ? 'none' : r.status)}" aria-label="Your decision">${opts}</select></td>
      <td><div class="action-text">${esc(r.text)}</div>${r.context ? `<div class="issue-synopsis" title="${esc(r.context)}">${esc(r.context)}</div>` : ''}<div class="hint action-meta">${meta}</div></td>
      <td class="nowrap">${talk}${agent ? `<div class="hint">Agent: ${agent}</div>` : ''}</td>
    </tr>`;
  }

  function render() {
    if (!dialog.open) return;
    if (!data) {
      body.innerHTML = '<p class="hint">Loading…</p>';
      return;
    }
    const inGroup = (r, g) => (g === 'all' ? r.group !== 'removed' : r.group === g);
    const count = (g) => data.rows.filter((r) => inGroup(r, g)).length;
    const rows = data.rows.filter((r) => inGroup(r, filter));
    const f = data.features ?? {};
    const from = [f.slack && 'Slack', f.gemini && 'meeting notes (Notes by Gemini)'].filter(Boolean).join(' and ');
    const list = projects();
    body.innerHTML = `
      <div class="issues-head">
        <h2>Actions</h2>
        <div class="chips" role="tablist">${FILTERS.map(([k, label]) => `<button class="chip ${k === filter ? 'active' : ''}" role="tab" aria-selected="${k === filter}" data-act-filter="${k}">${label} <span class="count">${count(k)}</span></button>`).join('')}</div>
        <span class="spacer"></span>
        <label class="hint" title="Where an agent works when you assign an action to one">Agents in <select data-act-project class="small">
          <option value="">pick a project</option>
          ${list.map((p) => `<option value="${esc(p.key)}" ${p.key === project ? 'selected' : ''}>${esc(p.name ?? p.key)}</option>`).join('')}
        </select></label>
        <button class="small" data-act="refresh" title="Look again (r)">↻</button>
        <button class="small" data-act="close" title="Close (Esc)">Close</button>
      </div>
      <p class="hint">What's asked of you in ${esc(from || 'Slack and meeting notes')}, found by the assistant on its checks. Decide on the left; <b>Discuss</b> talks one through with Claude. Keys: j/k move, a assign, s skip, d done, x remove, o open again, c discuss, Enter opens the source.</p>
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
                : 'None here.',
          )}</p>`}`;
    keys.redraw();
  }

  async function set(ids, state) {
    if (busy) return;
    busy = true;
    try {
      const r = await api('POST', '/actions/set', { ids, state, project: project || null });
      const bad = r.failed.map((x) => x.reason).join('; ');
      const label = STATES.find(([v]) => v === state)?.[1] ?? state;
      toast?.(r.started.length ? `Agent ${r.started.map((x) => x.agent.name).join(', ')} started` : bad ? `Not changed: ${bad}` : state === 'open' ? 'Open again' : label, bad ? 8000 : 2500);
    } catch (err) {
      toast?.(err.message, 6000);
    } finally {
      busy = false;
    }
    load();
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
      o: (r) => set([r.dataset.rowId], 'open'),
      c: (r) => discuss(r.dataset.rowId),
      Enter: (r) => r.querySelector('.action-meta a')?.click(),
      r: Object.assign(() => load(), { needsRow: false }),
    },
  });

  body.addEventListener('change', (e) => {
    const id = e.target.dataset.actState;
    if (id) return set([id], e.target.value);
    if (e.target.dataset.actProject !== undefined) {
      project = e.target.value;
      try {
        localStorage.setItem(PROJECT, project);
      } catch {}
    }
  });

  body.addEventListener('click', (e) => {
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
