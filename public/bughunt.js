// Bugs: what background bug hunts found, checked, worst first; and the hunts themselves (a project
// or a folder of it, recent changes or the whole module, by hand or every night, with a cost
// limit per run). Each finding opens to its evidence; Fix starts an agent on it, File it opens a
// filled-in issue, Not a bug keeps it from coming back, Snooze hides it until later.

import { holdWhilePicking, rowKeys } from './rowkeys.js';
import { expandButton, expandable } from './expand.js';

const SAVED = 'agentmgr.bugsFilter';
const FILTERS = [
  ['open', 'Open'],
  ['fixing', 'Fixing'],
  ['snoozed', 'Snoozed'],
  ['filed', 'Filed'],
  ['notbug', 'Not a bug'],
  ['dropped', 'Not kept'],
  ['hunts', 'Hunts'],
];
const SEV = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

/** Tomorrow at 9, or next Monday at 9. */
function later(which) {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  d.setDate(d.getDate() + (which === 'week' ? ((8 - d.getDay()) % 7 || 7) : 1));
  return d.toISOString();
}

export function initBugHunt({ api, $, esc, ago, toast, openAgent }) {
  const dialog = $('#bugs-dialog');
  const body = $('#bugs-body');
  let data = null;
  let filter = 'open';
  let opened = null; // the finding shown in full
  let editing = null; // a hunt being added ('new') or edited (its id)
  let sure = null; // a hunt whose Delete was pressed once
  try {
    filter = localStorage.getItem(SAVED) || 'open';
  } catch {}
  let projects = [];

  async function load() {
    try {
      data = await api('GET', '/hunts');
    } catch (e) {
      toast?.(e.message, 5000);
    }
    badge();
    render();
  }

  function badge() {
    const n = data ? data.findings.filter((f) => f.status === 'open').length : 0;
    const el = $('#bugs-count');
    if (el) {
      el.textContent = n ? String(n) : '';
      el.title = n ? `${n} open bug${n === 1 ? '' : 's'} found by hunts` : '';
    }
    const b = $('#bugs-btn');
    if (b) b.classList.toggle('hunting', Boolean(data?.running));
  }

  const count = (k) => (k === 'hunts' ? data.hunts.length : data.findings.filter((f) => f.status === k).length);
  const where = (f) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '');

  function findingRow(f) {
    const acts =
      f.status === 'open'
        ? `<button class="small primary" data-bug="fix" title="Start an agent on it, with the failing test (a)">Fix</button>
           <button class="small" data-bug="file" title="A filled-in issue to submit (i)">File it</button>
           <button class="small" data-bug="notbug" title="Not a bug: it won't be reported again (x)">Not a bug</button>
           <select class="small" data-bug-snooze title="Hide it until then (s: tomorrow)"><option value="">Snooze…</option><option value="day">Until tomorrow 9am</option><option value="week">Until Monday 9am</option></select>`
        : f.status === 'fixing' && f.fixAgentId
          ? `<button class="small" data-bug="open-fix" title="Open the agent fixing it">Open fix</button> <button class="small" data-bug="back" title="Back to open (o)">Bring back</button>`
          : `<button class="small" data-bug="back" title="Back to open (o)">Bring back</button>`;
    const full =
      opened === f.id
        ? `<tr class="bug-detail"><td colspan="3">
            <p><b>How it fails.</b> ${esc(f.why)}</p>
            <p><b>Evidence: ${f.evidence.type === 'test' ? 'a failing test' : 'the path through the code'}.</b></p><pre>${esc(f.evidence.detail)}</pre>
            ${f.evidence.test ? `<p><b>Test.</b></p><pre>${esc(f.evidence.test)}</pre>` : ''}
            ${f.fix ? `<p><b>Suggested fix.</b> ${esc(f.fix)}</p>` : ''}
            <p class="hint">${f.check ? `Second check: ${f.check.real ? 'holds up' : 'does not hold up'} (${Math.round(f.check.confidence * 100)}%). ${esc(f.check.reason ?? '')}` : 'Second check: not asked (the AI judge is off); kept because a test fails.'} Found ${esc(ago(f.at))} by the ${esc(f.hunt ?? '')} hunt${f.foundBy ? ` · <button class="link" data-bug-agent="${esc(f.foundBy)}">its session</button>` : ''}.</p>
          </td></tr>`
        : '';
    return `<tr data-row-id="${esc(f.id)}" class="bug-${esc(f.severity)}">
      <td class="nowrap"><span class="bug-sev ${esc(f.severity)}">${esc(SEV[f.severity] ?? f.severity)}</span></td>
      <td><div class="today-title">${esc(f.title)}</div><div class="hint">${esc(where(f))}${f.evidence?.type === 'test' ? ' · a test fails' : ''}${f.snoozeUntil ? ` · until ${esc(new Date(f.snoozeUntil).toLocaleString())}` : ''}</div></td>
      <td class="nowrap today-acts">${acts}</td>
    </tr>${full}`;
  }

  function huntForm(h) {
    const p = h ?? { focus: 'changes', schedule: 'manual', maxUsd: 5, kinds: [], path: '', project: projects[0]?.shortcut ?? '' };
    return `<form class="hunt-form alerts-body" data-hunt-form="${esc(h?.id ?? 'new')}">
      <h3>${h ? `Edit ${esc(h.name)}` : 'New hunt'}</h3>
      <div class="row three">
        <label>Project <select name="project" required>${projects.map((x) => `<option value="${esc(x.shortcut)}" ${x.shortcut === p.project ? 'selected' : ''}>${esc(x.name ?? x.shortcut)}</option>`).join('')}</select></label>
        <label>Folder <span class="hint">(empty: all of it)</span><input name="path" value="${esc(p.path)}" placeholder="pkg/providers" autocomplete="off" /></label>
        <label>Name <span class="hint">(optional)</span><input name="name" value="${esc(h?.name ?? '')}" autocomplete="off" /></label>
      </div>
      <fieldset><legend>Look at</legend>${Object.entries(data.focus).map(([k, label]) => `<label class="check"><input type="radio" name="focus" value="${k}" ${p.focus === k ? 'checked' : ''} /> ${esc(label)}</label>`).join('')}</fieldset>
      <fieldset><legend>For <span class="hint">(none ticked: any kind of bug)</span></legend><div class="hunt-kinds">${Object.entries(data.kinds).map(([k, label]) => `<label class="check"><input type="checkbox" name="kind" value="${k}" ${p.kinds.includes(k) ? 'checked' : ''} /> ${esc(label)}</label>`).join('')}</div></fieldset>
      <div class="row three">
        <label>When <select name="schedule">${Object.entries(data.schedules).map(([k, label]) => `<option value="${k}" ${p.schedule === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label>Cost limit per run ($) <input name="maxUsd" type="number" min="0.5" max="500" step="0.5" value="${esc(p.maxUsd)}" /></label>
      </div>
      <p class="hint">The hunter reads the code and runs the tests on its own copy; it never commits or pushes. One hunt runs at a time, and it stops at the cost limit.</p>
      <div class="dialog-actions"><button type="button" class="ghost" data-bug="cancel-hunt">Cancel</button><button type="submit" class="primary">${h ? 'Save' : 'Add hunt'}</button></div>
    </form>`;
  }

  function huntsHtml() {
    if (editing) return huntForm(editing === 'new' ? null : data.hunts.find((h) => h.id === editing));
    const rows = data.hunts
      .map((h) => {
        const last = h.last ? `${h.last.status === 'running' ? 'running now' : `${h.last.kept ?? 0} kept of ${h.last.found ?? 0} new`} · ${ago(h.last.at)}` : 'not run yet';
        return `<tr data-hunt="${esc(h.id)}">
          <td><div class="today-title">${esc(h.name)}</div><div class="hint">${esc(h.focus === 'changes' ? 'recent changes' : `whole module${h.coveredCount ? ` (${h.coveredCount} parts covered)` : ''}`)}${h.kinds.length ? ` · ${esc(h.kinds.join(', '))}` : ''} · ${esc(h.schedule === 'nightly' ? 'nightly' : 'by hand')} · up to $${esc(h.maxUsd)}</div></td>
          <td class="hint">${esc(last)}${h.open ? ` · ${h.open} open` : ''}</td>
          <td class="nowrap today-acts"><button class="small primary" data-bug="run" ${data.running ? 'disabled title="A hunt is running; one at a time"' : 'title="Start a run now"'}>Hunt now</button> <button class="small" data-bug="edit">Edit</button> <button class="small ${sure === h.id ? 'danger' : ''}" data-bug="delete">${sure === h.id ? 'Delete it?' : 'Delete'}</button></td>
        </tr>`;
      })
      .join('');
    return `${rows ? `<div class="issues-scroll"><table class="issues today-table"><tbody>${rows}</tbody></table></div>` : '<p class="hint issues-empty">No hunts yet. A hunt looks for bugs in a project, or one folder of it, in the background: in what changed since its last run, or the whole module a part at a time. Each bug comes with evidence, and a second check keeps only those that hold up.</p>'}
      <p><button class="small primary" data-bug="new-hunt" ${projects.length ? '' : 'disabled title="Add a project first"'}>+ New hunt</button></p>`;
  }

  function draw() {
    if (!dialog.open) return;
    if (!data) {
      body.innerHTML = '<p class="hint">Loading…</p>';
      return;
    }
    const rows = data.findings.filter((f) => f.status === filter);
    const empty = {
      open: data.hunts.length ? 'No open bugs. Hunts add what they find here, worst first.' : 'No bugs yet: set up a hunt under Hunts.',
      dropped: "Findings the second check didn't confirm. They aren't reported again.",
    };
    body.innerHTML = `
      <div class="issues-head">
        <h2>Bugs</h2>
        <div class="chips" role="tablist">${FILTERS.map(([k, label]) => `<button class="chip ${k === filter ? 'active' : ''}" role="tab" aria-selected="${k === filter}" data-bugs-filter="${k}">${label} <span class="count">${count(k)}</span></button>`).join('')}</div>
        <span class="spacer"></span>
        <button class="small" data-bug="refresh" title="Look again (r)">↻</button>
        ${expandButton(dialog)}
        <button class="small" data-bug="close" title="Close (Esc)">Close</button>
      </div>
      ${data.running ? `<p class="hunt-running">Hunting now: <button class="link" data-bug-agent="${esc(data.running.id)}">${esc(data.running.name)}</button>. Its findings come in when it's done.</p>` : ''}
      ${filter === 'hunts'
        ? huntsHtml()
        : rows.length
          ? `<div class="issues-scroll"><table class="issues today-table"><tbody>${rows.map(findingRow).join('')}</tbody></table></div>`
          : `<p class="hint issues-empty">${esc(empty[filter] ?? 'None here.')}</p>`}
      ${filter === 'hunts' ? '' : '<p class="hint">Keys: j/k move (or click a row), Enter shows the evidence, a fix, i file it, x not a bug, s snooze until tomorrow, o bring back, r look again, [ ] filters, f bigger.</p>'}`;
    keys.redraw();
  }
  const render = holdWhilePicking(body, draw);
  expandable(dialog, draw);

  const finding = (id) => data?.findings.find((f) => f.id === id) ?? null;

  /** Set findings to a decision; Undo puts each back. */
  async function decide(ids, status, until = null, { undoing = false } = {}) {
    const before = ids.map((id) => [id, finding(id)?.status, finding(id)?.snoozeUntil]);
    try {
      await api('POST', '/findings/set', { ids, status, until });
      const label = { open: 'Back on the list', notbug: 'Not a bug: it won\'t be reported again', snoozed: 'Snoozed', filed: 'Marked filed' }[status];
      const undo = undoing ? null : { label: 'Undo', run: async () => {
        for (const [id, st, u] of before) if (st && st !== 'fixing') await decide([id], st, st === 'snoozed' ? u : null, { undoing: true });
      } };
      toast?.(label, undo ? 6000 : 2500, undo);
    } catch (e) {
      toast?.(e.message, 6000);
    }
    load();
  }

  async function act(id, what, extra) {
    const f = finding(id);
    if (!f) return;
    if (what === 'fix') {
      try {
        const r = await api('POST', `/findings/${id}/fix`, {});
        toast?.(r.existing ? `${r.agent.name} is on it already` : `Agent ${r.agent.name} started on it`, 4000, { label: 'Open', run: () => (dialog.close(), openAgent(r.agent.id)) });
      } catch (e) {
        toast?.(e.message, 6000);
      }
      return load();
    }
    if (what === 'file') {
      try {
        const r = await api('GET', `/findings/${id}/issue`);
        if (r.url) window.open(r.url, '_blank', 'noopener');
        else await navigator.clipboard?.writeText(`# ${r.title}\n\n${r.markdown}`).catch(() => {});
        return decide([id], 'filed', null).then(() => toast?.(r.url ? 'GitHub opened with the issue filled in: submit it there' : 'Copied as Markdown, to paste into your tracker', 5000));
      } catch (e) {
        return toast?.(e.message, 6000);
      }
    }
    if (what === 'notbug') return decide([id], 'notbug');
    if (what === 'snooze') return decide([id], 'snoozed', later(extra || 'day'));
    if (what === 'back') return decide([id], 'open');
    if (what === 'open-fix' && f.fixAgentId) return dialog.close(), openAgent(f.fixAgentId);
    if (what === 'enter') {
      opened = opened === id ? null : id;
      return render();
    }
  }

  const keys = rowKeys(dialog, {
    rows: () => [...body.querySelectorAll('tbody tr[data-row-id]')],
    filters: () => [...body.querySelectorAll('[data-bugs-filter]')],
    keys: {
      Enter: (r) => act(r.dataset.rowId, 'enter'),
      a: (r) => act(r.dataset.rowId, 'fix'),
      i: (r) => act(r.dataset.rowId, 'file'),
      x: (r) => act(r.dataset.rowId, 'notbug'),
      s: (r) => act(r.dataset.rowId, 'snooze', 'day'),
      o: (r) => act(r.dataset.rowId, 'back'),
      r: Object.assign(() => load(), { needsRow: false }),
    },
  });

  async function hunt(id, what) {
    try {
      if (what === 'run') {
        const r = await api('POST', `/hunts/${id}/run`, {});
        toast?.(`${r.agent.name} is hunting. Its findings come in when it's done.`, 5000);
      } else if (what === 'edit') {
        editing = id;
        sure = null;
        return render();
      } else if (what === 'delete') {
        if (sure !== id) {
          sure = id;
          return render();
        }
        sure = null;
        await api('DELETE', `/hunts/${id}`);
        toast?.('Hunt deleted; its findings stay', 3000);
      }
    } catch (e) {
      toast?.(e.message, 6000);
    }
    load();
  }

  body.addEventListener('change', (e) => {
    const s = e.target.closest('[data-bug-snooze]');
    if (s && s.value) act(e.target.closest('tr[data-row-id]')?.dataset.rowId, 'snooze', s.value);
  });

  body.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-hunt-form]');
    if (!form) return;
    e.preventDefault();
    document.activeElement?.blur?.();
    const fd = new FormData(form);
    const input = { project: fd.get('project'), path: fd.get('path'), name: fd.get('name'), focus: fd.get('focus'), kinds: fd.getAll('kind'), schedule: fd.get('schedule'), maxUsd: Number(fd.get('maxUsd')) };
    try {
      const id = form.dataset.huntForm;
      await api(id === 'new' ? 'POST' : 'PUT', id === 'new' ? '/hunts' : `/hunts/${id}`, input);
      editing = null;
      toast?.(id === 'new' ? 'Hunt added: press Hunt now to start it' : 'Saved', 3000);
    } catch (err) {
      return toast?.(err.message, 6000);
    }
    load();
  });

  body.addEventListener('click', (e) => {
    const ag = e.target.closest('[data-bug-agent]');
    if (ag) return dialog.close(), openAgent(ag.dataset.bugAgent);
    const f = e.target.closest('[data-bugs-filter]');
    if (f) {
      filter = f.dataset.bugsFilter;
      editing = null;
      try {
        localStorage.setItem(SAVED, filter);
      } catch {}
      return render();
    }
    const b = e.target.closest('[data-bug]')?.dataset.bug;
    if (!b) {
      // A click on a finding's title shows its evidence.
      const row = e.target.closest('tr[data-row-id]');
      if (row && e.target.closest('.today-title')) act(row.dataset.rowId, 'enter');
      return;
    }
    if (b === 'close') return dialog.close();
    if (b === 'refresh') return load();
    if (b === 'new-hunt') return (editing = 'new'), render();
    if (b === 'cancel-hunt') return (editing = null), render();
    const huntRow = e.target.closest('tr[data-hunt]');
    if (huntRow) return hunt(huntRow.dataset.hunt, b);
    act(e.target.closest('tr[data-row-id]')?.dataset.rowId, b);
  });

  async function open({ show } = {}) {
    if (dialog.open && !show) return dialog.close();
    if (show) filter = show;
    if (!dialog.open) dialog.showModal();
    render();
    projects = await api('GET', '/projects').catch(() => []);
    load();
  }

  let again = null;
  function changed() {
    clearTimeout(again);
    again = setTimeout(load, dialog.open ? 1500 : 20_000);
  }

  load();
  return { open, changed, load, decide, fix: (id) => act(id, 'fix') };
}
