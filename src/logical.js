// The logical view of a repository: its components (what each piece of the system does, which can
// take files from several folders) and the links between them that imports don't show: a web page
// calling the server's HTTP routes, programs run (git, docker…), files read and written, outside
// services and hosts. The links are found in the code (no model); grouping the files into named
// components, and naming the data each link carries, is one model call (Describe with AI). Before
// that, the components are the top-level folders.
//
// Routes are found for Express-style servers (JavaScript and TypeScript), Flask and FastAPI, and Go's
// net/http, gin, echo and chi; the calls to them are the URL paths written in the code, matched to
// the routes. Tests are left out.

import { childrenOf, dirOf, langOf, serviceOf, targetOf } from './layers.js';

const MAX_UNITS = 160;
const MAX_EXTERNAL = 7; // outside boxes drawn; the rest as one
const TEST = /(^|\/)(test|tests|__tests__|spec|specs|e2e|testdata|fixtures)\/|\.(test|spec)\.[^/]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|(^|\/)conftest\.py$/;
export const isTest = (f) => TEST.test(f);

// A file that serves HTTP: a server framework is set up or imported in it.
const SERVER = /\b(?:express|fastify|Koa|Hono|restify)\s*\(|\.Router\s*\(|\bRouter\s*\(\s*\)|createServer\s*\(|from\s+(?:flask|fastapi|starlette|sanic|quart|aiohttp)\b|^import\s+(?:flask|fastapi)\b|\b(?:Flask|FastAPI|APIRouter|Blueprint)\s*\(|"net\/http"|gin-gonic\/gin|labstack\/echo|go-chi\/chi|gorilla\/mux|gofiber\/fiber/m;
const CLIENT_NAMES = /^(axios|https?|requests?|httpx|client|session|got|ky|superagent|\$|fetch|cy|page|request)$/i;

const SPAWN_JS = /\b(?:spawn|spawnSync|execFile|execFileSync|execa|execaSync|run|runSync)\(\s*['"]([A-Za-z][\w.+-]{0,30})['"]/g;
const SHELL_JS = /\b(?:exec|execSync)\(\s*['"`]([A-Za-z][\w.+-]{0,30})[\s'"`]/g;
const SPAWN_PY = /\bsubprocess\.\w+\(\s*\[\s*['"]([\w.+-]{1,30})['"]|\bos\.system\(\s*f?['"]([\w.+-]{1,30})/g;
const SPAWN_GO = /\bexec\.Command(?:Context)?\(\s*(?:\w+\s*,\s*)?"([\w.+-]{1,30})"/g;
const HOST = /\b(?:fetch|axios(?:\.\w+)?|got(?:\.\w+)?|requests\.\w+|httpx\.\w+|http\.(?:Get|Post|NewRequest(?:WithContext)?)|https?\.(?:get|request)|urlopen)\(\s*(?:(?:ctx|\w+)\s*,\s*)?(?:"[A-Z]+"\s*,\s*)?f?['"`]https?:\/\/([\w.-]+)|\b\w*(?:URL|Url|BASE|Base|ENDPOINT|Endpoint|API|Api|HOST|Host)\w*\s*[:=]\s*f?['"`]https?:\/\/([\w.-]+)/g;
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|example\.(com|org)|[\w-]+\.local$|\$)/;
const READ_JS = /\b(?:fs|fsp|fse|promises)\.(?:readFileSync|readFile|createReadStream|readdirSync|readdir|readJson|readJSON)\(/g;
const WRITE_JS = /\b(?:fs|fsp|fse|promises)\.(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|mkdir|renameSync|rename|rmSync|rm|unlinkSync|unlink|copyFileSync|cpSync|outputFile|writeJson)\(/g;
const READ_BARE = /(?<![.\w])(?:readFileSync|readFile|createReadStream|readdirSync|readdir)\(/g;
const WRITE_BARE = /(?<![.\w])(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|renameSync|rmSync|unlinkSync)\(/g;
const count = (text, re) => [...text.matchAll(re)].length;
export const FS_IMPORT = /from\s+['"](?:node:)?fs(?:\/promises)?['"]|require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/;
// Worked out once for each graph (a graph is built again when the code changes): the calls matched
// to routes, and the parts.
const memo = { http: new WeakMap(), units: new WeakMap() };

/** A URL path as a pattern: placeholders as '*', no query; null when it is not one. */
export function pathPattern(raw) {
  const p = String(raw)
    // A path like /layers followed by ${query}: what follows a word is a query string, not a part of it.
    .replace(/([\w.-])\$\{.*$/, '$1')
    .replace(/\$\{[^}]*\}?/g, '*')
    .replace(/\{[^}/]*\}|<[^>/]*>/g, '*')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '');
  if (!/^\/[A-Za-z_*:]/.test(p) || p.length > 200) return null;
  return p.split('/').slice(1).map((s) => (s.startsWith(':') || s.includes('*') ? '*' : s)).join('/');
}

/**
 * What a piece of code does outside itself: programs run, hosts called, files read and written.
 * fsImported: the file imports fs, so a bare readFileSync() is one.
 */
export function effectsOf(lang, text, { fsImported = false } = {}) {
  const out = { runs: [], hosts: [], reads: 0, writes: 0 };
  const runs = new Set();
  if (lang === 'js') for (const re of [SPAWN_JS, SHELL_JS]) for (const m of text.matchAll(re)) runs.add(m[1]);
  if (lang === 'py') for (const m of text.matchAll(SPAWN_PY)) runs.add(m[1] ?? m[2]);
  if (lang === 'go') for (const m of text.matchAll(SPAWN_GO)) runs.add(m[1]);
  out.runs = [...runs].filter((r) => !/^(true|false|null|test|node_modules)$/.test(r)).slice(0, 20);
  const hosts = new Set();
  for (const m of text.matchAll(HOST)) {
    const h = (m[1] ?? m[2]).toLowerCase().replace(/\.$/, '');
    if (h.includes('.') && !LOCAL_HOST.test(h)) hosts.add(h);
  }
  out.hosts = [...hosts].slice(0, 10);
  if (lang === 'js') {
    out.reads = count(text, READ_JS) + (fsImported ? count(text, READ_BARE) : 0);
    out.writes = count(text, WRITE_JS) + (fsImported ? count(text, WRITE_BARE) : 0);
  } else if (lang === 'py') {
    const opens = [...text.matchAll(/\bopen\(([^)\n]*)\)/g)];
    const writing = opens.filter((m) => /['"][rb]*[wax][bt+]*['"]/.test(m[1])).length;
    out.reads = opens.length - writing + count(text, /\.read_(?:text|bytes)\(/g);
    out.writes = writing + count(text, /\.write_(?:text|bytes)\(|\bshutil\.(?:copy\w*|move|rmtree)\(|\bos\.(?:makedirs|remove|rename)\(/g);
  } else if (lang === 'go') {
    out.reads = count(text, /\bos\.(?:ReadFile|Open|ReadDir)\(/g);
    out.writes = count(text, /\bos\.(?:WriteFile|Create|MkdirAll|Mkdir|Rename|Remove|RemoveAll|OpenFile)\(/g);
  }
  return out;
}

/**
 * Where the call starting at `at` ends: its closing parenthesis, skipping strings (a rough read; a
 * Python decorator's function, or a Go handler func, ends at the next blank line after its body).
 */
function closeOf(text, at) {
  const open = text.indexOf('(', at);
  if (open === -1) return at;
  let depth = 0;
  let quote = null;
  const stop = Math.min(text.length, open + 40_000);
  for (let i = open; i < stop; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) {
      // A decorator: its function follows, to the next line not indented.
      if (/^\s*\n\s*(?:async\s+)?def\b/.test(text.slice(i + 1, i + 200))) {
        const m = /\n(?=\S)/g;
        m.lastIndex = text.indexOf('def', i);
        return m.exec(text)?.index ?? text.length;
      }
      return i;
    }
  }
  return stop;
}

/** What one file shows of its links to other parts and the outside (see the top). */
export function linksOf(file, text) {
  const lang = langOf(file);
  const out = { routes: [], calls: [], callAt: {}, runs: [], hosts: [], services: [], reads: 0, writes: 0, live: null };
  if (!lang || !text) return out;
  // The line of a place in the text.
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineAt = (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const server = SERVER.test(text);
  if (server) {
    // Where each router is mounted: app.use('/api', api), include_router(r, prefix=…), r.Group("/v1").
    const mounts = {};
    for (const m of text.matchAll(/\b\w+\.use\(\s*['"](\/[^'"]*)['"]\s*,\s*(\w+)\s*[,)]/g)) mounts[m[2]] = m[1];
    for (const m of text.matchAll(/(\w+)\s*=\s*(?:APIRouter|Blueprint)\([^)]*(?:url_)?prefix\s*=\s*['"]([^'"]+)['"]/g)) mounts[m[1]] = m[2];
    for (const m of text.matchAll(/\b(?:include_router|register_blueprint)\(\s*(\w+)[^)]*?(?:url_)?prefix\s*=\s*['"]([^'"]+)['"]/g)) mounts[m[1]] = m[2];
    for (const m of text.matchAll(/(\w+)\s*:?=\s*\w+\.Group\(\s*"([^"]*)"/g)) mounts[m[1]] = m[2];
    const add = (method, p, router = null, at = 0) => {
      const prefix = router && mounts[router] ? pathPattern(mounts[router]) : null;
      // The root of a router ('/') is a route at its mount.
      const local = /^\/?$/.test(p) && prefix ? '' : pathPattern(p);
      if (local == null) return;
      const full = [prefix, local].filter(Boolean).join('/');
      out.routes.push({ method: method.toUpperCase(), path: `/${full}`, local: `/${local}`, line: lineAt(at), end: lineAt(closeOf(text, at)) });
    };
    for (const m of text.matchAll(/@?\b(\w+)\.(get|post|put|patch|delete|all|route|head|options|websocket)\(\s*f?['"`](\/[^'"`\s]*)['"`]([^\n]*)/g)) {
      if (CLIENT_NAMES.test(m[1])) continue;
      const method = m[2] === 'route' ? m[4].match(/methods\s*=\s*\[\s*['"](\w+)/)?.[1] ?? 'ANY' : m[2] === 'all' ? 'ANY' : m[2] === 'websocket' ? 'WS' : m[2];
      add(method, m[3], m[1], m.index);
    }
    for (const m of text.matchAll(/\b(?:HandleFunc|Handle)\(\s*"(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(\/[^"]*)"/g)) add(m[1] ?? 'ANY', m[2], null, m.index);
    for (const m of text.matchAll(/\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|Any|Get|Post|Put|Patch|Delete)\(\s*"(\/[^"]*)"/g)) add(m[2] === 'Any' ? 'ANY' : m[2], m[3], m[1], m.index);
    // A plain server: if (pathname === '/ws/events').
    for (const m of text.matchAll(/\b(?:pathname|url|path)\s*===?\s*['"](\/[A-Za-z][^'"]*)['"]/g)) add('ANY', m[1], null, m.index);
  }
  // URL paths written in the code: calls, once matched to a route somewhere else.
  const calls = new Set();
  for (const m of text.matchAll(/['"`](?:\$\{[^}`]*\}|\{[\w.]*\}|https?:\/\/[^/'"`\s]+)?(\/[A-Za-z_:{$][^'"`\s?#]*)/g)) {
    const pat = pathPattern(m[1]);
    if (!pat || calls.size >= 3000) continue;
    calls.add(pat);
    const at = (out.callAt[pat] ??= []);
    if (at.length < 10) at.push(lineAt(m.index));
  }
  out.calls = [...calls];
  Object.assign(out, effectsOf(lang, text, { fsImported: FS_IMPORT.test(text) }));
  // Databases in the standard library, which the packages imported don't show.
  if ((lang === 'py' && /^\s*(?:import|from)\s+sqlite3\b/m.test(text)) || (lang === 'js' && /['"]node:sqlite['"]/.test(text))) out.services.push('SQLite');
  if (lang === 'go' && /"database\/sql"/.test(text)) out.services.push('SQL database');
  if (/\bWebSocketServer\b|\bwebsockets\.serve\b|text\/event-stream|\bupgrader\.Upgrade\(|\.on\(\s*['"]upgrade['"]/.test(text)) out.live = 'server';
  else if (/\bnew\s+(?:WebSocket|EventSource)\(/.test(text)) out.live = 'client';
  return out;
}

/** Each source file's links, kept on the graph (graph.files[f].links). */
export function addLinks(graph, sources) {
  for (const { path: p, text } of sources) if (graph.files[p] && text && !isTest(p)) graph.files[p].links = linksOf(p, text);
  return graph;
}

/** A call's path parts fit a route's: '*' matches any one part, at least one fixed part the same. */
export function pathFits(call, segs) {
  if (call.length !== segs.length) return false;
  let fixed = 0;
  for (let i = 0; i < segs.length; i++) {
    if (call[i] === '*' || segs[i] === '*') continue;
    if (call[i] !== segs[i]) return false;
    fixed++;
  }
  return fixed > 0;
}

/**
 * The calls from one file to a route in another: Map("caller\nserver" -> Set("GET /api/x")). A
 * call matches a route's full path or its path inside its router, '*' matching any one part, with
 * at least one fixed part the same.
 */
export function httpLinks(graph) {
  if (memo.http.has(graph)) return memo.http.get(graph);
  const out = new Map();
  memo.http.set(graph, out);
  const routes = [];
  for (const [f, info] of Object.entries(graph.files)) for (const r of info.links?.routes ?? []) routes.push({ file: f, ...r, full: r.path.split('/').slice(1), inner: r.local.split('/').slice(1) });
  if (!routes.length) return out;
  const fits = pathFits;
  for (const [f, info] of Object.entries(graph.files)) {
    for (const c of info.links?.calls ?? []) {
      const call = c.split('/');
      for (const r of routes) {
        if (r.file === f || !(fits(call, r.full) || fits(call, r.inner))) continue;
        const k = `${f}\n${r.file}`;
        (out.get(k) ?? out.set(k, new Set()).get(k)).add(`${r.method} ${r.path}`);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ parts and components

/**
 * The parts the model groups into components: the top-level folders, opened (the biggest first)
 * while there are no more than `max` parts, down to files. Tests are left out.
 */
export function logicalUnits(graph, max = MAX_UNITS) {
  if (max === MAX_UNITS && memo.units.has(graph)) return memo.units.get(graph);
  const files = Object.keys(graph.files).filter((f) => !isTest(f));
  let units = childrenOf(files, '');
  for (let open = true; open; ) {
    open = false;
    for (const u of units.filter((x) => x.kind === 'folder').sort((a, b) => b.files.length - a.files.length)) {
      const kids = childrenOf(u.files, u.id);
      if (units.length - 1 + kids.length > max) continue;
      units = units.flatMap((x) => (x === u ? kids : [x]));
      open = true;
      break;
    }
  }
  units.sort((a, b) => (a.id < b.id ? -1 : 1));
  if (max === MAX_UNITS) memo.units.set(graph, units);
  return units;
}

const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The components: as the model grouped the parts, else the top-level folders (loose files as one). */
function componentsOf(graph, units, notes) {
  const comps = [];
  if (notes?.components?.length) {
    const ids = new Set(units.map((u) => u.id));
    const seen = new Set();
    for (const c of notes.components) {
      const members = (c.members ?? []).filter((m) => ids.has(m) && !seen.has(m));
      members.forEach((m) => seen.add(m));
      if (members.length) comps.push({ name: c.name, purpose: c.purpose ?? '', members });
    }
    const rest = units.filter((u) => !seen.has(u.id)).map((u) => u.id);
    if (rest.length) comps.push({ name: 'Not placed yet', purpose: 'Parts added since the components were found', members: rest, unplaced: true });
  } else {
    const top = childrenOf(units.flatMap((u) => u.files), '');
    const loose = top.filter((t) => t.kind === 'file');
    for (const t of top.filter((x) => x.kind === 'folder')) comps.push({ name: t.id, purpose: '', members: units.filter((u) => u.id === t.id || u.id.startsWith(`${t.id}/`)).map((u) => u.id) });
    if (loose.length) comps.push({ name: loose.length === 1 ? loose[0].id : 'Top-level files', purpose: '', members: loose.map((t) => t.id) });
  }
  const used = new Map();
  const byUnit = new Map(units.map((u) => [u.id, u]));
  return comps.map((c) => {
    const s = slug(c.name);
    const n = used.get(s) ?? 0;
    used.set(s, n + 1);
    return { ...c, id: `c:${n ? `${s}-${n + 1}` : s}`, files: c.members.flatMap((m) => byUnit.get(m)?.files ?? []) };
  });
}

/** Outside systems in links: programs, hosts, services, the disk. */
const EXT_FILES = 'x:files';
const extName = (id) => (id === EXT_FILES ? 'Files on disk' : id.replace(/^x:(run|host|svc):/, ''));
const extKind = (id) => (id === EXT_FILES ? 'files' : id.split(':')[1]);

/**
 * The links between groups of files (`groupOf(file)` -> id or null): imports, HTTP calls, live
 * streams, and each group's links to the outside. Returns Map("from\nto" -> link).
 */
function linksBetween(graph, groupOf, http) {
  const links = new Map();
  const link = (a, b) => {
    const k = `${a}\n${b}`;
    return links.get(k) ?? links.set(k, { from: a, to: b, imports: 0, routes: new Set(), runs: new Set(), hosts: new Set(), services: new Set(), reads: 0, writes: 0, live: false, evidence: [] }).get(k);
  };
  const note = (l, s) => l.evidence.length < 24 && !l.evidence.includes(s) && l.evidence.push(s);
  const files = Object.keys(graph.files).filter((f) => groupOf(f));
  const inDir = new Map();
  for (const f of files) {
    const d = dirOf(f);
    if (!inDir.has(d)) inDir.set(d, f);
  }
  for (const f of files) {
    const info = graph.files[f];
    const a = groupOf(f);
    for (const imp of info.imports) {
      const t = targetOf(imp);
      const b = groupOf(imp.file ? t : inDir.get(t) ?? '');
      if (b && b !== a) {
        const l = link(a, b);
        l.imports++;
        note(l, `${f} imports ${t}`);
      }
    }
    const L = info.links;
    if (!L) continue;
    for (const r of L.runs) {
      const l = link(a, `x:run:${r}`);
      l.runs.add(r);
      note(l, `${f} runs ${r}`);
    }
    for (const h of L.hosts) {
      const l = link(a, `x:host:${h}`);
      l.hosts.add(h);
      note(l, `${f} calls ${h}`);
    }
    for (const p of info.pkgs) {
      const s = serviceOf(p);
      if (!s) continue;
      const l = link(a, `x:svc:${s}`);
      l.services.add(p);
      note(l, `${f} uses ${p}`);
    }
    for (const s of info.links?.services ?? []) {
      const l = link(a, `x:svc:${s}`);
      l.services.add(s === 'SQLite' ? 'sqlite' : 'database/sql');
      note(l, `${f} uses ${s}`);
    }
    if (L.reads || L.writes) {
      const l = link(a, EXT_FILES);
      l.reads += L.reads;
      l.writes += L.writes;
      note(l, `${f} ${[L.reads && `reads (${L.reads})`, L.writes && `writes (${L.writes})`].filter(Boolean).join(' and ')}`);
    }
  }
  for (const [k, routes] of http) {
    const [f, s] = k.split('\n');
    const a = groupOf(f);
    const b = groupOf(s);
    if (!a || !b || a === b) continue;
    const l = link(a, b);
    for (const r of routes) {
      l.routes.add(r);
      note(l, `${f} calls ${r} (${s})`);
    }
  }
  // A live stream (WebSocket, server-sent events): from the clients to the one server, if one.
  const servers = new Set(files.filter((f) => graph.files[f].links?.live === 'server').map(groupOf));
  if (servers.size === 1) {
    const [b] = servers;
    for (const f of files.filter((x) => graph.files[x].links?.live === 'client')) {
      const a = groupOf(f);
      if (a === b) continue;
      const l = link(a, b);
      l.live = true;
      note(l, `${f} opens a live stream`);
    }
  }
  return links;
}

/** What a link carries as found, in words: "HTTP: 12 routes", "imports (3)", "runs git". */
function linkWords(l) {
  return [
    l.routes.size ? `HTTP: ${plural(l.routes.size, 'route')}` : '',
    l.live ? 'live stream' : '',
    l.imports ? `imports (${l.imports})` : '',
    l.runs.size ? `runs ${[...l.runs].join(', ')}` : '',
    l.hosts.size ? `calls ${[...l.hosts].join(', ')}` : '',
    l.services.size ? `uses ${[...l.services].join(', ')}` : '',
    l.reads || l.writes ? [l.reads && 'reads', l.writes && 'writes'].filter(Boolean).join(' and ') : '',
  ].filter(Boolean).join('; ');
}

// Which way data moves along a link found in the code, before the model says: files read come
// from the disk, files written go to it; null for the rest (drawn from the caller to what it calls).
const foundFlow = (l) => (l.to === EXT_FILES ? (l.reads && l.writes ? 'both' : l.writes ? 'to' : 'from') : null);

/**
 * The logical view: { components, edges, rank, summary, counts }. Each component: its name, what it
 * does, the parts in it, size, where the program starts, the agent's changes; each outside system a
 * box too. Each edge: what the code shows (routes, imports, programs run…), what data the model
 * says it carries and which way, and a few lines of evidence. `notes` is what the model wrote.
 */
export function logicalView(graph, { notes = null, changed = [], features = [], flow = null } = {}) {
  const units = logicalUnits(graph);
  const comps = componentsOf(graph, units, notes);
  const compOf = new Map();
  for (const c of comps) for (const f of c.files) compOf.set(f, c.id);
  const http = httpLinks(graph);
  const all = linksBetween(graph, (f) => compOf.get(f) ?? null, http);
  // The outside systems used by most components get a box each; the rest share one.
  const extUse = new Map();
  for (const l of all.values()) if (l.to.startsWith('x:')) extUse.set(l.to, (extUse.get(l.to) ?? 0) + 1);
  const keepExt = new Set([...extUse].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_EXTERNAL).map(([id]) => id));
  const OTHER = 'x:other';
  const edges = new Map();
  for (const l of all.values()) {
    const to = l.to.startsWith('x:') && !keepExt.has(l.to) ? OTHER : l.to;
    const k = `${l.from}\n${to}`;
    const e = edges.get(k);
    if (!e) edges.set(k, { ...l, to });
    else {
      e.imports += l.imports;
      for (const key of ['routes', 'runs', 'hosts', 'services']) for (const v of l[key]) e[key].add(v);
      e.reads += l.reads;
      e.writes += l.writes;
      for (const ev of l.evidence) if (e.evidence.length < 24) e.evidence.push(ev);
    }
  }
  const changedSet = new Set(changed);
  const names = new Map(comps.map((c) => [c.name.toLowerCase(), c.id]));
  for (const id of keepExt) names.set(extName(id).toLowerCase(), id);
  if (edges.size && [...edges.values()].some((e) => e.to === OTHER)) names.set('other outside systems', OTHER);
  // What the model said each link carries (either way round), and the ones it saw that the code doesn't show.
  const said = new Map();
  for (const fl of notes?.flows ?? []) {
    const a = names.get(String(fl.from).toLowerCase());
    const b = names.get(String(fl.to).toLowerCase());
    if (a && b && a !== b) said.set(`${a}\n${b}`, fl);
  }
  const flip = { to: 'from', from: 'to', both: 'both' };
  const out = [...edges.values()].map((e) => {
    const fwd = said.get(`${e.from}\n${e.to}`);
    // Said the other way round: only when that way has no link of its own.
    const back = edges.has(`${e.to}\n${e.from}`) ? null : said.get(`${e.to}\n${e.from}`);
    const fl = fwd ?? back;
    return {
      from: e.from,
      to: e.to,
      found: linkWords(e),
      routes: [...e.routes].sort().slice(0, 60),
      routeCount: e.routes.size,
      imports: e.imports,
      runs: [...e.runs],
      live: e.live,
      reads: e.reads,
      writes: e.writes,
      data: fl?.data ?? null,
      flow: fl ? (fwd ? fl.direction : flip[fl.direction]) ?? 'both' : foundFlow(e),
      guessed: false,
      evidence: e.evidence,
      weight: e.routes.size * 3 + e.imports + e.runs.size + e.hosts.size + e.services.size + (e.reads || e.writes ? 1 : 0) + (e.live ? 3 : 0),
    };
  });
  const have = new Set(out.flatMap((e) => [`${e.from}\n${e.to}`, `${e.to}\n${e.from}`]));
  for (const [k, fl] of said) {
    if (have.has(k) || out.filter((e) => e.guessed).length >= 5) continue;
    const [from, to] = k.split('\n');
    out.push({ from, to, found: '', routes: [], routeCount: 0, imports: 0, runs: [], live: false, reads: 0, writes: 0, data: fl.data, flow: fl.direction ?? 'both', guessed: true, evidence: [], weight: 1 });
    have.add(k);
  }
  const used = new Set(out.flatMap((e) => [e.from, e.to]));
  const externals = [...keepExt, ...(used.has(OTHER) ? [OTHER] : [])].filter((id) => used.has(id));
  const components = [
    ...comps.map((c) => ({
      id: c.id,
      name: c.name,
      kind: 'component',
      purpose: c.purpose,
      unplaced: Boolean(c.unplaced),
      members: c.members,
      files: c.files.length,
      lines: c.files.reduce((s, f) => s + (graph.files[f]?.lines ?? 0), 0),
      entry: c.files.filter((f) => graph.files[f]?.entry).slice(0, 5),
      serves: c.files.reduce((s, f) => s + (graph.files[f]?.links?.routes.length ?? 0), 0),
      changed: c.files.filter((f) => changedSet.has(f)),
    })),
    ...externals.map((id) => ({
      id,
      name: id === OTHER ? 'Other outside systems' : extName(id),
      kind: 'external',
      ext: id === OTHER ? 'other' : extKind(id),
      purpose: '',
      members: [],
      files: 0,
      lines: 0,
      entry: [],
      serves: 0,
      changed: [],
    })),
  ];
  // Rows: what calls a server or starts the program on top, the servers next, each other component
  // a row below the lowest of what calls or imports it (at most the fourth row), the outside at the
  // bottom. Imports into the top two rows, of a shared helper, don't move them.
  const callers = new Set(out.filter((e) => (e.routeCount || e.live) && !e.from.startsWith('x:')).map((e) => e.from));
  const fixed = {};
  for (const c of comps) if (c.files.some((f) => graph.files[f]?.links?.routes.length)) fixed[c.id] = 1;
  for (const c of comps) if (fixed[c.id] == null && (callers.has(c.id) || c.files.some((f) => graph.files[f]?.entry))) fixed[c.id] = 0;
  const into = new Map();
  for (const e of out) if (!e.from.startsWith('x:') && !e.to.startsWith('x:') && !e.guessed) (into.get(e.to) ?? into.set(e.to, []).get(e.to)).push(e.from);
  const rank = {};
  const seen = new Set();
  const rowOf = (id) => {
    if (fixed[id] != null) return fixed[id];
    if (rank[id] != null) return rank[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    const r = Math.min(3, Math.max(Object.keys(fixed).length ? 1 : 0, ...(into.get(id) ?? []).map((c) => rowOf(c) + 1)));
    seen.delete(id);
    return (rank[id] = r);
  };
  for (const c of comps) rank[c.id] = rowOf(c.id);
  const bottom = Math.max(0, ...Object.values(rank)) + 1;
  for (const id of externals) rank[id] = bottom;
  const routes = Object.values(graph.files).reduce((s, i) => s + (i.links?.routes.length ?? 0), 0);
  const tests = Object.keys(graph.files).filter(isTest).length;
  return {
    components,
    edges: out,
    rank,
    counts: { files: Object.keys(graph.files).length - tests, tests, routes, calls: [...http.values()].reduce((s, v) => s + v.size, 0), changed: comps.reduce((s, c) => s + c.files.filter((f) => changedSet.has(f)).length, 0) },
    described: Boolean(notes?.components?.length),
    features: features.map((f) => ({ key: f.key, kind: f.kind, routes: f.routes.length, name: notes?.features?.[f.key]?.name || (f.kind === 'start' ? `Starts: ${f.file}` : f.key), what: notes?.features?.[f.key]?.what ?? '' })),
    flow: flowIn(flow?.((f) => compOf.get(f) ?? null), { notes, keepExt, used, OTHER }),
  };
}

/**
 * A feature's flow (flows.js) placed on the view: its name, and each step's work outside the code
 * as a hop to that outside box.
 */
function flowIn(fl, { notes, keepExt, used, OTHER }) {
  if (!fl) return null;
  const ext = (id) => (keepExt.has(id) ? id : used.has(OTHER) ? OTHER : null);
  const hops = fl.hops.map(([a, b]) => [a, b]);
  const outside = new Set();
  for (const s of fl.steps) {
    if (!s.comp || !s.effects) continue;
    const ids = [...(s.effects.services ?? []).map((x) => `x:svc:${x}`), ...s.effects.runs.map((r) => `x:run:${r}`), ...s.effects.hosts.map((h) => `x:host:${h}`), ...(s.effects.reads || s.effects.writes ? [EXT_FILES] : [])].map(ext).filter(Boolean);
    for (const id of ids) {
      outside.add(id);
      if (!hops.some(([a, b]) => a === s.comp && b === id)) hops.push([s.comp, id]);
    }
  }
  const named = notes?.features?.[fl.key];
  return { ...fl, name: named?.name || (fl.kind === 'start' ? `Starts: ${fl.steps[0]?.file}` : fl.key), what: named?.what ?? '', hops, outsideIds: [...outside] };
}

// ------------------------------------------------------------------ found by a model

export const LOGICAL_HEAD = 'Find the logical components of a code repository';

/** What the parts are, for the model and for knowing when its components went out of date. */
export function logicalSig(graph) {
  return logicalUnits(graph).map((u) => u.id).join('\n');
}

/** The prompt: each part with what it defines and what the code shows it does, and the links between parts. */
export function logicalPrompt(graph, { project, features = [] }) {
  const units = logicalUnits(graph);
  const unitOf = new Map();
  for (const u of units) for (const f of u.files) unitOf.set(f, u.id);
  const http = httpLinks(graph);
  const links = linksBetween(graph, (f) => unitOf.get(f) ?? null, http);
  const lines = units.map((u) => {
    const infos = u.files.map((f) => graph.files[f]);
    const n = infos.reduce((s, i) => s + (i?.lines ?? 0), 0);
    const routes = infos.flatMap((i) => i?.links?.routes ?? []);
    const heads = [...new Set(routes.map((r) => r.path.split('/').slice(0, 3).join('/')))].slice(0, 12);
    const bits = [];
    if (u.kind === 'file') {
      const syms = (graph.files[u.id]?.symbols ?? []).filter((x) => x.kind !== 'method').slice(0, 10).map((x) => x.name);
      if (syms.length) bits.push(`defines ${syms.join(', ')}`);
    } else bits.push(`${plural(u.files.length, 'file')}: ${u.files.slice(0, 8).map((f) => f.slice(u.id.length + 1)).join(', ')}${u.files.length > 8 ? ', …' : ''}`);
    if (routes.length) bits.push(`serves ${plural(routes.length, 'HTTP route')} (${heads.join(', ')}${heads.length >= 12 ? ', …' : ''})`);
    if (infos.some((i) => i?.entry)) bits.push('the program starts here');
    return `- ${u.id} (${u.kind}, ${plural(n, 'line')})${bits.length ? `: ${bits.join('; ')}` : ''}`;
  });
  const between = [];
  const outside = [];
  for (const l of [...links.values()].sort((a, b) => b.routes.size * 3 + b.imports - (a.routes.size * 3 + a.imports))) {
    const w = linkWords(l);
    const sample = l.routes.size ? ` e.g. ${[...l.routes].slice(0, 3).join(', ')}` : '';
    if (l.to.startsWith('x:')) outside.push(`- ${l.from} -> ${extName(l.to)}: ${w}`);
    else between.push(`- ${l.from} -> ${l.to}: ${w}${sample}`);
  }
  const systems = [...new Set([...links.values()].filter((l) => l.to.startsWith('x:')).map((l) => extName(l.to)))];
  let text = [
    `${LOGICAL_HEAD}, for a developer who needs to see how the system works: its components and the data that moves between them.`,
    `Project: ${project}.`,
    '',
    'Its parts (files and folders; tests left out), with what each defines and what the code shows:',
    ...lines,
    '',
    'Links the code shows between parts ("a -> b": a imports b, or calls b\'s HTTP routes, or opens a live stream to it):',
    ...(between.length ? between.slice(0, 220) : ['(none)']),
    '',
    'Links to outside systems:',
    ...(outside.length ? outside.slice(0, 120) : ['(none)']),
    '',
    ...(features.length ? ['Features: its HTTP routes grouped by their main part, and where the program starts:', ...features, ''] : []),
    'Reply with only a JSON object:',
    '{"summary": "<one or two sentences: what the system is and how its main pieces fit together>",',
    ' "components": [{"name": "<1-3 words>", "purpose": "<what it does, under 16 words>", "members": ["<part id exactly as listed>", ...]}],',
    ' "flows": [{"from": "<component name>", "to": "<component name or outside system>", "data": "<what data moves, under 8 words>", "direction": "to" | "from" | "both"}],',
    ' "features": [{"key": "<feature key exactly as listed>", "name": "<what a user would call it, 1-4 words>", "what": "<what it does for them, under 14 words>"}]}',
    'Put every part in exactly one component: 4 to 12 components, each a piece of the system with one job (a user interface, an API, a store, a background worker, a feature area, shared helpers…), named for what it does, not where it is. A component can take parts from different folders, and one folder can be split.',
    `Flows: one for each pair of components (or a component and an outside system${systems.length ? `: ${systems.slice(0, 20).join(', ')}` : ''}) that the links connect, saying what data moves; direction "to" when it moves from "from" to "to", "from" the other way, "both" when both ways. Add a flow the links don't show only when the names make it clear, at most 5.`,
    ...(features.length ? ['Features: one for each listed, named for what it does for the people using it (e.g. "Agent timeline" for "timeline").'] : []),
    "Say only what the names, definitions and links show.",
  ].join('\n');
  if (text.length > 80_000) text = `${text.slice(0, 80_000)}\n…`;
  return text;
}

/** The model's reply checked against what is there: { summary, components, flows }. */
export function logicalNotesFrom(reply, graph, { featureKeys = [] } = {}) {
  const ids = new Set(logicalUnits(graph).map((u) => u.id));
  const line = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const seen = new Set();
  const components = (Array.isArray(reply?.components) ? reply.components : [])
    .map((c) => {
      const members = (Array.isArray(c?.members) ? c.members : []).map(String).filter((m) => ids.has(m) && !seen.has(m));
      members.forEach((m) => seen.add(m));
      return { name: line(c?.name, 40), purpose: line(c?.purpose, 200), members };
    })
    .filter((c) => c.name && c.members.length)
    .slice(0, 16);
  const flows = (Array.isArray(reply?.flows) ? reply.flows : [])
    .map((f) => ({ from: line(f?.from, 60), to: line(f?.to, 60), data: line(f?.data, 80), direction: ['to', 'from', 'both'].includes(f?.direction) ? f.direction : 'both' }))
    .filter((f) => f.from && f.to && f.data)
    .slice(0, 80);
  const keys = new Set(featureKeys);
  const features = {};
  for (const f of Array.isArray(reply?.features) ? reply.features : []) {
    const key = String(f?.key ?? '');
    if (keys.has(key) && line(f?.name, 40)) features[key] = { name: line(f.name, 40), what: line(f?.what, 160) };
  }
  return { summary: line(reply?.summary, 400), components, flows, features };
}
