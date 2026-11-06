// Map: a repository's folders as tiles sized by their files, with each agent as a badge on the
// folders it is changing (solid) or reading (ring) now. A red line joins two agents that changed
// the same file; a dashed one runs from an agent reading a file to the agent that changed it.

const SAVED = 'agentmgr.mapProject';
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

export function initCodeMap({ api, $, esc, agents, openAgent, toast }) {
  const view = $('#map-view');
  let open = false;
  let data = null;
  let timer = null;
  let project = null;
  try {
    project = localStorage.getItem(SAVED) || null;
  } catch {}

  const nameOf = (id) => data?.map.agents.find((a) => a.id === id)?.name ?? agents.get(id)?.name ?? id;
  const color = (id) => `hsl(${hue(id)} 70% 55%)`;

  async function load() {
    try {
      data = await api('GET', `/codemap${project ? `?project=${encodeURIComponent(project)}` : ''}`);
      if (data.project && data.project.key !== project) project = data.project.key;
    } catch (e) {
      toast?.(e.message, 5000);
    }
    draw();
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
      <span class="map-legend"><span class="map-key solid"></span>changing <span class="map-key ring"></span>reading <span class="map-key red"></span>same file changed <span class="map-key dash"></span>reading what another changed</span>
      <span class="spacer"></span>
      <button class="small" data-map="refresh" title="Look again now (it refreshes every few seconds)">↻</button>
      <button class="small" data-map="close" title="Back (Esc)">Close</button>`;
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
    const o = e.target.closest('[data-map-open]');
    if (o) {
      show(false);
      return openAgent(o.dataset.mapOpen);
    }
    const b = e.target.closest('[data-map]');
    if (b?.dataset.map === 'close') return show(false);
    if (b?.dataset.map === 'refresh') return load();
  });
  view.addEventListener('change', (e) => {
    if (e.target.dataset.mapSet !== 'project') return;
    project = e.target.value;
    try {
      localStorage.setItem(SAVED, project);
    } catch {}
    load();
  });
  document.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape' && !document.querySelector('dialog[open]')) show(false);
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 100);
  });

  return { show, isOpen: () => open };
}
