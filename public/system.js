// OS: the computer the agents run on and how loaded it is right now. The basics (name, system,
// processor, memory, disks), the load with its last ten minutes, what each open agent session
// takes, and the busiest processes. Read again every few seconds while the window is open.

import { expandButton, expandable } from './expand.js';
import { morph } from './morph.js';

const EVERY_MS = 3000;
const LEVEL = { light: 'Light load', busy: 'Busy', heavy: 'Heavy load' };

/** 1536 MB, 12.4 GB. */
export const bytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round((n ?? 0) / 1024 ** 2)} MB`);
/** 3d 4h, 5h 12m, 9m. */
export const span = (sec) => (sec >= 86400 ? `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h` : sec >= 3600 ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m` : `${Math.floor(sec / 60)}m`);

export function initSystem({ api, $, esc, toast, openAgent, openPort }) {
  const dialog = $('#os-dialog');
  const body = $('#os-body');
  let data = null;
  let problem = null;
  let local = null;
  let timer = null;

  async function load() {
    try {
      data = await api('GET', '/system');
      problem = null;
      // The model servers running here (asked again by the daemon every few seconds at most).
      local = await api('GET', '/local-models').catch(() => local);
    } catch (e) {
      problem = e.message;
    }
    if (dialog.open) render();
  }

  const tone = (p) => (p >= 90 ? 'heavy' : p >= 70 ? 'busy' : 'light');
  const meter = (p) => `<div class="os-meter ${tone(p)}" role="img" aria-label="${p}%"><span style="width:${Math.min(100, Math.max(0, p))}%"></span></div>`;

  /** An agent's lane, what it listens on (a port outside its lane marked), and who else holds a port of its lane. */
  function portsCell(a) {
    const open = (a.ports ?? []).map((p) => `<button class="link${a.lane && !p.inLane ? ' os-port-out' : ''}" data-os-port="${p.port}" data-os-port-agent="${esc(a.id)}" title="${esc(p.name)} (PID ${p.pid}) listens on ${p.port}${a.lane && !p.inLane ? ': outside its lane' : ''}. Open it">${p.port}</button>`).join(' ');
    const taken = (a.taken ?? []).map((t) => `<span class="os-port-out" title="${esc(t.name)} (PID ${t.pid})${t.by ? ', started by another agent,' : ''} holds ${t.port}, a port of this agent's lane">${t.port} taken</span>`).join(' ');
    const lane = a.lane ? `<span class="hint" title="Lane ${a.lane.n}: its own ports. Names it creates end with ${esc(a.lane.suffix)}">${a.lane.first}–${a.lane.last}</span>` : '';
    return [lane, open, taken].filter(Boolean).join(' · ') || '<span class="hint">—</span>';
  }

  /** The last ten minutes of one measure (0 to 100) as a small line. */
  function spark(points, label) {
    if (points.length < 2) return '<div class="os-spark hint">Its last ten minutes are drawn as they pass.</div>';
    const w = 240;
    const h = 44;
    const top = Math.max(100, ...points);
    const xy = points.map((v, i) => `${((i / (points.length - 1)) * w).toFixed(1)},${(h - 2 - (v / top) * (h - 4)).toFixed(1)}`);
    return `<svg class="os-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
      <polygon points="0,${h} ${xy.join(' ')} ${w},${h}"></polygon><polyline points="${xy.join(' ')}"></polyline></svg>`;
  }

  // A model named by its file (llama.cpp) is shown by the file's name; the whole of it is in the title.
  const short = (id) => (id.length > 60 && id.includes('//') ? `${id.slice(0, id.indexOf('/'))}/…${id.slice(id.lastIndexOf('/'))}`.replace(/(.{28}).+(.{12})$/, '$1…$2') : id);

  /** Models served on this computer, for agents on the "Local model" engine. */
  function localHtml() {
    const servers = (local?.servers ?? []).filter((s) => s.running);
    if (!local?.enabled || !servers.length) return '';
    const models = servers.flatMap((s) => s.models.map((m) => ({ ...m, server: s })));
    const harnesses = (local.harnesses ?? []).filter((h) => h.installed);
    return `<h3 title="Models served on this computer. Start an agent on one with a Local engine: the harness (Codex, OpenCode or Claude Code) is pointed at the server">Local models <span class="hint">${servers.map((s) => `${esc(s.label)}${s.version ? ` ${esc(s.version)}` : ''}`).join(', ')}${harnesses.length ? ` · run by ${harnesses.map((h) => esc(h.label)).join(', ')}` : ''}</span></h3>
      ${models.length
        ? `<table class="issues os-table os-local"><thead><tr><th>Model</th><th class="num">Size</th><th title="Whether an agent can work with it: it has to call tools to read and change files">For agents</th></tr></thead><tbody>
            ${models.map((m) => `<tr class="${m.usable ? '' : 'os-local-no'}"><td><code title="${esc(m.id)}">${esc(short(m.id))}</code>${m.loaded ? ' <span class="tag" title="In memory now">loaded</span>' : ''}${m.notes.length ? `<div class="hint">${esc(m.notes.join('. '))}</div>` : ''}</td><td class="num">${[m.sizeBytes ? bytes(m.sizeBytes) : '', esc(m.params ?? '')].filter(Boolean).join(' · ')}</td><td>${m.usable ? 'Yes' : '<span class="os-port-out">No</span>'}</td></tr>`).join('')}
          </tbody></table>`
        : '<p class="hint">No model yet.</p>'}`;
  }

  const row = (k, v) => (v ? `<tr><th>${esc(k)}</th><td>${v}</td></tr>` : '');

  function draw() {
    if (!data) return `<div class="issues-head"><h2>OS</h2><span class="spacer"></span><button class="small" data-os="close">Close</button></div><p class="hint">${problem ? esc(problem) : 'Loading…'}</p>`;
    const { host, cpu, memory: mem, disks, agents, processes, app, history, lanes } = data;
    const minutes = Math.max(1, Math.round((history.length * data.sampleSeconds) / 60));
    return `
      <div class="issues-head">
        <h2>OS</h2>
        <span class="tag os-level ${esc(data.level)}" title="From the processor in use, the load per core and the memory in use">${esc(LEVEL[data.level] ?? data.level)}</span>
        <span class="hint os-host">${esc(host.name)} · ${esc(host.os)}</span>
        <span class="spacer"></span>
        ${expandButton(dialog)}
        <button class="small" data-os="close" title="Close (Esc)">Close</button>
      </div>
      ${problem ? `<p class="issues-problem">${esc(problem)}</p>` : ''}
      <div class="issues-scroll os-scroll">
        <div class="value-cards os-cards">
          <div class="value-card" data-os-card="cpu">
            <div class="hint">Processor</div>
            <div class="value-big">${cpu.percent}%</div>
            ${meter(cpu.percent)}
            <div class="hint" title="How many processes wanted the processor, averaged over 1, 5 and 15 minutes. Above the number of cores (${cpu.cores}), work is waiting">Load ${cpu.load.map((l) => l.toFixed(2)).join(' · ')} on ${cpu.cores} cores</div>
            ${spark(history.map((p) => p.cpu), `Processor in use, last ${minutes} minutes`)}
          </div>
          <div class="value-card" data-os-card="memory">
            <div class="hint">Memory</div>
            <div class="value-big">${mem.percent}%</div>
            ${meter(mem.percent)}
            <div class="hint">${bytes(mem.used)} of ${bytes(mem.total)} in use${mem.swap ? ` · swap ${bytes(mem.swap.used)} of ${bytes(mem.swap.total)}` : ''}</div>
            ${spark(history.map((p) => p.mem), `Memory in use, last ${minutes} minutes`)}
          </div>
          <div class="value-card" data-os-card="disk">
            <div class="hint">Disk</div>
            ${disks.length
              ? disks.map((d) => `<div class="os-disk" title="${esc(d.path)}"><div class="value-big">${d.percent}%</div>${meter(d.percent)}<div class="hint">${esc(d.label)}: ${bytes(d.free)} free of ${bytes(d.total)}</div></div>`).join('')
              : '<div class="hint">Not available on this system.</div>'}
          </div>
          <div class="value-card" data-os-card="agents">
            <div class="hint">Agent sessions</div>
            <div class="value-big">${agents.open}</div>
            <div class="hint">open${agents.open ? `, taking ${agents.cpu}% of a core and ${bytes(agents.mem)}` : ''}</div>
            <div class="hint" title="AI Agent Manager's own background process">The app itself: ${bytes(app.mem)}${app.cpu != null ? ` · ${app.cpu}%` : ''}</div>
          </div>
        </div>
        <div class="os-cols">
          <section>
            <h3>This computer</h3>
            <table class="os-facts"><tbody>
              ${row('Name', esc(host.name))}
              ${row('System', esc(host.os))}
              ${row('Kernel', `${esc(host.kernel)} · ${esc(host.arch)}`)}
              ${row('Processor', cpu.model ? `${esc(cpu.model)} · ${cpu.cores} cores` : `${cpu.cores} cores`)}
              ${row('Memory', bytes(mem.total))}
              ${row('Up for', span(host.uptime))}
              ${row('User', host.user ? esc(host.user) : '')}
              ${row('Addresses', host.addresses.map((a) => `${esc(a.address)} <span class="hint">${esc(a.nic)}</span>`).join(', '))}
              ${row('AI Agent Manager', `${app.version ? `${esc(app.version)} · ` : ''}up ${span(app.uptime)} · Node ${esc(app.node.replace(/^v/, ''))}`)}
            </tbody></table>
          </section>
          <section>
            <h3>Agent sessions <span class="hint">${agents.open}</span></h3>
            ${agents.list.length
              ? `<table class="issues os-table"><thead><tr><th>Agent</th><th class="num" title="Of one core: 200% is two cores busy">Processor</th><th class="num">Memory</th><th class="num" title="The session and everything it started">Processes</th><th title="Its own range of ports, and what it listens on now">Ports</th></tr></thead><tbody>
                  ${agents.list.map((a) => `<tr><td><button class="link" data-os-agent="${esc(a.id)}">${esc(a.name)}</button></td><td class="num">${a.cpu}%</td><td class="num">${bytes(a.mem)}</td><td class="num">${a.count}</td><td class="os-ports">${portsCell(a)}</td></tr>`).join('')}
                </tbody></table>`
              : '<p class="hint">No agent session is open.</p>'}
            ${lanes ? `<div class="os-lanes"><label title="Each agent gets a range of ports and a name ending no other agent has, in its environment (AGENT_PORTS, AGENT_SUFFIX) and its instructions, so dev servers and test databases of agents working side by side don't collide. For sessions started from now on"><input type="checkbox" data-os-lanes="enabled" ${lanes.enabled ? 'checked' : ''} /> A lane of ports for each agent</label>${lanes.enabled ? `<label title="Many dev servers listen on PORT when it is set. Turn off if your projects use PORT for something else"><input type="checkbox" data-os-lanes="port" ${lanes.port ? 'checked' : ''} /> Set PORT to its first port</label><span class="hint">${lanes.size} port${lanes.size === 1 ? '' : 's'} each, from ${lanes.base}</span>` : ''}</div>` : ''}
            ${localHtml()}
            <h3>Busiest processes <span class="hint">of ${processes.count}</span></h3>
            <table class="issues os-table"><thead><tr><th>Process</th><th class="num" title="Of one core: 200% is two cores busy">Processor</th><th class="num">Memory</th><th class="num">PID</th></tr></thead><tbody>
              ${processes.top.map((p) => `<tr><td title="${esc(p.command)}">${esc(p.name)}</td><td class="num">${p.cpu}%</td><td class="num">${bytes(p.mem)}</td><td class="num hint">${p.pid}</td></tr>`).join('')}
            </tbody></table>
          </section>
        </div>
        <p class="hint">Read again every ${EVERY_MS / 1000} seconds while this is open. Processor and memory per process come from <code>ps</code>; nothing leaves this computer.</p>
      </div>`;
  }

  // Redrawn in place, so the list keeps its scroll and a pointer over a row doesn't lose it.
  const render = () => morph(body, draw());

  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-os="close"]')) return dialog.close();
    const port = e.target.closest('[data-os-port]');
    if (port) {
      dialog.close();
      return openPort?.(port.dataset.osPortAgent, Number(port.dataset.osPort));
    }
    const a = e.target.closest('[data-os-agent]');
    if (a) {
      dialog.close();
      openAgent?.(a.dataset.osAgent);
    }
  });
  // Lanes on or off, and PORT with them: for the sessions started from now on.
  body.addEventListener('change', async (e) => {
    const key = e.target.dataset?.osLanes;
    if (!key) return;
    try {
      const { enabled, base, size, port } = await api('PUT', '/lanes', { [key]: e.target.checked });
      if (data) data.lanes = { enabled, base, size, port };
      toast?.(key === 'port' ? (port ? 'PORT is set for sessions started from now on' : 'PORT is left alone in sessions started from now on') : enabled ? 'Each agent gets its own ports, in sessions started from now on' : 'No lanes for sessions started from now on', 4000);
    } catch (err) {
      toast?.(err.message, 5000);
    }
    render();
  });

  dialog.addEventListener('close', () => {
    clearInterval(timer);
    timer = null;
  });

  function open() {
    if (dialog.open) return dialog.close();
    dialog.showModal();
    render();
    load().catch((e) => toast?.(e.message, 5000));
    timer = setInterval(load, EVERY_MS);
  }

  expandable(dialog, render);
  return { open, isOpen: () => dialog.open };
}
