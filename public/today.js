// Today: what needs you, from every list, most pressing first: agents stopped at a prompt or
// waiting for an answer, issues and pull requests ready for your review, what's asked of you
// (by due date), new Jira issues, and the rest. Each says why it's here, and the common
// decisions are a click (or a key) away. Listen reads the top of it aloud.

import { listenHtml } from './speak.js';
import { holdWhilePicking, rowKeys } from './rowkeys.js';
import { expandButton, expandable } from './expand.js';

// Up to this score an item is pressing: it counts on the button.
const PRESSING = 32;

export function initToday({ api, $, esc, ago, openAgent, showInbox, openActions, openIssues, openReviews, openBugs, openChanges, toast }) {
  const dialog = $('#today-dialog');
  const body = $('#today-body');
  let data = null;
  let loading = false;
  let again = null;
  let loadedAt = 0;
  let undo = null; // { label, run }: the last change made here, to take back (u)
  let asideOpen = false;
  let editing = null; // the question whose draft answer is being edited
  let replying = null; // the item a reply or send-back box is open on
  const drafts = new Map(); // typed text per item, kept across redraws

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

  const snoozeBtn = btn('snooze', 'Snooze', 'Until tomorrow 9am (z)');

  /** The buttons for an item: the decision it asks for, then where to look. */
  function buttons(it) {
    if (it.kind === 'ask') return [it.draft ? btn('copy', 'Copy answer', 'Copy the drafted answer, to paste in the thread', true) : btn('draft', 'Draft answer', 'A session reads the thread, finds the answer and drafts it for you', true), btn('done', 'Answered', 'You answered it: off the list (d)'), snoozeBtn, link(it.url, 'Thread')].join(' ');
    if (it.kind === 'action') return [btn('done', 'Done', 'Handled: off the list (d)'), btn('skip', 'Skip', 'Not now (s)'), snoozeBtn, btn('discuss', 'Discuss', 'Talk it through with Claude (c)'), link(it.url, 'Source')].join(' ');
    if (it.kind === 'issue-new') return [btn('assign', 'Assign', 'Start an agent on it (a)', true), btn('skip', 'Skip', 'Not now (s)'), snoozeBtn, link(it.url, 'Jira')].join(' ');
    if (it.ship) return [btn('changes', 'See changes', 'The diff, to look over first'), btn('ship', 'Open PR', 'Commit what is left, push and open the pull request', true), btn('send-back', 'Send back', 'Tell the agent what is still missing'), btn('open', 'Open', "Open the agent's session (Enter)"), link(it.url, 'Jira')].join(' ');
    if (it.kind === 'pr-requested') return [btn('review', 'Review it', 'A reviewer agent reads it and finds what blocks approval (a)', true), link(it.url, 'PR')].join(' ');
    if (it.kind === 'pr-ready') return [btn('open-reviews', 'Open review', 'Pick what to post (Enter)', true), link(it.url, 'PR')].join(' ');
    if (it.kind === 'rule') return btn('inbox', 'Inbox', 'Decide in the inbox (Enter)', true);
    if (it.kind === 'bench') return [btn('fix', 'Ask to fix', 'Ask the agent to make it as fast as before, or say why it can\'t be (a)', true), btn('done', "It's fine", 'The slowdown is expected: off the list (d)'), btn('open', 'Open', "Open the agent's session (Enter)")].join(' ');
    if (it.kind === 'bug-pr') return [link(it.url, 'Open PR'), btn('done', 'Done', 'You looked at it: off the list (d)'), btn('bugs', 'Details', 'The bug and how the fix was checked (Enter)')].join(' ');
    if (it.kind === 'bug') return [btn('fix', 'Fix', 'Start an agent on it, with the failing test (a)', true), btn('skip', 'Snooze', 'Until tomorrow 9am (s)'), btn('notbug', 'Not a bug', "It won't be reported again"), btn('bugs', 'Evidence', 'See it in Bugs (Enter)')].join(' ');
    return [it.agentId ? btn('open', 'Open', "Open the agent's session (Enter)", it.score < 20) : '', link(it.url, it.issueKey ? 'Jira' : 'Link')].join(' ');
  }

  /** Under an item: the agent's choices and a reply box, a drafted answer, or a send-back box. */
  function extra(it) {
    const box = (placeholder, send) => `<form class="today-reply" data-today-form="${esc(it.id)}"><input data-today-text="${esc(it.id)}" placeholder="${esc(placeholder)}" value="${esc(drafts.get(it.id) ?? '')}" autocomplete="off" /><button class="small primary">${esc(send)}</button></form>`;
    if (it.answer) {
      const a = it.answer;
      const choices = a.via === 'key' ? a.choices.map((c, i) => `<button class="small ${i === 0 ? 'primary' : ''}" data-today-pick="${i}" title="Press ${esc(c.key)}">${esc(c.key)}. ${esc(c.label)}</button>`) : a.choices.map((c, i) => `<button class="small" data-today-pick="${i}" title="Answer this (${i + 1})">${esc(c)}</button>`);
      return `<div class="today-answer">${choices.join(' ')}${a.default ? ` <span class="hint">Going ahead with “${esc(String(a.default).replace(/[.!\s]+$/, ''))}” until you answer.</span>` : ''}${a.reply ? box('Or type an answer…', 'Send') : ''}</div>`;
    }
    if (it.kind === 'ask') {
      if (editing === it.id) return `<form class="today-draft-edit" data-today-edit="${esc(it.id)}"><textarea rows="4" data-today-edit-text>${esc(it.draft?.text ?? '')}</textarea><div><button class="small primary">Save</button> <button type="button" class="small" data-today="cancel-edit">Cancel</button></div></form>`;
      if (it.draft) return `<div class="today-draft"><div class="today-draft-text">${esc(it.draft.text)}</div><div class="hint">${it.draft.by === 'you' ? 'Your edit' : 'Drafted by the assistant'}${it.draft.sources ? ` · from ${esc(it.draft.sources)}` : ''} · <button class="link" data-today="edit">Edit</button> · <button class="link" data-today="draft">Draft again</button></div></div>`;
      return '';
    }
    if (it.ship && replying === it.id) return box('What is still missing?', 'Send back');
    return '';
  }

  function row(it) {
    return `<tr data-row-id="${esc(it.id)}" class="today-${esc(it.kind)} ${it.score <= PRESSING ? 'pressing' : ''}">
      <td class="nowrap"><span class="today-label">${esc(it.label)}</span></td>
      <td><div class="today-title">${esc(it.title)}</div><div class="hint today-why">${esc(it.why ?? '')}${it.at ? ` · ${esc(ago(it.at))}` : ''}</div>${extra(it)}</td>
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
      ${asideHtml()}
      <p class="hint">Keys: j/k move (or click a row), Enter opens, 1–6 pick an answer, a assign or review, d done, s skip, z snooze, c discuss, u undo, r look again, f bigger.${off.length ? ` Not included (off in Settings → What you use): ${esc(off.join(', '))}.` : ''}${data.errors?.length ? ` Couldn't get: ${esc(data.errors.map((e) => `${e.source === 'jira' ? 'Jira' : e.source} (${e.error})`).join('; '))}.` : ''}</p>`;
    keys.redraw();
  }
  const render = holdWhilePicking(body, draw);

  /** What you skipped, marked done or removed: each can be brought back, or all of them. */
  function asideHtml() {
    const aside = data?.aside ?? [];
    if (!aside.length) return '';
    const rows = aside
      .map((a) => `<tr data-aside-id="${esc(a.id)}"><td class="nowrap"><span class="today-label">${esc(a.label)}</span></td><td><div class="today-title">${esc(a.title)}</div><div class="hint">${a.until ? `until ${esc(new Date(a.until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}` : a.at ? esc(ago(a.at)) : ''}</div></td><td class="nowrap today-acts"><button class="small" data-today-back="${esc(a.id)}" title="Back on the list, undecided">Bring back</button></td></tr>`)
      .join('');
    return `<details class="today-aside" ${asideOpen ? 'open' : ''}><summary>Set aside: skipped, done or removed (${aside.length})</summary>
      <div class="today-aside-head"><span class="hint">Brought back, an item is undecided again and shows in Today and its own list.</span><button class="small" data-today-back="all" title="Bring every one back">Bring all ${aside.length} back</button></div>
      <table class="issues today-table"><tbody>${rows}</tbody></table></details>`;
  }

  /** Back to undecided: issues to no action, actions to open. Returns how to set them aside again. */
  async function bringBack(list) {
    const issues = list.filter((a) => a.kind === 'issue');
    const acts = list.filter((a) => a.kind === 'action');
    if (issues.length) await api('POST', '/issues/action', { keys: issues.map((a) => a.issueKey), action: null });
    if (acts.length) await api('POST', '/actions/set', { ids: acts.map((a) => a.actionId), state: 'open' });
    return async () => {
      for (const state of new Set(list.map((a) => a.state))) {
        const same = list.filter((a) => a.state === state);
        const keys = same.filter((a) => a.kind === 'issue').map((a) => a.issueKey);
        const ids = same.filter((a) => a.kind === 'action').map((a) => a.actionId);
        // A snooze goes back to its own time, or tomorrow when that has passed.
        const until = state === 'snooze' ? (same.map((a) => a.until).find((u) => Date.parse(u) > Date.now()) ?? tomorrow9()) : undefined;
        if (keys.length) await api('POST', '/issues/action', { keys, action: state, until });
        if (ids.length) await api('POST', '/actions/set', { ids, state, until });
      }
    };
  }

  /** Tomorrow at 9 in the morning. */
  function tomorrow9() {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(9, 0, 0, 0);
    return t.toISOString();
  }

  /** Answer an agent's question: a choice (by its index) or typed text. */
  async function answer(it, { pick = null, text = null }) {
    const a = it.answer;
    if (a.via === 'key') {
      const c = a.choices[pick];
      if (!c) return;
      await api('POST', `/agents/${it.agentId}/prompt-key`, { key: c.key });
      return `Pressed ${c.key}. ${c.label}`;
    }
    const t = text ?? a.choices[pick];
    if (!t) return;
    if (a.via === 'waiting') await api('POST', `/agents/${it.agentId}/waiting/answer`, { text: t });
    else await api('POST', `/agents/${it.agentId}/answer`, { question: a.qid, text: t });
    return `Answered: ${t.length > 60 ? `${t.slice(0, 59)}…` : t}`;
  }

  /** Remember how to take back a change, and offer it on the toast. */
  function changedWith(msg, label, run) {
    undo = { label, run };
    toast?.(msg, 6000, { label: 'Undo', run: takeBack });
  }

  async function takeBack() {
    if (!undo) return toast?.('Nothing to undo', 2000);
    const u = undo;
    undo = null;
    try {
      await u.run();
      toast?.(`Undone: ${u.label}`, 2500);
    } catch (e) {
      toast?.(e.message, 6000);
    }
    load();
  }
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
      if (what === 'bugs' || (what === 'enter' && (it.kind === 'bug' || it.kind === 'bug-pr'))) {
        dialog.close();
        return openBugs?.(it.kind === 'bug-pr' ? 'pr' : undefined);
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
      if (what === 'snooze' && ['action', 'ask', 'issue-new'].includes(it.kind)) {
        const until = tomorrow9();
        if (it.kind === 'issue-new') await api('POST', '/issues/action', { keys: [it.issueKey], action: 'snooze', until });
        else await api('POST', '/actions/set', { ids: [it.actionId], state: 'snooze', until });
        changedWith('Snoozed until tomorrow 9am', 'snoozed', () => (it.kind === 'issue-new' ? api('POST', '/issues/action', { keys: [it.issueKey], action: null }) : api('POST', '/actions/set', { ids: [it.actionId], state: 'open' })));
      } else if (it.kind === 'ask' && what === 'copy' && it.draft) {
        const ok = await navigator.clipboard?.writeText(it.draft.text).then(() => true, () => false);
        return toast?.(ok ? `Copied${it.url ? ': paste it in the thread' : ''}` : "Couldn't copy: select the text instead", 3000, it.url ? { label: 'Open thread', run: () => window.open(it.url, '_blank', 'noopener') } : undefined);
      } else if (it.kind === 'ask' && what === 'draft') {
        const r = await api('POST', `/actions/${it.actionId}/draft`, {});
        toast?.(r.existing ? 'A session is drafting it already' : 'Drafting: a session reads the thread and finds the answer', 5000, { label: 'Watch', run: () => (dialog.close(), openAgent(r.agent.id)) });
      } else if (it.kind === 'ask' && what === 'edit') {
        editing = it.id;
        return render();
      } else if (what === 'cancel-edit') {
        editing = null;
        return render();
      } else if (it.kind === 'ask' && what === 'done') {
        await api('POST', '/actions/set', { ids: [it.actionId], state: 'done' });
        changedWith('Answered: off the list', 'answered', () => api('POST', '/actions/set', { ids: [it.actionId], state: 'open' }));
      } else if (it.ship && what === 'changes') {
        dialog.close();
        return openChanges?.(it.agentId);
      } else if (it.ship && what === 'ship') {
        toast?.('Opening its pull request…', 3000);
        const r = await api('POST', `/agents/${it.agentId}/ship`, {});
        toast?.(r.url ? 'Pull request opened' : 'Pushed', 6000, r.url ? { label: 'Open it', run: () => window.open(r.url, '_blank', 'noopener') } : undefined);
      } else if (it.ship && what === 'send-back') {
        replying = replying === it.id ? null : it.id;
        render();
        return body.querySelector(`[data-today-text="${CSS.escape(it.id)}"]`)?.focus();
      } else if (it.kind === 'action' && ['done', 'skip'].includes(what)) {
        const r = await api('POST', '/actions/set', { ids: [it.actionId], state: what });
        if (r.failed.length) toast?.(`Not changed: ${r.failed.map((x) => x.reason).join('; ')}`, 6000);
        else changedWith(what === 'done' ? 'Done' : 'Skipped', `${what === 'done' ? 'done' : 'skipped'} "${it.title}"`, () => api('POST', '/actions/set', { ids: [it.actionId], state: 'open' }));
      } else if (it.kind === 'action' && what === 'discuss') {
        const r = await api('POST', `/actions/${it.actionId}/discuss`, {});
        dialog.close();
        return openAgent(r.agent.id);
      } else if (it.kind === 'issue-new' && ['assign', 'skip'].includes(what)) {
        const r = await api('POST', '/issues/action', { keys: [it.issueKey], action: what });
        const bad = r.failed.map((x) => x.reason).join('; ');
        if (bad || r.started.length) toast?.(bad ? `Not changed: ${bad}` : `Started an agent on ${it.title}`, bad ? 6000 : 3000);
        else changedWith(`${it.title}: skipped`, `skipped ${it.issueKey}`, () => api('POST', '/issues/action', { keys: [it.issueKey], action: null }));
      } else if (it.kind === 'bug' && (what === 'fix' || what === 'assign')) {
        const r = await api('POST', `/findings/${it.findingId}/fix`, {});
        toast?.(r.existing ? `${r.agent.name} is on it already` : `Agent ${r.agent.name} started on it`, 4000);
      } else if (it.kind === 'bug' && ['skip', 'notbug'].includes(what)) {
        const t = new Date();
        t.setDate(t.getDate() + 1);
        t.setHours(9, 0, 0, 0);
        await api('POST', '/findings/set', { ids: [it.findingId], status: what === 'skip' ? 'snoozed' : 'notbug', until: what === 'skip' ? t.toISOString() : null });
        changedWith(what === 'skip' ? 'Snoozed until tomorrow 9am' : "Not a bug: it won't be reported again", what === 'skip' ? 'snoozed' : 'not a bug', () => api('POST', '/findings/set', { ids: [it.findingId], status: 'open' }));
      } else if (it.kind === 'bench' && (what === 'fix' || what === 'assign')) {
        await api('POST', `/benchruns/${it.runId}/fix`, {});
        toast?.('Asked the agent to fix it, or say why it can\'t be', 4000);
        return;
      } else if (it.kind === 'bench' && what === 'done') {
        await api('POST', `/benchruns/${it.runId}/accept`, { accepted: true });
        changedWith("It's fine: off the list", 'accepted', () => api('POST', `/benchruns/${it.runId}/accept`, { accepted: false }));
      } else if (it.kind === 'bug-pr' && what === 'done') {
        await api('POST', '/findings/set', { ids: [it.findingId], status: 'done' });
        changedWith('Done: off the list', 'done', () => api('POST', '/findings/set', { ids: [it.findingId], status: 'pr' }));
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
      u: Object.assign(() => takeBack(), { needsRow: false }),
      z: (r) => act(itemOf(r.dataset.rowId), 'snooze'),
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [String(n), (r) => pickAt(itemOf(r.dataset.rowId), n - 1)])),
    },
  });

  /** A choice by its place: keys 1–6 on the selected row. */
  async function pickAt(it, i) {
    if (!it?.answer) return;
    try {
      const done = await answer(it, { pick: it.answer.via === 'key' ? i : i });
      if (done) toast?.(done, 3000);
    } catch (e) {
      toast?.(e.message, 6000);
    }
    load();
  }

  body.addEventListener('input', (e) => {
    const id = e.target.dataset?.todayText;
    if (id) drafts.set(id, e.target.value);
  });
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Done typing: the list may be drawn again.
    document.activeElement?.blur?.();
    const f = e.target.closest('[data-today-form]');
    const ed = e.target.closest('[data-today-edit]');
    try {
      if (ed) {
        const it = itemOf(ed.dataset.todayEdit);
        await api('PUT', `/actions/${it.actionId}/answer`, { text: ed.querySelector('[data-today-edit-text]').value });
        editing = null;
        toast?.('Draft saved', 2000);
      } else if (f) {
        const it = itemOf(f.dataset.todayForm);
        const text = f.querySelector('input').value.trim();
        if (!it || !text) return;
        if (it.answer) toast?.(await answer(it, { text }), 3000);
        else if (it.ship) {
          await api('POST', `/agents/${it.agentId}/tell`, { text });
          replying = null;
          toast?.('Sent back to the agent', 3000);
        }
        drafts.delete(it.id);
      }
    } catch (err) {
      return toast?.(err.message, 6000);
    }
    load();
  });
  body.addEventListener('toggle', (e) => {
    if (e.target.matches?.('.today-aside')) asideOpen = e.target.open;
  }, true);
  body.addEventListener('click', async (e) => {
    const back = e.target.closest('[data-today-back]')?.dataset.todayBack;
    if (back) {
      const list = back === 'all' ? data?.aside ?? [] : (data?.aside ?? []).filter((a) => a.id === back);
      if (!list.length) return;
      try {
        const again = await bringBack(list);
        changedWith(list.length === 1 ? `Back on the list: ${list[0].title}` : `${list.length} back on the list`, list.length === 1 ? 'brought back' : `brought ${list.length} back`, again);
      } catch (err) {
        toast?.(err.message, 6000);
      }
      return load();
    }
    const pick = e.target.closest('[data-today-pick]');
    if (pick) return pickAt(itemOf(e.target.closest('tr[data-row-id]')?.dataset.rowId), Number(pick.dataset.todayPick));
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
