// Map's Design view: one layer of the code as boxes in rows, callers above what they use, with an
// arrow for each pair of boxes whose files import one another (thicker for more imports). Click a
// folder to go one layer in, a file for its functions and classes; the crumbs go back out. An
// agent's changes are lit up, and the boxes with code that uses them, which it did not change.
// Described by a model (Describe with AI), each box says what it does, and a busy folder's files
// are put in named groups, each a box to go into.

const BOX_H = 66;
const BOX_H_NOTES = 100; // with a line on what each does
const GAP_X = 16;
const GAP_Y = 46;
const MIN_W = 150;
const MAX_W = 240;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lines = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Where each box goes: rows by rank, wrapped to the width. Returns { pos: { id: { x, y, w, h } }, height }. */
export function layout(boxes, rank, W, boxH = BOX_H) {
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
      y += boxH + GAP_Y;
    }
  }
  return { pos, height: Math.max(y - GAP_Y + 8, 120) };
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

export function drawDesign({ data, box, warn, esc, only = true, describing = false }) {
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
  warn.innerHTML = `<div class="design-head"><span class="design-crumbs">${crumbs}</span>${pick}<button class="small" data-design-focus ${data.agent ? '' : 'hidden'} title="Go to the folder holding all of the agent's changes">Where its changes are</button>${toggle}${describe}</div>${about}
    <p class="hint design-facts">${facts}. Read from ${esc(data.from?.name ?? 'an agent')}'s folder${data.read?.capped ? ` (the first ${data.read.files} files)` : ''}. ${talks}</p>`;
  if (L.kind === 'file') return drawFile(L.file, box, esc, data);
  if (!L.boxes.length) {
    box.innerHTML = `<p class="hint map-empty">${L.missing ? 'This group is gone: the folder was described again. Go back out.' : 'No source files here.'}</p>`;
    return;
  }
  const W = box.clientWidth;
  const rank = { ...L.rank, '\u0000rest': Math.max(0, ...Object.values(L.rank)) + 1 };
  const { pos, height } = layout(shown.boxes, rank, W, shown.boxes.some((b) => b.purpose) ? BOX_H_NOTES : BOX_H);
  box.style.height = `${height}px`;
  const byId = Object.fromEntries(shown.boxes.map((b) => [b.id, b]));
  const max = Math.max(1, ...shown.edges.map((e) => e.count));
  const arrows = shown.edges
    .filter((e) => pos[e.from] && pos[e.to])
    .map((e) => {
      const a = pos[e.from];
      const b = pos[e.to];
      const down = b.y > a.y;
      const [x1, y1] = down ? [a.x + a.w / 2, a.y + a.h] : [a.x + a.w / 2, a.y + (b.y < a.y ? 0 : a.h)];
      const [x2, y2] = down ? [b.x + b.w / 2, b.y] : [b.x + b.w / 2, b.y + (b.y < a.y ? b.h : a.h)];
      const bend = down ? Math.max(18, (y2 - y1) / 2) : b.y < a.y ? -30 : 30;
      // The path a change can break along: from code using it to the changed code.
      const risk = byId[e.to]?.changed.length && byId[e.from]?.dependents.length;
      const sw = (1 + 3 * Math.sqrt(e.count / max)).toFixed(1);
      return `<path class="design-arrow ${down ? '' : 'back'} ${risk ? 'risk' : ''}" d="M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - (down ? bend : -bend)} ${x2},${y2}" stroke-width="${sw}" marker-end="url(#design-head${risk ? '-risk' : ''})"><title>${esc(`${byId[e.from]?.name} uses ${byId[e.to]?.name}: ${plural(e.count, 'import')}`)}</title></path>`;
    })
    .join('');
  const tiles = shown.boxes
    .map((b) => {
      const p = pos[b.id];
      const cls = ['design-box', b.kind, b.purpose ? 'noted' : '', b.changed.length ? 'changed' : '', b.dependents.length ? 'dependent' : '', b.entry.length ? 'entry' : ''].join(' ');
      const tags = [
        b.entry.length ? `<span class="design-tag entry" title="${esc(`Starts here: ${b.entry.join(', ')}`)}">start</span>` : '',
        b.changed.length ? `<span class="design-tag changed" title="${esc(b.changed.slice(0, 12).join('\n'))}">${b.changed.length} changed</span>` : '',
        b.dependents.length ? `<span class="design-tag dependent" title="${esc(`Use what the agent changed:\n${b.dependents.slice(0, 12).join('\n')}`)}">${b.dependents.length} use it</span>` : '',
        ...b.talksTo.slice(0, 2).map((t) => `<span class="design-tag ext">${esc(t)}</span>`),
      ].join('');
      const title = `${b.name}${b.purpose ? ` (${b.purpose})` : ''}: ${plural(b.files, 'file')}, ${plural(b.lines, 'line')}${b.churn ? `, ${plural(b.churn, 'change')} in 30 days` : ''}; used from outside ${b.in}×, uses outside ${b.out}×`;
      const open = b.kind === 'more' ? '' : `data-design-at="${esc(b.id)}"`;
      return `<div class="${cls}" ${open} role="${b.kind === 'more' ? 'note' : 'button'}" tabindex="${b.kind === 'more' ? -1 : 0}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px" title="${esc(title)}">
        <span class="design-name">${b.kind === 'folder' || b.kind === 'group' ? '▸ ' : ''}${esc(b.name)}</span>
        ${b.purpose ? `<span class="design-purpose">${esc(b.purpose)}</span>` : ''}
        <span class="design-size">${b.kind === 'group' && b.members !== b.files ? `${plural(b.members, 'part')} · ` : ''}${b.kind === 'file' ? '' : `${plural(b.files, 'file')} · `}${lines(b.lines)} lines</span>
        <span class="design-tags">${tags}</span>
      </div>`;
    })
    .join('');
  box.innerHTML = `<svg class="design-arrows" width="${W}" height="${height}">
      <defs><marker id="design-head" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" /></marker>
      <marker id="design-head-risk" class="risk" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" /></marker></defs>${arrows}</svg>${tiles}`;
}

function drawFile(f, box, esc, data) {
  box.style.height = '';
  const link = (p) => `<button class="link" data-design-at="${esc(p)}"><code>${esc(p)}</code></button>`;
  const kinds = { class: 'class', type: 'type', function: 'function', method: 'method' };
  box.innerHTML = `<div class="design-file">
    <p>${f.changed ? '<span class="design-tag changed">changed by the agent</span> ' : ''}${f.dependent ? '<span class="design-tag dependent">uses what the agent changed</span> ' : ''}
      <button class="small" data-design-code="1" title="Open it in ${esc(data.from?.name ?? 'the agent')}'s Code tab">Open the code</button></p>
    <h4>Functions and classes</h4>
    ${f.symbols.length ? `<ul class="design-symbols">${f.symbols.map((s) => `<li class="${s.kind}"><span class="hint">${kinds[s.kind] ?? s.kind}</span> <button class="link" data-design-code="${s.line}">${esc(s.name)}</button> <span class="hint">line ${s.line}</span></li>`).join('')}</ul>` : '<p class="hint">None found (only JavaScript, TypeScript, Python, Go, Java and Kotlin are read for them).</p>'}
    <div class="design-uses"><div><h4>Uses</h4>${f.imports.length ? f.imports.map(link).join('') : '<p class="hint">Nothing in this repository.</p>'}${f.pkgs.length ? `<p class="hint">Packages: ${f.pkgs.map(esc).join(', ')}</p>` : ''}</div>
    <div><h4>Used by</h4>${f.importedBy.length ? f.importedBy.map(link).join('') : '<p class="hint">Nothing in this repository imports it.</p>'}</div></div>
  </div>`;
}
