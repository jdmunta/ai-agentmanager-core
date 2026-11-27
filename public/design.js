// Architecture's Code view: one layer of the code as boxes in rows, callers above what they use, with an
// arrow for each pair of boxes whose files import one another (thicker for more imports). Click a
// folder to go one layer in, a file for its functions and classes; the crumbs go back out. An
// agent's changes are lit up, and the boxes with code that uses them, which it did not change.
// Described by a model (Describe with AI), each box says what it does, and a busy folder's files
// are put in named groups, each a box to go into. A box's ⋯ asks an agent about it or starts Debug
// there. Change the design: arrows drawn, cut, boxes moved and new parts become a request to an
// agent, previewed before it is sent; then its progress shows, with the arrows that came and went.

const BOX_H = 66;
const BOX_H_NOTES = 100; // with a line on what each does
const GAP_X = 16;
const GAP_Y = 46;
const MIN_W = 150;
const MAX_W = 240;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A new part's name as the daemon keeps it (a file or folder name). */
export const partName = (s) => String(s ?? '').trim().replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 60);
const when = (s) => new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The curve from one box to another: down from a caller above, round the side otherwise; at(t): a point on it. */
export function arrowPath(a, b) {
  const down = b.y > a.y;
  const [x1, y1] = down ? [a.x + a.w / 2, a.y + a.h] : [a.x + a.w / 2, a.y + (b.y < a.y ? 0 : a.h)];
  const [x2, y2] = down ? [b.x + b.w / 2, b.y] : [b.x + b.w / 2, b.y + (b.y < a.y ? b.h : a.h)];
  const bend = down ? Math.max(18, (y2 - y1) / 2) : b.y < a.y ? -30 : 30;
  const [c1, c2] = [y1 + bend, y2 - (down ? bend : -bend)];
  // A point along it, t from 0 to 1.
  const at = (t) => [x1 + (x2 - x1) * (3 * (1 - t) * t * t + t * t * t), (1 - t) ** 3 * y1 + 3 * (1 - t) ** 2 * t * c1 + 3 * (1 - t) * t * t * c2 + t ** 3 * y2];
  return { d: `M${x1},${y1} C${x1},${c1} ${x2},${c2} ${x2},${y2}`, down, at };
}

/** The changes drawn so far, in words. */
export function changeWords(c, nameOf) {
  const n = (id) => (String(id).startsWith('new:') ? `new "${id.slice(4)}"` : nameOf(id));
  return { use: `${n(c.from)} uses ${n(c.to)}`, unuse: `${n(c.from)} no longer uses ${n(c.to)}`, move: `${n(c.from)} moved into ${n(c.to)}`, new: `New part "${c.name}"` }[c.kind];
}
const lines = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Where each box goes: rows by rank, wrapped to the width. Returns { pos: { id: { x, y, w, h } }, height }. */
export function layout(boxes, rank, W, boxH = BOX_H, gapY = GAP_Y) {
  const ranks = [...new Set(boxes.map((b) => rank[b.id] ?? 0))].sort((a, b) => a - b);
  const pos = {};
  let y = 4;
  const perRow = Math.max(1, Math.floor((W + GAP_X) / (MIN_W + GAP_X)));
  for (const r of ranks) {
    const row = boxes.filter((b) => (rank[b.id] ?? 0) === r);
    for (let i = 0; i < row.length; i += perRow) {
      const chunk = row.slice(i, i + perRow);
      const w = Math.min(MAX_W, (W - (chunk.length - 1) * GAP_X) / chunk.length);
      let x = (W - (chunk.length * w + (chunk.length - 1) * GAP_X)) / 2;
      for (const b of chunk) {
        pos[b.id] = { x, y, w, h: boxH };
        x += w + GAP_X;
      }
      y += boxH + gapY;
    }
  }
  return { pos, height: Math.max(y - gapY + 8, 120) };
}

// More boxes than this with an agent picked: only its changes and what uses them, unless all are asked for.
const FOCUS_OVER = 8;

/**
 * The boxes to draw: all of them, or with an agent picked in a busy layer, the ones it changed and
 * the ones using them, the rest as one box. Returns { boxes, edges, hidden }.
 */
export function focusBoxes(layer, only) {
  const touched = (b) => b.changed.length || b.dependents.length;
  if (!only || layer.boxes.length <= FOCUS_OVER || !layer.boxes.some(touched)) return { boxes: layer.boxes, edges: layer.edges, hidden: 0 };
  const keep = layer.boxes.filter(touched);
  const rest = layer.boxes.filter((b) => !touched(b));
  const ids = new Set(keep.map((b) => b.id));
  const boxes = rest.length
    ? [...keep, { id: '\u0000rest', name: `${rest.length} others`, kind: 'more', files: rest.reduce((s, b) => s + b.files, 0), lines: rest.reduce((s, b) => s + b.lines, 0), churn: 0, entry: [], changed: [], dependents: [], talksTo: [], in: 0, out: 0 }]
    : keep;
  return { boxes, edges: layer.edges.filter((e) => ids.has(e.from) && ids.has(e.to)), hidden: rest.length };
}

/**
 * edit: changing the design, { mode: 'use' | 'move', changes, pick } (pick: the box tapped first).
 * panel: under the head, { kind: 'ask' | 'debug', id, name, text, to } for a box, or
 * { kind: 'request', text, to, sending } for the request written from the changes.
 */
export function drawDesign({ data, box, warn, esc, only = true, describing = false, edit = null, panel = null }) {
  const L = data?.layer;
  if (!L) {
    box.innerHTML = `<p class="hint map-empty">${data?.project ? 'No agent in this project has its folder on this computer.' : 'No agents with a repository yet.'}</p>`;
    warn.innerHTML = '';
    return;
  }
  const crumbs = L.crumbs.map((c, i) => (i === L.crumbs.length - 1 ? `<b>${esc(c.name)}</b>` : `<button class="link" data-design-at="${esc(c.id)}">${esc(c.name)}</button>`)).join(' <span class="hint">›</span> ');
  const agents = data.agents ?? [];
  const pick = `<label class="design-agent">Changes of <select data-design-agent aria-label="Light up an agent's changes"><option value="">no agent</option>${agents.map((a) => `<option value="${esc(a.id)}" ${a.id === data.agent ? 'selected' : ''}>${esc(a.name)}${a.changed ? ` (${a.changed} changed)` : ''}</option>`).join('')}</select></label>`;
  const c = L.counts ?? {};
  const facts =
    L.kind === 'file'
      ? `${plural(L.file.lines, 'line')}${L.file.entry ? ' · where the program starts' : ''}`
      : `${plural(c.files ?? 0, 'file')}${data.agent && c.changed ? ` · ${c.changed} changed by the agent · ${plural(c.dependents ?? 0, 'other file')} using what it changed` : ''}`;
  const n = data.notes;
  const describe =
    data.describe && L.kind === 'folder' && !L.group
      ? `<button class="small" data-design-describe ${describing ? 'disabled' : ''} title="One model call with the names of the files here, what they define and the imports between them (not the code): a line on what each does${L.boxes.length > 12 || L.grouped ? ', and the files in named groups' : ''}. Kept for everyone looking at this project.">${describing ? 'Describing…' : n ? 'Describe again' : 'Describe with AI'}</button>`
      : '';
  const about = n?.summary && L.kind === 'folder' ? `<p class="design-summary">${esc(L.group?.purpose || n.summary)} <span class="hint">${n.stale ? 'Written before files here were added or removed. ' : ''}By ${esc(n.by || 'a model')}, ${esc(new Date(n.at).toLocaleDateString())}; from the names and imports, check before relying on it.</span></p>` : '';
  const talks = L.kind === 'folder' && L.talksTo?.length ? `<span class="hint">Talks to:</span> ${L.talksTo.map((t) => `<span class="design-ext" title="${esc(t.pkgs.join(', '))}">${esc(t.name)}</span>`).join(' ')}` : '';
  const shown = L.kind === 'folder' ? focusBoxes(L, only && data.agent) : null;
  const toggle = data.agent && L.kind === 'folder' && L.boxes.length > FOCUS_OVER && L.boxes.some((b) => b.changed.length || b.dependents.length)
    ? `<button class="small" data-design-only aria-pressed="${only}" title="${only ? 'Show every box here' : 'Show only what the agent changed and what uses it'}">${only ? `Show all ${L.boxes.length}` : 'Only its changes'}</button>`
    : '';
  const canEdit = L.kind === 'folder' && !L.missing && L.boxes.length;
  const editBtn = canEdit ? `<button class="small" data-design-edit aria-pressed="${Boolean(edit)}" title="Draw arrows, cut them, move boxes or add new parts; they become a request to an agent that you read before it is sent">${edit ? 'Stop changing' : 'Change the design'}</button>` : '';
  const toOptions = (to) => agents.map((a) => `<option value="${esc(a.id)}" ${a.id === to ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  const nameOf = (id) => L.boxes?.find((b) => b.id === id)?.name ?? id;
  let below = '';
  if (panel?.kind === 'request')
    below = `<div class="design-panel"><div><b>The request</b> <span class="hint">Change it as you like; nothing is sent until you press Send.</span></div>
      <textarea data-design-text rows="9" aria-label="The request">${esc(panel.text)}</textarea>
      <div class="design-panel-row"><label class="design-agent">To <select data-design-to aria-label="The agent to send it to">${toOptions(panel.to)}</select></label><button class="primary small" data-design-send ${panel.sending ? 'disabled' : ''}>${panel.sending ? 'Sending…' : 'Send'}</button><button class="small" data-design-cancel>Back</button></div></div>`;
  else if (panel)
    below = `<div class="design-panel"><div><b>${esc(panel.name)}</b> <span class="chips"><button class="chip ${panel.kind === 'ask' ? 'active' : ''}" aria-pressed="${panel.kind === 'ask'}" data-design-kind="ask">Ask about it</button><button class="chip ${panel.kind === 'debug' ? 'active' : ''}" aria-pressed="${panel.kind === 'debug'}" data-design-kind="debug" title="Start Debug in the agent's session, there">Debug here</button></span></div>
      <textarea data-design-text rows="3" placeholder="${panel.kind === 'debug' ? 'What goes wrong there?' : 'What do you want to know about it?'}" aria-label="${panel.kind === 'debug' ? 'What to debug' : 'Your question'}">${esc(panel.text)}</textarea>
      <div class="design-panel-row"><label class="design-agent">To <select data-design-to aria-label="The agent">${toOptions(panel.to)}</select></label><button class="primary small" data-design-send ${panel.sending ? 'disabled' : ''}>${panel.sending ? 'Sending…' : panel.kind === 'debug' ? 'Start Debug' : 'Ask'}</button><button class="small" data-design-cancel>Cancel</button>
      <span class="hint">Sent with what it holds, what it uses and what uses it.</span></div></div>`;
  else if (edit)
    below = `<div class="design-panel design-editing"><div class="design-panel-row"><b>Changing the design</b>
        <span class="chips"><button class="chip ${edit.mode === 'use' ? 'active' : ''}" aria-pressed="${edit.mode === 'use'}" data-design-mode="use" title="Drag or tap from a box to one it should use">Draw: uses</button><button class="chip ${edit.mode === 'move' ? 'active' : ''}" aria-pressed="${edit.mode === 'move'}" data-design-mode="move" title="Drag or tap a file or folder, then the folder it goes into">Move into</button></span>
        <form class="design-new" data-design-new><input name="name" maxlength="60" placeholder="New part (file or folder name)" aria-label="New part"><button class="small">Add</button></form></div>
      <p class="hint">${edit.pick ? `From <b>${esc(nameOf(edit.pick))}</b>: now tap the box it ${edit.mode === 'move' ? 'goes into' : 'should use'} (tap it again to let go).` : `Drag from one box to another, or tap one and then the other. Tap an arrow to cut it. Stop changing to go into a box; what you drew here stays.`}</p>
      ${edit.changes.length ? `<ol class="design-changes">${edit.changes.map((c, i) => `<li class="${c.kind}">${esc(changeWords(c, nameOf))} <button class="link" data-design-undo="${i}" aria-label="Take it back">×</button></li>`).join('')}</ol>` : ''}
      <div class="design-panel-row"><button class="primary small" data-design-preview ${edit.changes.length ? '' : 'disabled'}>Write the request</button>${edit.changes.length ? '<button class="small" data-design-clear>Clear</button>' : ''}</div></div>`;
  const reqs = !edit && !panel && L.kind === 'folder' ? data.requests ?? [] : [];
  const requests = reqs.length
    ? `<div class="design-requests">${reqs
        .map((r, i) => `<div class="design-request"><b>Asked ${esc(r.agent.name)}</b> <span class="hint">${esc(when(r.when))}</span> · ${r.agent.here ? `${r.done} of ${plural(r.changes.length, 'change')} in its code now` : 'its folder is gone'}
          <ul>${r.changes.map((c) => `<li class="${c.done ? 'done' : 'open'}">${c.done ? '✓' : '○'} ${esc(c.words)}</li>`).join('')}</ul>
          ${i === 0 && r.since ? `<span class="hint">Drawn from ${esc(r.agent.name)}'s code: ${plural(r.since.added.length, 'arrow')} came since (green), ${r.since.gone.length} went (dashed).</span> ` : ''}${!r.since && r.agent.here ? `<button class="small" data-design-show="${esc(r.agent.id)}" title="Draw this layer from its code, with what came and went since">Show its code</button> ` : ''}<button class="small" data-design-dismiss="${esc(r.id)}">Put away</button></div>`)
        .join('')}</div>`
    : '';
  warn.innerHTML = `<div class="design-head"><span class="design-crumbs">${crumbs}</span>${pick}<button class="small" data-design-focus ${data.agent ? '' : 'hidden'} title="Go to the folder holding all of the agent's changes">Where its changes are</button>${toggle}${describe}${editBtn}</div>${about}
    <p class="hint design-facts">${facts}. Read from ${esc(data.from?.name ?? 'an agent')}'s folder${data.read?.capped ? ` (the first ${data.read.files} files)` : ''}. ${talks}</p>${below}${requests}`;
  if (L.kind === 'file') return drawFile(L.file, box, esc, data);
  if (!L.boxes.length) {
    box.innerHTML = `<p class="hint map-empty">${L.missing ? 'This group is gone: the folder was described again. Go back out.' : 'No source files here.'}</p>`;
    return;
  }
  const W = box.clientWidth;
  // Changing: every box, and the new parts as dashed boxes at the bottom.
  const news = (edit?.changes ?? []).filter((x) => x.kind === 'new').map((x) => ({ id: `new:${x.name}`, name: x.name, kind: 'new', files: 0, lines: 0, entry: [], changed: [], dependents: [], talksTo: [], purpose: '' }));
  const drawn = edit ? { boxes: [...L.boxes, ...news], edges: L.edges } : shown;
  const top = Math.max(0, ...Object.values(L.rank));
  const rank = { ...L.rank, '\u0000rest': top + 1, ...Object.fromEntries(news.map((b) => [b.id, top + 1])) };
  const { pos, height } = layout(drawn.boxes, rank, W, drawn.boxes.some((b) => b.purpose) ? BOX_H_NOTES : BOX_H);
  box.style.height = `${height}px`;
  const byId = Object.fromEntries(drawn.boxes.map((b) => [b.id, b]));
  const max = Math.max(1, ...drawn.edges.map((e) => e.count));
  const key = (e) => `${e.from}\n${e.to}`;
  const cut = new Set((edit?.changes ?? []).filter((x) => x.kind === 'unuse').map(key));
  // The newest request's arrows that came and went since, and what it asked that is not there yet.
  const r = !edit && data.requests?.[0]?.since ? data.requests[0] : null;
  const added = new Set((r?.since.added ?? []).map(key));
  const arrows = drawn.edges
    .filter((e) => pos[e.from] && pos[e.to])
    .map((e) => {
      const { d, down } = arrowPath(pos[e.from], pos[e.to]);
      // The path a change can break along: from code using it to the changed code.
      const risk = byId[e.to]?.changed.length && byId[e.from]?.dependents.length;
      const sw = (1 + 3 * Math.sqrt(e.count / max)).toFixed(1);
      const cls = cut.has(key(e)) ? 'cut' : added.has(key(e)) ? 'came' : risk ? 'risk' : '';
      const tip = `${byId[e.from]?.name} uses ${byId[e.to]?.name}: ${plural(e.count, 'import')}${cls === 'cut' ? ' (to be cut)' : cls === 'came' ? ' (came since the request)' : ''}`;
      const hit = edit ? `<path class="design-hit" d="${d}" data-design-edge="${esc(JSON.stringify([e.from, e.to]))}"><title>${esc(`${tip}. Tap to ${cls === 'cut' ? 'keep it' : 'cut it'}`)}</title></path>` : '';
      return `<path class="design-arrow ${down ? '' : 'back'} ${cls}" d="${d}" stroke-width="${sw}" marker-end="url(#design-head${cls ? `-${cls}` : ''})"><title>${esc(tip)}</title></path>${hit}`;
    })
    .join('');
  const ghost = (from, to, cls, tip) => (pos[from] && pos[to] ? `<path class="design-arrow ${cls}" d="${arrowPath(pos[from], pos[to]).d}" stroke-width="2" marker-end="url(#design-head-${cls})"><title>${esc(tip)}</title></path>` : '');
  const asked = [
    ...(edit?.changes ?? []).filter((x) => x.kind === 'use').map((x) => ghost(x.from, x.to, 'asked', `${changeWords(x, (id) => byId[id]?.name ?? id)} (drawn)`)),
    ...(r?.since.gone ?? []).map((e) => ghost(e.from, e.to, 'went', `${byId[e.from]?.name} used ${byId[e.to]?.name} before the request`)),
    ...(r?.changes ?? []).filter((x) => x.kind === 'use' && !x.done).map((x) => ghost(x.from, x.to, 'asked', `${x.words} (asked, not in the code yet)`)),
  ].join('');
  const moving = Object.fromEntries((edit?.changes ?? []).filter((x) => x.kind === 'move').map((x) => [x.from, byId[x.to]?.name ?? x.to]));
  const tiles = drawn.boxes
    .map((b) => {
      const p = pos[b.id];
      const cls = ['design-box', b.kind, b.purpose ? 'noted' : '', b.changed.length ? 'changed' : '', b.dependents.length ? 'dependent' : '', b.entry.length ? 'entry' : '', edit?.pick === b.id ? 'picked' : ''].join(' ');
      const tags = [
        moving[b.id] ? `<span class="design-tag move">→ into ${esc(moving[b.id])}</span>` : '',
        b.entry.length ? `<span class="design-tag entry" title="${esc(`Starts here: ${b.entry.join(', ')}`)}">start</span>` : '',
        b.changed.length ? `<span class="design-tag changed" title="${esc(b.changed.slice(0, 12).join('\n'))}">${b.changed.length} changed</span>` : '',
        b.dependents.length ? `<span class="design-tag dependent" title="${esc(`Use what the agent changed:\n${b.dependents.slice(0, 12).join('\n')}`)}">${b.dependents.length} use it</span>` : '',
        ...b.talksTo.slice(0, 2).map((t) => `<span class="design-tag ext">${esc(t)}</span>`),
      ].join('');
      const title = b.kind === 'new' ? `${b.name}: a new part, drawn` : `${b.name}${b.purpose ? ` (${b.purpose})` : ''}: ${plural(b.files, 'file')}, ${plural(b.lines, 'line')}${b.churn ? `, ${plural(b.churn, 'change')} in 30 days` : ''}; used from outside ${b.in}×, uses outside ${b.out}×`;
      const real = b.kind !== 'more' && b.kind !== 'new';
      // Changing: a box is dragged or tapped, not gone into.
      const act = b.kind === 'more' ? '' : edit ? `data-design-box="${esc(b.id)}"` : `data-design-at="${esc(b.id)}"`;
      return `<div class="${cls}" ${act} role="${b.kind === 'more' ? 'note' : 'button'}" tabindex="${b.kind === 'more' ? -1 : 0}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px" title="${esc(title)}">
        <span class="design-name">${b.kind === 'folder' || b.kind === 'group' ? '▸ ' : b.kind === 'new' ? '+ ' : ''}${esc(b.name)}</span>
        ${real && !edit ? `<button class="design-more" data-design-menu="${esc(b.id)}" title="Ask an agent about it, or start Debug there" aria-label="${esc(`Ask about ${b.name}`)}">⋯</button>` : ''}
        ${b.purpose ? `<span class="design-purpose">${esc(b.purpose)}</span>` : ''}
        ${b.kind === 'new' ? '<span class="design-size">new</span>' : `<span class="design-size">${b.kind === 'group' && b.members !== b.files ? `${plural(b.members, 'part')} · ` : ''}${b.kind === 'file' ? '' : `${plural(b.files, 'file')} · `}${lines(b.lines)} lines</span>`}
        <span class="design-tags">${tags}</span>
      </div>`;
    })
    .join('');
  const head = (id, size = 9) => `<marker id="design-head${id}" ${id ? `class="${id.slice(1)}"` : ''} viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="${size}" markerHeight="${size}" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" /></marker>`;
  box.innerHTML = `<svg class="design-arrows ${edit ? 'editing' : ''}" width="${W}" height="${height}">
      <defs>${head('')}${head('-risk', 10)}${head('-cut')}${head('-came')}${head('-asked')}${head('-went')}</defs>${arrows}${asked}<line class="design-drag" x1="0" y1="0" x2="0" y2="0" hidden /></svg>${tiles}`;
}

function drawFile(f, box, esc, data) {
  box.style.height = '';
  const link = (p) => `<button class="link" data-design-at="${esc(p)}"><code>${esc(p)}</code></button>`;
  const kinds = { class: 'class', type: 'type', function: 'function', method: 'method' };
  box.innerHTML = `<div class="design-file">
    <p>${f.changed ? '<span class="design-tag changed">changed by the agent</span> ' : ''}${f.dependent ? '<span class="design-tag dependent">uses what the agent changed</span> ' : ''}
      <button class="small" data-design-code="1" title="Open it in ${esc(data.from?.name ?? 'the agent')}'s Code tab">Open the code</button>
      <button class="small" data-design-menu="${esc(f.path)}" title="Ask an agent about this file, or start Debug there">Ask or debug</button></p>
    <h4>Functions and classes</h4>
    ${f.symbols.length ? `<ul class="design-symbols">${f.symbols.map((s) => `<li class="${s.kind}"><span class="hint">${kinds[s.kind] ?? s.kind}</span> <button class="link" data-design-code="${s.line}">${esc(s.name)}</button> <span class="hint">line ${s.line}</span></li>`).join('')}</ul>` : '<p class="hint">None found (only JavaScript, TypeScript, Python, Go, Java and Kotlin are read for them).</p>'}
    <div class="design-uses"><div><h4>Uses</h4>${f.imports.length ? f.imports.map(link).join('') : '<p class="hint">Nothing in this repository.</p>'}${f.pkgs.length ? `<p class="hint">Packages: ${f.pkgs.map(esc).join(', ')}</p>` : ''}</div>
    <div><h4>Used by</h4>${f.importedBy.length ? f.importedBy.map(link).join('') : '<p class="hint">Nothing in this repository imports it.</p>'}</div></div>
  </div>`;
}
