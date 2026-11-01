// The Built tab: agents made with the builder (agentkit agents, docs/agentkit.md). Build one from
// a task; review its analysis, spec and tests; test it; run it here; open its chat; download it.
import { attachBox } from '/attach.js';

const STATUS = { designed: 'designed', 'needs-fixing': 'needs fixing', testing: 'testing…', tested: 'tests pass', failing: 'tests fail', running: 'running' };

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

export function initBuilt({ api, esc, toast, $, isOpen, setCount, reports = () => [] }) {
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
    view.innerHTML = `<div class="built-head"><button class="small primary" data-bt="new">+ Build an agent</button><span class="hint">An agent for a task or workflow: it plans, acts, checks itself and keeps working in the background.</span></div>
      ${list.length ? `<ul class="built-list">${list.map((b) => `<li data-bt-open="${esc(b.name)}"><div class="line1"><b>${esc(b.title ?? b.name)}</b>${b.running ? ' <span class="dot-run" title="Running">●</span>' : ''}<span class="spacer"></span><span class="tag ${b.status === 'tested' ? 'open' : b.status === 'failing' || b.status === 'needs-fixing' ? 'fail' : ''}">${esc(b.pending ?? STATUS[b.status] ?? b.status)}</span></div>
        <div class="hint">${esc(b.name)} · ${esc(b.engine ?? '')}${b.results?.total ? ` · tests ${b.results.passed}/${b.results.total}` : ''}${b.triggers.length ? ` · ${esc(b.triggers.join(', '))}` : ''}</div></li>`).join('')}</ul>` : '<p class="hint built-empty">No agents built yet.</p>'}
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
    btn.textContent = 'Designing… (about a minute)';
    try {
      const b = await api('POST', '/builder', { task: f.task.value, engine: f.engine.value, attachments: files.paths().length ? files.paths() : undefined });
      buildDlg.close();
      f.reset();
      files.clear();
      await load();
      show(b);
    } catch (err) {
      $('#build-error').textContent = err.message;
      $('#build-error').hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Design the agent';
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
    body.innerHTML = `
      <div class="built-actions">
        <span class="tag ${b.status === 'tested' ? 'open' : b.status === 'failing' || b.status === 'needs-fixing' ? 'fail' : ''}">${esc(b.pending ?? STATUS[b.status] ?? b.status)}</span>
        ${b.running ? `<span class="hint">running since ${new Date(b.running.since).toLocaleTimeString()}</span>${b.running.url ? ` <a href="${esc(b.running.url)}" target="_blank" rel="noopener">Open its chat ↗</a>` : ''}` : ''}
        <span class="spacer"></span>
        <button class="small" data-bt="test" ${b.pending ? 'disabled' : ''} title="Run each test through the real engine and judge the results">${b.pending === 'testing' ? 'Testing…' : 'Run tests'}</button>
        <button class="small ${b.running ? '' : 'primary'}" data-bt="${b.running ? 'stop' : 'start'}" ${b.specError ? 'disabled' : ''} title="${b.running ? 'Stop it' : 'Run it continuously on this computer: its triggers, chat page and API'}">${b.running ? 'Stop' : 'Start'}</button>
        <a class="button small ghost" href="/api/builder/${esc(b.name)}/download" title="Its folder (agent.yaml, instructions, tests) to run anywhere with agentkit">Download folder</a>
        <button class="small ghost" data-bt="delete">Delete</button>
      </div>
      <div class="built-exe"><b>Single executable</b> <span class="hint">one file that runs this agent anywhere, no Node or agentkit needed (its engine's CLI must be installed and signed in)</span>
        <div class="built-exe-row"><select id="built-platform">${(b.platforms ?? []).map((p) => `<option value="${esc(p)}" ${p === b.host ? 'selected' : ''}>${esc(p)}${p === b.host ? ' (this computer)' : ''}</option>`).join('')}</select>
        <button class="small" data-bt="package" ${b.pending || b.specError ? 'disabled' : ''}>${b.pending?.startsWith('packaging') ? 'Building… (a minute or two)' : 'Build executable'}</button>
        ${Object.entries(b.executables ?? {}).map(([p, x]) => `<a class="button small ghost" href="/api/builder/${esc(b.name)}/executable/${esc(p)}" title="Built ${esc(new Date(x.at).toLocaleString())}">⬇ ${esc(p)} · ${Math.round(x.size / 1e6)} MB</a>`).join('')}</div>
        ${b.packageError ? `<p class="error">${esc(b.packageError)}</p>` : ''}</div>
      ${b.specError ? `<p class="error">${esc(b.specError)}</p>` : ''}
      ${b.missingEnv.length ? `<p class="hint warn">Set these in the environment before running it: ${esc(b.missingEnv.join(', '))}</p>` : ''}
      <details open><summary><b>Analysis</b></summary><p>${esc(a.problem ?? '')}</p><div class="row three"><div><b>Inputs</b>${li(a.inputs)}</div><div><b>Outputs</b>${li(a.outputs)}</div><div><b>Risks</b>${li(a.risks)}</div></div>
        ${b.tools?.length ? `<p><b>Tools</b></p><ul>${b.tools.map((t) => `<li><code>${esc(t.name)}</code> ${esc(t.why)}</li>`).join('')}</ul>` : ''}</details>
      <details ${r ? 'open' : ''}><summary><b>Tests</b> ${r?.total ? `<span class="hint">${r.passed}/${r.total} pass · ${new Date(r.at).toLocaleString()}</span>` : '<span class="hint">not run yet</span>'}</summary>
        ${r?.error ? `<p class="error">${esc(r.error)}</p>` : ''}
        <ol class="built-tests">${(r?.list?.length ? r.list : b.tests ?? []).map((t) => `<li class="${t.pass === true ? 'pass' : t.pass === false ? 'fail' : ''}"><div><b>${t.pass === true ? '✓' : t.pass === false ? '✗' : '·'}</b> ${esc(t.input)}</div><div class="hint">Expect: ${esc(t.expect)}</div>${t.why ? `<div class="hint">${esc(t.why)}</div>` : ''}${t.result ? `<details><summary class="hint">Result</summary><pre>${esc(t.result)}</pre></details>` : ''}</li>`).join('')}</ol></details>
      <details><summary><b>agent.yaml</b> and instructions</summary>
        <textarea id="built-yaml" class="code-area" rows="16" spellcheck="false">${esc(b.yaml)}</textarea>
        <textarea id="built-instr" class="code-area" rows="10" spellcheck="false">${esc(b.instructionsText)}</textarea>
        <div class="dialog-actions"><button class="small primary" data-bt="save">Save</button></div></details>
      ${b.runs.length ? `<details><summary><b>Recent runs</b></summary><ul class="built-runs">${b.runs.map((x) => `<li><span class="tag">${esc(x.status)}</span> <span class="hint">${esc(x.source ?? '')} · ${x.startedAt ? new Date(x.startedAt).toLocaleString() : ''}</span><div>${esc(String(x.result ?? '').slice(0, 300))}</div></li>`).join('')}</ul></details>` : ''}
      <p class="hint">Task: ${esc(b.task ?? '')}</p>`;
    if (!dlg.open) dlg.showModal();
    clearInterval(poll);
    if (b.pending) poll = setInterval(refresh, 3000);
  }

  async function refresh() {
    if (!open || !dlg.open) return clearInterval(poll);
    try {
      const b = await api('GET', `/builder/${open.name}`);
      if (b.pending !== open.pending || b.updatedAt !== open.updatedAt) show(b);
      if (!b.pending) clearInterval(poll), load();
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
    const li = e.target.closest('[data-bt-open]');
    if (li) show(await api('GET', `/builder/${li.dataset.btOpen}`));
  });
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bt]');
    if (b) act(b.dataset.bt);
  });
  $('#built-close').onclick = () => (clearInterval(poll), dlg.close());

  load();
  return { load, render };
}
