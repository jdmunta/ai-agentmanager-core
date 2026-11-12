// MCP: the MCP servers Claude Code has in an agent's folder (or the home folder), each with its
// status, where it comes from and its tools. Each folder has its own MCP session on the daemon
// (apart from any agent's), where a server is signed in to, connected again and its tools are
// called directly; a tool can also run through Claude Code from plain words, or in the agent's
// session. The window also opens on its own (#mcp or #mcp/<agent>).

const SOURCE = { project: 'Project (.mcp.json)', user: 'User', local: 'Local', claudeai: 'claude.ai connector', dynamic: 'Added at launch', enterprise: 'Managed' };
const STATUS = { connected: 'mcp-ok', pending: 'mcp-wait', failed: 'fail', 'needs-auth': 'mcp-wait', disabled: '' };
const STATUS_LABEL = { 'needs-auth': 'needs sign-in' };
const RAN = { direct: 'called directly', workspace: 'through Claude Code', session: 'in the session' };
const SIGN_IN_WAIT_MS = 5 * 60_000;

/** Arguments typed for a tool: nothing or a JSON object is a direct call; anything else is plain words. */
export function directArgs(input) {
  const text = String(input ?? '').trim();
  if (!text) return true;
  if (!text.startsWith('{')) return false;
  try {
    const v = JSON.parse(text);
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

export function initMcp({ api, $, esc, ago, md, toast, agents }) {
  const dialog = $('#mcp-dialog');
  const body = $('#mcp-body');
  let where = 'home';
  let data = null;
  let loading = false;
  let query = '';
  const results = new Map(); // "<where>:<tool id>" -> a run | { error } | { running } | { told }
  const forms = new Set(); // tool ids with their run form open
  const sure = new Set(); // destructive tools waiting for a second click
  const signIns = new Map(); // "<where>:<server>" -> { url, callback, local, since, error, busy }
  const reconnecting = new Set(); // "<where>:<server>"
  let watching = null;

  const sourceOf = (s) => SOURCE[s.source] ?? (String(s.source ?? '').startsWith('plugin') ? `Plugin${s.source.includes(':') ? `: ${s.source.split(':').slice(1).join(':')}` : ''}` : s.source ?? s.scope ?? '');

  async function load({ refresh = false, quiet = false } = {}) {
    if (!quiet) {
      loading = true;
      render();
    }
    const at = where;
    try {
      const next = await api('GET', `/mcp?agent=${encodeURIComponent(at)}${refresh ? '&refresh=1' : ''}`);
      if (at !== where) return;
      data = next;
    } catch (e) {
      if (at !== where) return;
      data = { servers: [], runs: [], error: e.message };
    } finally {
      loading = false;
    }
    // A sign-in is over once its server is connected.
    for (const s of data.servers ?? []) if (s.status === 'connected' && signIns.delete(`${where}:${s.name}`)) toast(`Signed in to ${s.name}`);
    render();
  }

  /** While a sign-in is open, look again every few seconds: the server connects by itself when it's done. */
  function watch() {
    clearInterval(watching);
    watching = setInterval(() => {
      for (const [k, v] of signIns) if (Date.now() - v.since > SIGN_IN_WAIT_MS) signIns.delete(k);
      if (!signIns.size || !dialog.open) return clearInterval(watching);
      if ([...signIns.keys()].some((k) => k.startsWith(`${where}:`))) load({ quiet: true });
    }, 3000);
  }

  function picker() {
    const list = agents().filter((a) => a.workdir && a.status !== 'preparing');
    return `<select id="mcp-where" title="Whose folder: an agent's workspace has its project's servers too. Each folder has its own MCP session">
      <option value="home" ${where === 'home' ? 'selected' : ''}>Home folder (your servers and connectors)</option>
      ${list.map((a) => `<option value="${esc(a.id)}" ${where === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
    </select>`;
  }

  const resultHtml = (r) =>
    r?.error
      ? `<p class="error">${esc(r.error)}</p>`
      : r?.text
        ? `<div class="mcp-result ${r.isError ? 'failed' : ''}"><p class="hint">${r.isError ? 'The tool reported an error · ' : ''}Ran ${ago(r.at)} in ${(r.ms / 1000).toFixed(1)} s, ${RAN[r.where] ?? ''}</p><div class="md">${md(r.text)}</div></div>`
        : r?.told
          ? `<p class="hint">Sent to ${esc(r.told)}. Its answer is in the session.</p>`
          : '';

  function toolHtml(s, t) {
    const key = `${where}:${t.id}`;
    const r = results.get(key);
    const agent = data.agent;
    const canSession = agent && agent.engine === 'claude';
    const open = forms.has(t.id);
    const tags = `${t.readOnly ? '<span class="tag mcp-ok" title="The server says it only reads">read-only</span>' : ''}${t.destructive ? '<span class="tag fail" title="The server says it may change or delete things">destructive</span>' : ''}`;
    const form = open
      ? `<div class="mcp-form">
          <textarea data-mcp-input="${esc(t.id)}" rows="2" placeholder='Its arguments as JSON, like {"query": "…"}, or nothing: called directly, no model. Or say what it should do in plain words: Claude Code works out the arguments.'></textarea>
          ${sure.has(t.id) ? `<p class="hint error">${esc(t.name)} may change or delete things. Click again to run it.</p>` : ''}
          <div class="mcp-actions">
            ${agent ? `<button type="button" class="small" data-mcp-run="session" data-server="${esc(s.name)}" data-tool="${esc(t.name)}" ${canSession ? '' : 'disabled'} title="${canSession ? `Tell ${esc(agent.name)} to use it, with its conversation and context${agent.running ? '' : ' (resumes the session)'}` : 'Works for Claude Code agents'}">Run in agent session</button>` : ''}
            <button type="button" class="small primary" data-mcp-run="here" data-server="${esc(s.name)}" data-tool="${esc(t.name)}" ${r?.running ? 'disabled' : ''} title="In this folder's MCP session, apart from the agent's: JSON arguments (or none) call the tool directly; plain words go through a one-off Claude Code call that may use only this tool">${r?.running ? 'Running…' : 'Run'}</button>
          </div>
        </div>`
      : '';
    return `<li class="mcp-tool">
      <div class="mcp-tool-row"><code title="${esc(t.id)}">${esc(t.name)}</code>${t.title ? ` <span class="hint">${esc(t.title)}</span>` : ''} ${tags}
        <span class="spacer"></span>${s.status === 'connected' ? `<button type="button" class="small ghost" data-mcp-form="${esc(t.id)}">${open ? 'Hide' : 'Run…'}</button>` : ''}</div>
      ${form}${resultHtml(r)}
    </li>`;
  }

  function signInHtml(s) {
    const si = signIns.get(`${where}:${s.name}`);
    if (!si) return s.status === 'needs-auth' ? '<p class="hint">Sign in to use its tools. Claude Code keeps the sign-in; this app never sees it.</p>' : '';
    if (si.busy) return '<p class="hint">Getting the sign-in page…</p>';
    if (si.error) return `<p class="error">${esc(si.error)}</p>`;
    return `<div class="mcp-signin">
      <p><a href="${esc(si.url)}" target="_blank" rel="noopener">Open the sign-in page ↗</a> <span class="hint">${si.callback ? 'When you finish there, this server connects by itself.' : 'When you have connected it there, press ↻ here.'}</span></p>
      ${si.callback ? `<details data-keep="cb:${esc(s.name)}"><summary class="hint">Signing in on another device, or the page at the end doesn't load?</summary>
        <p class="hint">The sign-in ends on an address on this computer (localhost). Copy that address from the browser and paste it here.</p>
        <div class="mcp-paste"><input type="text" data-mcp-callback="${esc(s.name)}" placeholder="http://localhost:…/callback?code=…" /><button type="button" class="small" data-mcp-callback-send="${esc(s.name)}">Finish sign-in</button></div>
      </details>` : ''}
    </div>`;
  }

  function serverHtml(s) {
    const q = query.toLowerCase();
    const tools = s.tools.filter((t) => !q || s.name.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || (t.title ?? '').toLowerCase().includes(q));
    if (q && !tools.length && !s.name.toLowerCase().includes(q)) return '';
    const busy = reconnecting.has(`${where}:${s.name}`);
    const needs = s.status === 'needs-auth';
    return `<details class="mcp-server" data-keep="srv:${esc(s.name)}" ${q || s.tools.length <= 12 ? 'open' : ''}>
      <summary><b>${esc(s.name)}</b> <span class="tag ${STATUS[s.status] ?? ''}">${esc(STATUS_LABEL[s.status] ?? s.status)}</span> <span class="tag">${esc(sourceOf(s))}</span>
        <span class="hint">${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}</span><span class="spacer"></span>
        ${needs && s.canSignIn ? `<button type="button" class="small primary" data-mcp-signin="${esc(s.name)}" title="Open ${esc(s.name)}'s sign-in page">Sign in</button>` : ''}
        ${s.status === 'disabled' ? '' : `<button type="button" class="small ghost mcp-again" data-mcp-reconnect="${esc(s.name)}" ${busy ? 'disabled' : ''} title="Connect ${esc(s.name)} again and list its tools${needs ? ' (after signing in)' : ''}" aria-label="Refresh ${esc(s.name)}">${busy ? '…' : '↻'}</button>`}</summary>
      ${s.target ? `<p class="hint mcp-target" title="${esc(s.transport ?? '')}">${esc(s.target)}</p>` : ''}
      ${s.error ? `<p class="error">${esc(s.error)}</p>` : ''}
      ${signInHtml(s)}
      ${tools.length ? `<ul class="mcp-tools">${tools.map((t) => toolHtml(s, t)).join('')}</ul>` : s.status === 'connected' ? '<p class="hint">No tools.</p>' : ''}
    </details>`;
  }

  function runsHtml() {
    const runs = data.runs ?? [];
    if (!runs.length) return '';
    return `<details class="mcp-runs" data-keep="runs"><summary><b>Runs in this MCP session</b> <span class="hint">${runs.length}, newest first</span></summary>
      <ul class="mcp-tools">${runs.map((r) => `<li class="mcp-tool"><details data-keep="run:${esc(r.at)}"><summary><code>${esc(r.server)}: ${esc(r.name)}</code> ${r.isError ? '<span class="tag fail">error</span>' : ''} <span class="hint">${ago(r.at)} · ${(r.ms / 1000).toFixed(1)} s · ${RAN[r.where] ?? ''}</span></summary>
        ${r.input ? `<p class="hint mcp-target">${esc(r.input)}</p>` : ''}<div class="mcp-result ${r.isError ? 'failed' : ''}"><div class="md">${md(r.text)}</div></div></details></li>`).join('')}</ul>
    </details>`;
  }

  function render() {
    if (!dialog.open) return;
    // What was typed, where the cursor is and what was folded all survive a redraw.
    const boxKey = (t) => (t?.dataset?.mcpInput ? `in:${t.dataset.mcpInput}` : t?.dataset?.mcpCallback ? `cb:${t.dataset.mcpCallback}` : null);
    const boxes = () => [...body.querySelectorAll('[data-mcp-input], [data-mcp-callback]')];
    const active = document.activeElement;
    const focus = boxKey(active) && { key: boxKey(active), from: active.selectionStart, to: active.selectionEnd };
    const typed = new Map(boxes().map((t) => [boxKey(t), t.value]));
    const folded = new Map([...body.querySelectorAll('details[data-keep]')].map((d) => [d.dataset.keep, d.open]));
    const n = data?.servers?.reduce((k, s) => k + s.tools.length, 0) ?? 0;
    $('#mcp-head').innerHTML = `${picker()}<input id="mcp-filter" type="search" placeholder="Filter servers and tools" value="${esc(query)}" />
      <button type="button" class="small" id="mcp-refresh" ${loading ? 'disabled' : ''} title="Start this folder's MCP session again: it reads the configuration again and connects to every server">${loading ? 'Listing…' : 'Refresh all'}</button>
      ${window.name === 'agentmgr-mcp' ? '' : '<button type="button" class="small ghost" id="mcp-window" title="Open this in its own window">↗ Window</button>'}`;
    body.innerHTML = loading && !data
      ? '<p class="hint">Starting the MCP session here and asking Claude Code for its servers (it connects to each one)…</p>'
      : !data
        ? ''
        : `<p class="hint">${data.servers.length} server${data.servers.length === 1 ? '' : 's'}, ${n} tool${n === 1 ? '' : 's'}${data.at ? `, listed ${ago(data.at)}` : ''}${data.dir ? ` in <code>${esc(data.dir)}</code>` : ''}. The same servers Claude Code has there: your own, the project's .mcp.json, claude.ai connectors and plugins. ${data.session ? `This folder's MCP session has been up since ${ago(data.session.startedAt)}; it is separate from any agent's session.` : ''}</p>
          ${data.error ? `<p class="error">${esc(data.error)}</p>` : ''}
          ${data.servers.map(serverHtml).join('') || (data.error ? '' : '<p class="hint">No MCP servers here. Add one with <code>claude mcp add</code>, or a .mcp.json in the project.</p>')}
          ${runsHtml()}`;
    for (const box of boxes()) {
      const key = boxKey(box);
      if (typed.has(key)) box.value = typed.get(key);
      if (focus?.key === key) {
        box.focus();
        box.setSelectionRange(focus.from, focus.to);
      }
    }
    for (const d of body.querySelectorAll('details[data-keep]')) if (folded.has(d.dataset.keep)) d.open = folded.get(d.dataset.keep);
  }

  async function run(btn) {
    const server = btn.dataset.server;
    const tool = btn.dataset.tool;
    const t = data.servers.find((s) => s.name === server)?.tools.find((x) => x.name === tool);
    if (!t) return;
    if (t.destructive && !sure.has(t.id)) {
      sure.add(t.id);
      return render();
    }
    sure.delete(t.id);
    const input = body.querySelector(`[data-mcp-input="${CSS.escape(t.id)}"]`)?.value ?? '';
    const key = `${where}:${t.id}`;
    if (btn.dataset.mcpRun === 'session') {
      try {
        await api('POST', '/mcp/run', { agent: where, server, tool, input, where: 'session' });
        results.set(key, { told: data.agent.name });
        toast(`Asked ${data.agent.name} to use ${tool}`);
      } catch (e) {
        results.set(key, { error: e.message });
      }
      return render();
    }
    results.set(key, { running: true });
    render();
    try {
      const r = await api('POST', '/mcp/run', { agent: where, server, tool, input, where: directArgs(input) ? 'direct' : 'workspace' });
      results.set(key, r);
      data.runs = [r, ...(data.runs ?? [])].slice(0, 30);
    } catch (e) {
      results.set(key, { error: e.message });
    }
    render();
  }

  /** Sign in: the page opens in a new tab at once (so the browser doesn't block it), then goes to the address. */
  async function signIn(name) {
    const key = `${where}:${name}`;
    const tab = window.open('', '_blank');
    signIns.set(key, { busy: true, since: Date.now() });
    render();
    try {
      const r = await api('POST', '/mcp/signin', { agent: where, server: name });
      if (!r.url) {
        tab?.close();
        signIns.delete(key);
        toast(`${name} is already signed in`);
        return load({ quiet: true });
      }
      signIns.set(key, { url: r.url, callback: r.callback, local: r.local, since: Date.now() });
      if (tab) tab.location = r.url;
      watch();
    } catch (e) {
      tab?.close();
      signIns.set(key, { error: e.message, since: Date.now() });
    }
    render();
  }

  async function reconnect(name) {
    const key = `${where}:${name}`;
    reconnecting.add(key);
    render();
    try {
      data = await api('POST', '/mcp/reconnect', { agent: where, server: name });
      const s = data.servers.find((x) => x.name === name);
      if (s?.status === 'connected') signIns.delete(key);
      toast(`${name}: ${STATUS_LABEL[s?.status] ?? s?.status ?? 'not listed'}${s?.status === 'connected' ? `, ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}` : ''}`);
    } catch (e) {
      toast(`${name}: ${e.message}`, 6000);
    } finally {
      reconnecting.delete(key);
    }
    render();
  }

  async function finishSignIn(name) {
    const url = body.querySelector(`[data-mcp-callback="${CSS.escape(name)}"]`)?.value.trim();
    if (!url) return;
    try {
      data = await api('POST', '/mcp/signin/callback', { agent: where, server: name, url });
      if (data.servers.find((x) => x.name === name)?.status === 'connected') {
        signIns.delete(`${where}:${name}`);
        toast(`Signed in to ${name}`);
      }
    } catch (e) {
      toast(e.message, 8000);
    }
    render();
  }

  dialog.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    // Buttons in a server's heading don't fold it.
    if (b.closest('summary')) e.preventDefault();
    if (b.id === 'mcp-close') return dialog.close();
    if (b.id === 'mcp-refresh') return load({ refresh: true });
    if (b.id === 'mcp-window') return void window.open(`/#mcp${where === 'home' ? '' : `/${where}`}`, 'agentmgr-mcp', 'width=1040,height=820');
    if (b.dataset.mcpSignin) return signIn(b.dataset.mcpSignin);
    if (b.dataset.mcpReconnect) return reconnect(b.dataset.mcpReconnect);
    if (b.dataset.mcpCallbackSend) return finishSignIn(b.dataset.mcpCallbackSend);
    if (b.dataset.mcpForm) {
      if (forms.has(b.dataset.mcpForm)) forms.delete(b.dataset.mcpForm);
      else forms.add(b.dataset.mcpForm);
      sure.delete(b.dataset.mcpForm);
      return render();
    }
    if (b.dataset.mcpRun) return run(b);
  });
  dialog.addEventListener('change', (e) => {
    if (e.target.id !== 'mcp-where') return;
    where = e.target.value;
    data = null;
    forms.clear();
    load();
  });
  dialog.addEventListener('input', (e) => {
    if (e.target.id !== 'mcp-filter') return;
    query = e.target.value.trim();
    const pos = e.target.selectionStart;
    render();
    const box = $('#mcp-filter');
    box.focus();
    box.setSelectionRange(pos, pos);
  });

  return {
    /** Open for an agent's workspace, or the home folder. */
    open(agentId = null) {
      const next = agentId ?? 'home';
      if (next !== where) {
        where = next;
        data = null;
        forms.clear();
      }
      if (!dialog.open) dialog.showModal();
      render();
      load();
    },
  };
}
