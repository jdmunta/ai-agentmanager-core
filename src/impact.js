// An agent's change seen at the Logical view's level: the features whose flow it touches (functions
// in it changed, steps come or gone, routes added or removed) and the links between components that
// came, went or call other routes now. Read by comparing the code now with the same code at the
// agent's base (its changed files read from the base commit).

import { featureFlow, featureList } from './flows.js';
import { componentMap, logicalView } from './logical.js';
import { featureChangeWords } from '../public/logical.js';

const MAX_FEATURES = 60;
const MAX_STEPS = 30; // changed steps listed for one feature

const stepKey = (s) => `${s.file}#${s.name}`;

const sigMemo = new WeakMap();

/** Each function's and route handler's fingerprint in a graph: Map("file#name" -> sig). */
function sigsOf(graph) {
  const hit = sigMemo.get(graph);
  if (hit) return hit;
  const out = new Map();
  for (const [f, info] of Object.entries(graph.files)) {
    for (const fn of info.code?.fns ?? []) out.set(`${f}#${fn.name}`, fn.sig);
    (info.links?.routes ?? []).forEach((r, i) => out.set(`${f}#${r.method} ${r.path}`, info.code?.routeCalls[i]?.sig ?? null));
  }
  sigMemo.set(graph, out);
  return out;
}

/**
 * Steps of two flows of a feature compared: those changed, new and gone. A step is new or gone only
 * when it, or the step calling it, changed (not when the flow's limit reached other functions).
 */
function stepsCompared(before, now, { graphBefore, graphNow }) {
  const was = new Map((before?.steps ?? []).map((s) => [stepKey(s), s]));
  const is = new Map((now?.steps ?? []).map((s) => [stepKey(s), s]));
  const sb = sigsOf(graphBefore);
  const sn = sigsOf(graphNow);
  const moved = (k) => !k || sb.get(k) !== sn.get(k) || !sb.has(k) || !sn.has(k);
  const out = [];
  for (const [k, s] of is) {
    const old = was.get(k);
    if (!old) {
      if (!before || moved(k) || moved(s.from)) out.push({ ...pick(s), how: 'new' });
    } else if (old.sig !== s.sig) out.push({ ...pick(s), how: 'changed' });
  }
  for (const [k, s] of was) if (!is.has(k) && (!now || moved(k) || moved(s.from))) out.push({ ...pick(s), how: 'gone' });
  return out;
}

const pick = (s) => ({ file: s.file, name: s.name, line: s.line, comp: s.comp ?? null, route: Boolean(s.route) });

/** Callers of a feature compared: page functions or commands that call it now and didn't, or the other way. */
function callersCompared(before, now) {
  const key = (c) => `${c.file}#${c.name}`;
  const was = new Map((before?.callers ?? []).map((c) => [key(c), c]));
  const is = new Map((now?.callers ?? []).map((c) => [key(c), c]));
  const out = [];
  for (const [k, c] of is) {
    if (!was.has(k)) out.push({ file: c.file, name: c.name, line: c.line, how: 'new' });
    else if (was.get(k).sig !== c.sig) out.push({ file: c.file, name: c.name, line: c.line, how: 'changed' });
  }
  for (const [k, c] of was) if (!is.has(k)) out.push({ file: c.file, name: c.name, line: c.line, how: 'gone' });
  return out;
}

/**
 * What changed from `before` to `now`, at the level of features and components:
 * { features: [{ key, name, how: 'new' | 'gone' | 'changed', routes: { added, gone }, steps: [{ file,
 * name, line, comp, how }], callers: [...] }], links: { added, gone, changed: [{ from, to, routes: {
 * added, gone } }] } }.
 */
export function changeImpact(now, before, { notes = null } = {}) {
  const compNow = componentMap(now, notes);
  const compBefore = componentMap(before, notes);
  const keys = new Set([...featureList(now), ...featureList(before)].map((f) => f.key));
  const features = [];
  for (const key of keys) {
    const a = featureFlow(before, key, { compOf: (f) => compBefore.get(f) ?? null });
    const b = featureFlow(now, key, { compOf: (f) => compNow.get(f) ?? null });
    const routes = { added: (b?.routes ?? []).filter((r) => !(a?.routes ?? []).includes(r)), gone: (a?.routes ?? []).filter((r) => !(b?.routes ?? []).includes(r)) };
    const steps = stepsCompared(a, b, { graphBefore: before, graphNow: now });
    const callers = callersCompared(a, b);
    if (a && b && !steps.length && !callers.length && !routes.added.length && !routes.gone.length) continue;
    const named = notes?.features?.[key];
    const kind = (b ?? a).kind;
    features.push({
      key,
      kind,
      name: named?.name || (kind === 'start' ? `Starts: ${key.slice(6)}` : key),
      how: !a ? 'new' : !b ? 'gone' : 'changed',
      routes,
      steps: steps.slice(0, MAX_STEPS),
      more: Math.max(0, steps.length - MAX_STEPS),
      callers,
    });
  }
  // The most changed first; new and gone features before the rest.
  const weight = (f) => (f.how === 'changed' ? 0 : 100) + f.routes.added.length + f.routes.gone.length + f.steps.length + f.callers.length;
  features.sort((x, y) => weight(y) - weight(x) || x.name.localeCompare(y.name));
  // The links between components: came, went, or carrying other routes now.
  const V = logicalView(now, { notes, routesMax: Infinity });
  const W = logicalView(before, { notes, routesMax: Infinity });
  const k = (e) => `${e.from}\n${e.to}`;
  const was = new Map(W.edges.filter((e) => !e.guessed).map((e) => [k(e), e]));
  const is = new Map(V.edges.filter((e) => !e.guessed).map((e) => [k(e), e]));
  const brief = (e) => ({ from: e.from, to: e.to, found: e.found });
  const links = { added: [], gone: [], changed: [] };
  for (const [key, e] of is) {
    const old = was.get(key);
    if (!old) links.added.push(brief(e));
    else {
      const added = e.routes.filter((r) => !old.routes.includes(r));
      const gone = old.routes.filter((r) => !e.routes.includes(r));
      if (added.length || gone.length) links.changed.push({ ...brief(e), routes: { added, gone } });
    }
  }
  for (const [key, e] of was) if (!is.has(key)) links.gone.push(brief(e));
  // The components' names, for the links shown away from the view.
  const names = {};
  for (const c of [...W.components, ...V.components]) names[c.id] = c.name;
  return { features: features.slice(0, MAX_FEATURES), featureCount: features.length, links, names };
}

/**
 * A pull request's changes at the level of features and components, as Markdown for a comment on
 * it: each feature with its routes and the functions changed, new or gone, then the links.
 */
export function impactMarkdown(impact, { from = 'its base' } = {}) {
  // Names written by a model: no Markdown of their own, and no @mention that would notify someone.
  const plain = (s) => String(s).replace(/[\\`*_[\]<>#|~]/g, (c) => `\\${c}`).replace(/@/g, '@\u200b');
  const name = (id) => plain(impact.names?.[id] ?? id);
  const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;
  const out = [`### What this changes in the system`, '', `Features and the links between components, against ${from}. Read from the code by AI Agent Manager; no model wrote it.`, ''];
  if (impact.features.length) {
    out.push(`**Features** (${impact.featureCount})`, '');
    for (const f of impact.features) {
      out.push(`- **${plain(f.name)}**: ${f.how === 'changed' ? '' : `${f.how}; `}${featureChangeWords(f) || 'its flow changed'}`);
      for (const r of f.routes.added) out.push(`  - route added: ${code(r)}`);
      for (const r of f.routes.gone) out.push(`  - route removed: ${code(r)}`);
      for (const s of f.steps.slice(0, 8)) out.push(`  - ${s.how}: ${code(`${s.name}`)} in ${code(`${s.file}:${s.line}`)}`);
      const left = f.steps.length + f.more - Math.min(8, f.steps.length);
      if (left) out.push(`  - and ${left} more ${left === 1 ? 'function' : 'functions'}`);
      for (const c of f.callers) out.push(`  - caller ${c.how}: ${code(c.name)} in ${code(c.file)}`);
    }
    if (impact.featureCount > impact.features.length) out.push(`- and ${impact.featureCount - impact.features.length} more`);
    out.push('');
  } else out.push("No feature's flow changed.", '');
  const L = impact.links;
  if (L.added.length || L.gone.length || L.changed.length) {
    out.push('**Links between components**', '');
    for (const e of L.added) out.push(`- new: ${name(e.from)} → ${name(e.to)}${e.found ? ` (${plain(e.found)})` : ''}`);
    for (const e of L.gone) out.push(`- gone: ${name(e.from)} → ${name(e.to)}`);
    for (const e of L.changed) out.push(`- changed: ${name(e.from)} → ${name(e.to)}${e.routes.added.length ? `, now also ${e.routes.added.map(code).join(', ')}` : ''}${e.routes.gone.length ? `, no longer ${e.routes.gone.map(code).join(', ')}` : ''}`);
  } else out.push('No link between components came, went or changed.');
  return out.join('\n');
}

// ------------------------------------------------------------------ change requests

export const LOGICAL_REQUEST_HEAD = 'A change asked from the Logical view of';
const MAX_LISTED = 40;

const listed = (xs, n = MAX_LISTED) => (xs.length > n ? [...xs.slice(0, n), `and ${xs.length - n} more`] : xs);

/** The files an arrow's evidence names ("web/page.js calls GET /api/x (src/server.js)"): both ends. */
function evidenceFiles(e) {
  const out = new Set();
  for (const x of e.evidence ?? []) {
    out.add(x.split(' ')[0]);
    const m = /\(([^()\s]+)\)$/.exec(x);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/**
 * What a request is about, found in a view of the code: { title, files, flow, edge, comp } or null
 * when it is not there. target: { kind: 'feature', key } | { kind: 'box', id } | { kind: 'edge', from, to }.
 * comps: componentMap of the graph.
 */
export function requestPart(V, target, comps) {
  const name = (id) => V.components.find((c) => c.id === id)?.name ?? id;
  if (target.kind === 'feature') {
    const F = V.flow?.key === target.key ? V.flow : null;
    return F ? { title: `the feature "${F.name}"`, short: F.name, flow: F } : null;
  }
  if (target.kind === 'box') {
    const c = V.components.find((x) => x.id === target.id && x.kind === 'component');
    return c ? { title: `the component "${c.name}"`, short: c.name, comp: c, files: [...comps].filter(([, id]) => id === c.id).map(([f]) => f).sort() } : null;
  }
  const e = V.edges.find((x) => x.from === target.from && x.to === target.to);
  return e ? { title: `the link from "${name(e.from)}" to "${name(e.to)}"`, short: `${name(e.from)} → ${name(e.to)}`, edge: e, files: evidenceFiles(e) } : null;
}

/** The request for the agent: what to change, about which part, and what the code shows of it now. */
export function logicalRequestPrompt(V, part, { project, words }) {
  const name = (id) => V.components.find((c) => c.id === id)?.name ?? id;
  const at = (f, line) => `\`${f}\`${line ? ` (line ${line})` : ''}`;
  const lines = [`${LOGICAL_REQUEST_HEAD} ${project} in Agent Manager, about ${part.title}:`, '', words.trim(), '', 'What the code shows of it now:'];
  const F = part.flow;
  if (F) {
    if (F.what) lines.push(`- What it is: ${F.what}`);
    if (F.callers.length) lines.push(`- Called from: ${listed(F.callers.map((c) => `${c.name ? `${c.name}() in ` : ''}${at(c.file, c.line)}`), 12).join(', ')}`);
    if (F.routes.length) lines.push(`- Routes: ${listed(F.routes.map((r) => `\`${r}\``), 20).join(', ')}`);
    lines.push('- Through the code:');
    for (const s of F.steps.slice(0, MAX_LISTED)) lines.push(`  ${'  '.repeat(s.depth)}- ${s.route ? `\`${s.name}\`` : `${s.name}()`} in ${at(s.file, s.line)}${s.comp ? `, ${name(s.comp)}` : ''}${s.does ? ` (${s.does})` : ''}`);
    if (F.steps.length > MAX_LISTED) lines.push(`  - and ${F.steps.length - MAX_LISTED} more`);
    const comps = F.comps.map(name);
    if (comps.length) lines.push(`- Components it goes through: ${comps.join(', ')}`);
  } else if (part.comp) {
    const c = part.comp;
    if (c.purpose) lines.push(`- What it does: ${c.purpose}`);
    lines.push(`- Its files: ${listed(part.files.map((f) => `\`${f}\``)).join(', ')}`);
    const link = (e, other) => `${name(other)}${e.data ? `: ${e.data}` : ''}${e.found ? ` (${e.found})` : ''}`;
    const outs = V.edges.filter((e) => e.from === c.id && !e.guessed);
    const ins = V.edges.filter((e) => e.to === c.id && !e.guessed);
    if (outs.length) lines.push(`- It uses: ${outs.map((e) => link(e, e.to)).join('; ')}`);
    if (ins.length) lines.push(`- Used by: ${ins.map((e) => link(e, e.from)).join('; ')}`);
  } else {
    const e = part.edge;
    if (e.data) lines.push(`- It carries: ${e.data}`);
    lines.push(e.guessed ? '- The code does not show it; the link was guessed from the names.' : `- The code shows: ${e.found}`);
    if (e.routes.length) lines.push(`- Routes called: ${listed(e.routes.map((r) => `\`${r}\``), 30).join(', ')}`);
    if (e.evidence.length) lines.push(`- Where: ${listed(e.evidence, 12).join('; ')}`);
  }
  lines.push('', 'Make the change in every part it needs, keep the rest of the behaviour the same, update or add tests, and run them. If it is a bad idea or needs much more than it says, say so and ask before making it. When done, say what you changed in each part.');
  return lines.join('\n');
}

/** The functions and route handlers a request covers, each with its fingerprint: { "file#name": sig }. */
export function requestSnapshot(graph, part) {
  const out = {};
  if (part.flow) {
    for (const s of [...part.flow.steps, ...part.flow.callers]) if (s.name) out[`${s.file}#${s.name}`] = s.sig ?? null;
    return out;
  }
  for (const f of part.files.slice(0, 400)) {
    const info = graph.files[f];
    for (const fn of info?.code?.fns ?? []) out[`${f}#${fn.name}`] = fn.sig;
    (info?.links?.routes ?? []).forEach((r, i) => (out[`${f}#${r.method} ${r.path}`] = info.code?.routeCalls[i]?.sig ?? null));
  }
  return out;
}

/** What changed in what a request covers since it was sent: { changed, new, gone } of "file#name". */
export function snapshotCompared(before, now) {
  const out = { changed: [], new: [], gone: [] };
  for (const [k, sig] of Object.entries(now)) {
    if (!(k in before)) out.new.push(k);
    else if (before[k] !== sig) out.changed.push(k);
  }
  for (const k of Object.keys(before)) if (!(k in now)) out.gone.push(k);
  return out;
}
