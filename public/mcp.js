// MCP: the MCP servers Claude Code has in an agent's folder (or the home folder), each with its
// status, where it comes from and its tools; any tool runs in the agent's session, or once in the
// workspace with only that tool allowed.

const SOURCE = { project: 'Project (.mcp.json)', user: 'User', local: 'Local', claudeai: 'claude.ai connector', dynamic: 'Added at launch', enterprise: 'Managed' };
const STATUS = { connected: 'mcp-ok', pending: 'mcp-wait', failed: 'fail', 'needs-auth': 'mcp-wait', disabled: '' };

export function initMcp({ api, $, esc, ago, md, toast, agents }) {
  const dialog = $('#mcp-dialog');
  const body = $('#mcp-body');
  let where = 'home';
  let data = null;
  let loading = false;
  let query = '';
  const results = new Map(); // "<where>:<tool id>" -> { text, ms, at } | { error } | { running }
  const forms = new Set(); // tool ids with their run form open
  const sure = new Set(); // destructive tools waiting for a second click

  const sourceOf = (s) => SOURCE[s.source] ?? (String(s.source ?? '').startsWith('plugin') ? `Plugin${s.source.includes(':') ? `: ${s.source.split(':').slice(1).join(':')}` : ''}` : s.source ?? s.scope ?? '');

  async function load(refresh = false) {
    loading = true;
    render();
    try {
      data = await api('GET', `/mcp?agent=${encodeURIComponent(where)}${refresh ? '&refresh=1' : ''}`);
    } catch (e) {
      data = { servers: [], error: e.message };
    } finally {
      loading = false;
    }
    render();
  }

  function picker() {
    const list = agents().filter((a) => a.workdir && a.status !== 'preparing');
    return `<select id="mcp-where" title="Whose folder: an agent's workspace has its project's servers too">
      <option value="home" ${where === 'home' ? 'selected' : ''}>Home folder (your servers and connectors)</option>
      ${list.map((a) => `<option value="${esc(a.id)}" ${where === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
    </select>`;
  }

  function toolHtml(s, t) {
    const key = `${where}:${t.id}`;
    const r = results.get(key);
    const agent = data.agent;
    const canSession = agent && agent.engine === 'claude';
    const open = forms.has(t.id);
    const tags = `${t.readOnly ? '<span class="tag mcp-ok" title="The server says it only reads">read-only</span>' : ''}${t.destructive ? '<span class="tag fail" title="The server says it may change or delete things">destructive</span>' : ''}`;
    const form = open
      ? `<div class="mcp-form">
          <textarea data-mcp-input="${esc(t.id)}" rows="2" placeholder="What it should do, or its arguments in plain words (optional)"></textarea>
          ${sure.has(t.id) ? `<p class="hint error">${esc(t.name)} may change or delete things. Click again to run it.</p>` : ''}
          <div class="mcp-actions">
            ${agent ? `<button type="button" class="small" data-mcp-run="session" data-server="${esc(s.name)}" data-tool="${esc(t.name)}" ${canSession ? '' : 'disabled'} title="${canSession ? `Tell ${esc(agent.name)} to use it, with its conversation and context${agent.running ? '' : ' (resumes the session)'}` : 'Works for Claude Code agents'}">Run in session</button>` : ''}
            <button type="button" class="small primary" data-mcp-run="workspace" data-server="${esc(s.name)}" data-tool="${esc(t.name)}" ${r?.running ? 'disabled' : ''} title="A separate one-off Claude Code call in ${agent ? 'the workspace' : 'your home folder'} that may use only this tool; the agent is not interrupted">${r?.running ? 'Running…' : `Run once in ${agent ? 'workspace' : 'home folder'}`}</button>
          </div>
        </div>`
      : '';
    const out = r?.error
      ? `<p class="error">${esc(r.error)}</p>`
      : r?.text
        ? `<div class="mcp-result"><p class="hint">Ran ${ago(r.at)} in ${(r.ms / 1000).toFixed(1)} s</p><div class="md">${md(r.text)}</div></div>`
        : r?.told
          ? `<p class="hint">Sent to ${esc(r.told)}. Its answer is in the session.</p>`
          : '';
    return `<li class="mcp-tool">
      <div class="mcp-tool-row"><code title="${esc(t.id)}">${esc(t.name)}</code>${t.title ? ` <span class="hint">${esc(t.title)}</span>` : ''} ${tags}
        <span class="spacer"></span>${s.status === 'connected' ? `<button type="button" class="small ghost" data-mcp-form="${esc(t.id)}">${open ? 'Hide' : 'Run…'}</button>` : ''}</div>
      ${form}${out}
    </li>`;
  }

  function serverHtml(s) {
    const q = query.toLowerCase();
    const tools = s.tools.filter((t) => !q || s.name.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || (t.title ?? '').toLowerCase().includes(q));
    if (q && !tools.length) return '';
    return `<details class="mcp-server" ${q || s.tools.length <= 12 ? 'open' : ''}>
      <summary><b>${esc(s.name)}</b> <span class="tag ${STATUS[s.status] ?? ''}">${esc(s.status)}</span> <span class="tag">${esc(sourceOf(s))}</span>
        <span class="hint">${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}</span></summary>
      ${s.target ? `<p class="hint mcp-target" title="${esc(s.transport ?? '')}">${esc(s.target)}</p>` : ''}
      ${s.error ? `<p class="error">${esc(s.error)}</p>` : ''}
      ${s.status === 'needs-auth' ? '<p class="hint">Sign in to it from Claude Code (/mcp) to use its tools.</p>' : ''}
      ${tools.length ? `<ul class="mcp-tools">${tools.map((t) => toolHtml(s, t)).join('')}</ul>` : s.status === 'connected' ? '<p class="hint">No tools.</p>' : ''}
    </details>`;
  }

  function render() {
    if (!dialog.open) return;
    const focus = document.activeElement?.dataset?.mcpInput;
    const typed = Object.fromEntries([...body.querySelectorAll('[data-mcp-input]')].map((t) => [t.dataset.mcpInput, t.value]));
    const n = data?.servers?.reduce((k, s) => k + s.tools.length, 0) ?? 0;
    $('#mcp-head').innerHTML = `${picker()}<input id="mcp-filter" type="search" placeholder="Filter servers and tools" value="${esc(query)}" />
      <button type="button" class="small" id="mcp-refresh" ${loading ? 'disabled' : ''} title="Ask Claude Code again (it connects to each server)">${loading ? 'Listing…' : 'Refresh'}</button>`;
    body.innerHTML = loading && !data
      ? '<p class="hint">Asking Claude Code for its MCP servers here (it connects to each one)…</p>'
      : !data
        ? ''
        : `<p class="hint">${data.servers.length} server${data.servers.length === 1 ? '' : 's'}, ${n} tool${n === 1 ? '' : 's'}${data.at ? `, listed ${ago(data.at)}` : ''}${data.dir ? ` in <code>${esc(data.dir)}</code>` : ''}. The same servers Claude Code has there: your own, the project's .mcp.json, claude.ai connectors and plugins.</p>
          ${data.error ? `<p class="error">${esc(data.error)}</p>` : ''}
          ${data.servers.map(serverHtml).join('') || (data.error ? '' : '<p class="hint">No MCP servers here. Add one with <code>claude mcp add</code>, or a .mcp.json in the project.</p>')}`;
    for (const [id, v] of Object.entries(typed)) {
      const box = body.querySelector(`[data-mcp-input="${CSS.escape(id)}"]`);
      if (box) box.value = v;
    }
    if (focus) body.querySelector(`[data-mcp-input="${CSS.escape(focus)}"]`)?.focus();
  }

  async function run(btn) {
    const how = btn.dataset.mcpRun;
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
    if (how === 'session') {
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
      results.set(key, await api('POST', '/mcp/run', { agent: where, server, tool, input, where: 'workspace' }));
    } catch (e) {
      results.set(key, { error: e.message });
    }
    render();
  }

  dialog.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'mcp-close') return dialog.close();
    if (b.id === 'mcp-refresh') return load(true);
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
      dialog.showModal();
      render();
      load();
    },
  };
}
