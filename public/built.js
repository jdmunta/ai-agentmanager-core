// The Built tab: agents made with the builder (agentkit agents, docs/agentkit.md). Each one is
// developed in an agent session working in its folder: building one starts that session, and the
// person keeps shaping the agent there. Here (and in a panel on that session) they review its
// analysis, spec and tests, test it, run it here, open its chat, package and download it.
import { attachBox } from '/attach.js';

const STATUS = { designing: 'designing…', designed: 'designed', 'needs-fixing': 'needs fixing', testing: 'testing…', tested: 'tests pass', failing: 'tests fail', running: 'running' };

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

const sessionText = (s) => (!s ? 'no session' : s.attention ? 'session waiting for you' : s.busy ? 'session working' : s.running ? 'session idle' : 'session closed');
const tagClass = (b) => (b.status === 'tested' ? 'open' : b.status === 'failing' || b.status === 'needs-fixing' ? 'fail' : '');
const later = (a, b) => Boolean(a && b && Date.parse(a) > Date.parse(b) + 1000);

/** `openSession(id)`: show an agent session (the agents view). `onPanel()`: a session's panel has new data. */
export function initBuilt({ api, esc, toast, $, isOpen, setCount, reports = () => [], openSession = () => {}, onPanel = () => {} }) {
  const view = $('#built-view');
  const dlg = $('#built-dialog');
  const body = $('#built-body');
  let list = [];
  let open = null; // the built agent shown in the dialog
  let poll = null;

  async function load() {
    try {
      list = await api('GET', '/builder');
    } catch {
      list = [];
    }
    setCount(list.length || '');
    if (isOpen()) render();
  }

  function render() {
    view.innerHTML = `<div class="built-head"><button class="small primary" data-bt="new">+ Build an agent</button><span class="hint">An agent for a task or workflow: it plans, acts, checks itself and keeps working in the background. Each is developed in its own agent session.</span></div>
      ${list.length ? `<ul class="built-list">${list.map((b) => `<li data-bt-open="${esc(b.name)}"><div class="line1"><b>${esc(b.title ?? b.name)}</b>${b.running ? ' <span class="dot-run" title="Running">●</span>' : ''}<span class="spacer"></span>${b.session ? `<a href="#${esc(b.session.id)}" class="button small ghost" data-bt-session="${esc(b.session.id)}" title="Its session: where you shape it">Session${b.session.busy ? ' ●' : ''}</a>` : ''}<span class="tag ${tagClass(b)}">${esc(b.pending ?? STATUS[b.status] ?? b.status)}</span></div>
        <div class="hint">${esc(b.name)} · ${esc(b.engine ?? '')} · ${sessionText(b.session)}${b.results?.total ? ` · tests ${b.results.passed}/${b.results.total}` : ''}${b.triggers.length ? ` · ${esc(b.triggers.join(', '))}` : ''}</div></li>`).join('')}</ul>` : '<p class="hint built-empty">No agents built yet.</p>'}
      ${reporting()}`;
  }

  // ------------------------------------------------------------ agents reporting in (here or elsewhere)
  function reporting() {
    const rs = reports();
    const head = `<div class="built-head reporting-head"><b>Reporting in</b><span class="hint">Agents running here or on other computers: their runs, cost and the tools they wait to have approved.</span><span class="spacer"></span><button class="small ghost" data-bt="connect">Connect one from elsewhere</button></div><div id="built-connect" ${connectHtml ? '' : 'hidden'}>${connectHtml ?? ''}</div>`;
    if (!rs.length) return `${head}<p class="hint built-empty">None yet. Agents you start here report automatically.</p>`;
    return `${head}<ul class="built-list reports">${rs.map((r) => `<li data-report="${esc(r.key)}">
      <div class="line1"><span class="dot-run ${r.online ? '' : 'off'}" title="${r.online ? 'Online' : 'Not heard from'}">●</span> <b>${esc(r.title)}</b> <span class="hint">${esc(r.host)}</span><span class="spacer"></span>
        ${r.chat && r.online ? `<a class="button small ghost" href="${esc(r.chat)}" target="_blank" rel="noopener">Chat ↗</a>` : ''}
        <button class="small ghost" data-rp="forget" title="Remove it from this list (it shows up again when it reports)">Forget</button></div>
      <div class="hint">${esc(r.engine)} · ${r.online ? (r.current ? `working on a run (${esc(r.current.source)})` : 'idle') : `last seen ${ago(r.lastSeen)}`} · ${r.totals.runs} run${r.totals.runs === 1 ? '' : 's'}${r.totals.failed ? `, ${r.totals.failed} failed` : ''}${r.totals.costUsd ? ` · $${r.totals.costUsd.toFixed(2)}` : ''}${r.triggers.length ? ` · ${esc(r.triggers.join(', '))}` : ''}</div>
      ${r.pending.map((p) => `<div class="report-approval" data-ap="${esc(p.id)}"><b>Wants to run <code>${esc(p.tool)}</code></b> <span class="hint">${ago(p.at)}</span><pre>${esc(JSON.stringify(p.input, null, 2).slice(0, 1500))}</pre><button class="small primary" data-rp="approve">Approve</button> <button class="small" data-rp="deny">Deny</button></div>`).join('')}
      ${r.runs.length ? `<details><summary class="hint">Recent runs</summary><ul class="built-runs">${r.runs.map((x) => `<li><span class="tag ${x.status === 'failed' ? 'fail' : x.status === 'done' ? 'open' : ''}">${esc(x.status)}</span> <span class="hint">${esc(x.source)} · ${x.at ? ago(x.at) : ''}${x.costUsd ? ` · $${x.costUsd.toFixed(3)}` : ''}${x.ms ? ` · ${Math.round(x.ms / 1000)}s` : ''}</span><div>${esc(x.result.slice(0, 400))}</div></li>`).join('')}</ul></details>` : ''}
    </li>`).join('')}</ul>`;
  }

  let connectHtml = null; // the connection details, kept open across live re-renders
  async function connect() {
    const box = $('#built-connect');
    if (connectHtml) return (connectHtml = null), (box.hidden = true);
    try {
      const c = await api('GET', '/agentkit/connect');
      const lines = (url, cert) => [`AGENTKIT_REPORT_URL=${url}`, `AGENTKIT_REPORT_TOKEN=${c.token}`, ...(cert ? [`AGENTKIT_REPORT_CERT=${cert}`] : [])].join('\n');
      box.innerHTML = `<p class="hint">Set these where the agent runs (in its environment, or in its service), then start it. It reports here and asks here for approvals.</p>
        ${c.remote.length ? c.remote.map((u) => `<p><b>From another computer</b> <span class="hint">(over remote access)</span></p><pre class="code-area">${esc(lines(u.replace(/\/$/, ''), c.cert))}</pre>`).join('') : '<p class="hint">Turn on remote access (Settings) to connect agents on other computers.</p>'}
        <p><b>On this computer</b></p><pre class="code-area">${esc(lines(c.local))}</pre>`;
    } catch (err) {
      box.innerHTML = `<p class="hint">${esc(err.message)}. Open AI Agent Manager on this computer to see the connection details.</p>`;
    }
    connectHtml = box.innerHTML;
    box.hidden = false;
  }

  // ------------------------------------------------------------ build
  const buildDlg = $('#build-dialog');
  const files = attachBox({ slot: $('#build-attach'), form: $('#build-form'), paste: $('#build-form textarea'), esc, toast });
  async function openBuild() {
    const sel = $('#build-form').engine;
    if (sel.options.length <= 1) {
      const engines = await api('GET', '/engines').catch(() => []);
      for (const e of engines.filter((x) => x.installed && x.id !== 'claude')) sel.append(Object.assign(document.createElement('option'), { value: e.id.startsWith('acp-') ? `acp:${e.id.slice(4)}` : e.id, textContent: e.label }));
    }
    $('#build-error').hidden = true;
    buildDlg.showModal();
    $('#build-form textarea').focus();
  }
  $('#build-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (files.pending()) return toast('Still uploading the attached files');
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Starting its session…';
    try {
      const b = await api('POST', '/builder', { task: f.task.value, engine: f.engine.value, name: f.name.value.trim() || undefined, attachments: files.paths().length ? files.paths() : undefined });
      buildDlg.close();
      f.reset();
      files.clear();
      cache.set(b.name, b);
      await load();
      // Building happens in its session: go there.
      if (b.session) openSession(b.session.id);
      else show(b);
    } catch (err) {
      $('#build-error').textContent = err.message;
      $('#build-error').hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Start building';
    }
  });
  $('#build-cancel').onclick = () => buildDlg.close();

  // ------------------------------------------------------------ one agent
  function show(b) {
    open = b;
    $('#built-title').textContent = b.title ?? b.name;
    const a = b.analysis ?? {};
    const li = (xs) => (xs?.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="hint">—</p>');
    const r = b.results;
    const failed = (r?.list ?? []).filter((t) => t.pass === false);
    body.innerHTML = `
      ${sessionBlock(b)}
      <div class="built-actions">
        <span class="tag ${tagClass(b)}">${esc(b.pending ?? STATUS[b.status] ?? b.status)}</span>
        ${b.running ? `<span class="hint">running since ${new Date(b.running.since).toLocaleTimeString()}</span>${b.running.url ? ` <a href="${esc(b.running.url)}" target="_blank" rel="noopener">Open its chat ↗</a>` : ''}` : ''}
        <span class="spacer"></span>
        <button class="small" data-bt="test" ${b.pending || b.specError || b.status === 'designing' ? 'disabled' : ''} title="Run each test through the real engine and judge the results">${b.pending === 'testing' ? 'Testing…' : 'Run tests'}</button>
        <button class="small ${b.running ? '' : 'primary'}" data-bt="${b.running ? 'stop' : 'start'}" ${b.specError || b.status === 'designing' ? 'disabled' : ''} title="${b.running ? 'Stop it' : 'Run it continuously on this computer: its triggers, chat page and API'}">${b.running ? 'Stop' : 'Start'}</button>
        <a class="button small ghost" href="/api/builder/${esc(b.name)}/download" title="Its folder (agent.yaml, instructions, tests) to run anywhere with agentkit">Download folder</a>
        <button class="small ghost" data-bt="delete">Delete</button>
      </div>
      <div class="built-exe"><b>Single executable</b> <span class="hint">one file that runs this agent anywhere, no Node or agentkit needed (its engine's CLI must be installed and signed in)</span>
        <div class="built-exe-row"><select id="built-platform">${(b.platforms ?? []).map((p) => `<option value="${esc(p)}" ${p === b.host ? 'selected' : ''}>${esc(p)}${p === b.host ? ' (this computer)' : ''}</option>`).join('')}</select>
        <button class="small" data-bt="package" ${b.pending || b.specError || b.status === 'designing' ? 'disabled' : ''}>${b.pending?.startsWith('packaging') ? 'Building… (a minute or two)' : 'Build executable'}</button>
        ${Object.entries(b.executables ?? {}).map(([p, x]) => `<a class="button small ghost" href="/api/builder/${esc(b.name)}/executable/${esc(p)}" title="Built ${esc(new Date(x.at).toLocaleString())}${later(b.changedAt, x.at) ? ', before its latest change: build it again' : ''}">⬇ ${esc(p)} · ${Math.round(x.size / 1e6)} MB${later(b.changedAt, x.at) ? ' (older)' : ''}</a>`).join('')}</div>
        ${b.packageError ? `<p class="error">${esc(b.packageError)}</p>` : ''}</div>
      ${b.specError ? `<p class="error">${esc(b.specError)}</p>` : ''}
      ${b.missingEnv.length ? `<p class="hint warn">Set these in the environment before running it: ${esc(b.missingEnv.join(', '))}</p>` : ''}
      <details open><summary><b>Analysis</b></summary>${b.status === 'designing' && !a.problem ? '<p class="hint">Its session is working it out; this fills in as it writes the files.</p>' : ''}<p>${esc(a.problem ?? '')}</p><div class="row three"><div><b>Inputs</b>${li(a.inputs)}</div><div><b>Outputs</b>${li(a.outputs)}</div><div><b>Risks</b>${li(a.risks)}</div></div>
        ${b.tools?.length ? `<p><b>Tools</b></p><ul>${b.tools.map((t) => `<li><code>${esc(t.name)}</code> ${esc(t.why)}</li>`).join('')}</ul>` : ''}</details>
      <details ${r ? 'open' : ''}><summary><b>Tests</b> ${r?.total ? `<span class="hint">${r.passed}/${r.total} pass · ${new Date(r.at).toLocaleString()}</span>` : '<span class="hint">not run yet</span>'}</summary>
        ${r?.error ? `<p class="error">${esc(r.error)}</p>` : ''}
        ${r?.at && later(b.changedAt, r.at) ? '<p class="hint warn">The agent changed after these results; run the tests again.</p>' : ''}
        ${failed.length && b.session ? `<button class="small" data-bt="fix">Ask its session to fix the ${failed.length} failing test${failed.length > 1 ? 's' : ''}</button>` : ''}
        <ol class="built-tests">${(r?.list?.length ? r.list : b.tests ?? []).map((t) => `<li class="${t.pass === true ? 'pass' : t.pass === false ? 'fail' : ''}"><div><b>${t.pass === true ? '✓' : t.pass === false ? '✗' : '·'}</b> ${esc(t.input)}</div><div class="hint">Expect: ${esc(t.expect)}</div>${t.why ? `<div class="hint">${esc(t.why)}</div>` : ''}${t.result ? `<details><summary class="hint">Result</summary><pre>${esc(t.result)}</pre></details>` : ''}</li>`).join('')}</ol></details>
      <details><summary><b>agent.yaml</b> and instructions</summary>
        <textarea id="built-yaml" class="code-area" rows="16" spellcheck="false">${esc(b.yaml)}</textarea>
        <textarea id="built-instr" class="code-area" rows="10" spellcheck="false">${esc(b.instructionsText)}</textarea>
        <div class="dialog-actions"><button class="small primary" data-bt="save">Save</button></div></details>
      ${b.runs.length ? `<details><summary><b>Recent runs</b></summary><ul class="built-runs">${b.runs.map((x) => `<li><span class="tag">${esc(x.status)}</span> <span class="hint">${esc(x.source ?? '')} · ${x.startedAt ? new Date(x.startedAt).toLocaleString() : ''}</span><div>${esc(String(x.result ?? '').slice(0, 300))}</div></li>`).join('')}</ul></details>` : ''}
      <p class="hint">Task: ${esc(b.task ?? '')}</p>`;
    if (!dlg.open) dlg.showModal();
    clearInterval(poll);
    if (b.pending || b.status === 'designing') poll = setInterval(refresh, 3000);
  }

  // Where the agent is developed: its session, and a box to ask it for a change.
  function sessionBlock(b) {
    if (!b.session)
      return `<div class="built-session"><b>No session</b> <span class="hint">Open an agent session in its folder to keep shaping it with you.</span><span class="spacer"></span><button class="small primary" data-bt="session-new">Open a session for it</button></div>`;
    return `<div class="built-session"><div class="line1"><b>Developed in its session</b> <span class="hint">${sessionText(b.session)}</span><span class="spacer"></span><a href="#${esc(b.session.id)}" class="button small primary" data-bt-session="${esc(b.session.id)}">Open session</a></div>
      <div class="built-change"><textarea id="built-change" rows="2" placeholder="Ask its session for a change: “also post a summary to #support every evening”, “never reassign tickets”…"></textarea><button class="small" data-bt="change">Send</button></div></div>`;
  }

  function failuresText(b) {
    const failed = (b.results?.list ?? []).filter((t) => t.pass === false);
    return `These tests failed. Change the agent so they pass (or fix a test if its expectation is wrong), check it, and tell me what you changed.\n\n${failed.map((t, i) => `${i + 1}. Input: ${t.input}\n   Expected: ${t.expect}\n   Judge: ${t.why}\n   Result: ${String(t.result ?? '').slice(0, 600)}`).join('\n\n')}`;
  }

  async function refresh() {
    if (!open || !dlg.open) return clearInterval(poll);
    try {
      const b = await api('GET', `/builder/${open.name}`);
      cache.set(b.name, b);
      onPanel();
      const typing = document.activeElement?.closest?.('#built-body textarea');
      if (!typing && JSON.stringify(b) !== JSON.stringify(open)) show(b);
      if (!b.pending && b.status !== 'designing') clearInterval(poll), load();
    } catch {}
  }

  async function act(what) {
    const name = open?.name;
    try {
      if (what === 'test') show(await api('POST', `/builder/${name}/test`));
      else if (what === 'package') show(await api('POST', `/builder/${name}/package`, { platform: $('#built-platform').value }));
      else if (what === 'start') {
        show(await api('POST', `/builder/${name}/start`));
        setTimeout(refresh, 1500);
      } else if (what === 'stop') show(await api('POST', `/builder/${name}/stop`));
      else if (what === 'change' || what === 'fix') {
        const text = what === 'fix' ? failuresText(open) : $('#built-change').value.trim();
        if (!text) return toast('Say what to change');
        show(await api('POST', `/builder/${name}/change`, { text }));
        toast('Sent to its session');
      } else if (what === 'session-new') {
        const b = await api('POST', `/builder/${name}/change`, {});
        dlg.close();
        if (b.session) openSession(b.session.id);
      }
      else if (what === 'save') {
        show(await api('PUT', `/builder/${name}`, { yaml: $('#built-yaml').value, instructions: $('#built-instr').value }));
        toast('Saved');
      } else if (what === 'delete') {
        if (!confirm(`Delete ${name} and its folder?`)) return;
        await api('DELETE', `/builder/${name}`);
        dlg.close();
      }
      load();
    } catch (err) {
      toast(`Error: ${err.message}`, 6000);
    }
  }

  view.addEventListener('click', async (e) => {
    if (e.target.closest('[data-bt="new"]')) return openBuild();
    if (e.target.closest('[data-bt="connect"]')) return connect();
    const rp = e.target.closest('[data-rp]');
    if (rp) {
      const key = rp.closest('[data-report]').dataset.report;
      try {
        if (rp.dataset.rp === 'forget') await api('DELETE', `/agentkit/agents/${encodeURIComponent(key)}`);
        else {
          rp.disabled = true;
          await api('POST', `/agentkit/agents/${encodeURIComponent(key)}/approvals/${encodeURIComponent(rp.closest('[data-ap]').dataset.ap)}`, { allow: rp.dataset.rp === 'approve' });
          toast(rp.dataset.rp === 'approve' ? 'Approved; the agent goes on' : 'Declined');
        }
      } catch (err) {
        toast(`Error: ${err.message}`, 6000);
      }
      return;
    }
    const ses = e.target.closest('[data-bt-session]');
    if (ses) return e.preventDefault(), openSession(ses.dataset.btSession);
    const li = e.target.closest('[data-bt-open]');
    if (li) show(await api('GET', `/builder/${li.dataset.btOpen}`));
  });
  body.addEventListener('click', (e) => {
    const ses = e.target.closest('[data-bt-session]');
    if (ses) return e.preventDefault(), dlg.close(), openSession(ses.dataset.btSession);
    const b = e.target.closest('[data-bt]');
    if (b) act(b.dataset.bt);
  });
  $('#built-close').onclick = () => (clearInterval(poll), dlg.close());

  // ------------------------------------------------------------ the panel on its session
  const cache = new Map(); // name -> its latest view (or { missing: true })
  const fetching = new Set();
  async function fetchOne(name) {
    if (fetching.has(name)) return;
    fetching.add(name);
    try {
      cache.set(name, await api('GET', `/builder/${encodeURIComponent(name)}`));
    } catch (err) {
      cache.set(name, /No built agent|Unknown agent/.test(err.message) ? { missing: true, name } : { error: err.message, name });
    } finally {
      fetching.delete(name);
      onPanel();
    }
  }

  /** The panel shown on a session that builds an agent (agent `a`, with a.builds). */
  function panel(a) {
    const name = a.builds.name;
    const b = cache.get(name);
    if (!b) {
      fetchOne(name);
      return `<div class="built-panel"><b>⚙ Builds the agent ${esc(name)}</b> <span class="hint">loading…</span></div>`;
    }
    if (b.error) return `<div class="built-panel"><b>⚙ Builds the agent ${esc(name)}</b> <span class="hint">· ${esc(b.error)}</span></div>`;
    if (b.missing) return `<div class="built-panel"><b>⚙ Built the agent ${esc(name)}</b> <span class="hint">· deleted from the Built tab</span></div>`;
    const r = b.results;
    const failed = (r?.list ?? []).filter((t) => t.pass === false);
    const stale = r?.at && later(b.changedAt, r.at);
    return `<div class="built-panel" data-bp-name="${esc(name)}">
      <div class="line1"><b>⚙ ${esc(b.title ?? name)}</b> <span class="tag ${tagClass(b)}">${esc(b.pending ?? STATUS[b.status] ?? b.status)}</span>
        <span class="hint">${esc(b.engine ?? '')}${b.triggers.length ? ` · ${esc(b.triggers.join(', '))}` : ''}${r?.total ? ` · tests ${r.passed}/${r.total}${stale ? ' (before the latest change)' : ''}` : b.tests.length ? ` · ${b.tests.length} tests, not run` : ''}${b.running ? ' · running here' : ''}</span>
        <span class="spacer"></span>
        <button class="small" data-bp="test" ${b.pending || b.specError || b.status === 'designing' ? 'disabled' : ''} title="Run each test through the real engine and judge the results">${b.pending === 'testing' ? 'Testing…' : 'Run tests'}</button>
        <button class="small" data-bp="${b.running ? 'stop' : 'start'}" ${b.specError || b.status === 'designing' ? 'disabled' : ''} title="${b.running ? 'Stop it' : 'Run it continuously on this computer: its triggers, chat page and API'}">${b.running ? 'Stop' : 'Start'}</button>
        ${b.running?.url ? `<a class="button small ghost" href="${esc(b.running.url)}" target="_blank" rel="noopener">Chat ↗</a>` : ''}
        <button class="small ghost" data-bp="open" title="Analysis, spec, tests, executables, downloads">Details</button></div>
      ${b.specError ? `<p class="error">${esc(b.specError)}</p>` : ''}
      ${b.missingEnv.length ? `<p class="hint warn">Needs in the environment before it runs: ${esc(b.missingEnv.join(', '))}</p>` : ''}
      ${b.description ? `<div class="hint">${esc(b.description)}</div>` : ''}
      ${failed.length && !stale ? `<div class="hint">Failing: ${failed.map((t) => esc(t.input.slice(0, 60))).join(' · ')} <button class="small" data-bp="fix">Ask this session to fix them</button></div>` : ''}
    </div>`;
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-bp]');
    if (!el) return;
    const name = el.closest('[data-bp-name]').dataset.bpName;
    try {
      if (el.dataset.bp === 'open') return show(await api('GET', `/builder/${name}`));
      if (el.dataset.bp === 'fix') {
        await api('POST', `/builder/${name}/change`, { text: failuresText(cache.get(name)) });
        return toast('Sent to this session');
      }
      el.disabled = true;
      cache.set(name, await api('POST', `/builder/${name}/${el.dataset.bp}`));
      onPanel();
      // Tests and starting finish in the background; follow them.
      const follow = setInterval(async () => {
        await fetchOne(name);
        const b = cache.get(name);
        if (!b || b.missing || (!b.pending && (el.dataset.bp !== 'start' || b.running?.url || !b.running))) clearInterval(follow), load();
      }, 2000);
    } catch (err) {
      toast(`Error: ${err.message}`, 6000);
    }
  });

  // Its session changed (it edits the files as it goes): fetch the agent again, a moment later.
  const timers = new Map();
  function sessionChanged(a) {
    const name = a.builds?.name;
    if (!name) return;
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => {
      fetchOne(name);
      if (open?.name === name && dlg.open) refresh();
      if (isOpen()) load();
    }, 1000));
  }

  load();
  return { load, render, panel, sessionChanged, openAgent: async (name) => show(await api('GET', `/builder/${name}`)) };
}
