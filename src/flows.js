// Features as flows, for the Logical view: each feature is an entry point (a group of HTTP routes,
// or where the program starts) traced through the calls in the code to where it ends: the
// functions it goes through, in which components, and what each does outside the code (programs
// run, hosts called, files read and written). Who calls it (a page, the CLI) is found from the URL
// paths in their code. All of it read from the code; a model only names the features.
//
// The calls are traced by name: a function called is the one of that name in the same file, in a
// file named like what it is called on (manager.debug() in manager.js, this.store.save() in
// store.js), in a file imported, or the only one in the repository. Calls through variables,
// callbacks and events are not followed.

import { langOf, serviceOf } from './layers.js';
import { FS_IMPORT, effectsOf, httpLinks, isTest, pathFits } from './logical.js';

const MAX_DEPTH = 6;
const MAX_STEPS = 40; // functions in one route's flow
const MAX_FEATURE_STEPS = 80;
const MAX_ROUTES_TRACED = 30; // routes of one feature followed
const SPAN = 30; // lines of a route's handler read, at most
const NOT_CALLS = new Set('if for while switch catch function return typeof await new super import require constructor elif def print len str int dict list set tuple isinstance range'.split(' '));

/** The calls in a piece of code: [{ recv, name }] (recv: what it is called on, if anything). */
export function callsIn(text) {
  const seen = new Set();
  const out = [];
  // recv '.': called on a value (list.map(), [..].join()), not followed.
  for (const m of text.matchAll(/(?:\b([A-Za-z_$][\w$]*)\s*\??\.\s*|([)\]'"`])\s*\??\.\s*)?\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const [recv, name] = [m[1] ?? (m[2] ? '.' : null), m[3]];
    if (recv === '.') continue;
    if (NOT_CALLS.has(name) || /^[A-Z][A-Z0-9_]+$/.test(name)) continue;
    const k = `${recv}.${name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ recv, name });
  }
  return out.slice(0, 200);
}

// Databases in the standard library, which no package names.
const STD_SERVICES = { sqlite3: 'SQLite', 'node:sqlite': 'SQLite', 'database/sql': 'SQL database' };

/**
 * The names a file binds to outside services: { name: 'PostgreSQL' }, from its imports (import pg
 * from 'pg', import redis, "database/sql") and what is made from them (r = redis.Redis()).
 */
export function serviceNames(file, text) {
  const lang = langOf(file);
  const out = {};
  const bind = (name, spec) => {
    const s = STD_SERVICES[spec] ?? serviceOf(spec);
    if (s && /^[A-Za-z_$][\w$]*$/.test(name)) out[name] = s;
  };
  if (lang === 'js') {
    for (const m of text.matchAll(/import\s+(?:([\w$]+)\s*,?\s*)?(?:\*\s+as\s+([\w$]+)|\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g))
      for (const n of [m[1], m[2], ...(m[3] ?? '').split(',').map((x) => x.trim().split(/\s+as\s+/).pop())]) if (n) bind(n, m[4]);
    for (const m of text.matchAll(/(?:const|let|var)\s+(?:([\w$]+)|\{([^}]*)\})\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g))
      for (const n of [m[1], ...(m[2] ?? '').split(',').map((x) => x.trim().split(':').pop().trim())]) if (n) bind(n, m[3]);
  } else if (lang === 'py') {
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm)) bind(m[2] ?? m[1].split('.')[0], m[1].split('.')[0]);
    for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([^\n#]+)/gm)) for (const n of m[2].replace(/[()]/g, '').split(',')) bind(n.trim().split(/\s+as\s+/).pop(), m[1].split('.')[0]);
  } else if (lang === 'go') {
    for (const m of text.matchAll(/^\s*(?:(\w+)\s+)?"([^"]+)"\s*$/gm)) bind(m[1] ?? m[2].split('/').filter((x) => !/^v\d+$/.test(x)).pop().replace(/^go-/, ''), m[2]);
  }
  // What is made from them: pool = new pg.Pool(), r = redis.Redis().
  for (const m of text.matchAll(/^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*:?=\s*(?:new\s+|await\s+)?([A-Za-z_$][\w$]*)\s*[.(]/gm)) if (out[m[2]] && !out[m[1]]) out[m[1]] = out[m[2]];
  return out;
}

/** A short fingerprint of some code, to tell whether it changed: its lines, trailing spaces aside. */
export function sigOf(text) {
  let h = 5381;
  for (const l of text.trimEnd().split('\n')) {
    const t = l.trimEnd();
    for (let i = 0; i < t.length; i++) h = (Math.imul(h, 33) ^ t.charCodeAt(i)) >>> 0;
    h = (Math.imul(h, 33) ^ 10) >>> 0;
  }
  return h.toString(36);
}

/** The services a piece of code uses: those whose names it calls or reads from. */
function servicesIn(body, names) {
  const used = new Set();
  for (const [n, s] of Object.entries(names)) if (new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}\\s*[.(]`).test(body)) used.add(s);
  return [...used];
}

/**
 * A file's functions with what each calls and does outside the code, and the calls in each of its
 * routes' handlers: { fns: [{ name, line, end, calls, effects, sig }], routeCalls: [{ calls, effects,
 * sig }], top }. top: the calls outside any function (a script's body); sig: see sigOf.
 */
export function codeOf(file, text, symbols = [], routes = []) {
  const lang = langOf(file);
  const lines = text.split('\n');
  const fsImported = FS_IMPORT.test(text);
  const names = serviceNames(file, text);
  const effects = (body) => ({ ...effectsOf(lang, body, { fsImported }), services: servicesIn(body, names) });
  const at = (a, b) => lines.slice(a - 1, b).join('\n');
  // Functions inside functions too (JavaScript), each its own step.
  const nested = lang === 'js' ? lines.flatMap((l, i) => (/^\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.test(l) ? [{ name: l.match(/function\s*\*?\s*([A-Za-z_$][\w$]*)/)[1], kind: 'function', line: i + 1 }] : [])) : [];
  const defs = [...symbols.filter((s) => s.kind !== 'type'), ...nested].sort((a, b) => a.line - b.line);
  // A body ends at the next definition, or before that where the indentation comes back (with the
  // line closing it: "}", ")").
  const indent = (l) => l.match(/^\s*/)[0].length;
  const blockEnd = (line) => {
    const k = indent(lines[line - 1]);
    for (let i = line; i < lines.length; i++) {
      if (!lines[i].trim() || indent(lines[i]) > k) continue;
      return /^\s*[}\])]/.test(lines[i]) ? i + 1 : i;
    }
    return lines.length;
  };
  const fns = defs.map((s, i) => {
    const next = (defs[i + 1]?.line ?? lines.length + 1) - 1;
    const end = Math.min(next, blockEnd(s.line));
    const body = at(s.line, end);
    const inner = body.split('\n').slice(1).join('\n');
    return { name: s.name, kind: s.kind, line: s.line, end, calls: callsIn(inner), effects: effects(inner), sig: sigOf(body) };
  });
  const lineOf = routes.map((r) => r.line).sort((a, b) => a - b);
  const routeCalls = routes.map((r) => {
    const next = lineOf.find((l) => l > r.line) ?? Infinity;
    const body = at(r.line, Math.min(next - 1, r.end ?? r.line + SPAN - 1));
    return { calls: callsIn(body), effects: effects(body), sig: sigOf(body) };
  });
  const inside = new Set();
  for (const f of fns) for (let l = f.line; l <= f.end; l++) inside.add(l);
  const top = callsIn(lines.filter((_, i) => !inside.has(i + 1)).join('\n'));
  return { fns, routeCalls, top };
}

/** Each source file's functions and calls, kept on the graph (graph.files[f].code). */
export function addFlows(graph, sources) {
  for (const { path: p, text } of sources) {
    const info = graph.files[p];
    if (!info || !text || isTest(p) || !langOf(p)) continue;
    info.code = codeOf(p, text, info.symbols, info.links?.routes ?? []);
  }
  return graph;
}

const memo = { features: new WeakMap(), resolve: new WeakMap(), callers: new WeakMap() };

/** Which function a call lands on, by name (see the top). Kept for the graph. */
function resolver(graph) {
  const hit = memo.resolve.get(graph);
  if (hit) return hit;
  const r = makeResolver(graph);
  memo.resolve.set(graph, r);
  return r;
}

function makeResolver(graph) {
  const byName = new Map();
  for (const [f, info] of Object.entries(graph.files)) {
    for (const [i, fn] of (info.code?.fns ?? []).entries()) {
      const names = fn.name.includes('.') ? [fn.name, fn.name.split('.').pop()] : [fn.name];
      for (const n of names) (byName.get(n) ?? byName.set(n, []).get(n)).push({ file: f, i });
    }
  }
  const base = (f) => f.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
  const dir = (f) => f.split('/').slice(0, -1).join('/');
  return (from, { recv, name }) => {
    const cands = byName.get(name);
    if (!cands?.length) return null;
    if (recv === 'this' || recv === 'self') return cands.find((c) => c.file === from) ?? null;
    // Called on something: the file named like it (manager.debug() in manager.js), else not followed.
    if (recv) {
      const r = recv.toLowerCase();
      return cands.find((c) => base(c.file) === r || base(c.file) === r.replace(/s$/, '')) ?? null;
    }
    // By its name alone: in the same file, a file imported, or (Go) the same package.
    const own = cands.find((c) => c.file === from);
    if (own) return own;
    const imported = new Set((graph.files[from]?.imports ?? []).map((imp) => imp.file).filter(Boolean));
    const near = cands.filter((c) => imported.has(c.file) || (langOf(from) === 'go' && dir(c.file) === dir(from)));
    return near.length === 1 ? near[0] : null;
  };
}

/**
 * From some calls, the functions they lead to, breadth first: [{ file, name, line, depth, from,
 * effects }] (from: the step that called it, as "file#name").
 */
function trace(graph, resolve, from, calls, seen = new Set()) {
  const steps = [];
  let wave = calls.map((c) => ({ c, file: from, parent: null }));
  for (let depth = 1; depth <= MAX_DEPTH && wave.length && steps.length < MAX_STEPS; depth++) {
    const next = [];
    for (const { c, file, parent } of wave) {
      const hit = resolve(file, c);
      if (!hit) continue;
      const fn = graph.files[hit.file].code.fns[hit.i];
      const key = `${hit.file}#${fn.name}`;
      if (seen.has(key) || steps.length >= MAX_STEPS) continue;
      seen.add(key);
      steps.push({ file: hit.file, name: fn.name, line: fn.line, depth, from: parent, effects: fn.effects, sig: fn.sig });
      for (const cc of fn.calls) next.push({ c: cc, file: hit.file, parent: key });
    }
    wave = next;
  }
  return steps;
}

/** The feature a route belongs to: its main part ("/api/agents/:id/timeline" -> "timeline"). */
export function routeKey(path) {
  const segs = path.split('/').filter(Boolean);
  while (segs.length && (/^(api|v\d+)$/i.test(segs[0]) || segs[0] === '*')) segs.shift();
  if (!segs.length) return '/';
  const lit = segs.filter((s) => s !== '*');
  if (segs[1] === '*' && lit[1]) return lit[1];
  return segs[0];
}

/** The calls to each route: Map("file\nindex" -> [{ file, line }]). Kept for the graph. */
function routeCallers(graph) {
  const hit = memo.callers.get(graph);
  if (hit) return hit;
  const out = new Map();
  memo.callers.set(graph, out);
  const http = httpLinks(graph);
  const fits = pathFits;
  for (const k of http.keys()) {
    const [caller, server] = k.split('\n');
    const routes = graph.files[server].links.routes;
    for (const [c, lines] of Object.entries(graph.files[caller].links.callAt ?? {})) {
      for (const line of [lines].flat()) {
      const call = c.split('/');
      routes.forEach((r, i) => {
        if (!fits(call, r.path.split('/').slice(1)) && !fits(call, r.local.split('/').slice(1))) return;
        const key = `${server}\n${i}`;
        const list = out.get(key) ?? out.set(key, []).get(key);
        list.push({ file: caller, line });
      });
      }
    }
  }
  return out;
}

/**
 * The features: [{ key, kind: 'http' | 'start', routes: [{ file, i, label }] , files: [file] }]
 * by key. HTTP routes grouped by their main part; each file where the program starts, one.
 */
export function featureList(graph) {
  const hit = memo.features.get(graph);
  if (hit) return hit;
  const groups = new Map();
  for (const [f, info] of Object.entries(graph.files)) {
    if (isTest(f)) continue;
    (info.links?.routes ?? []).forEach((r, i) => {
      const key = routeKey(r.path);
      const g = groups.get(key) ?? groups.set(key, { key, kind: 'http', routes: [] }).get(key);
      g.routes.push({ file: f, i, label: `${r.method} ${r.path}` });
    });
  }
  for (const [f, info] of Object.entries(graph.files)) if (info.entry && !isTest(f) && info.code) groups.set(`start:${f}`, { key: `start:${f}`, kind: 'start', routes: [], file: f });
  const list = [...groups.values()].sort((a, b) => (a.kind !== b.kind ? (a.kind === 'start' ? 1 : -1) : b.routes.length - a.routes.length || (a.key < b.key ? -1 : 1)));
  memo.features.set(graph, list);
  return list;
}

/**
 * One feature as a flow: who calls it, its routes, the functions it goes through (each with its
 * component and what it does outside), the outside it reaches, and the components in order.
 * compOf(file) -> component id.
 */
export function featureFlow(graph, key, { compOf = () => null } = {}) {
  const f = featureList(graph).find((x) => x.key === key);
  if (!f) return null;
  const resolve = resolver(graph);
  const callersOf = routeCallers(graph);
  const callers = [];
  const steps = new Map();
  const add = (s) => {
    const k = `${s.file}#${s.name}`;
    const had = steps.get(k);
    if (!had || had.depth > s.depth) steps.set(k, s);
  };
  const entries = [];
  if (f.kind === 'http') {
    for (const r of f.routes.slice(0, MAX_ROUTES_TRACED)) {
      const route = graph.files[r.file].links.routes[r.i];
      const rc = graph.files[r.file].code?.routeCalls[r.i] ?? { calls: [], effects: null, sig: null };
      const k = `${r.file}#${r.label}`;
      entries.push({ file: r.file, name: r.label, line: route.line, depth: 0, from: null, effects: rc.effects, sig: rc.sig, route: true });
      for (const c of callersOf.get(`${r.file}\n${r.i}`) ?? []) {
        const fn = (graph.files[c.file].code?.fns ?? []).find((x) => x.line <= c.line && c.line <= x.end);
        if (!callers.some((x) => x.file === c.file && x.name === (fn?.name ?? null))) callers.push({ file: c.file, name: fn?.name ?? null, line: fn?.line ?? c.line, comp: compOf(c.file), sig: fn?.sig ?? null });
      }
      for (const s of trace(graph, resolve, r.file, rc.calls)) add({ ...s, from: s.from ?? k });
    }
  } else {
    const code = graph.files[f.file].code;
    const main = code.fns.find((x) => /^main$/i.test(x.name));
    entries.push({ file: f.file, name: main ? main.name : '(the file)', line: main?.line ?? 1, depth: 0, from: null, effects: main?.effects ?? null, sig: main?.sig ?? sigOf(code.top.map((c) => `${c.recv}.${c.name}`).join('\n')), route: false });
    for (const s of trace(graph, resolve, f.file, main ? main.calls : code.top, new Set(main ? [`${f.file}#${main.name}`] : []))) add({ ...s, from: s.from ?? `${f.file}#${entries[0].name}` });
  }
  const all = [...entries, ...[...steps.values()].sort((a, b) => a.depth - b.depth).slice(0, MAX_FEATURE_STEPS)].map((s) => ({ ...s, comp: compOf(s.file) }));
  // What it reaches outside the code, from the functions it goes through.
  const outside = { runs: new Set(), hosts: new Set(), services: new Set(), reads: 0, writes: 0 };
  for (const s of all) {
    for (const x of s.effects?.services ?? []) outside.services.add(x);
    for (const r of s.effects?.runs ?? []) outside.runs.add(r);
    for (const h of s.effects?.hosts ?? []) outside.hosts.add(h);
    outside.reads += s.effects?.reads ?? 0;
    outside.writes += s.effects?.writes ?? 0;
  }
  // The components it goes through, and the hops between them.
  const comps = [];
  const hops = new Set();
  const stepComp = new Map(all.map((s) => [`${s.file}#${s.name}`, s.comp]));
  for (const c of callers) if (c.comp && !comps.includes(c.comp)) comps.push(c.comp);
  for (const s of all) if (s.comp && !comps.includes(s.comp)) comps.push(s.comp);
  for (const c of callers) for (const e of all.filter((x) => x.depth === 0)) if (c.comp && e.comp && c.comp !== e.comp) hops.add(`${c.comp}\n${e.comp}`);
  for (const s of all) {
    const p = s.from ? stepComp.get(s.from) : null;
    if (p && s.comp && p !== s.comp) hops.add(`${p}\n${s.comp}`);
  }
  return {
    key: f.key,
    kind: f.kind,
    routes: f.routes.map((r) => r.label),
    callers: callers.slice(0, 30),
    steps: all.map((s) => ({ ...s, does: effectWords(s.effects) })),
    outside: { runs: [...outside.runs], hosts: [...outside.hosts], services: [...outside.services], reads: outside.reads, writes: outside.writes },
    comps,
    hops: [...hops].map((h) => h.split('\n')),
  };
}

/** What a step does outside the code, in words: "runs git; reads files". */
function effectWords(e) {
  if (!e) return '';
  return [e.services?.length ? `uses ${e.services.join(', ')}` : '', e.runs.length ? `runs ${e.runs.join(', ')}` : '', e.hosts.length ? `calls ${e.hosts.join(', ')}` : '', e.reads && e.writes ? 'reads and writes files' : e.reads ? 'reads files' : e.writes ? 'writes files' : ''].filter(Boolean).join('; ');
}

/** For the model's prompt: each feature with a few of its routes. */
export function featureLines(graph, max = 220) {
  return featureList(graph)
    .slice(0, max)
    .map((f) => (f.kind === 'start' ? `- ${f.key}: where the program starts` : `- ${f.key}: ${f.routes.length} route${f.routes.length === 1 ? '' : 's'}, e.g. ${f.routes.slice(0, 3).map((r) => r.label).join(', ')}`));
}

