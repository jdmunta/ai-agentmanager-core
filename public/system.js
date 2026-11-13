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

export function initSystem({ api, $, esc, toast, openAgent }) {
  const dialog = $('#os-dialog');
  const body = $('#os-body');
  let data = null;
  let problem = null;
  let timer = null;

  async function load() {
    try {
      data = await api('GET', '/system');
      problem = null;
    } catch (e) {
      problem = e.message;
    }
    if (dialog.open) render();
  }

  const tone = (p) => (p >= 90 ? 'heavy' : p >= 70 ? 'busy' : 'light');
  const meter = (p) => `<div class="os-meter ${tone(p)}" role="img" aria-label="${p}%"><span style="width:${Math.min(100, Math.max(0, p))}%"></span></div>`;

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

  const row = (k, v) => (v ? `<tr><th>${esc(k)}</th><td>${v}</td></tr>` : '');

  function draw() {
    if (!data) return `<div class="issues-head"><h2>OS</h2><span class="spacer"></span><button class="small" data-os="close">Close</button></div><p class="hint">${problem ? esc(problem) : 'Loading…'}</p>`;
    const { host, cpu, memory: mem, disks, agents, processes, app, history } = data;
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
              ? `<table class="issues os-table"><thead><tr><th>Agent</th><th class="num" title="Of one core: 200% is two cores busy">Processor</th><th class="num">Memory</th><th class="num" title="The session and everything it started">Processes</th></tr></thead><tbody>
                  ${agents.list.map((a) => `<tr><td><button class="link" data-os-agent="${esc(a.id)}">${esc(a.name)}</button></td><td class="num">${a.cpu}%</td><td class="num">${bytes(a.mem)}</td><td class="num">${a.count}</td></tr>`).join('')}
                </tbody></table>`
              : '<p class="hint">No agent session is open.</p>'}
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
    const a = e.target.closest('[data-os-agent]');
    if (a) {
      dialog.close();
      openAgent?.(a.dataset.osAgent);
    }
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
