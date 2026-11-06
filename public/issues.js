// Jira: every issue an agent works on in one table, the ones waiting for your review first: the
// issue and its Jira status, where the work stands, its pull request and a link to the agent.

const SAVED = 'agentmgr.issuesFilter';
const FILTERS = [
  ['you', 'Waiting for you'],
  ['agent', 'Agents on it'],
  ['done', 'Done'],
  ['all', 'All'],
];
const CHECKS = { passed: ['✓', 'Checks pass'], failed: ['✗', 'Checks failing'], running: ['●', 'Checks running'] };

export function initIssues({ api, $, esc, ago, openAgent, toast }) {
  const dialog = $('#issues-dialog');
  const body = $('#issues-body');
  let data = null;
  let loading = false;
  let again = null;
  let filter = 'you';
  try {
    filter = localStorage.getItem(SAVED) || 'you';
  } catch {}

  let loadedAt = 0;

  async function load({ quiet = false } = {}) {
    if (loading) return;
    loading = true;
    try {
      data = await api('GET', '/issues');
      loadedAt = Date.now();
    } catch (e) {
      if (!quiet) toast?.(e.message, 5000);
    } finally {
      loading = false;
    }
    badge();
    render();
  }

  /** The button's count: issues waiting for your review. */
  function badge() {
    const n = data ? data.rows.filter((r) => r.group === 'you').length : 0;
    const el = $('#issues-count');
    if (el) {
      el.textContent = n ? String(n) : '';
      el.title = n ? `${n} waiting for your review` : '';
    }
  }

  function row(r) {
    const issue = r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener" class="issue-key">${esc(r.key)}</a>` : `<span class="issue-key">${esc(r.key)}</span>`;
    const status = r.jira?.status ? `<span class="jira-status ${esc(r.jira.category ?? '')}">${esc(r.jira.status)}</span>` : '<span class="hint">—</span>';
    const check = r.pr?.checks && CHECKS[r.pr.checks] ? ` <span class="checks ${esc(r.pr.checks)}" title="${CHECKS[r.pr.checks][1]}">${CHECKS[r.pr.checks][0]}</span>` : '';
    const pr = r.pr?.url
      ? `<a href="${esc(r.pr.url)}" target="_blank" rel="noopener" title="${esc(r.pr.title ?? '')}">#${esc(r.pr.number ?? '?')}</a>${check}${r.aiReview ? `<div class="hint" title="AI review">AI: ${esc(r.aiReview)}</div>` : ''}`
      : '<span class="hint">—</span>';
    const dot = r.agent.busy ? '<span class="dot busy" title="Working"></span>' : r.agent.running ? '<span class="dot idle" title="Session open"></span>' : '';
    const agent = `<button class="link" data-issue-open="${esc(r.agent.id)}" title="Open the agent's session">${dot}${esc(r.agent.name)}</button>${r.agent.project ? `<div class="hint">${esc(r.agent.project)}${r.agent.from ? ` · by ${esc(r.agent.from)}` : ''}</div>` : ''}`;
    return `<tr class="stage-${esc(r.stage)}">
        <td>${issue}${r.title ? `<div class="issue-title">${esc(r.title)}</div>` : ''}</td>
        <td>${status}</td>
        <td class="issue-note">${esc(r.note)}</td>
        <td>${pr}</td>
        <td>${agent}</td>
        <td class="hint">${esc(ago(r.updatedAt))}</td>
      </tr>`;
  }

  function render() {
    if (!dialog.open) return;
    if (!data) {
      body.innerHTML = '<p class="hint">Loading…</p>';
      return;
    }
    const count = (g) => (g === 'all' ? data.rows.length : data.rows.filter((r) => r.group === g).length);
    const rows = filter === 'all' ? data.rows : data.rows.filter((r) => r.group === filter);
    const empty = !data.rows.length
      ? 'No agent works on a Jira or Linear issue yet. Start one with the issue link first ("https://…/browse/OPS-7 fix the timeout"), or let the assistant start them for issues assigned to you.'
      : filter === 'you'
        ? 'Nothing is waiting for your review.'
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
      ${rows.length
        ? `<div class="issues-scroll"><table class="issues">
            <thead><tr><th>Issue</th><th>Jira status</th><th>Where it stands</th><th>Pull request</th><th>Agent</th><th>Active</th></tr></thead>
            <tbody>${rows.map(row).join('')}</tbody>
          </table></div>`
        : `<p class="hint issues-empty">${esc(empty)}</p>`}
      ${data.jira.signedIn || !data.rows.length ? '' : '<p class="hint">Jira status shows for public issues only until you add your Jira site, email and API token in Settings → Jira.</p>'}`;
  }

  body.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-issue-open]');
    if (o) {
      dialog.close();
      return openAgent(o.dataset.issueOpen);
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
    if (b === 'refresh') return load();
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
  return { open, changed, isOpen: () => dialog.open };
}
