// Standards, inside the Quality view: what every change in a repository has to meet. Lessons from
// what went wrong (proposed from the merged pull requests that had a problem, yours to word and
// accept), the paths that are high risk, and the checks the app runs itself before a change is scored.

const SAVED = 'agentmgr.standardsRepo';

export function initStandards({ api, esc, toast, rerender }) {
  let data = null;
  let repoKey = null;
  let busy = null; // a lesson being worded by a model
  try {
    repoKey = localStorage.getItem(SAVED);
  } catch {}

  async function load() {
    try {
      data = await api('GET', '/standards');
      // The one being looked at stays, whatever the order becomes (the ones with proposals come first).
      if (!data.repos.some((r) => r.key === repoKey)) repoKey = data.repos[0]?.key ?? null;
    } catch (e) {
      toast?.(e.message, 5000);
    }
    rerender();
  }

  const repo = () => data?.repos.find((r) => r.key === repoKey) ?? data?.repos[0] ?? null;
  const proposed = () => (data?.repos ?? []).reduce((n, r) => n + r.proposed.length, 0);

  const source = (s) =>
    s ? `<div class="hint">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">#${esc(s.number ?? '?')} ${esc(s.title ?? '')}</a>` : esc(s.title ?? '')}${s.detail ? ` · ${esc(s.detail)}` : ''}</div>` : '';

  function lessonsHtml(r) {
    const prop = r.proposed
      .map(
        (l) => `<li class="std-proposed" data-std-lesson="${esc(l.id)}">
          ${source(l.source)}
          <div class="std-line">
            <input type="text" maxlength="300" value="${esc(l.text)}" placeholder="What should agents do differently here? One line." aria-label="The lesson" />
            <button type="button" class="small" data-std="draft" ${busy === l.id ? 'disabled' : ''} title="Have a model word it from the pull request and what followed; yours to change">${busy === l.id ? 'Wording…' : 'Suggest wording'}</button>
            <button type="button" class="small primary" data-std="accept" title="Every later agent in this repository is given it, and the scorecard checks it">Accept</button>
            <button type="button" class="small ghost" data-std="dismiss" title="Nothing to learn from this one">Dismiss</button>
          </div></li>`,
      )
      .join('');
    const acc = r.lessons
      .map((l) => `<li data-std-lesson="${esc(l.id)}"><div class="std-line"><span class="std-text">${esc(l.text)}</span><button type="button" class="link" data-std="remove" title="Agents are no longer given it">Remove</button></div>${source(l.source)}</li>`)
      .join('');
    return `<section class="std-section">
      <h3>Lessons <span class="hint">${r.lessons.length} of ${data.limits.lessons}</span></h3>
      <p class="hint">One line each. Every later agent in this repository is told to follow them, and the review scorecard checks each one against the changes: a lesson not followed means "Not ready".</p>
      ${prop ? `<h4>Proposed, from pull requests that had a problem</h4><ul class="std-list">${prop}</ul>` : ''}
      ${acc ? `<ul class="std-list">${acc}</ul>` : prop ? '' : '<p class="hint">No lessons yet. One is proposed here whenever a merged pull request is reverted, fixed afterwards, fails its checks or had changes requested.</p>'}
      <form data-std-form="lesson" class="std-line"><input type="text" name="text" maxlength="300" required placeholder="Add a lesson: e.g. Every new endpoint checks the caller's permissions in a test" aria-label="A new lesson" /><button class="small">Add lesson</button></form>
    </section>`;
  }

  function riskHtml(r) {
    return `<section class="std-section">
      <h3>High-risk paths <span class="hint">${r.risk.length}</span></h3>
      <p class="hint">A change that touches one is never opened or merged by autopilot or on its Eval without you, is reviewed by another model, and cannot be scored "Ready to approve". Agents are told to say what they will change there before they do. <code>*</code> stays inside a folder, <code>**</code> crosses folders, a name without a slash fits at any depth.</p>
      ${r.risk.length ? `<ul class="std-list">${r.risk.map((x) => `<li><div class="std-line"><code class="std-text">${esc(x.pattern)}</code><span class="hint">${esc(x.why)}</span><button type="button" class="link" data-std="unrisk" data-pattern="${esc(x.pattern)}">Remove</button></div></li>`).join('')}</ul>` : ''}
      <form data-std-form="risk" class="std-line"><input type="text" name="pattern" maxlength="200" required placeholder="src/auth/**  or  **/migrations/**  or  *.sql" aria-label="A path pattern" /><input type="text" name="why" maxlength="200" placeholder="Why (optional)" aria-label="Why it is high risk" /><button class="small">Mark high risk</button></form>
    </section>`;
  }

  function barHtml(r) {
    const b = r.bar;
    return `<section class="std-section">
      <h3>Quality bar <span class="hint">${b.checks.length + (b.tests ? 1 : 0) + (b.secrets ? 1 : 0)} checks</span></h3>
      <p class="hint">Run by the app on an agent's changes, in its folder, before they are scored. A failed check means "Not ready" whatever the agent says, and on autopilot the work goes back to the agent with the output. Each command gets ${Math.round(data.limits.checkSeconds / 60)} minutes.</p>
      <label class="check"><input type="checkbox" data-std-bar="tests" ${b.tests ? 'checked' : ''} /> Code changes need a test file changed too</label>
      <label class="check"><input type="checkbox" data-std-bar="secrets" ${b.secrets ? 'checked' : ''} /> No keys or tokens on the added lines</label>
      ${b.checks.length ? `<ul class="std-list">${b.checks.map((c) => `<li><div class="std-line"><b>${esc(c.name)}</b><code class="std-text">${esc(c.command)}</code><button type="button" class="link" data-std="uncheck" data-name="${esc(c.name)}">Remove</button></div></li>`).join('')}</ul>` : ''}
      ${r.suggested.length ? `<p class="hint">Found in this repository: ${r.suggested.map((c) => `<button type="button" class="chip" data-std="suggest" data-name="${esc(c.name)}" data-command="${esc(c.command)}" title="Add this check">+ ${esc(c.name)}: ${esc(c.command)}</button>`).join(' ')}</p>` : ''}
      <form data-std-form="check" class="std-line"><input type="text" name="label" maxlength="60" placeholder="Name: Lint" aria-label="The check's name" class="std-short" /><input type="text" name="command" maxlength="500" required placeholder="Command: npm run lint" aria-label="The command" /><button class="small">Add check</button></form>
    </section>`;
  }

  function html() {
    if (!data) return '<p class="hint">Loading…</p>';
    const r = repo();
    if (!r) return '<p class="hint issues-empty">Standards are per repository. Start an agent in one, and it shows here.</p>';
    return `<div class="std">
      <p class="std-repo"><label>Repository <select data-std-repo aria-label="Repository">${data.repos.map((x) => `<option value="${esc(x.key)}" ${x.key === r.key ? 'selected' : ''}>${esc(x.name)}${x.proposed.length ? ` (${x.proposed.length} proposed)` : ''}</option>`).join('')}</select></label>
        <span class="hint">${r.agents} agent${r.agents === 1 ? '' : 's'} here now · what is set applies to agents started from now on, and to every change scored from now on</span></p>
      ${data.enabled ? '' : '<p class="hint"><b>Standards are turned off</b> in config.json ("standards": { "enabled": false }): nothing below is applied.</p>'}
      ${lessonsHtml(r)}${riskHtml(r)}${barHtml(r)}
    </div>`;
  }

  const save = async (fn, said) => {
    try {
      await fn();
      if (said) toast?.(said);
    } catch (e) {
      toast?.(e.message, 6000);
    }
    document.activeElement?.blur();
    return load();
  };

  /** A click inside the view; true when it was one of ours. */
  function click(e) {
    const b = e.target.closest('[data-std]');
    const r = repo();
    if (!b || !r) return false;
    const act = b.dataset.std;
    const li = b.closest('[data-std-lesson]');
    const id = li?.dataset.stdLesson;
    const text = li?.querySelector('input')?.value.trim();
    if (act === 'accept') {
      if (!text) return toast?.('Word the lesson first: one line', 4000), true;
      save(() => api('PUT', `/standards/lessons/${id}`, { key: r.key, state: 'accepted', text }), 'Accepted: agents started from now on are given it');
    } else if (act === 'dismiss' || act === 'remove') save(() => api('DELETE', `/standards/lessons/${id}?key=${encodeURIComponent(r.key)}`));
    else if (act === 'draft') {
      busy = id;
      rerender(true);
      save(() => api('POST', `/standards/lessons/${id}/draft`, { key: r.key })).finally(() => {
        busy = null;
        rerender(true);
      });
    } else if (act === 'unrisk') save(() => api('PUT', '/standards/repo', { key: r.key, risk: r.risk.filter((x) => x.pattern !== b.dataset.pattern) }));
    else if (act === 'uncheck') save(() => api('PUT', '/standards/repo', { key: r.key, bar: { checks: r.bar.checks.filter((c) => c.name !== b.dataset.name) } }));
    else if (act === 'suggest') save(() => api('PUT', '/standards/repo', { key: r.key, bar: { checks: [...r.bar.checks, { name: b.dataset.name, command: b.dataset.command }] } }), `Added: ${b.dataset.name}`);
    return true;
  }

  function change(e) {
    const r = repo();
    if (e.target.matches('[data-std-repo]')) {
      repoKey = e.target.value;
      try {
        localStorage.setItem(SAVED, repoKey);
      } catch {}
      e.target.blur();
      rerender(true);
      return true;
    }
    if (e.target.matches('[data-std-bar]') && r) {
      save(() => api('PUT', '/standards/repo', { key: r.key, bar: { [e.target.dataset.stdBar]: e.target.checked } }));
      return true;
    }
    return false;
  }

  function submit(e) {
    const f = e.target.closest('[data-std-form]');
    const r = repo();
    if (!f || !r) return false;
    e.preventDefault();
    const kind = f.dataset.stdForm;
    if (kind === 'lesson') save(() => api('POST', '/standards/lessons', { key: r.key, text: f.text.value }), 'Added: agents started from now on are given it');
    else if (kind === 'risk') save(() => api('PUT', '/standards/repo', { key: r.key, risk: [...r.risk, { pattern: f.pattern.value, why: f.why.value }] }));
    else if (kind === 'check') save(() => api('PUT', '/standards/repo', { key: r.key, bar: { checks: [...r.bar.checks, { name: f.label.value, command: f.command.value }] } }));
    return true;
  }

  return { load, html, click, change, submit, proposed, loaded: () => Boolean(data) };
}
