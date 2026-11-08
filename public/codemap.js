// Map: a repository's folders as tiles sized by their files, with each agent as a badge on the
// folders it is changing (solid) or reading (ring) now. A red line joins two agents that changed
// the same file; a dashed one runs from an agent reading a file to the agent that changed it.
// The Bugs view colours each folder by the bugs hunts found there (worst weigh most) and how much it
// changed lately, draws the paths through the code those bugs take as arrows between folders, and
// hatches the folders no hunt has looked at. Click a folder or an arrow for its bugs, or Hunt here.

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

export function initCodeMap({ api, $, esc, agents, openAgent, openBugs, toast }) {
  const view = $('#map-view');
  let open = false;
  let data = null;
  let timer = null;
  let project = null;
  let layer = 'agents';
  let picked = null; // in the Bugs and Speed views: { module } or { from, to }
  try {
    project = localStorage.getItem(SAVED) || null;
    layer = ['bugs', 'speed'].includes(localStorage.getItem(LAYER)) ? localStorage.getItem(LAYER) : 'agents';
  } catch {}

  const nameOf = (id) => data?.map.agents.find((a) => a.id === id)?.name ?? agents.get(id)?.name ?? id;
  const color = (id) => `hsl(${hue(id)} 70% 55%)`;

  async function load() {
    try {
      const q = new URLSearchParams({ ...(project ? { project } : {}), ...(layer !== 'agents' ? { layer } : {}) });
      data = await api('GET', `/codemap${q.size ? `?${q}` : ''}`);
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
      <span class="chips map-layers" role="tablist"><button class="chip ${layer === 'agents' ? 'active' : ''}" data-map-layer="agents" role="tab" aria-selected="${layer === 'agents'}">Agents</button><button class="chip ${layer === 'bugs' ? 'active' : ''}" data-map-layer="bugs" role="tab" aria-selected="${layer === 'bugs'}" title="Where hunts found bugs, and the paths through the code they take">Bugs</button><button class="chip ${layer === 'speed' ? 'active' : ''}" data-map-layer="speed" role="tab" aria-selected="${layer === 'speed'}" title="Modules where speed matters: micro benchmarks for the Jira issues that change them">Speed</button></span>
      ${layer === 'speed'
        ? `<span class="map-legend"><span class="map-key watched"></span>benchmarked <span class="map-key slower"></span>last issue made it over ${data?.speed?.slowerPct ?? 5}% slower <span class="map-key faster"></span>faster</span>`
        : layer === 'bugs'
        ? '<span class="map-legend"><span class="map-key heat"></span>bugs (worst weigh most) and recent changes <span class="map-key arrow"></span>path a bug takes <span class="map-key cold"></span>no hunt has looked here</span>'
        : '<span class="map-legend"><span class="map-key solid"></span>changing <span class="map-key ring"></span>reading <span class="map-key red"></span>same file changed <span class="map-key dash"></span>reading what another changed</span>'}
      <span class="spacer"></span>
      <button class="small" data-map="refresh" title="Look again now (it refreshes every few seconds)">↻</button>
      <button class="small" data-map="close" title="Back (Esc)">Close</button>`;
    if (layer === 'bugs') return drawBugs();
    if (layer === 'speed') return drawSpeed();
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
    const f = e.target.closest('[data-bench-watch]');
    if (!f) return;
    e.preventDefault();
    benchWatch(f);
  });
  view.addEventListener('change', (e) => {
    if (e.target.dataset.mapSet !== 'project') return;
    project = e.target.value;
    picked = null;
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
