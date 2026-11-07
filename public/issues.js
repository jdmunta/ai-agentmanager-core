// Jira: every issue an agent works on in one table, the ones waiting for your review first: the
// issue and its Jira status, where the work stands, its plan, design doc and pull request, and a
// link to the agent. Issues proposed for agents (when you pick) come first, with a box to tick:
// agents start only for the ticked ones. Each issue has your action on its left (assign, skip, done,
// remove), kept by the daemon across restarts and updates, and changeable any time.

import { listenHtml } from './speak.js';

const SAVED = 'agentmgr.issuesFilter';
const FILTERS = [
  ['new', 'Not started'],
  ['you', 'Waiting for you'],
  ['agent', 'Agents on it'],
  ['done', 'Done'],
  ['skipped', 'Skipped'],
  ['all', 'All'],
  ['removed', 'Removed'],
];
const ACTIONS = [
  ['assign', 'Assign', 'An agent works on it (assigning one not started yet starts its agent)'],
  ['skip', 'Skip', 'Not now: under Skipped, and not proposed or started again'],
  ['done', 'Done', 'Handled (by you or elsewhere): under Done'],
  ['remove', 'Remove', 'Off the list (under Removed, to bring back)'],
];
const CHECKS = { passed: ['✓', 'Checks pass'], failed: ['✗', 'Checks failing'], running: ['●', 'Checks running'] };

export function initIssues({ api, $, esc, ago, openAgent, openDoc, toast }) {
  const dialog = $('#issues-dialog');
  const ext = (label, url, title = '') => `<a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(label)} ↗</a>`;
  const body = $('#issues-body');
  let data = null;
  let loading = false;
  let again = null;
  let filter = 'you';
  // Proposed issues ticked to start, by key.
  const ticked = new Set();
  let starting = false;
  try {
    filter = localStorage.getItem(SAVED) || 'you';
  } catch {}

  let loadedAt = 0;

  async function load({ quiet = false, fresh = false } = {}) {
    if (loading) return;
    loading = true;
    try {
      data = await api('GET', `/issues${fresh ? '?fresh=1' : ''}`);
      loadedAt = Date.now();
    } catch (e) {
      if (!quiet) toast?.(e.message, 5000);
    } finally {
      loading = false;
    }
    badge();
    render();
  }

  /** The button's count: issues to start or waiting for your review. */
  function badge() {
    const fresh = data ? data.rows.filter((r) => r.group === 'new').length : 0;
    const n = (data ? data.rows.filter((r) => r.group === 'you').length : 0) + fresh;
    const el = $('#issues-count');
    if (el) {
      el.textContent = n ? String(n) : '';
      el.title = [fresh && `${fresh} not started`, n - fresh && `${n - fresh} waiting for your review`].filter(Boolean).join(', ');
    }
  }

  /** Your action on the issue, left of it: kept across restarts; change it any time. */
  function actionCell(r) {
    const none = r.agent ? '' : `<option value="" ${r.action ? '' : 'selected'}>—</option>`;
    const opts = ACTIONS.map(([v, label, title]) => `<option value="${v}" title="${esc(title)}" ${r.action === v ? 'selected' : ''}>${label}</option>`).join('');
    return `<td class="issue-action"><select data-issue-action="${esc(r.key)}" class="act-${esc(r.action ?? 'none')}" aria-label="Your action on ${esc(r.key)}" title="Your action: kept across restarts and updates">${none}${opts}</select></td>`;
  }

  function aboutIssue(r) {
    return `${r.title ? `<div class="issue-title">${esc(r.title)}</div>` : ''}${r.synopsis ? `<div class="issue-synopsis" title="${esc(r.synopsis)}">${esc(r.synopsis)}</div>` : ''}`;
  }

  function row(r, boxes) {
    const box = !boxes ? '' : r.group === 'new' ? `<td class="pick"><input type="checkbox" data-issue-pick="${esc(r.key)}" ${ticked.has(r.key) ? 'checked' : ''} aria-label="Start an agent for ${esc(r.key)}" /></td>` : '<td></td>';
    const type = r.type && !/^(story|task|bug|sub-?task)$/i.test(r.type) ? ` <span class="issue-type" title="Jira issue type">${esc(r.type)}</span>` : '';
    const issue = (r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener" class="issue-key">${esc(r.key)}</a>` : `<span class="issue-key">${esc(r.key)}</span>`) + type;
    const status = r.jira?.status ? `<span class="jira-status ${esc(r.jira.category ?? '')}">${esc(r.jira.status)}</span>` : '<span class="hint">—</span>';
    const check = r.pr?.checks && CHECKS[r.pr.checks] ? ` <span class="checks ${esc(r.pr.checks)}" title="${CHECKS[r.pr.checks][1]}">${CHECKS[r.pr.checks][0]}</span>` : '';
    const pr = r.pr?.url
      ? `<a href="${esc(r.pr.url)}" target="_blank" rel="noopener" title="${esc(r.pr.title ?? '')}">#${esc(r.pr.number ?? '?')}</a>${check}${r.aiReview ? `<div class="hint" title="AI review">AI: ${esc(r.aiReview)}</div>` : ''}<div>${listenHtml(`prvoice:${r.agent.id}`, { title: 'Explain the review aloud: the PR, its checks, the AI review, the riskiest changes and what is left', label: 'Explain' })}</div>`
      : '<span class="hint">—</span>';
    if (!r.agent) {
      const by = !r.proposal ? 'assigned to you' : r.proposal.by === 'assistant' ? 'proposed by the assistant' : r.proposal.by === 'jira' ? 'assigned to you' : 'proposed';
      return `<tr class="stage-proposed ${ticked.has(r.key) ? 'ticked' : ''} ${r.action ? `action-${esc(r.action)}` : ''}">${box}${actionCell(r)}
        <td>${issue}${aboutIssue(r)}</td>
        <td>${status}</td>
        <td class="issue-note">${esc(r.note)}</td>
        <td class="hint">—</td>
        <td class="hint">—</td>
        <td class="hint">—</td>
        <td><span class="hint">${esc(by)}</span>${r.proposal?.project ? `<div class="hint">@${esc(r.proposal.project)}</div>` : ''}</td>
        <td class="hint col-active">${esc(ago(r.updatedAt))}</td>
      </tr>`;
    }
    const dot = r.agent.busy ? '<span class="dot busy" title="Working"></span>' : r.agent.running ? '<span class="dot idle" title="Session open"></span>' : '';
    const agent = `<button class="link" data-issue-open="${esc(r.agent.id)}" title="Open the agent's session">${dot}${esc(r.agent.name)}</button>${r.agent.project ? `<div class="hint">${esc(r.agent.project)}${r.agent.from ? ` · by ${esc(r.agent.from)}` : ''}</div>` : ''}`;
    const read = (kind, label, title) => `<button class="link" data-issue-doc="${esc(kind)}" data-agent="${esc(r.agent.id)}" title="${esc(title)}">${label}</button>`;
    const REVIEW = { writing: 'being written', review: 'waiting for your approval', approved: 'approved', changes: 'changes asked' };
    const p = r.plan;
    const plan = p
      ? `${p.written ? read('plan', 'Read', 'Read the plan here') : '<span class="hint">not yet</span>'}${p.total ? ` <span class="steps" title="Steps done">${p.done}/${p.total}</span>` : ''}${p.review ? `<div class="hint plan-${esc(p.review)}">${esc(REVIEW[p.review] ?? p.review)}</div>` : ''}`
      : '<span class="hint">—</span>';
    const d = r.design;
    const design = d
      ? [d.written ? read('designdoc', 'Read', 'Read the design doc here') : '<span class="hint">not yet</span>', d.page && ext('Page', d.page, 'The design page the agent published'), d.google && ext('Doc', d.google, 'Google Doc')].filter(Boolean).join(' · ')
      : '<span class="hint">—</span>';
    return `<tr class="stage-${esc(r.stage)} action-${esc(r.action)}">${box}${actionCell(r)}
        <td>${issue}${aboutIssue(r)}</td>
        <td>${status}</td>
        <td class="issue-note">${esc(r.note)}</td>
        <td class="nowrap">${plan}</td>
        <td class="nowrap">${design}</td>
        <td>${pr}</td>
        <td>${agent}</td>
        <td class="hint col-active">${esc(ago(r.updatedAt))}</td>
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
    // Ticks only for issues still on the list.
    const fresh = new Set(data.rows.filter((r) => r.group === 'new').map((r) => r.key));
    for (const k of ticked) if (!fresh.has(k)) ticked.delete(k);
    const shownNew = rows.filter((r) => r.group === 'new');
    const boxes = shownNew.length > 0;
    const allTicked = boxes && shownNew.every((r) => ticked.has(r.key));
    const n = ticked.size;
    const empty = !data.rows.length
      ? 'No agent works on a Jira or Linear issue yet. Start one with the issue link first ("https://…/browse/OPS-7 fix the timeout"), or let the assistant start them for issues assigned to you.'
      : filter === 'you'
        ? 'Nothing is waiting for your review.'
        : filter === 'new'
          ? 'No issues waiting to be started. Open Jira issues assigned to you show here once your Jira site, email and API token are in Settings → Jira. With "Let me pick" on in Assistant, new Jira and Linear issues assigned to you come here instead of getting agents right away (or: agentmgr issues propose).'
          : filter === 'skipped'
            ? 'Nothing skipped. Issues you set to Skip wait here, and the assistant leaves them alone.'
            : filter === 'removed'
              ? 'Nothing removed. Set an issue back to another action here to bring it back.'
              : 'None here.';
    body.innerHTML = `
      <div class="issues-head">
        <h2>Jira</h2>
        <div class="chips" role="tablist">${FILTERS.map(([k, label]) => `<button class="chip ${k === filter ? 'active' : ''}" role="tab" aria-selected="${k === filter}" data-issues-filter="${k}">${label} <span class="count">${count(k)}</span></button>`).join('')}</div>
        <span class="spacer"></span>
        <button class="small" data-issues="copy" title="Copy this list as a Markdown table, to paste into Slack, Jira or a doc" ${rows.length ? '' : 'disabled'}>Copy</button>
        <button class="small" data-issues="refresh" title="Look again now">↻</button>
        <button class="small" data-issues="close" title="Close (Esc)">Close</button>
      </div>
      ${boxes
        ? `<div class="issues-pickbar">
            <button class="primary small" data-issues="start" ${n && !starting ? '' : 'disabled'} title="Start an agent for each ticked issue">${starting ? 'Starting…' : `Start ${n || ''} agent${n === 1 ? '' : 's'}`.replace('  ', ' ')}</button>
            <button class="small" data-issues="skip" ${n && !starting ? '' : 'disabled'} title="Not now: under Skipped, and not proposed again">Skip</button>
            <button class="small" data-issues="dismiss" ${n && !starting ? '' : 'disabled'} title="Take the ticked issues off the list (under Removed, to bring back); they won't be proposed again">Remove</button>
            <span class="hint">Tick the issues to start agents for; the rest stay here.</span>
          </div>`
        : ''}
      ${rows.length
        ? `<div class="issues-scroll"><table class="issues">
            <thead><tr>${boxes ? `<th class="pick"><input type="checkbox" data-issue-pick-all ${allTicked ? 'checked' : ''} aria-label="Tick all" title="Tick all" /></th>` : ''}<th class="issue-action" title="Your action, kept across restarts and updates">Action</th><th>Issue</th><th>Jira status</th><th>Where it stands</th><th>Plan</th><th>Design</th><th>Pull request</th><th>Agent</th><th class="col-active">Active</th></tr></thead>
            <tbody>${rows.map((r) => row(r, boxes)).join('')}</tbody>
          </table></div>`
        : `<p class="hint issues-empty">${esc(empty)}</p>`}
      ${data.jira.signedIn || !data.rows.length ? '' : '<p class="hint">Jira status shows for public issues only, and the issues assigned to you aren\'t listed, until you add your Jira site, email and API token in Settings → Jira.</p>'}`;
  }

  /** Set your action on issues; assign starts the agents of ones not started yet. */
  async function setAction(keys, action) {
    try {
      const r = await api('POST', '/issues/action', { keys, action: action || null });
      for (const k of r.set) ticked.delete(k);
      const bad = r.failed.map((x) => `${x.key}: ${x.reason}`).join('; ');
      const label = ACTIONS.find(([v]) => v === action)?.[1] ?? 'Cleared';
      const what = r.started.length ? `Started ${r.started.map((x) => `${x.key} (${x.agent.name})`).join(', ')}` : r.set.length ? `${r.set.join(', ')}: ${label}` : 'Nothing changed';
      toast?.(`${what}${bad ? `. Not changed: ${bad}` : ''}`, bad ? 8000 : 3000);
    } catch (err) {
      toast?.(err.message, 6000);
    }
    load();
  }

  body.addEventListener('change', (e) => {
    const act = e.target.dataset.issueAction;
    if (act) return setAction([act], e.target.value);
    const one = e.target.dataset.issuePick;
    if (one) {
      if (e.target.checked) ticked.add(one);
      else ticked.delete(one);
      return render();
    }
    if (e.target.dataset.issuePickAll !== undefined) {
      const shown = data.rows.filter((r) => r.group === 'new' && (filter === 'all' || filter === 'new'));
      for (const r of shown) e.target.checked ? ticked.add(r.key) : ticked.delete(r.key);
      render();
    }
  });

  async function startTicked() {
    const keys = [...ticked];
    starting = true;
    render();
    try {
      // Assign: starts agents for proposals and for issues assigned to you in Jira alike.
      const r = await api('POST', '/issues/action', { keys, action: 'assign' });
      for (const x of r.started) ticked.delete(x.key);
      const bad = r.failed.map((x) => `${x.key}: ${x.reason}`).join('; ');
      toast?.(`${r.started.length ? `Started ${r.started.length} agent${r.started.length === 1 ? '' : 's'}: ${r.started.map((x) => x.key).join(', ')}` : 'No agents started'}${bad ? `. Not started: ${bad}` : ''}`, bad ? 8000 : 4000);
    } catch (err) {
      toast?.(err.message, 6000);
    } finally {
      starting = false;
    }
    load();
  }

  body.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-issue-open]');
    if (o) {
      dialog.close();
      return openAgent(o.dataset.issueOpen);
    }
    const doc = e.target.closest('[data-issue-doc]');
    if (doc) {
      dialog.close();
      return openDoc(doc.dataset.agent, doc.dataset.issueDoc);
    }
    const f = e.target.closest('[data-issues-filter]');
    if (f) {
      filter = f.dataset.issuesFilter;
      try {
        localStorage.setItem(SAVED, filter);
      } catch {}
      return render();
    }
    const b = e.target.closest('[data-issues]')?.dataset.issues;
    if (b === 'close') return dialog.close();
    if (b === 'refresh') return load({ fresh: true });
    if (b === 'start') return startTicked();
    if (b === 'dismiss') return setAction([...ticked], 'remove');
    if (b === 'skip') return setAction([...ticked], 'skip');
    if (b === 'copy') {
      try {
        const { markdown } = await api('GET', `/issues?group=${encodeURIComponent(filter)}&format=markdown`);
        await navigator.clipboard.writeText(markdown);
        toast?.('Copied as a Markdown table');
      } catch (err) {
        toast?.(`Couldn't copy: ${err.message}`, 5000);
      }
    }
  });

  function open() {
    if (dialog.open) return dialog.close();
    dialog.showModal();
    render();
    load();
  }

  /** An agent changed: look again shortly while open, and now and then for the count. */
  function changed() {
    // Closed: one look at most every half minute, however busy the agents are.
    if (!dialog.open && again) return;
    clearTimeout(again);
    const wait = dialog.open ? 1500 : Math.max(5000, 30_000 - (Date.now() - loadedAt));
    again = setTimeout(() => {
      again = null;
      load({ quiet: true });
    }, wait);
  }

  load({ quiet: true });
  /** What the table knows about an agent's issue: its key and design doc summary. */
  const about = (agentId) => {
    const r = data?.rows.find((x) => x.agent?.id === agentId);
    return r ? { issueKey: r.key, designSummary: r.design?.summary ?? null } : {};
  };

  return { open, changed, about, isOpen: () => dialog.open };
}
