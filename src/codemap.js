// Codebase map: a repository's folders, sized by how many files they hold, with each agent in that
// repository on the folders it is changing or reading right now. Two agents that changed the same
// file are about to conflict; one reading a file another has changed is heading that way, which is
// the earlier warning. Changes come from the conflict radar's diffs, reading from the last half
// hour of the agent's transcript.

import fs from 'node:fs';
import path from 'node:path';

export const RECENT_MS = 30 * 60_000;
const MAX_FILES = 20_000;
const TAIL_BYTES = 768 * 1024;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

/** The folder a file belongs to on the map: its first `depth` directories ("." for top-level files). */
export function moduleOf(file, depth = 2) {
  const parts = file.split('/').slice(0, -1);
  return parts.length ? parts.slice(0, depth).join('/') : '.';
}

/** Files the agent's tools touched since `since`, from its transcript: { file: { kind, at } }, kind 'edit' or 'read'. */
export function touchedFiles(transcript, workdir, since = Date.now() - RECENT_MS) {
  const out = {};
  let text = '';
  try {
    const st = fs.statSync(transcript);
    const fd = fs.openSync(transcript, 'r');
    try {
      const len = Math.min(st.size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return out;
  }
  const root = workdir.endsWith('/') ? workdir : `${workdir}/`;
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line may be cut
    }
    const at = Date.parse(entry.timestamp ?? 0);
    if (!(at >= since)) continue;
    for (const c of entry.message?.content ?? []) {
      if (c?.type !== 'tool_use') continue;
      const kind = EDIT_TOOLS.has(c.name) ? 'edit' : READ_TOOLS.has(c.name) ? 'read' : null;
      const p = c.input?.file_path ?? c.input?.notebook_path ?? c.input?.path;
      if (!kind || typeof p !== 'string') continue;
      const abs = path.isAbsolute(p) ? p : path.join(workdir, p);
      if (!abs.startsWith(root)) continue;
      const rel = abs.slice(root.length);
      if (!rel || rel.startsWith('.git/')) continue;
      const prev = out[rel];
      // An edit outranks a read; otherwise the latest time wins.
      if (!prev || (kind === 'edit' && prev.kind === 'read') || (kind === prev.kind && at > prev.at)) out[rel] = { kind, at };
    }
  }
  return out;
}

/**
 * The map: { modules: [{ key, files, agents: [{ id, changed, reading }] }], agents, links }.
 * agents: [{ id, name, busy, attention, changed: { file: {added, removed} }, touched: { file: {kind, at} } }].
 * links: [{ a, b, kind: 'collide' | 'heading' | 'near', files }], 'heading' from `a` (reading) to `b` (changed it).
 */
export function buildMap({ files = [], agents = [], depth = 2 }) {
  const modules = new Map();
  const mod = (key) => modules.get(key) ?? modules.set(key, { key, files: 0, agents: new Map() }).get(key);
  for (const f of files.slice(0, MAX_FILES)) mod(moduleOf(f, depth)).files += 1;
  const touch = (id, file, what) => {
    const m = mod(moduleOf(file, depth));
    const x = m.agents.get(id) ?? m.agents.set(id, { id, changed: 0, reading: 0 }).get(id);
    x[what] += 1;
  };
  for (const a of agents) {
    for (const f of Object.keys(a.changed ?? {})) touch(a.id, f, 'changed');
    for (const [f, t] of Object.entries(a.touched ?? {})) if (!a.changed?.[f] && t.kind === 'read') touch(a.id, f, 'reading');
  }
  const links = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const x = agents[i];
      const y = agents[j];
      const cx = Object.keys(x.changed ?? {});
      const cy = new Set(Object.keys(y.changed ?? {}));
      const both = cx.filter((f) => cy.has(f));
      if (both.length) {
        links.push({ a: x.id, b: y.id, kind: 'collide', files: both.slice(0, 10) });
        continue;
      }
      // Reading what the other changed: the next step is often an edit there.
      const heading = (r, c) => Object.entries(r.touched ?? {}).filter(([f, t]) => t.kind === 'read' && !r.changed?.[f] && c.changed?.[f]).map(([f]) => f);
      const xy = heading(x, y);
      const yx = heading(y, x);
      if (xy.length) links.push({ a: x.id, b: y.id, kind: 'heading', files: xy.slice(0, 10) });
      if (yx.length) links.push({ a: y.id, b: x.id, kind: 'heading', files: yx.slice(0, 10) });
      if (xy.length || yx.length) continue;
      const mx = new Set([...cx, ...Object.keys(x.touched ?? {})].map((f) => moduleOf(f, depth)));
      const near = [...new Set([...cy, ...Object.keys(y.touched ?? {})].map((f) => moduleOf(f, depth)))].filter((m) => mx.has(m));
      if (near.length) links.push({ a: x.id, b: y.id, kind: 'near', files: near.slice(0, 5) });
    }
  }
  return {
    modules: [...modules.values()].map((m) => ({ key: m.key, files: m.files, agents: [...m.agents.values()] })).sort((a, b) => b.files - a.files || a.key.localeCompare(b.key)),
    agents: agents.map(({ id, name, busy, attention, changed, touched }) => ({ id, name, busy: Boolean(busy), attention: Boolean(attention), changed: Object.keys(changed ?? {}).length, reading: Object.values(touched ?? {}).filter((t) => t.kind === 'read').length })),
    links,
  };
}

// Bugs on the map: each folder's heat is its open bugs, weighted by severity, plus a little for how
// much it changed lately (new bugs come from changed code). A finding that names its path through
// the code ("a.js:3 -> b/c.js:9") is drawn as arrows from folder to folder along it: the hot paths,
// thicker where several bugs go the same way. Folders no hunt has looked at are the cold spots.

export const SEVERITY_WEIGHT = { critical: 8, high: 4, medium: 2, low: 1 };
// Still in the code: not a bug, not kept, or done with are left out.
const LIVE = new Set(['open', 'fixing', 'pr', 'filed', 'snoozed']);
const CHURN_WEIGHT = 0.25;
const MAX_CHURN = 20;

/** A path as the repository lists it: as given, without "./" or an absolute prefix, or by its unique end. */
export function resolveFile(p, files, set = new Set(files)) {
  const v = String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!v) return null;
  if (set.has(v)) return v;
  const tail = v.replace(/^\/+/, '');
  if (set.has(tail)) return tail;
  const hits = files.filter((f) => f === tail || f.endsWith(`/${tail}`) || tail.endsWith(`/${f}`));
  return hits.length === 1 ? hits[0] : null;
}

/** The files, in order, of a path through the code written as file:line steps. */
export function traceFiles(detail, files, set = new Set(files)) {
  const out = [];
  for (const m of String(detail ?? '').matchAll(/([\w@.\-/\\]+\.[A-Za-z]\w*):(\d+)/g)) {
    const f = resolveFile(m[1], files, set);
    if (f && out[out.length - 1] !== f) out.push(f);
  }
  return out;
}

/**
 * The bugs layer: { modules: { key: { score, bugs, churn, covered, files, findings } }, paths, findings, max, hunted }.
 * `findings` are a hunt's findings in this repository; `churn` the recent commits, each a list of
 * the files it changed (a folder's churn is how many commits touched it, however many files); `hunts`
 * the project's hunts (their folder, focus, what they covered, and whether one has run).
 */
export function bugHeat({ files = [], findings = [], churn = [], hunts = [], depth = 2 }) {
  const set = new Set(files);
  const modules = {};
  const mod = (key) => (modules[key] ??= { score: 0, bugs: { critical: 0, high: 0, medium: 0, low: 0 }, churn: 0, covered: false, files: {}, findings: [] });
  for (const commit of churn) for (const key of new Set(commit.filter((f) => set.has(f)).map((f) => moduleOf(f, depth)))) mod(key).churn += 1;
  const paths = new Map();
  const shown = [];
  for (const f of findings) {
    if (!LIVE.has(f.status)) continue;
    const file = resolveFile(f.file, files, set);
    const steps = f.evidence?.type === 'trace' ? traceFiles(f.evidence.detail, files, set) : [];
    if (file && steps[steps.length - 1] !== file) steps.push(file);
    const at = file ?? steps[steps.length - 1];
    if (!at) continue;
    const w = SEVERITY_WEIGHT[f.severity] ?? 1;
    const m = mod(moduleOf(at, depth));
    m.bugs[f.severity in m.bugs ? f.severity : 'medium'] += 1;
    m.score += w;
    m.files[at] = (m.files[at] ?? 0) + w;
    m.findings.push(f.id);
    shown.push({ id: f.id, title: f.title, severity: f.severity, status: f.status, file: at, line: f.line ?? null, module: moduleOf(at, depth), prUrl: f.prUrl ?? null, steps: steps.length });
    // Folder to folder along its path; staying in one folder isn't an arrow.
    const route = steps.map((s) => moduleOf(s, depth)).filter((x, i, a) => i === 0 || a[i - 1] !== x);
    for (let i = 1; i < route.length; i++) {
      const key = `${route[i - 1]}\u0000${route[i]}`;
      const p = paths.get(key) ?? paths.set(key, { from: route[i - 1], to: route[i], weight: 0, findings: [] }).get(key);
      p.weight += w;
      if (!p.findings.includes(f.id)) p.findings.push(f.id);
    }
  }
  // Covered: a hunt that has run looks at this folder (its folder, and for a whole-module hunt, the parts it went through).
  const ran = hunts.filter((h) => h.ran);
  const inside = (key, p) => !p || key === p || key.startsWith(`${p}/`) || p.startsWith(`${key}/`);
  for (const key of new Set(files.slice(0, 20_000).map((f) => moduleOf(f, depth)))) {
    const m = mod(key);
    m.covered = ran.some((h) => inside(key, h.path) && (h.focus !== 'module' || !h.covered?.length || h.covered.some((c) => inside(key, String(c).replace(/^\.?\/+|\/+$/g, '')))));
  }
  let max = 0;
  for (const m of Object.values(modules)) {
    m.score += Math.min(m.churn, MAX_CHURN) * CHURN_WEIGHT;
    m.score = Math.round(m.score * 100) / 100;
    max = Math.max(max, m.score);
    m.files = Object.entries(m.files).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([file, score]) => ({ file, score }));
  }
  return { modules, paths: [...paths.values()].sort((a, b) => b.weight - a.weight).slice(0, 60), findings: shown, max, hunted: hunts.length > 0 };
}
