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
