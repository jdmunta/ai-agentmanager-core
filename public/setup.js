// The home page, where an agent's details go while none is selected: Getting started until every
// step is done or it is hidden (steps open the dialog that does them), then what the app can do.

const STEPS = [
  ['agent', 'Start your first agent', 'Give it a request and a repo or folder; it works in its own branch.', '#new-btn', 'New agents'],
  ['alerts', 'Get Slack alerts', 'Hear when an agent needs you, is stuck or finished.', '#alerts-btn', 'Alerts'],
  ['assistant', 'Let work come to you', 'The assistant, or triggers (a GitHub label, a webhook), start agents for new work.', '#assistant-btn', 'Assistant'],
  ['remote', 'Use it from your phone', 'Answer agents from anywhere on your network.', '#remote-btn', 'Remote access'],
  ['budget', 'Set a budget', 'An alert at 80% of an agent budget, and a daily limit.', '#spend-btn', 'Results'],
];

// What the app can do, each with where to find it: a button to click, a sidebar tab, or a link.
const FEATURES = [
  ['Agents side by side', 'Each works on its own branch in its own folder; the list shows which need you.', { btn: '#new-btn', label: 'New agents' }],
  ['Teams and races', 'A team (analyst, critics, implementer, tester, reviewer) solves one problem; a race tries variants and you keep the best.', { btn: '#new-btn', label: 'New agents' }],
  ['Inbox', 'Every question, permission prompt, stuck agent and overlap between agents, in one place.', { tab: 'inbox', label: 'Inbox' }],
  ['Code', "Every agent has a Code tab: its files in the editor from VS Code, with search and a diff against where it started. Or open the folder in VS Code or Cursor."],
  ['Shells and browser', "+ Shell opens a terminal in an agent's folder; + Browser shows a page as this computer sees it (a dev server on localhost), from your phone too."],
  ['Terminal', 'A shell on this computer in your home folder, from any device you are signed in on.', { btn: '#machine-btn', label: 'Terminal' }],
  ['Review and land', "Review an agent's changes and send comments back; Land shows each pull request and what it needs to merge.", { tab: 'land', label: 'Land' }],
  ['Backlog and assistant', 'Queue work to start as agents finish; the assistant and triggers (a GitHub label, a webhook) bring in new work.', { tab: 'backlog', label: 'Backlog' }],
  ['Results', 'Merge rate, time to PR and cost per merged PR, with budgets and a daily limit.', { btn: '#spend-btn', label: 'Results' }],
  ['From your phone', 'Answer agents, review and use the terminals from anywhere on your network.', { btn: '#remote-btn', label: 'Remote access' }],
  ['Several machines', 'Link your computers to a hub to see every agent in one place, and move an agent to another machine to carry on there.', { href: 'https://github.com/jdmunta/ai-agentmanager-core/blob/main/docs/distributed.md', label: 'How it works' }],
];

export function initSetup({ api, esc, $ }) {
  const el = $('#placeholder');
  const plain = el.innerHTML;
  let data = null;
  const hidden = () => {
    try {
      return localStorage.getItem('agentmgr.setupHidden') === '1';
    } catch {
      return false;
    }
  };

  // A feature's button, unless what it opens isn't available here (local-only, on a phone).
  function action(f) {
    if (f.href) return `<a href="${f.href}" target="_blank" rel="noopener">${f.label} ↗</a>`;
    if (f.btn && document.body.classList.contains('remote') && document.querySelector(f.btn)?.classList.contains('local-only')) return '';
    if (f.btn) return `<button class="small ghost" data-setup-open="${f.btn}">${f.label}</button>`;
    if (f.tab) return `<button class="small ghost" data-setup-tab="${f.tab}">${f.label}</button>`;
    return '';
  }

  function steps() {
    if (!data || hidden()) return '';
    const done = STEPS.filter(([k]) => data.steps[k]).length;
    if (done === STEPS.length && !data.checks.length) return '';
    return `<div class="setup-head"><h3>Getting started</h3><span class="hint">${done} of ${STEPS.length} done</span><span class="spacer"></span><button class="link" data-setup-hide>Hide</button></div>
      ${data.checks.length ? `<div class="setup-checks">${data.checks.map((c) => `<div class="setup-check ${c.status}"><b>${esc(c.name)}</b>: ${esc(c.detail)}${c.fix ? `<div class="hint">${esc(c.fix)}</div>` : ''}</div>`).join('')}</div>` : ''}
      <ol class="setup-steps">${STEPS.map(([k, title, why, btn, label]) => `<li class="${data.steps[k] ? 'done' : ''}">
        <span class="setup-mark">${data.steps[k] ? '✓' : ''}</span>
        <div><b>${title}</b><div class="hint">${why}</div></div>
        ${data.steps[k] ? '' : `<button class="small" data-setup-open="${btn}">${label}</button>`}</li>`).join('')}</ol>`;
  }

  function render() {
    el.innerHTML = `<div class="setup">
      <p class="hint">${plain}</p>
      ${steps()}
      <h3 class="setup-features-head">What you can do</h3>
      <ul class="setup-features">${FEATURES.map(([title, why, f = {}]) => `<li><div><b>${title}</b><div class="hint">${why}</div></div>${action(f)}</li>`).join('')}</ul>
    </div>`;
  }

  el.addEventListener('click', (e) => {
    const open = e.target.closest('[data-setup-open]');
    if (open) return document.querySelector(open.dataset.setupOpen)?.click();
    const tab = e.target.closest('[data-setup-tab]');
    if (tab) return document.querySelector(`.side-tab[data-tab="${tab.dataset.setupTab}"]`)?.click();
    if (e.target.closest('[data-setup-hide]')) {
      try {
        localStorage.setItem('agentmgr.setupHidden', '1');
      } catch {}
      render();
    }
  });

  async function load() {
    try {
      data = await api('GET', '/setup');
    } catch {
      data = null;
    }
    render();
  }
  load();
  window.addEventListener('focus', () => !hidden() && load());
  return { load };
}
