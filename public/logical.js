// Architecture's Logical view: the project's components (what each piece of the system does, from any
// folders) and the links between them that imports don't show: HTTP routes called, live streams,
// programs run, files read and written, outside services. Before Describe with AI the components
// are the top-level folders; after it, named components, with the data each link carries and which
// way it moves. A box or arrow tapped shows what is in it and what the code shows of it.

import { arrowPath, layout } from './design.js';

const BOX_H = 104;
const GAP_Y = 84; // room for the names of the links between rows
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lines = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const EXT_ICON = { run: '▶', host: '🌐', svc: '◆', files: '▤', other: '…' };
const when = (s) => new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** An edge's kind for its look: HTTP between parts, code imports, the outside, guessed by the model. */
function edgeClass(e) {
  if (e.guessed) return 'guessed';
  if (e.to.startsWith('x:')) return 'ext';
  if (e.routeCount || e.live) return 'http';
  return 'imports';
}

/** What an edge carries, shortest first: the data the model named, else what the code shows. */
function edgeLabel(e) {
  if (e.data) return e.data;
  if (e.routeCount) return `HTTP · ${plural(e.routeCount, 'route')}`;
  if (e.live) return 'live stream';
  return '';
}

// Each component's biggest code links drawn when only the main links are.
const CODE_PER_BOX = 3;

/**
 * The links to draw: all, or the main ones: HTTP and live streams, the model's guesses, each
 * component's biggest code links, and the outside systems other than files and the rest. Code links
 * both ways between two components are drawn as one. Returns { edges, hidden }.
 */
export function mainEdges(V, all) {
  let keep = V.edges;
  if (!all) {
    const code = V.edges.filter((e) => edgeClass(e) === 'imports');
    const big = new Set();
    for (const c of V.components) for (const e of code.filter((x) => x.from === c.id).sort((a, b) => b.weight - a.weight).slice(0, CODE_PER_BOX)) big.add(e);
    keep = V.edges.filter((e) => big.has(e) || (edgeClass(e) !== 'imports' && e.to !== 'x:files' && e.to !== 'x:other'));
  }
  const drawn = [];
  const pairs = new Map();
  for (const e of keep) {
    if (edgeClass(e) !== 'imports') {
      drawn.push(e);
      continue;
    }
    const twin = pairs.get(`${e.to}\n${e.from}`);
    if (twin) {
      const i = drawn.indexOf(twin);
      drawn[i] = { ...twin, flow: 'both', weight: twin.weight + e.weight, twin: true };
      continue;
    }
    pairs.set(`${e.from}\n${e.to}`, e);
    drawn.push(e);
  }
  return { edges: drawn, hidden: V.edges.length - keep.length };
}

/** What changed in a feature, in a few words: "+1 route, 2 changed, 1 new". */
function featureChangeWords(f) {
  const n = (how) => f.steps.filter((s) => s.how === how).length + f.callers.filter((c) => c.how === how).length;
  return [
    f.routes.added.length && `+${plural(f.routes.added.length, 'route')}`,
    f.routes.gone.length && `−${plural(f.routes.gone.length, 'route')}`,
    n('changed') && `${n('changed')} changed`,
    n('new') && `${n('new')} new`,
    n('gone') && `${n('gone')} gone`,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * pick: { kind: 'box', id } or { kind: 'edge', from, to }, shown under the head. all: every link
 * drawn. compose: a change being asked ({ target, title, words, text, to, sending }; text null until
 * written).
 */
export function drawLogical({ data, box, warn, esc, describing = false, pick = null, all = false, compose = null }) {
  const V = data?.view;
  if (!V) {
    box.innerHTML = `<p class="hint map-empty">${data?.project ? 'No agent in this project has its folder on this computer.' : 'No agents with a repository yet.'}</p>`;
    warn.innerHTML = '';
    return;
  }
  const byId = Object.fromEntries(V.components.map((c) => [c.id, c]));
  const name = (id) => byId[id]?.name ?? id.replace(/^x:\w+:/, '').replace(/^c:/, '');
  const agents = data.agents ?? [];
  const agentPick = `<label class="design-agent">Changes of <select data-logical-agent aria-label="Light up an agent's changes"><option value="">no agent</option>${agents.map((a) => `<option value="${esc(a.id)}" ${a.id === data.agent ? 'selected' : ''}>${esc(a.name)}${a.changed ? ` (${a.changed} changed)` : ''}</option>`).join('')}</select></label>`;
  const n = data.notes;
  const describe = data.describe
    ? `<button class="small" data-logical-describe ${describing ? 'disabled' : ''} title="One model call with the names of the files, what they define and the links the code shows between them (not the code): the files grouped into named components, and what data each link carries. Kept for everyone looking at this project.">${describing ? 'Finding components…' : n ? 'Find again' : 'Find components with AI'}</button>`
    : '';
  const comps = V.components.filter((c) => c.kind === 'component');
  const about = n?.summary
    ? `<p class="design-summary">${esc(n.summary)} <span class="hint">${n.stale ? 'Found before files were added or removed. ' : ''}By ${esc(n.by || 'a model')}, ${esc(new Date(n.at).toLocaleDateString())}; from the names and links, check before relying on it.</span></p>`
    : `<p class="hint design-summary">These are the top-level folders. ${data.describe ? '<b>Find components with AI</b> groups the files by what they do, from any folder, and names the data on each link.' : ''}</p>`;
  const c = V.counts;
  const facts = `${plural(comps.length, 'component')} from ${plural(c.files, 'file')}${c.tests ? ` (${plural(c.tests, 'test file')} left out)` : ''}; ${plural(c.routes, 'HTTP route')} served, ${plural(c.calls, 'call')} to them found in the code${data.agent && c.changed ? `; ${c.changed} changed by the agent` : ''}. Read from ${esc(data.from?.name ?? 'an agent')}'s folder${data.read?.capped ? ` (the first ${data.read.files} files)` : ''}.`;
  const F = V.flow;
  const feats = V.features ?? [];
  const featurePick = feats.length
    ? `<label class="design-agent">Follow <select data-logical-feature aria-label="Follow a feature through the code"><option value="">a feature…</option>${[...feats].sort((a, b) => (a.kind !== b.kind ? (a.kind === 'start' ? 1 : -1) : a.name.localeCompare(b.name))).map((f) => `<option value="${esc(f.key)}" ${f.key === F?.key ? 'selected' : ''}>${esc(f.name)}${f.routes ? ` (${plural(f.routes, 'route')})` : ''}</option>`).join('')}</select></label>`
    : '';
  const I = !F && data.agent ? data.impact : null;
  const toOptions = (to) => agents.map((a) => `<option value="${esc(a.id)}" ${a.id === to ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  const changeBtn = (target) => `<button class="small" data-logical-change="${esc(JSON.stringify(target))}" title="Say what should change here; it becomes a request to an agent, with what the code shows of it, that you read before it is sent">Change this…</button>`;
  const tag = (how) => (how ? `<span class="design-tag ${how}">${how}</span> ` : '');
  const open = (file, line, text) => `<button class="link" data-logical-open="${esc(JSON.stringify([file, line]))}" title="${esc(`Open ${file} at line ${line}`)}">${text}</button>`;
  let below = '';
  if (compose) {
    below = `<div class="design-panel logical-panel logical-compose"><div><b>Change ${esc(compose.title)}</b> <span class="hint">${compose.text == null ? 'Say what should change; it is sent with what the code shows of it.' : 'Change it as you like; nothing is sent until you press Send.'}</span></div>
      ${compose.text == null
        ? `<textarea data-logical-words rows="3" placeholder="What should change?" aria-label="What should change">${esc(compose.words)}</textarea>
      <div class="design-panel-row"><button class="primary small" data-logical-write ${compose.writing ? 'disabled' : ''}>${compose.writing ? 'Writing…' : 'Write the request'}</button><button class="small" data-logical-cancel>Cancel</button></div>`
        : `<textarea data-logical-text rows="10" aria-label="The request">${esc(compose.text)}</textarea>
      <div class="design-panel-row"><label class="design-agent">To <select data-logical-to aria-label="The agent to send it to">${toOptions(compose.to)}</select></label><button class="primary small" data-logical-send ${compose.sending ? 'disabled' : ''}>${compose.sending ? 'Sending…' : 'Send'}</button><button class="small" data-logical-back>Back</button></div>`}</div>`;
  } else if (F && !pick) {
    const C = F.changes;
    const howOf = new Map((C?.steps ?? []).map((s) => [`${s.file}#${s.name}`, s.how]));
    const callerHow = new Map((C?.callers ?? []).map((c) => [`${c.file}#${c.name}`, c.how]));
    const goneSteps = (C?.steps ?? []).filter((s) => s.how === 'gone');
    const goneCallers = (C?.callers ?? []).filter((c) => c.how === 'gone');
    const reach = [...F.outside.services, ...F.outside.runs.map((r) => `runs ${r}`), ...F.outside.hosts, F.outside.reads || F.outside.writes ? [F.outside.reads && 'reads', F.outside.writes && 'writes'].filter(Boolean).join(' and ') + ' files' : ''].filter(Boolean);
    const agentName = agents.find((a) => a.id === data.agent)?.name ?? 'the agent';
    below = `<div class="design-panel logical-panel logical-flow"><div class="design-panel-row"><b>${esc(F.name)}</b>${F.what ? ` <span>${esc(F.what)}</span>` : ''}<span class="spacer"></span>${changeBtn({ kind: 'feature', key: F.key })}<button class="small" data-logical-unfollow>Close</button></div>
      ${C ? `<p class="logical-changed-note">${C.how === 'changed' ? '' : tag(C.how)}<b>${esc(agentName)}</b> changed it: ${esc(featureChangeWords(C) || 'its flow')}. <span class="hint">Marked below, against its code when it started.</span></p>` : ''}
      ${F.callers.length ? `<div><span class="hint">Called from</span><ul class="logical-links">${F.callers.map((c) => `<li>${tag(callerHow.get(`${c.file}#${c.name}`))}${open(c.file, c.line, `<code>${esc(c.file)}</code>${c.name ? ` ${esc(c.name)}()` : ''}`)} <span class="hint">${esc(name(c.comp))}</span></li>`).join('')}${goneCallers.map((c) => `<li class="gone">${tag('gone')}<code>${esc(c.file)}</code> ${esc(c.name ?? '')}()</li>`).join('')}</ul></div>` : F.kind === 'http' ? '<p class="hint">No page or command in this repository calls its routes (another program may).</p>' : ''}
      ${F.routes.length ? `<div><span class="hint">Routes</span> ${F.routes.map((r) => `${C?.routes.added.includes(r) ? tag('new') : ''}<code>${esc(r)}</code>`).join(' ')}${(C?.routes.gone ?? []).map((r) => ` ${tag('gone')}<code class="gone">${esc(r)}</code>`).join('')}</div>` : ''}
      <div><span class="hint">Through the code</span><ul class="logical-steps">${F.steps.map((st) => `<li style="padding-left:${st.depth * 14}px">${tag(howOf.get(`${st.file}#${st.name}`))}${open(st.file, st.line, `<code>${esc(st.file)}</code> ${esc(st.name)}${st.route ? '' : '()'}`)} <span class="hint">${esc(name(st.comp))}${st.does ? ` · ${esc(st.does)}` : ''}</span></li>`).join('')}${goneSteps.map((st) => `<li class="gone">${tag('gone')}<code>${esc(st.file)}</code> ${esc(st.name)}${st.route ? '' : '()'}</li>`).join('')}</ul></div>
      ${reach.length ? `<div><span class="hint">Reaches</span> ${reach.map(esc).join(' · ')}</div>` : ''}
      <p class="hint">Followed by the names of the functions called; calls through variables, callbacks and events are not followed.</p></div>`;
  } else if (pick?.kind === 'box' && byId[pick.id]) {
    const b = byId[pick.id];
    const ins = V.edges.filter((e) => e.to === b.id);
    const outs = V.edges.filter((e) => e.from === b.id);
    const linkLi = (e, other, dir) => `<li><button class="link" data-logical-edge="${esc(JSON.stringify([e.from, e.to]))}">${dir} ${esc(name(other))}</button> <span class="hint">${esc([e.data, e.found || (e.guessed ? 'guessed by the model' : '')].filter(Boolean).join(' · '))}</span></li>`;
    below = `<div class="design-panel logical-panel"><div class="design-panel-row"><b>${esc(b.name)}</b>${b.kind === 'external' ? ' <span class="hint">outside the code</span>' : ` <span class="hint">${plural(b.files, 'file')} · ${lines(b.lines)} lines${b.serves ? ` · serves ${plural(b.serves, 'route')}` : ''}</span>`}<span class="spacer"></span>${b.kind === 'component' ? changeBtn({ kind: 'box', id: b.id }) : ''}<button class="small" data-logical-close>Close</button></div>
      ${b.purpose ? `<p>${esc(b.purpose)}</p>` : ''}
      ${b.members.length ? `<div><span class="hint">In it (open in the Code view):</span> <span class="logical-members">${b.members.map((m) => `<button class="link" data-logical-code="${esc(m)}"><code>${esc(m)}</code></button>`).join(' ')}</span></div>` : ''}
      ${b.changed.length ? `<div><span class="design-tag changed">${b.changed.length} changed</span> <span class="hint">${esc(b.changed.slice(0, 8).join(', '))}${b.changed.length > 8 ? ', …' : ''}</span></div>` : ''}
      ${outs.length ? `<div><span class="hint">Uses</span><ul class="logical-links">${outs.map((e) => linkLi(e, e.to, '→')).join('')}</ul></div>` : ''}
      ${ins.length ? `<div><span class="hint">Used by</span><ul class="logical-links">${ins.map((e) => linkLi(e, e.from, '←')).join('')}</ul></div>` : ''}</div>`;
  } else if (pick?.kind === 'edge') {
    const e = V.edges.find((x) => x.from === pick.from && x.to === pick.to);
    if (e) {
      const way = e.flow === 'from' ? `${name(e.to)} → ${name(e.from)}` : e.flow === 'both' ? 'both ways' : `${name(e.from)} → ${name(e.to)}`;
      below = `<div class="design-panel logical-panel"><div class="design-panel-row"><b><button class="link" data-logical-box="${esc(e.from)}">${esc(name(e.from))}</button> → <button class="link" data-logical-box="${esc(e.to)}">${esc(name(e.to))}</button></b><span class="spacer"></span>${changeBtn({ kind: 'edge', from: e.from, to: e.to })}<button class="small" data-logical-close>Close</button></div>
        ${e.data ? `<p><b>${esc(e.data)}</b> <span class="hint">(${esc(way)}; named by the model)</span></p>` : ''}
        <p>${e.guessed ? '<span class="hint">The model saw this link from the names; the code does not show it.</span>' : `<span class="hint">The code shows:</span> ${esc(e.found)}`}</p>
        ${e.routes.length ? `<details ${e.routeCount <= 12 ? 'open' : ''}><summary class="hint">${plural(e.routeCount, 'route')} called</summary><ul class="logical-routes">${e.routes.map((r) => `<li><code>${esc(r)}</code></li>`).join('')}</ul>${e.routeCount > e.routes.length ? `<span class="hint">and ${e.routeCount - e.routes.length} more</span>` : ''}</details>` : ''}
        ${e.evidence.length ? `<details><summary class="hint">Where in the code</summary><ul class="logical-routes">${e.evidence.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul></details>` : ''}</div>`;
    }
  } else if (I) {
    const agentName = agents.find((a) => a.id === data.agent)?.name ?? 'the agent';
    const L = I.links;
    const linkLi = (e, how, more = '') => `<li class="${how}">${tag(how)}<button class="link" data-logical-edge="${esc(JSON.stringify([e.from, e.to]))}">${esc(name(e.from))} → ${esc(name(e.to))}</button> <span class="hint">${esc(more || e.found)}</span></li>`;
    const routesWords = (r) => [r.added.length && `now also ${r.added.slice(0, 3).join(', ')}${r.added.length > 3 ? '…' : ''}`, r.gone.length && `no longer ${r.gone.slice(0, 3).join(', ')}${r.gone.length > 3 ? '…' : ''}`].filter(Boolean).join('; ');
    const links = [...L.added.map((e) => linkLi(e, 'new')), ...L.gone.map((e) => linkLi(e, 'gone')), ...L.changed.map((e) => linkLi(e, 'changed', routesWords(e.routes)))];
    below = `<div class="design-panel logical-panel logical-impact"><div><b>What ${esc(agentName)}'s changes touch</b> <span class="hint">against its code when it started</span></div>
      ${I.features.length ? `<div><span class="hint">${plural(I.featureCount, 'feature')}; follow one for its steps</span><ul class="logical-links">${I.features.map((f) => `<li>${tag(f.how)}${f.how === 'gone' ? esc(f.name) : `<button class="link" data-logical-follow="${esc(f.key)}">${esc(f.name)}</button>`} <span class="hint">${esc(featureChangeWords(f))}</span></li>`).join('')}</ul>${I.featureCount > I.features.length ? `<span class="hint">and ${I.featureCount - I.features.length} more</span>` : ''}</div>` : '<p class="hint">No feature\'s flow changed.</p>'}
      ${links.length ? `<div><span class="hint">Links between components</span><ul class="logical-links">${links.join('')}</ul></div>` : '<p class="hint">No link between components came, went or changed its routes.</p>'}</div>`;
  }
  const reqs = compose ? [] : data.requests ?? [];
  const sinceWords = (r) => {
    if (!r.agent.here) return 'Its folder is gone.';
    if (r.gone) return 'That is no longer in its code.';
    const x = r.since;
    if (!x || !(x.changed || x.new || x.gone)) return 'Nothing in it has changed in its code yet.';
    return `Since then in its code: ${[x.changed && `${x.changed} changed`, x.new && `${x.new} new`, x.gone && `${x.gone} gone`].filter(Boolean).join(', ')}${x.names.length ? ` (${x.names.join(', ')})` : ''}.`;
  };
  const requests = reqs.length
    ? `<div class="design-requests">${reqs.map((r) => `<div class="design-request"><b>Asked ${esc(r.agent.name)}</b> <span class="hint">${esc(when(r.when))}</span> to change ${r.target.kind === 'feature' && r.agent.here && !r.gone ? `<button class="link" data-logical-follow="${esc(r.target.key)}">${esc(r.title)}</button>` : `<b>${esc(r.title)}</b>`}: ${esc(r.words)}
        <div><span class="hint">${esc(sinceWords(r))}</span> <button class="small" data-logical-dismiss="${esc(r.id)}">Put away</button></div></div>`).join('')}</div>`
    : '';
  let { edges, hidden } = mainEdges(V, all);
  // Following a feature: only its hops, the components it goes through lit, the rest dimmed.
  const onPath = new Set(F ? [...F.comps, ...F.outsideIds] : []);
  if (F) {
    edges = F.hops.map(([a, b]) => {
      const e = V.edges.find((x) => x.from === a && x.to === b) ?? V.edges.find((x) => x.from === b && x.to === a);
      return { ...(e ?? { found: '', routes: [], routeCount: 0, data: null, flow: null, guessed: false, evidence: [], weight: 1 }), from: a, to: b, flow: e && e.from === a ? e.flow : null, follow: true };
    });
    hidden = 0;
  } else if (I) {
    // The agent's links: those that came marked, those that went drawn dashed.
    const came = new Set(I.links.added.map((e) => `${e.from}\n${e.to}`));
    edges = edges.map((e) => (came.has(`${e.from}\n${e.to}`) ? { ...e, came: true } : e));
    // Drawn even where only the main links are (to files, say).
    for (const e of V.edges) if (came.has(`${e.from}\n${e.to}`) && !edges.some((x) => x.from === e.from && x.to === e.to)) edges.push({ ...e, came: true });
    for (const e of I.links.gone) edges.push({ from: e.from, to: e.to, found: e.found, routes: [], routeCount: 0, data: null, flow: null, guessed: false, evidence: [], weight: 1, went: true });
  }
  const toggle = hidden || all ? `<button class="small" data-logical-all aria-pressed="${all}" title="${all ? 'Only HTTP, live streams, outside systems and each component\'s biggest code links' : 'Every link the code shows, and the files read and written'}">${all ? 'Main links only' : `Show all ${V.edges.length} links`}</button>` : '';
  warn.innerHTML = `<div class="design-head"><span class="design-crumbs"><b>Components</b></span>${agentPick}${featurePick}${F ? '' : toggle}${describe}</div>${about}<p class="hint design-facts">${facts}${hidden ? ` Showing the main links; ${plural(hidden, 'more link')} in each box (tap it) or with Show all.` : ''}</p>${below}${requests}`;
  if (!V.components.length) {
    box.innerHTML = '<p class="hint map-empty">No source files here.</p>';
    return;
  }
  const W = box.clientWidth;
  // The outside systems with no link drawn are left out.
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const boxes = V.components.filter((b) => b.kind !== 'external' || linked.has(b.id) || onPath.has(b.id));
  const { pos, height } = layout(boxes, V.rank, W, BOX_H, GAP_Y);
  box.style.height = `${height}px`;
  const max = Math.max(1, ...edges.map((e) => e.weight));
  // Names on arrows between the same rows are put at different points along them.
  const named = new Map();
  const arrows = edges
    .filter((e) => pos[e.from] && pos[e.to])
    .map((e) => {
      const { d, down, at } = arrowPath(pos[e.from], pos[e.to]);
      const cls = edgeClass(e);
      const sw = (1 + 3 * Math.sqrt(e.weight / max)).toFixed(1);
      const end = e.flow !== 'from' ? `marker-end="url(#logical-head-${cls})"` : '';
      const start = e.flow === 'from' || e.flow === 'both' ? `marker-start="url(#logical-head-${cls})"` : '';
      const on = pick?.kind === 'edge' && ((pick.from === e.from && pick.to === e.to) || (e.twin && pick.from === e.to && pick.to === e.from));
      const tip = `${e.went ? 'Went: ' : e.came ? 'Came: ' : ''}${name(e.from)} ${e.twin ? '⇄' : '→'} ${name(e.to)}${e.data ? `: ${e.data}` : ''}${e.found ? ` (${e.found})` : e.guessed ? ' (guessed by the model)' : ''}`;
      // Named on the arrow: HTTP and live streams between rows, and the one picked; the rest in their tips and panels.
      const across = pos[e.from].y !== pos[e.to].y;
      const label = ((cls === 'http' || cls === 'guessed') && across) || on ? edgeLabel(e) : '';
      let text = '';
      if (label) {
        const row = `${pos[e.from].y}\n${pos[e.to].y}`;
        const k = named.get(row) ?? 0;
        named.set(row, k + 1);
        const [x, y0] = at([0.5, 0.3, 0.7, 0.4, 0.6][k % 5]);
        // Arrows within one row all bend the same way: their names one under another.
        const y = across ? y0 : y0 + (k % 3) * 13;
        const cut = W < 600 ? 18 : 26;
        text = `<text class="logical-label ${cls}" x="${x.toFixed(0)}" y="${y.toFixed(0)}" text-anchor="middle" dominant-baseline="middle">${esc(label.length > cut ? `${label.slice(0, cut - 1)}…` : label)}</text>`;
      }
      return `<path class="design-arrow logical-arrow ${cls} ${down ? '' : 'back'} ${on ? 'on' : ''} ${e.follow ? 'follow' : ''} ${e.came ? 'came' : ''} ${e.went ? 'went' : ''}" d="${d}" stroke-width="${sw}" ${end} ${start}><title>${esc(tip)}</title></path><path class="design-hit" d="${d}" data-logical-edge="${esc(JSON.stringify([e.from, e.to]))}"><title>${esc(tip)}</title></path>${text}`;
    })
    .join('');
  const tiles = boxes
    .map((b) => {
      const p = pos[b.id];
      const cls = ['design-box', 'logical-box', b.kind, b.unplaced ? 'unplaced' : '', b.changed.length ? 'changed' : '', pick?.kind === 'box' && pick.id === b.id ? 'picked' : '', F ? (onPath.has(b.id) ? 'on-path' : 'off-path') : ''].join(' ');
      const tags = [
        b.entry.length ? `<span class="design-tag entry" title="${esc(`Starts here: ${b.entry.join(', ')}`)}">start</span>` : '',
        b.serves ? `<span class="design-tag http">serves ${b.serves}</span>` : '',
        b.changed.length ? `<span class="design-tag changed" title="${esc(b.changed.slice(0, 12).join('\n'))}">${b.changed.length} changed</span>` : '',
      ].join('');
      const size = b.kind === 'external' ? { run: 'a program it runs', host: 'a host it calls', svc: 'a service it uses', files: 'read and written', other: 'programs, hosts, services' }[b.ext] : `${plural(b.files, 'file')} · ${lines(b.lines)} lines`;
      return `<div class="${cls}" data-logical-box="${esc(b.id)}" role="button" tabindex="0" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px" title="${esc(`${b.name}${b.purpose ? `: ${b.purpose}` : ''}`)}">
        <span class="design-name">${b.kind === 'external' ? `${EXT_ICON[b.ext] ?? ''} ` : ''}${esc(b.name)}</span>
        ${b.purpose ? `<span class="design-purpose">${esc(b.purpose)}</span>` : ''}
        <span class="design-size">${esc(size)}</span>
        <span class="design-tags">${tags}</span>
      </div>`;
    })
    .join('');
  const head = (cls) => `<marker id="logical-head-${cls}" class="${cls}" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" /></marker>`;
  box.innerHTML = `<svg class="design-arrows logical-arrows" width="${W}" height="${height}"><defs>${['http', 'imports', 'ext', 'guessed'].map(head).join('')}</defs>${arrows}</svg>${tiles}`;
}
