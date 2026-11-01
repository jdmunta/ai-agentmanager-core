// The Built tab: agents made with the builder (agentkit agents, docs/agentkit.md). Build one from
// a task; review its analysis, spec and tests; test it; run it here; open its chat; download it.
import { attachBox } from '/attach.js';

const STATUS = { designed: 'designed', 'needs-fixing': 'needs fixing', testing: 'testing…', tested: 'tests pass', failing: 'tests fail', running: 'running' };

export function initBuilt({ api, esc, toast, $, isOpen, setCount }) {
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
        <div class="hint">${esc(b.name)} · ${esc(b.engine ?? '')}${b.results?.total ? ` · tests ${b.results.passed}/${b.results.total}` : ''}${b.triggers.length ? ` · ${esc(b.triggers.join(', '))}` : ''}</div></li>`).join('')}</ul>` : '<p class="hint built-empty">No agents built yet.</p>'}`;
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
        <a class="button small ghost" href="/api/builder/${esc(b.name)}/download" title="Its folder (agent.yaml, instructions, tests) to run anywhere with agentkit">Download</a>
        <button class="small ghost" data-bt="delete">Delete</button>
      </div>
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
