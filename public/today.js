// Today: what needs you, from every list, most pressing first: agents stopped at a prompt or
// waiting for an answer, issues and pull requests ready for your review, what's asked of you
// (by due date), new Jira issues, and the rest. Each says why it's here, and the common
// decisions are a click (or a key) away. Listen reads the top of it aloud.

import { listenHtml } from './speak.js';
import { holdWhilePicking, rowKeys } from './rowkeys.js';
import { expandButton, expandable } from './expand.js';

// Up to this score an item is pressing: it counts on the button.
const PRESSING = 32;

export function initToday({ api, $, esc, ago, openAgent, showInbox, openActions, openIssues, openReviews, toast }) {
  const dialog = $('#today-dialog');
  const body = $('#today-body');
  let data = null;
  let loading = false;
  let again = null;
  let loadedAt = 0;

  async function load({ quiet = false, fresh = false } = {}) {
    if (loading) return;
    loading = true;
    try {
      data = await api('GET', `/today${fresh ? '?fresh=1' : ''}`);
      loadedAt = Date.now();
    } catch (e) {
      if (!quiet) toast?.(e.message, 5000);
    } finally {
      loading = false;
    }
    badge();
    render();
  }

  function badge() {
    const n = data ? data.items.filter((i) => i.score <= PRESSING).length : 0;
    const el = $('#today-count');
    if (el) {
      el.textContent = n ? String(n) : '';
      el.title = n ? `${n} pressing: agents waiting on you, overdue or due-today actions, reviews` : '';
    }
  }

  const link = (url, label) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="small-link">${esc(label)} ↗</a>` : '');
  const btn = (act, label, title, primary = false) => `<button class="small ${primary ? 'primary' : ''}" data-today="${act}" title="${esc(title)}">${esc(label)}</button>`;

  /** The buttons for an item: the decision it asks for, then where to look. */
  function buttons(it) {
    if (it.kind === 'action') return [btn('done', 'Done', 'Handled: off the list (d)'), btn('skip', 'Skip', 'Not now (s)'), btn('discuss', 'Discuss', 'Talk it through with Claude (c)'), link(it.url, 'Source')].join(' ');
    if (it.kind === 'issue-new') return [btn('assign', 'Assign', 'Start an agent on it (a)', true), btn('skip', 'Skip', 'Not now (s)'), link(it.url, 'Jira')].join(' ');
    if (it.kind === 'pr-requested') return [btn('review', 'Review it', 'A reviewer agent reads it and finds what blocks approval (a)', true), link(it.url, 'PR')].join(' ');
    if (it.kind === 'pr-ready') return [btn('open-reviews', 'Open review', 'Pick what to post (Enter)', true), link(it.url, 'PR')].join(' ');
    if (it.kind === 'rule') return btn('inbox', 'Inbox', 'Decide in the inbox (Enter)', true);
    return [it.agentId ? btn('open', 'Open', "Open the agent's session (Enter)", it.score < 20) : '', link(it.url, it.issueKey ? 'Jira' : 'Link')].join(' ');
  }

  function row(it) {
    return `<tr data-row-id="${esc(it.id)}" class="today-${esc(it.kind)} ${it.score <= PRESSING ? 'pressing' : ''}">
      <td class="nowrap"><span class="today-label">${esc(it.label)}</span></td>
      <td><div class="today-title">${esc(it.title)}</div><div class="hint today-why">${esc(it.why ?? '')}${it.at ? ` · ${esc(ago(it.at))}` : ''}</div></td>
      <td class="nowrap today-acts">${buttons(it)}</td>
    </tr>`;
  }

  function draw() {
    if (!dialog.open) return;
    if (!data) {
      body.innerHTML = '<p class="hint">Loading…</p>';
      return;
    }
    const items = data.items;
    const pressing = items.filter((i) => i.score <= PRESSING).length;
    const off = [!data.features?.jira && 'Jira', !data.features?.slack && !data.features?.gemini && 'Actions'].filter(Boolean);
    body.innerHTML = `
      <div class="issues-head">
        <h2>Today</h2>
        <span class="hint">${items.length ? `${pressing} pressing · ${items.length} in all` : ''}</span>
        <span class="spacer"></span>
        ${listenHtml('today', { title: 'Read the top of the list aloud', label: 'Listen' })}
        <button class="small" data-today="refresh" title="Look again (r)">↻</button>
        ${expandButton(dialog)}
        <button class="small" data-today="close" title="Close (Esc)">Close</button>
      </div>
      ${items.length
        ? `<div class="issues-scroll"><table class="issues today-table"><tbody>${items.map(row).join('')}</tbody></table></div>`
        : '<p class="hint issues-empty">Nothing needs you right now: no agent is waiting on you, nothing is due, and no review is waiting.</p>'}
      <p class="hint">Keys: j/k move (or click a row), Enter opens, a assign or review, d done, s skip, c discuss, r look again, f bigger.${off.length ? ` Not included (off in Settings → What you use): ${esc(off.join(', '))}.` : ''}${data.errors?.length ? ` Couldn't get: ${esc(data.errors.map((e) => `${e.source === 'jira' ? 'Jira' : e.source} (${e.error})`).join('; '))}.` : ''}</p>`;
    keys.redraw();
  }
  const render = holdWhilePicking(body, draw);
  expandable(dialog, draw);

  const itemOf = (id) => data?.items.find((i) => i.id === id) ?? null;

  /** Do `act` for the item; the list is looked at again after anything that changes it. */
  async function act(it, what) {
    if (!it) return;
    try {
      if (what === 'open' || (what === 'enter' && it.agentId && !['pr-ready', 'rule'].includes(it.kind))) {
        if (!it.agentId) return;
        dialog.close();
        return openAgent(it.agentId);
      }
      if (what === 'inbox' || (what === 'enter' && it.kind === 'rule')) {
        dialog.close();
        return showInbox();
      }
      if (what === 'open-reviews' || (what === 'enter' && it.kind.startsWith('pr-'))) {
        dialog.close();
        return openReviews();
      }
      if (what === 'enter') {
        if (it.kind === 'action') {
          dialog.close();
          return openActions();
        }
        if (it.kind === 'issue-new') {
          dialog.close();
          return openIssues();
        }
        if (it.url) window.open(it.url, '_blank', 'noopener');
        return;
      }
      if (it.kind === 'action' && ['done', 'skip'].includes(what)) {
        const r = await api('POST', '/actions/set', { ids: [it.actionId], state: what });
        toast?.(r.failed.length ? `Not changed: ${r.failed.map((x) => x.reason).join('; ')}` : what === 'done' ? 'Done' : 'Skipped', 2500);
      } else if (it.kind === 'action' && what === 'discuss') {
        const r = await api('POST', `/actions/${it.actionId}/discuss`, {});
        dialog.close();
        return openAgent(r.agent.id);
      } else if (it.kind === 'issue-new' && ['assign', 'skip'].includes(what)) {
        const r = await api('POST', '/issues/action', { keys: [it.issueKey], action: what });
        const bad = r.failed.map((x) => x.reason).join('; ');
        toast?.(bad ? `Not changed: ${bad}` : r.started.length ? `Started an agent on ${it.title}` : `${it.title}: skipped`, bad ? 6000 : 3000);
      } else if (it.kind === 'pr-requested' && (what === 'review' || what === 'assign')) {
        const a = await api('POST', '/reviews', { url: it.reviewUrl });
        toast?.(`Reviewer ${a.name ?? 'agent'} started`, 3000);
      } else return;
    } catch (err) {
      return toast?.(err.message, 6000);
    }
    load();
  }

  const keys = rowKeys(dialog, {
    rows: () => [...body.querySelectorAll('tbody tr[data-row-id]')],
    keys: {
      Enter: (r) => act(itemOf(r.dataset.rowId), 'enter'),
      a: (r) => act(itemOf(r.dataset.rowId), 'assign'),
      d: (r) => act(itemOf(r.dataset.rowId), 'done'),
      s: (r) => act(itemOf(r.dataset.rowId), 'skip'),
      c: (r) => act(itemOf(r.dataset.rowId), 'discuss'),
      r: Object.assign(() => load({ fresh: true }), { needsRow: false }),
    },
  });

  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-today]')?.dataset.today;
    if (!b) return;
    if (b === 'close') return dialog.close();
    if (b === 'refresh') return load({ fresh: true });
    act(itemOf(e.target.closest('tr[data-row-id]')?.dataset.rowId), b);
  });

  function open() {
    if (dialog.open) return dialog.close();
    dialog.showModal();
    render();
    load();
  }

  /** Something changed (an agent, an action): look again shortly while open, now and then for the count. */
  function changed() {
    if (!dialog.open && again) return;
    clearTimeout(again);
    const wait = dialog.open ? 1500 : Math.max(5000, 30_000 - (Date.now() - loadedAt));
    again = setTimeout(() => {
      again = null;
      load({ quiet: true });
    }, wait);
  }

  load({ quiet: true });
  return { open, changed, load, isOpen: () => dialog.open, speech: () => data?.speech ?? null };
}
