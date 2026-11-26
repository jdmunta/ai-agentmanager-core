// Value and paths: the part of a design that is a decision. Three things are read from Markdown
// the same way wherever they are written (the Insights call, or the agent's own brief):
//   Value - what the work is worth now against what it is worth later, and what waiting costs.
//   Kind  - whether it is just a task, worth writing up (a white paper), or possibly patentable.
//   Paths - the ways to do it, preferred first, each with its value now and later, cost and risk.
// Shared by the page and the daemon (brief.js reads an agent's "## Options" with it).

const LEVELS = ['high', 'medium', 'low'];
const COSTS = ['small', 'medium', 'large'];
export const KINDS = { task: 'Just a task', paper: 'Worth a white paper', patent: 'Possibly patentable' };

const level = (s, set = LEVELS) => set.find((l) => new RegExp(`^\\W*${l}\\b`, 'i').test(String(s ?? ''))) ?? null;
const clean = (s) => String(s ?? '').replace(/\*\*/g, '').trim();
/** "high - support stops doing this by hand" -> { level: 'high', why: 'support stops…' } */
const rated = (s, set = LEVELS) => {
  const t = clean(s);
  const l = level(t, set);
  return { level: l, why: (l ? t.replace(new RegExp(`^\\W*${l}\\b`, 'i'), '') : t).replace(/^\s*[-–—:,;.()]+\s*/, '').trim() };
};
const field = (md, name) => new RegExp(`^\\s*[-*]\\s+\\**\\s*${name}\\s*\\**\\s*:\\s*\\**\\s*(.+)$`, 'im').exec(String(md ?? ''))?.[1]?.trim() ?? '';

/** "### Value": { now, later: { level, why }, waiting, weighs: { side: now|later|both, why } } or null. */
export function parseValue(md) {
  const now = field(md, 'now');
  const later = field(md, 'later');
  if (!now && !later) return null;
  const w = clean(field(md, 'weighs'));
  const side = /^\W*(now|later|both)\b/i.exec(w)?.[1].toLowerCase() ?? null;
  return { now: rated(now), later: rated(later), waiting: clean(field(md, 'waiting')), weighs: { side, why: (side ? w.replace(/^\W*(now|later|both)\b/i, '') : w).replace(/^\s*[-–—:,;.]+\s*/, '').trim() } };
}

/** "### Kind": { kind: task|paper|patent, new, next } or null. */
export function parseKind(md) {
  const k = clean(field(md, 'kind')).toLowerCase();
  if (!k) return null;
  const kind = /patent/.test(k) ? 'patent' : /paper|write-?up|publish/.test(k) ? 'paper' : 'task';
  return { kind, new: clean(field(md, 'new')), next: clean(field(md, 'next')) };
}

/**
 * One path: "1. Name: what it is | now: high | later: low | cost: small | risk: low | when: …"
 * -> { rank, name, what, now, later, cost, risk, when }, or null when the line is not one.
 */
export function parsePathLine(line) {
  const m = /^\s*(\d+)[.)]\s+(.+)$/.exec(String(line ?? ''));
  if (!m) return null;
  const [head, ...rest] = m[2].split('|').map((s) => s.trim());
  const [name, ...what] = clean(head).split(/:\s+/);
  const get = (key) => rest.map((r) => new RegExp(`^\\**${key}\\**\\s*:\\s*(.+)$`, 'i').exec(r)?.[1]).find(Boolean) ?? '';
  if (!name) return null;
  return { rank: Number(m[1]), name: name.trim().slice(0, 120), what: what.join(': ').trim().slice(0, 300), now: level(get('now')), later: level(get('later')), cost: level(get('cost'), COSTS), risk: level(get('risk')), when: clean(get('when') || get('pick when')).slice(0, 300) };
}

/** "### Paths" (or a brief's "## Options"): { paths (by rank), preferred (why the first wins), new }. */
export function parsePaths(md) {
  const paths = String(md ?? '').split('\n').map(parsePathLine).filter(Boolean).slice(0, 6).sort((a, b) => a.rank - b.rank);
  return { paths, preferred: clean(field(md, 'preferred')).replace(/^\d+\s*[,:]?\s*(because\s+)?/i, '').slice(0, 400), new: clean(field(md, 'new')).slice(0, 300) };
}

const WORD = { high: 'High', medium: 'Medium', low: 'Low', small: 'Small', large: 'Large' };
const meter = (l) => `<span class="vl-meter vl-${l ?? 'none'}" aria-hidden="true"><i></i><i></i><i></i></span>`;

export function valueHtml(v, esc) {
  if (!v) return '';
  const row = (label, r) => `<div class="vl-row"><b>${label}</b> ${meter(r.level)} <span class="vl-word">${WORD[r.level] ?? 'Unclear'}</span><div class="hint">${esc(r.why)}</div></div>`;
  const weighs = { now: 'Design for now', later: 'Design for later', both: 'Both count' }[v.weighs.side];
  return `${row('Now', v.now)}${row('Later', v.later)}
    ${v.waiting ? `<p class="vl-line"><b>Waiting costs</b> ${esc(v.waiting)}</p>` : ''}
    ${weighs || v.weighs.why ? `<p class="vl-line"><b>${weighs ?? 'Weighs'}</b> ${esc(v.weighs.why)}</p>` : ''}`;
}

export function kindHtml(k, esc) {
  if (!k) return '';
  return `<p class="vl-line"><span class="tag vl-kind vl-kind-${k.kind}">${KINDS[k.kind]}</span></p>
    ${k.new ? `<p class="vl-line"><b>New</b> ${esc(k.new)}</p>` : ''}
    ${k.next ? `<p class="vl-line"><b>Next</b> ${esc(k.next)}</p>` : ''}
    ${k.kind === 'patent' ? '<p class="hint">A first read, not legal advice. Publishing before filing can cost the right to a patent: keep it private until you have talked to a patent attorney.</p>' : ''}`;
}

/**
 * The paths, preferred first. `tries` (in an agent's Results): each other path gets a Try this
 * path button, or the agent already trying it: { 2: { id, name } }.
 */
export function pathsHtml(p, esc, tries = null) {
  if (!p?.paths.length) return '';
  const tryOf = (i) => {
    if (!tries || i === 0) return '';
    const t = tries[i + 1];
    return t
      ? `<div class="vl-try hint">Being tried by <button class="link" data-act="try-path-open" data-agent="${esc(t.id)}">${esc(t.name)}</button></div>`
      : `<div class="vl-try"><button class="small" data-act="try-path" data-path="${i + 1}" title="Start this path as a second agent from the same commit, and compare the two">Try this path</button></div>`;
  };
  const chip = (label, l, good) => (l ? `<span class="vl-chip ${good.includes(l) ? 'vl-good' : l === 'medium' ? '' : 'vl-poor'}">${label} ${l}</span>` : '');
  return `<ol class="vl-paths">${p.paths
    .map(
      (x, i) => `<li class="${i === 0 ? 'vl-first' : ''}">
        <div class="vl-name">${i === 0 ? '<span class="tag vl-pick">Preferred</span> ' : ''}<b>${esc(x.name)}</b>${x.what ? ` <span class="hint">${esc(x.what)}</span>` : ''}</div>
        <div class="vl-chips">${chip('now', x.now, ['high'])}${chip('later', x.later, ['high'])}${chip('cost', x.cost, ['small'])}${chip('risk', x.risk, ['low'])}</div>
        ${x.when ? `<div class="hint">Pick when: ${esc(x.when)}</div>` : ''}
        ${tryOf(i)}
      </li>`,
    )
    .join('')}</ol>
    ${p.preferred ? `<p class="vl-line"><b>Why the first</b> ${esc(p.preferred)}</p>` : ''}`;
}

/**
 * In the agent's Results: the ways it weighed before building, preferred first. `tries`: the
 * agents trying its other paths ({ n: { id, name } }), or null where none can be tried.
 */
export function optionsRows(a, esc, tries = null) {
  const o = a.brief?.options;
  if (!o?.paths?.length && !o?.new) return '';
  return `<details class="vl-options"${o.new ? ' open' : ''}><summary><b>Paths it weighed</b> <span class="hint">${o.paths.length ? `${o.paths.length}, preferred first${o.paths[0] ? `: ${esc(o.paths[0].name)}` : ''}` : ''}</span></summary>
    ${pathsHtml(o, esc, tries)}
    ${o.new ? `<p class="vl-line"><span class="tag vl-kind vl-kind-paper">Possibly new</span> ${esc(o.new)} <span class="hint">Kept inside the repository; whether it is worth a paper or a patent is yours to decide.</span></p>` : ''}
  </details>`;
}

/** In the agent's Results: that its work is kept private, why, and the way to allow sharing; or the way to keep it private. */
export function privateRow(a, esc) {
  const k = a.keptPrivate;
  if (k)
    return `<div class="kept-private"><b>🔒 Kept private</b> <span>${esc(k.why)}.</span>
      <p class="hint">The app does not publish or send it: no Google Drive, update, Slack, comment on the pull request or new pull request. Publishing before filing can cost the right to a patent; talk to a patent attorney first.</p>
      <button class="small" data-act="idea-allow" title="You decide it can be shared: the holds are lifted">Allow sharing</button></div>`;
  if (a.idea?.allowed) return `<p class="hint kept-private-off">Sharing allowed by you. <button class="link" data-act="idea-reset">Undo</button></p>`;
  return '';
}
