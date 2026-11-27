// Map: a repository's folders as tiles sized by their files, with each agent as a badge on the
// folders it is changing (solid) or reading (ring) now. A red line joins two agents that changed
// the same file; a dashed one runs from an agent reading a file to the agent that changed it.
// The Bugs view colours each folder by the bugs hunts found there (worst weigh most) and how much it
// changed lately, draws the paths through the code those bugs take as arrows between folders, and
// hatches the folders no hunt has looked at. Click a folder or an arrow for its bugs, or Hunt here.
// The Design view (design.js) draws the code itself in layers, an agent's changes lit up; the
// Logical view (logical.js), its components and the links between them that imports don't show.

import { drawDesign, partName } from './design.js';
import { drawLogical } from './logical.js';

const SAVED = 'agentmgr.mapProject';
const LAYER = 'agentmgr.mapLayer';
const SEV = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const EVERY_MS = 8000;

const hue = (id) => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 17);
const initials = (name) => String(name).split(/[^a-z0-9]+/i).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

/** Squarified treemap: items [{ weight }] into the rectangle, as [{ x, y, w, h, item }]. */
export function squarify(items, x, y, w, h) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (!items.length || total <= 0 || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  const out = [];
  let rest = items.map((item) => ({ item, area: item.weight * scale }));
  const worst = (row, side) => {
    const s = row.reduce((a, r) => a + r.area, 0);
    const max = Math.max(...row.map((r) => r.area));
    const min = Math.min(...row.map((r) => r.area));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  while (rest.length) {
    const side = Math.min(w, h);
    let row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) row.push(rest[i++]);
    rest = rest.slice(i);
    const s = row.reduce((a, r) => a + r.area, 0);
    if (w >= h) {
      const rw = s / h;
      let yy = y;
      for (const r of row) {
        const rh = r.area / rw;
        out.push({ x, y: yy, w: rw, h: rh, item: r.item });
        yy += rh;
      }
      x += rw;
      w -= rw;
    } else {
      const rh = s / w;
      let xx = x;
      for (const r of row) {
        const rw = r.area / rh;
        out.push({ x: xx, y, w: rw, h: rh, item: r.item });
        xx += rw;
      }
      y += rh;
      h -= rh;
    }
  }
  return out;
}

export function initCodeMap({ api, $, esc, agents, openAgent, openBugs, openCode, toast }) {
  const view = $('#map-view');
  let open = false;
  let data = null;
  let timer = null;
  let project = null;
  let layer = 'agents';
  let picked = null; // in the Bugs and Speed views: { module } or { from, to }
  // The Design view: the layer shown (a folder or file, '' for the system), the agent whose changes
  // are lit up, and whether to go to where its changes are on the next load.
  let designAt = '';
  let designAgent = null;
  let designFocus = false;
  let describing = false;
  let designOnly = true; // with an agent picked: only its changes and what uses them, in a busy layer
  // Changing the design: { at, mode, changes, pick }, each layer's kept while away from it; the
  // panel under the head (asking about a box, or the request written); a box being dragged.
  let designEdit = null;
  const designEdits = new Map();
  let designPanel = null;
  let dragging = null;
  let dragged = false;
  // The Logical view: the box or arrow tapped ({ kind: 'box', id } or { kind: 'edge', from, to }).
  let logicalPick = null;
  let logicalAll = false;
  let findingParts = false;
  try {
    project = localStorage.getItem(SAVED) || null;
    layer = ['bugs', 'speed', 'design', 'logical'].includes(localStorage.getItem(LAYER)) ? localStorage.getItem(LAYER) : 'agents';
  } catch {}

  const nameOf = (id) => data?.map.agents.find((a) => a.id === id)?.name ?? agents.get(id)?.name ?? id;
  const color = (id) => `hsl(${hue(id)} 70% 55%)`;

  async function load() {
    if (layer === 'design') return loadDesign();
    if (layer === 'logical') return loadLogical();
    try {
      const q = new URLSearchParams({ ...(project ? { project } : {}), ...(layer !== 'agents' ? { layer } : {}) });
      data = await api('GET', `/codemap${q.size ? `?${q}` : ''}`);
      if (data.project && data.project.key !== project) project = data.project.key;
    } catch (e) {
      toast?.(e.message, 5000);
    }
    draw();
  }

  async function loadDesign() {
    const before = JSON.stringify(data);
    try {
      const q = new URLSearchParams({ ...(project ? { project } : {}), ...(designAgent ? { agent: designAgent } : {}), ...(designFocus ? { focus: '1' } : designAt ? { at: designAt } : {}) });
      data = await api('GET', `/layers${q.size ? `?${q}` : ''}`);
      if (data.project && data.project.key !== project) project = data.project.key;
      designFocus = false;
      designAt = data.layer?.at ?? '';
      designAgent = data.agent;
    } catch (e) {
      toast?.(e.message, 5000);
    }
    // Another layer: its own changes drawn, if any; a panel about this one goes.
    if (designEdit && designEdit.at !== designAt) {
      if (designEdit.changes.length) designEdits.set(designEdit.at, designEdit);
      designEdit = designEdits.get(designAt) ?? null;
      designPanel = null;
    }
    if (designPanel?.at !== undefined && designPanel.at !== designAt) designPanel = null;
    // The refresh every few seconds draws again only when something changed (a picker left open
    // stays), and not while writing in the panel or dragging.
    if ((designPanel || dragging) && $('#map-box').childElementCount) return;
    if (JSON.stringify(data) !== before || !$('#map-box').childElementCount) draw();
  }

  async function loadLogical() {
    const before = JSON.stringify(data);
    try {
      const q = new URLSearchParams({ ...(project ? { project } : {}), ...(designAgent ? { agent: designAgent } : {}) });
      data = await api('GET', `/logical${q.size ? `?${q}` : ''}`);
      if (data.project && data.project.key !== project) project = data.project.key;
      designAgent = data.agent;
    } catch (e) {
      toast?.(e.message, 5000);
    }
    if (JSON.stringify(data) !== before || !$('#map-box').childElementCount) draw();
  }

  /** The components found by a model; the view waits for it (a minute or two). */
  async function findComponents() {
    findingParts = true;
    draw();
    try {
      data = await api('POST', '/logical/describe', { project, ...(designAgent ? { agent: designAgent } : {}) });
      logicalPick = null;
    } catch (e) {
      toast?.(e.message, 6000);
    }
    findingParts = false;
    draw();
  }

  /** The layer described by a model; the view waits for it (a minute or so). */
  async function describeLayer() {
    describing = true;
    draw();
    try {
      data = await api('POST', '/layers/describe', { project, ...(designAgent ? { agent: designAgent } : {}), at: designAt });
      designAt = data.layer?.at ?? designAt;
    } catch (e) {
      toast?.(e.message, 6000);
    }
    describing = false;
    draw();
  }

  // ---------------------------------------------------------------- changing the design

  const boxKind = (id) => (String(id).startsWith('new:') ? 'new' : data?.layer?.boxes?.find((b) => b.id === id)?.kind);
  const boxName = (id) => (String(id).startsWith('new:') ? id.slice(4) : data?.layer?.boxes?.find((b) => b.id === id)?.name ?? id);

  /** A change drawn from one box to another, as the mode says. */
  function addChange(from, to) {
    const e = designEdit;
    if (!e || from === to) return;
    const same = (c) => c.from === from && c.to === to;
    if (e.mode === 'move') {
      if (!['file', 'folder'].includes(boxKind(from)) || boxKind(to) !== 'folder') return toast?.('Only a file or folder moves, and only into a folder', 4000);
      e.changes = [...e.changes.filter((c) => !(c.kind === 'move' && c.from === from)), { kind: 'move', from, to }];
    } else if (e.changes.some((c) => c.kind === 'unuse' && same(c))) e.changes = e.changes.filter((c) => !(c.kind === 'unuse' && same(c)));
    else if (data.layer.edges.some(same)) return toast?.(`${boxName(from)} uses ${boxName(to)} already`, 3000);
    else if (!e.changes.some((c) => c.kind === 'use' && same(c))) e.changes = [...e.changes, { kind: 'use', from, to }];
    draw();
  }

  /** A box tapped while changing: the first is where the change starts, the second where it goes. */
  function tapBox(id) {
    if (!designEdit) return;
    if (!designEdit.pick) designEdit.pick = id;
    else if (designEdit.pick === id) designEdit.pick = null;
    else {
      const from = designEdit.pick;
      designEdit.pick = null;
      return addChange(from, id);
    }
    draw();
  }

  async function designSend() {
    const p = designPanel;
    if (!p || p.sending) return;
    if (p.kind !== 'request' && p.text.trim().length < 3) return toast?.(p.kind === 'debug' ? 'Say what to debug' : 'Say what to ask', 3000);
    p.sending = true;
    draw();
    const base = { project, ...(designAgent ? { agent: designAgent } : {}), at: designAt, to: p.to };
    try {
      const r =
        p.kind === 'request'
          ? await api('POST', '/layers/request', { ...base, changes: designEdit?.changes ?? [], text: p.text })
          : await api('POST', '/layers/ask', { ...base, id: p.id, kind: p.kind, text: p.text });
      const did = p.kind === 'request' ? `Request sent to ${r.agent.name}` : p.kind === 'debug' ? `Debug started in ${r.agent.name}` : `Asked ${r.agent.name}`;
      toast?.(did, 5000, { label: 'Open', run: () => (show(false), openAgent(r.agent.id)) });
      if (p.kind === 'request') {
        designEdits.delete(designAt);
        designEdit = null;
      }
      designPanel = null;
      draw();
      return load();
    } catch (e) {
      p.sending = false;
      toast?.(e.message, 6000);
      draw();
    }
  }

  async function designPreview() {
    try {
      const r = await api('POST', '/layers/request', { project, ...(designAgent ? { agent: designAgent } : {}), at: designAt, changes: designEdit.changes, preview: true });
      designPanel = { kind: 'request', at: designAt, text: r.text, to: designAgent ?? data.from?.id };
      designEdit.pick = null;
      draw();
    } catch (e) {
      toast?.(e.message, 6000);
    }
  }

  /** A click in the Design view's own controls; true when it was one. */
  function designClick(e) {
    const t = e.target;
    const on = (sel) => t.closest(sel);
    const menu = on('[data-design-menu]');
    if (menu) {
      const id = menu.dataset.designMenu;
      designPanel = { kind: 'ask', at: designAt, id, name: data.layer.kind === 'file' ? id : boxName(id), text: '', to: designAgent ?? data.from?.id };
    } else if (on('[data-design-kind]') && designPanel) designPanel.kind = on('[data-design-kind]').dataset.designKind;
    else if (on('[data-design-cancel]')) designPanel = null;
    else if (on('[data-design-send]')) return designSend(), true;
    else if (on('[data-design-edit]')) {
      if (designEdit) {
        if (designEdit.changes.length) designEdits.set(designAt, designEdit);
        designEdit = null;
      } else designEdit = designEdits.get(designAt) ?? { at: designAt, mode: 'use', changes: [], pick: null };
      designPanel = null;
    } else if (on('[data-design-mode]') && designEdit) {
      designEdit.mode = on('[data-design-mode]').dataset.designMode;
      designEdit.pick = null;
    } else if (on('[data-design-undo]') && designEdit) {
      const [gone] = designEdit.changes.splice(Number(on('[data-design-undo]').dataset.designUndo), 1);
      // A new part taken back takes its arrows with it.
      if (gone?.kind === 'new') designEdit.changes = designEdit.changes.filter((c) => c.from !== `new:${gone.name}` && c.to !== `new:${gone.name}`);
    } else if (on('[data-design-clear]') && designEdit) {
      designEdit.changes = [];
      designEdit.pick = null;
    } else if (on('[data-design-preview]') && designEdit?.changes.length) return designPreview(), true;
    else if (on('[data-design-edge]') && designEdit) {
      const [from, to] = JSON.parse(on('[data-design-edge]').dataset.designEdge);
      const cut = (c) => c.kind === 'unuse' && c.from === from && c.to === to;
      designEdit.changes = designEdit.changes.some(cut) ? designEdit.changes.filter((c) => !cut(c)) : [...designEdit.changes, { kind: 'unuse', from, to }];
    } else if (on('[data-design-box]')) {
      // The click after a drag is not a tap.
      if (dragged) dragged = false;
      else tapBox(on('[data-design-box]').dataset.designBox);
      return true;
    } else if (on('[data-design-show]')) {
      designAgent = on('[data-design-show]').dataset.designShow;
      return load(), true;
    } else if (on('[data-design-dismiss]')) {
      api('DELETE', `/layers/request/${encodeURIComponent(on('[data-design-dismiss]').dataset.designDismiss)}`)
        .catch((err) => toast?.(err.message, 5000))
        .then(load);
      return true;
    } else return false;
    draw();
    return true;
  }

  function sentence(l) {
    const a = `<button class="link" data-map-open="${esc(l.a)}">${esc(nameOf(l.a))}</button>`;
    const b = `<button class="link" data-map-open="${esc(l.b)}">${esc(nameOf(l.b))}</button>`;
    const files = l.files.slice(0, 3).map((f) => `<code>${esc(f)}</code>`).join(', ') + (l.files.length > 3 ? ` and ${l.files.length - 3} more` : '');
    if (l.kind === 'collide') return `<li class="collide">${a} and ${b} both changed ${files}: they will conflict when merged.</li>`;
    if (l.kind === 'heading') return `<li class="heading">${a} is reading ${files}, which ${b} changed: heading for the same code.</li>`;
    return '';
  }

  function draw() {
    if (!open) return;
    const m = data?.map;
    const projects = data?.projects ?? [];
    $('#map-bar').innerHTML = `
      <b>Map</b>
      ${projects.length ? `<select data-map-set="project" aria-label="Project">${projects.map((p) => `<option value="${esc(p.key)}" ${p.key === data?.project?.key ? 'selected' : ''}>${esc(p.name)} (${p.running} running)</option>`).join('')}</select>` : ''}
      <span class="chips map-layers" role="tablist"><button class="chip ${layer === 'agents' ? 'active' : ''}" data-map-layer="agents" role="tab" aria-selected="${layer === 'agents'}">Agents</button><button class="chip ${layer === 'bugs' ? 'active' : ''}" data-map-layer="bugs" role="tab" aria-selected="${layer === 'bugs'}" title="Where hunts found bugs, and the paths through the code they take">Bugs</button><button class="chip ${layer === 'speed' ? 'active' : ''}" data-map-layer="speed" role="tab" aria-selected="${layer === 'speed'}" title="Modules where speed matters: micro benchmarks for the Jira issues that change them">Speed</button><button class="chip ${layer === 'design' ? 'active' : ''}" data-map-layer="design" role="tab" aria-selected="${layer === 'design'}" title="The code in layers, from the system in: its parts and the imports between them, an agent's changes and what uses them lit up">Design</button><button class="chip ${layer === 'logical' ? 'active' : ''}" data-map-layer="logical" role="tab" aria-selected="${layer === 'logical'}" title="The system's components and the links between them that imports don't show: HTTP routes called, programs run, files, outside services, and the data each carries">Logical</button></span>
      ${layer === 'logical'
        ? '<span class="map-legend"><span class="map-key logical-http"></span>HTTP or live stream <span class="map-key logical-code"></span>code imports <span class="map-key logical-ext"></span>to the outside <span class="map-key logical-guessed"></span>guessed by the model</span>'
        : layer === 'design'
        ? '<span class="map-legend"><span class="map-key design-changed"></span>changed by the agent <span class="map-key design-dependent"></span>uses what it changed <span class="map-key arrow"></span>uses (callers above)</span>'
        : layer === 'speed'
        ? `<span class="map-legend"><span class="map-key watched"></span>benchmarked <span class="map-key slower"></span>last issue made it over ${data?.speed?.slowerPct ?? 5}% slower <span class="map-key faster"></span>faster</span>`
        : layer === 'bugs'
        ? '<span class="map-legend"><span class="map-key heat"></span>bugs (worst weigh most) and recent changes <span class="map-key arrow"></span>path a bug takes <span class="map-key cold"></span>no hunt has looked here</span>'
        : '<span class="map-legend"><span class="map-key solid"></span>changing <span class="map-key ring"></span>reading <span class="map-key red"></span>same file changed <span class="map-key dash"></span>reading what another changed</span>'}
      <span class="spacer"></span>
      <button class="small" data-map="refresh" title="Look again now (it refreshes every few seconds)">↻</button>
      <button class="small" data-map="close" title="Back (Esc)">Close</button>`;
    if (layer === 'bugs') return drawBugs();
    if (layer === 'speed') return drawSpeed();
    if (layer === 'logical') {
      $('#map-agents').innerHTML = '';
      if (data && !('view' in data)) return;
      return drawLogical({ data, box: $('#map-box'), warn: $('#map-warn'), esc, describing: findingParts, pick: logicalPick, all: logicalAll });
    }
    if (layer === 'design') {
      $('#map-agents').innerHTML = '';
      drawDesign({ data, box: $('#map-box'), warn: $('#map-warn'), esc, only: designOnly, describing, edit: designEdit, panel: designPanel });
      if (designPanel && !designPanel.sending) $('#map-warn [data-design-text]')?.focus();
      return;
    }
    const warn = (m?.links ?? []).filter((l) => l.kind !== 'near');
    $('#map-warn').innerHTML = warn.length ? `<ul>${warn.map(sentence).join('')}</ul>` : m?.agents.length ? '<p class="hint">No agents are on the same code.</p>' : '';
    const box = $('#map-box');
    if (!m || !m.agents.length) {
      box.innerHTML = `<p class="hint map-empty">${data?.project ? 'No agent in this project is running or has changes yet.' : 'No agents with a repository yet.'}</p>`;
      $('#map-agents').innerHTML = '';
      return;
    }
    // Folders with agents in them get room to show their badges.
    const items = m.modules.map((mod) => ({ ...mod, weight: Math.max(1, mod.files) + (mod.agents.length ? 6 + 4 * mod.agents.length : 0) }));
    const W = box.clientWidth;
    const H = Math.max(320, view.clientHeight - box.offsetTop - $('#map-agents').offsetHeight - 24);
    box.style.height = `${H}px`;
    // Small folders past the first hundred go into one tile.
    const big = items.slice(0, 100);
    const rest = items.slice(100);
    if (rest.length) big.push({ key: `${rest.length} more folders`, files: rest.reduce((s, x) => s + x.files, 0), agents: rest.flatMap((x) => x.agents), weight: rest.reduce((s, x) => s + x.weight, 0), more: true });
    const rects = squarify(big, 0, 0, W, H);
    // Agents in a collision get a red ring, ones heading for one a yellow ring.
    const ring = new Map();
    for (const l of m.links) {
      if (l.kind === 'collide') for (const id of [l.a, l.b]) ring.set(id, 'collide');
      if (l.kind === 'heading' && ring.get(l.a) !== 'collide') ring.set(l.a, 'heading');
    }
    const tiles = rects.map(({ x, y, w, h, item }) => {
      const busy = item.agents.length;
      const badges = item.agents.map((x2) => {
        const a = m.agents.find((z) => z.id === x2.id);
        const cls = [x2.changed ? 'solid' : 'ring', a?.busy ? 'busy' : '', a?.attention ? 'needs' : '', ring.get(x2.id) ?? ''].join(' ');
        return `<span class="map-badge ${cls}" data-badge="${esc(x2.id)}" data-mod="${esc(item.key)}" style="--c:${color(x2.id)}" title="${esc(`${nameOf(x2.id)}: ${x2.changed} changed, ${x2.reading} reading here`)}">${esc(initials(nameOf(x2.id)))}</span>`;
      }).join('');
      return `<div class="map-tile ${busy ? 'active' : ''} ${item.more ? 'more' : ''}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px" title="${esc(`${item.key}: ${item.files} files`)}">
          ${w > 46 && h > 22 ? `<span class="map-name">${esc(item.key === '.' ? '(top level)' : item.key)}</span>` : ''}
          ${w > 46 && h > 38 ? `<span class="map-count">${item.files}</span>` : ''}
          <span class="map-badges">${badges}</span>
        </div>`;
    }).join('');
    box.innerHTML = `${tiles}<svg class="map-links" width="${W}" height="${H}"></svg>`;
    drawLinks(m.links);
    $('#map-agents').innerHTML = m.agents.map((a) => `<button class="map-agent" data-map-open="${esc(a.id)}" style="--c:${color(a.id)}"><span class="map-badge solid ${a.busy ? 'busy' : ''} ${a.attention ? 'needs' : ''}" style="--c:${color(a.id)}">${esc(initials(a.name))}</span>${esc(a.name)} <span class="hint">${a.changed} changed · ${a.reading} reading</span></button>`).join('');
  }

  /** Lines between badges: in the folder of the first shared file, else their nearest badges. */
  function drawLinks(links) {
    const box = $('#map-box');
    const svg = box.querySelector('svg');
    const origin = box.getBoundingClientRect();
    const center = (el) => {
      const r = el.getBoundingClientRect();
      return [r.left - origin.left + r.width / 2, r.top - origin.top + r.height / 2];
    };
    const badges = (id) => [...box.querySelectorAll(`[data-badge="${CSS.escape(id)}"]`)];
    const lines = [];
    for (const l of links.filter((x) => x.kind !== 'near')) {
      const A = badges(l.a);
      const B = badges(l.b);
      if (!A.length || !B.length) continue;
      let best = null;
      for (const p of A) for (const q of B) {
        const [x1, y1] = center(p);
        const [x2, y2] = center(q);
        const d = Math.hypot(x2 - x1, y2 - y1) - (p.dataset.mod === q.dataset.mod ? 1e6 : 0);
        if (!best || d < best.d) best = { d, x1, y1, x2, y2 };
      }
      lines.push(`<line class="${l.kind}" x1="${best.x1}" y1="${best.y1}" x2="${best.x2}" y2="${best.y2}"><title>${esc(l.files.join(', '))}</title></line>`);
    }
    svg.innerHTML = lines.join('');
  }

  const finding = (id) => data?.heat?.findings.find((f) => f.id === id);

  /** The Bugs view: folders by heat, arrows along bugs' paths, cold spots hatched. */
  function drawBugs() {
    const m = data?.map;
    const heat = data?.heat;
    const box = $('#map-box');
    $('#map-agents').innerHTML = '';
    if (!m || !heat || !m.modules.length) {
      box.innerHTML = `<p class="hint map-empty">${data?.project ? 'No files to show for this project yet.' : 'No projects with a repository yet.'}</p>`;
      $('#map-warn').innerHTML = '';
      return;
    }
    const of = (key) => heat.modules[key] ?? { score: 0, bugs: {}, churn: 0, covered: false, files: [], findings: [] };
    // Hot folders get more room, so their names and counts show.
    const items = m.modules.map((mod) => ({ ...mod, weight: Math.max(1, mod.files) + of(mod.key).score * 3 })).sort((a, b) => b.weight - a.weight);
    const W = box.clientWidth;
    const H = Math.max(320, view.clientHeight - box.offsetTop - 24);
    box.style.height = `${H}px`;
    const big = items.slice(0, 100);
    const rest = items.slice(100);
    if (rest.length) big.push({ key: `${rest.length} more folders`, files: rest.reduce((s2, x) => s2 + x.files, 0), weight: rest.reduce((s2, x) => s2 + x.weight, 0), more: true });
    const rects = squarify(big, 0, 0, W, H);
    const at = new Map(rects.map((r) => [r.item.key, r]));
    const tiles = rects
      .map(({ x, y, w, h, item }) => {
        const t = of(item.key);
        const n = Object.values(t.bugs).reduce((a, b) => a + b, 0);
        const r = heat.max ? t.score / heat.max : 0;
        const worst = ['critical', 'high', 'medium', 'low'].find((k) => t.bugs[k]);
        const cold = heat.hunted && !t.covered && !item.more;
        const sel = picked?.module === item.key || picked?.from === item.key || picked?.to === item.key;
        const tip = `${item.key}: ${item.files} files${n ? ` · ${n} bug${n === 1 ? '' : 's'}` : ''}${t.churn ? ` · changed ${t.churn}× in 30 days` : ''}${cold ? ' · no hunt has looked here' : ''}`;
        return `<div class="map-tile heat ${n ? 'buggy' : ''} ${cold ? 'cold' : ''} ${sel ? 'picked' : ''} ${item.more ? 'more' : ''}" data-map-mod="${esc(item.more ? '' : item.key)}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;--heat:${r.toFixed(3)}" title="${esc(tip)}">
            ${w > 46 && h > 22 ? `<span class="map-name">${esc(item.key === '.' ? '(top level)' : item.key)}</span>` : ''}
            ${n && w > 40 && h > 38 ? `<span class="map-bugs ${worst}">${n} bug${n === 1 ? '' : 's'}</span>` : w > 46 && h > 38 ? `<span class="map-count">${item.files}</span>` : ''}
          </div>`;
      })
      .join('');
    // Arrows from the middle of one folder to the next, thicker the more (and worse) bugs go that way.
    const maxW = Math.max(1, ...heat.paths.map((p) => p.weight));
    const mid = (r) => [r.x + r.w / 2, r.y + r.h / 2];
    const arrows = heat.paths
      .map((p, i) => {
        const a = at.get(p.from);
        const b = at.get(p.to);
        if (!a || !b || a === b) return '';
        const [x1, y1] = mid(a);
        const [x2, y2] = mid(b);
        // A slight curve, so arrows both ways between two folders don't overlap.
        const cx = (x1 + x2) / 2 - (y2 - y1) * 0.15;
        const cy = (y1 + y2) / 2 + (x2 - x1) * 0.15;
        const sel = picked?.from === p.from && picked?.to === p.to;
        const sw = 1.5 + (4.5 * p.weight) / maxW;
        // Each arrow its own head, sized to its width.
        const head = Math.max(10, Math.min(20, sw * 3)).toFixed(1);
        return `<marker id="map-arrow-${i}" class="${sel ? 'picked' : ''}" viewBox="0 0 10 10" refX="7" refY="5" markerUnits="userSpaceOnUse" markerWidth="${head}" markerHeight="${head}" orient="auto"><path d="M0,0 L10,5 L0,10 z" /></marker><path class="bug-path ${sel ? 'picked' : ''}" data-map-path="${i}" d="M${x1},${y1} Q${cx},${cy} ${x2},${y2}" stroke-width="${sw.toFixed(1)}" marker-end="url(#map-arrow-${i})"><title>${esc(`${p.from} → ${p.to}: ${p.findings.length} bug${p.findings.length === 1 ? '' : 's'}`)}</title></path>`;
      })
      .join('');
    box.innerHTML = `${tiles}<svg class="map-links bug-paths" width="${W}" height="${H}">${arrows}</svg>`;
    $('#map-warn').innerHTML = bugPanel(of);
  }

  function bugRow(f) {
    return `<li data-map-finding="${esc(f.id)}"><span class="bug-sev ${esc(f.severity)}">${esc(SEV[f.severity] ?? f.severity)}</span> ${esc(f.title)} <span class="hint">${esc(f.file)}${f.line ? `:${f.line}` : ''}${f.status === 'pr' ? ' · draft PR' : f.status === 'fixing' ? ' · being fixed' : f.status === 'snoozed' ? ' · snoozed' : ''}</span>
      ${f.status === 'open' ? '<button class="small" data-map-bug="fix" title="Start an agent on it">Fix</button>' : ''}
      ${f.prUrl ? `<a class="small-link" href="${esc(f.prUrl)}" target="_blank" rel="noopener">PR ↗</a>` : ''}
      <button class="small" data-map-bug="evidence" title="See it in Bugs">Evidence</button></li>`;
  }

  /** Under the map: the picked folder's or path's bugs, else the hottest folders. */
  function bugPanel(of) {
    const heat = data.heat;
    const hunt = data.project?.shortcut ? `<button class="small primary" data-map-hunt title="A hunt on this folder, the whole module a part at a time">Hunt here</button>` : '';
    if (picked?.module !== undefined) {
      const t = of(picked.module);
      const list = t.findings.map(finding).filter(Boolean);
      const name = picked.module === '.' ? '(top level)' : picked.module;
      return `<div class="map-pick"><b>${esc(name)}</b> <span class="hint">${list.length ? `${list.length} bug${list.length === 1 ? '' : 's'}` : 'no bugs found'}${t.churn ? ` · changed ${t.churn}× in 30 days` : ''}${heat.hunted && !t.covered ? ' · no hunt has looked here yet' : ''}${t.files.length ? ` · hottest: ${t.files.map((x) => `<code>${esc(x.file)}</code>`).join(', ')}` : ''}</span> ${hunt} <button class="small" data-map-unpick>×</button>
        ${list.length ? `<ul class="map-bug-list">${list.map(bugRow).join('')}</ul>` : ''}</div>`;
    }
    if (picked?.from !== undefined) {
      const p = heat.paths.find((x) => x.from === picked.from && x.to === picked.to);
      const list = (p?.findings ?? []).map(finding).filter(Boolean);
      return `<div class="map-pick"><b>${esc(picked.from)} → ${esc(picked.to)}</b> <span class="hint">the path ${list.length === 1 ? 'this bug takes' : `${list.length} bugs take`} through the code</span> <button class="small" data-map-unpick>×</button>
        <ul class="map-bug-list">${list.map(bugRow).join('')}</ul></div>`;
    }
    const hot = Object.entries(heat.modules).filter(([, t]) => t.findings.length).sort((a, b) => b[1].score - a[1].score).slice(0, 5);
    if (!heat.hunted) return '<p class="hint">No bug hunts on this project yet: set one up under Bugs (b), and what it finds shows here. Folders are coloured by recent changes until then.</p>';
    if (!hot.length) return `<p class="hint">No open bugs in this project.${heat.findings.length ? '' : ' Hatched folders are ones no hunt has looked at.'} Click a folder to hunt there.</p>`;
    return `<p class="hint">Hottest: ${hot.map(([k, t]) => `<button class="link" data-map-mod="${esc(k)}">${esc(k === '.' ? '(top level)' : k)}</button> (${t.findings.length})`).join(', ')}. ${heat.paths.length ? 'Arrows are the paths bugs take through the code; click one for its bugs.' : ''} Hatched folders are ones no hunt has looked at.</p>`;
  }

  async function bugAct(id, what) {
    if (what === 'evidence') {
      show(false);
      return openBugs?.();
    }
    if (what === 'fix') {
      try {
        const r = await api('POST', `/findings/${id}/fix`, {});
        toast?.(r.existing ? `${r.agent.name} is on it already` : `Agent ${r.agent.name} started on it`, 4000, { label: 'Open', run: () => (show(false), openAgent(r.agent.id)) });
      } catch (e) {
        toast?.(e.message, 6000);
      }
      load();
    }
  }

  /** Hunt the picked folder: its hunt if there is one, else a new whole-module hunt; then run it. */
  async function huntHere() {
    const folder = picked?.module === '.' ? '' : picked?.module ?? '';
    try {
      const { hunts } = await api('GET', '/hunts');
      let h = hunts.find((x) => x.project === data.project.shortcut && x.path === folder);
      h ??= await api('POST', '/hunts', { project: data.project.shortcut, path: folder, focus: 'module' });
      const r = await api('POST', `/hunts/${h.id}/run`, {});
      toast?.(`${r.agent.name} is hunting in ${folder || 'the whole project'}. Its findings come in when it's done.`, 5000);
    } catch (e) {
      toast?.(e.message, 6000);
    }
  }

  /** The benchmarked modules a map folder has, or is in (a folder can be deeper or shallower than a tile). */
  const watchedIn = (key) => (data?.speed?.modules ?? []).filter((w) => !w.path || key === w.path || key.startsWith(`${w.path}/`) || w.path.startsWith(`${key === '.' ? '' : key}/`));
  const pct = (n) => (n === null || n === undefined ? '' : `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}%`);
  const trend = (n, limit) => (n === null || n === undefined ? '' : n > limit ? 'slower' : n < -limit ? 'faster' : 'same');

  /** The Speed view: benchmarked folders, coloured by what the last issue on them did to their speed. */
  function drawSpeed() {
    const m = data?.map;
    const sp = data?.speed;
    const box = $('#map-box');
    $('#map-agents').innerHTML = '';
    if (!m || !sp || !m.modules.length) {
      box.innerHTML = `<p class="hint map-empty">${data?.project ? 'No files to show for this project yet.' : 'No projects with a repository yet.'}</p>`;
      $('#map-warn').innerHTML = '';
      return;
    }
    const limit = sp.slowerPct;
    const last = (key) => watchedIn(key).flatMap((w) => w.runs).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] ?? null;
    // Benchmarked folders get more room, so their numbers show.
    const items = m.modules.map((mod) => ({ ...mod, weight: Math.max(1, mod.files) + (watchedIn(mod.key).length ? 20 : 0) })).sort((a, b) => b.weight - a.weight);
    const W = box.clientWidth;
    const H = Math.max(320, view.clientHeight - box.offsetTop - 24);
    box.style.height = `${H}px`;
    const big = items.slice(0, 100);
    const rest = items.slice(100);
    if (rest.length) big.push({ key: `${rest.length} more folders`, files: rest.reduce((s2, x) => s2 + x.files, 0), weight: rest.reduce((s2, x) => s2 + x.weight, 0), more: true });
    box.innerHTML = squarify(big, 0, 0, W, H)
      .map(({ x, y, w, h, item }) => {
        const on = !item.more && watchedIn(item.key).length > 0;
        const r = on ? last(item.key) : null;
        const t = trend(r?.worst, limit);
        const sel = picked?.module === item.key;
        const tip = `${item.key}: ${item.files} files${on ? ` · benchmarked${r ? ` · ${r.issue ?? r.agent}: ${pct(r.worst)} at worst` : ', no issue has measured it yet'}` : ''}`;
        return `<div class="map-tile speed ${on ? 'watched' : ''} ${t} ${sel ? 'picked' : ''} ${item.more ? 'more' : ''}" data-map-mod="${esc(item.more ? '' : item.key)}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px" title="${esc(tip)}">
            ${w > 46 && h > 22 ? `<span class="map-name">${esc(item.key === '.' ? '(top level)' : item.key)}</span>` : ''}
            ${on && w > 40 && h > 38 ? `<span class="map-speed ${t}">${r ? esc(`${r.issue ?? 'last'} ${pct(r.worst)}`) : 'benchmarked'}</span>` : w > 46 && h > 38 ? `<span class="map-count">${item.files}</span>` : ''}
          </div>`;
      })
      .join('');
    $('#map-warn').innerHTML = speedPanel(limit);
  }

  function runRow(r, limit) {
    const cases = r.cases
      .map((c) => `<tr class="${trend(c.change, limit)}"><td>${esc(c.name)}</td><td>${c.before ?? '—'}</td><td>${c.after}</td><td>${esc(c.unit ?? '')}</td><td>${pct(c.change) || '—'}</td><td>${esc(c.note ?? '')}</td></tr>`)
      .join('');
    return `<li><details><summary><b>${esc(r.issue ?? '(no issue)')}</b> <button class="link" data-map-open="${esc(r.agentId)}" title="Open its agent">${esc(r.agent && r.agent !== r.issue ? r.agent : 'its agent')}</button> <span class="map-speed ${trend(r.worst, limit)}">${r.worst === null ? 'no before numbers' : `${pct(r.worst)} at worst`}</span> <span class="hint">${esc(new Date(r.at).toLocaleDateString())} · ${r.cases.length} case${r.cases.length === 1 ? '' : 's'}${r.accepted ? ' · marked fine' : ''}</span></summary>
      <table class="bench-cases"><thead><tr><th>Case</th><th>Before</th><th>After</th><th>Unit</th><th>Change</th><th>Note</th></tr></thead><tbody>${cases}</tbody></table>
      ${r.command ? `<p class="hint">Run with <code>${esc(r.command)}</code>${r.env ? ` · ${esc(r.env)}` : ''}</p>` : ''}</details></li>`;
  }

  /** Under the map: the picked folder's benchmarks and the issues that ran them, else a summary. */
  function speedPanel(limit) {
    const sp = data.speed;
    if (picked?.module !== undefined) {
      const name = picked.module === '.' ? '(top level)' : picked.module;
      const ws = watchedIn(picked.module);
      const unpick = '<button class="small" data-map-unpick>×</button>';
      if (!ws.length) {
        return `<div class="map-pick"><b>${esc(name)}</b> <span class="hint">not benchmarked</span> ${unpick}
          <form class="bench-watch" data-bench-watch="${esc(picked.module === '.' ? '' : picked.module)}"><input name="components" placeholder="Jira components or labels for it (optional, comma-separated)" autocomplete="off" /> <button class="small primary">Benchmark this folder</button></form>
          <p class="hint">Agents on Jira issues that name it (a component or label, or the folder in the request), or whose change touches it, run its micro benchmarks before and after. The benchmarks are kept on this computer, outside the repository, and reused by the next issue.</p></div>`;
      }
      return ws
        .map((w) => `<div class="map-pick"><b>${esc(w.path || '(whole repository)')}</b> <span class="hint">${w.runs.length ? `${w.runs.length} issue${w.runs.length === 1 ? '' : 's'} measured` : 'no issue has measured it yet'} · kept in <code>${esc(w.dir)}</code></span> ${unpick}
          <form class="bench-watch" data-bench-watch="${esc(w.path)}"><input name="components" value="${esc(w.components.join(', '))}" placeholder="Jira components or labels for it (comma-separated)" autocomplete="off" /> <button class="small">Save</button> <button type="button" class="small" data-bench-unwatch="${esc(w.id)}" title="Agents stop benchmarking it; what was measured stays">Stop benchmarking</button></form>
          ${w.runs.length ? `<ul class="map-bug-list bench-runs">${w.runs.map((r) => runRow(r, limit)).join('')}</ul>` : ''}</div>`)
        .join('');
    }
    if (!sp.modules.length) return `<p class="hint">No folder is benchmarked in this project yet. Click one where speed matters, then <b>Benchmark this folder</b>: agents on Jira issues about it measure its speed before and after their change.${sp.other.length ? ` ${sp.other.length} run${sp.other.length === 1 ? '' : 's'} from agents with benchmarks on are kept too.` : ''}</p>`;
    return `<p class="hint">Benchmarked: ${sp.modules
      .map((w) => {
        const r = w.runs[0];
        return `<button class="link" data-map-mod="${esc(w.path ? w.path.split('/').slice(0, 2).join('/') : '.')}">${esc(w.path || '(whole repository)')}</button>${r ? ` <span class="map-speed ${trend(r.worst, limit)}">${esc(r.issue ?? 'last')} ${pct(r.worst)}</span>` : ''}`;
      })
      .join(', ')}. Click a folder for its issues and numbers.</p>`;
  }

  async function benchWatch(form) {
    try {
      await api('POST', '/benchmodules', { project: data.project.key, path: form.dataset.benchWatch, components: form.components.value });
      toast?.('Saved: agents on Jira issues about it will benchmark it', 4000);
    } catch (e) {
      toast?.(e.message, 6000);
    }
    load();
  }

  async function benchUnwatch(id) {
    try {
      await api('DELETE', `/benchmodules/${id}`);
      toast?.('Not benchmarked any more', 3000);
    } catch (e) {
      toast?.(e.message, 6000);
    }
    load();
  }

  function show(on) {
    open = on;
    view.hidden = !on;
    document.body.classList.toggle('mapping', on);
    $('#map-btn')?.classList.toggle('active', on);
    clearInterval(timer);
    if (on) {
      history.replaceState(null, '', '#map');
      load();
      timer = setInterval(() => document.visibilityState === 'visible' && load(), EVERY_MS);
    } else if (location.hash === '#map') history.replaceState(null, '', '#');
  }

  view.addEventListener('click', (e) => {
    const lay = e.target.closest('[data-map-layer]');
    if (lay) {
      if (layer !== lay.dataset.mapLayer) data = null;
      layer = lay.dataset.mapLayer;
      picked = null;
      try {
        localStorage.setItem(LAYER, layer);
      } catch {}
      return load();
    }
    if (layer === 'bugs') {
      const ba = e.target.closest('[data-map-bug]');
      if (ba) return bugAct(ba.closest('[data-map-finding]')?.dataset.mapFinding, ba.dataset.mapBug);
      if (e.target.closest('[data-map-hunt]')) return huntHere();
      if (e.target.closest('[data-map-unpick]')) return (picked = null), draw();
      const path = e.target.closest('[data-map-path]');
      if (path) {
        const p = data.heat.paths[Number(path.dataset.mapPath)];
        return (picked = p ? { from: p.from, to: p.to } : null), draw();
      }
      const mod = e.target.closest('[data-map-mod]');
      if (mod?.dataset.mapMod) return (picked = picked?.module === mod.dataset.mapMod ? null : { module: mod.dataset.mapMod }), draw();
    }
    if (layer === 'design') {
      if (designClick(e)) return;
      const at = e.target.closest('[data-design-at]');
      if (at) return (designAt = at.dataset.designAt), load();
      if (e.target.closest('[data-design-focus]')) return (designFocus = true), load();
      if (e.target.closest('[data-design-only]')) return (designOnly = !designOnly), draw();
      if (e.target.closest('[data-design-describe]') && !describing) return describeLayer();
      const code = e.target.closest('[data-design-code]');
      if (code && data?.layer?.file && data.from) {
        show(false);
        return openCode(data.from.id, data.layer.file.path, Number(code.dataset.designCode) > 1 ? Number(code.dataset.designCode) : undefined);
      }
    }
    if (layer === 'logical') {
      const code = e.target.closest('[data-logical-code]');
      if (code) {
        // A part of a component, opened in the Design view.
        layer = 'design';
        designAt = code.dataset.logicalCode;
        data = null;
        try {
          localStorage.setItem(LAYER, layer);
        } catch {}
        return load();
      }
      if (e.target.closest('[data-logical-describe]') && !findingParts) return findComponents();
      if (e.target.closest('[data-logical-close]')) return (logicalPick = null), draw();
      if (e.target.closest('[data-logical-all]')) return (logicalAll = !logicalAll), draw();
      const edge = e.target.closest('[data-logical-edge]');
      if (edge) {
        const [from, to] = JSON.parse(edge.dataset.logicalEdge);
        return (logicalPick = logicalPick?.kind === 'edge' && logicalPick.from === from && logicalPick.to === to ? null : { kind: 'edge', from, to }), draw();
      }
      const b = e.target.closest('[data-logical-box]');
      if (b) return (logicalPick = logicalPick?.kind === 'box' && logicalPick.id === b.dataset.logicalBox ? null : { kind: 'box', id: b.dataset.logicalBox }), draw();
    }
    if (layer === 'speed') {
      const un = e.target.closest('[data-bench-unwatch]');
      if (un) return benchUnwatch(un.dataset.benchUnwatch);
      if (e.target.closest('[data-map-unpick]')) return (picked = null), draw();
      const mod = e.target.closest('[data-map-mod]');
      if (mod?.dataset.mapMod) return (picked = picked?.module === mod.dataset.mapMod ? null : { module: mod.dataset.mapMod }), draw();
    }
    const o = e.target.closest('[data-map-open]');
    if (o) {
      show(false);
      return openAgent(o.dataset.mapOpen);
    }
    const b = e.target.closest('[data-map]');
    if (b?.dataset.map === 'close') return show(false);
    if (b?.dataset.map === 'refresh') return load();
  });
  view.addEventListener('submit', (e) => {
    const n = e.target.closest('[data-design-new]');
    if (n) {
      e.preventDefault();
      const name = partName(n.elements.name.value);
      if (!name || !designEdit) return;
      if (designEdit.changes.some((c) => c.kind === 'new' && c.name === name) || data.layer.boxes.some((b) => b.name === name)) return toast?.(`There is already ${name} here`, 3000);
      designEdit.changes = [...designEdit.changes, { kind: 'new', name }];
      return draw();
    }
    const f = e.target.closest('[data-bench-watch]');
    if (!f) return;
    e.preventDefault();
    benchWatch(f);
  });
  view.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches?.('[data-design-at], [data-design-box], [data-logical-box]')) e.target.click();
  });
  view.addEventListener('input', (e) => {
    if (e.target.matches('[data-design-text]') && designPanel) designPanel.text = e.target.value;
  });
  // Dragging from one box to another while changing the design; a short press is a tap.
  view.addEventListener('pointerdown', (e) => {
    dragged = false;
    const b = designEdit && e.button === 0 && e.target.closest('[data-design-box]');
    if (!b) return;
    dragging = { from: b.dataset.designBox, x: e.clientX, y: e.clientY, moved: false };
  });
  view.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (!dragging.moved && Math.hypot(e.clientX - dragging.x, e.clientY - dragging.y) < 8) return;
    dragging.moved = true;
    const box = $('#map-box');
    const line = box.querySelector('.design-drag');
    const from = box.querySelector(`[data-design-box="${CSS.escape(dragging.from)}"]`);
    if (!line || !from) return;
    const r = box.getBoundingClientRect();
    line.setAttribute('x1', from.offsetLeft + from.offsetWidth / 2);
    line.setAttribute('y1', from.offsetTop + from.offsetHeight / 2);
    line.setAttribute('x2', e.clientX - r.left);
    line.setAttribute('y2', e.clientY - r.top);
    line.hidden = false;
  });
  const endDrag = (e) => {
    const d = dragging;
    dragging = null;
    if (!d?.moved) return;
    dragged = e.type === 'pointerup';
    $('#map-box').querySelector('.design-drag')?.setAttribute('hidden', '');
    const over = e.type === 'pointerup' ? document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-design-box]') : null;
    if (over && over.dataset.designBox !== d.from) addChange(d.from, over.dataset.designBox);
  };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
  view.addEventListener('change', (e) => {
    if (e.target.matches('[data-logical-agent]')) {
      designAgent = e.target.value || null;
      return load();
    }
    if (e.target.matches('[data-design-agent]')) {
      designAgent = e.target.value || null;
      designFocus = Boolean(designAgent);
      return load();
    }
    if (e.target.matches('[data-design-to]') && designPanel) return (designPanel.to = e.target.value);
    if (e.target.dataset.mapSet !== 'project') return;
    project = e.target.value;
    picked = null;
    designAt = '';
    designAgent = null;
    designEdit = null;
    designEdits.clear();
    designPanel = null;
    logicalPick = null;
    try {
      localStorage.setItem(SAVED, project);
    } catch {}
    load();
  });
  document.addEventListener('keydown', (e) => {
    if (!open || e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    // Escape closes the panel, then lets go of a tapped box, then the map.
    if (layer === 'design' && designPanel) return (designPanel = null), draw();
    if (layer === 'design' && designEdit?.pick) return (designEdit.pick = null), draw();
    if (layer === 'logical' && logicalPick) return (logicalPick = null), draw();
    show(false);
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 100);
  });

  return {
    show,
    isOpen: () => open,
    /** The Design view at where an agent's changes are, lit up. */
    showDesign(agentId) {
      layer = 'design';
      designAgent = agentId;
      designFocus = true;
      project = null;
      if (open) return load();
      show(true);
    },
  };
}
