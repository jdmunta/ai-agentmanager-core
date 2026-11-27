// Design layers: a repository as nested boxes, from the outside in: the system (its top-level parts,
// where it starts and what it talks to), then each part's parts, down to a file's functions and
// classes. The boxes are its folders; the arrows between them are the imports between their files,
// counted. Callers are drawn above what they use. An agent's changes light up the boxes they are in,
// and the boxes with code that imports a changed file (what the change can break that the agent did
// not touch). All of it is read from the code: no model is called.
//
// Imports are traced for JavaScript and TypeScript, Python, Go, Java and Kotlin; other files show as
// boxes without arrows.

const MAX_FILES = 8000;
const MAX_BYTES = 512 * 1024;
const MAX_BOXES = 30;

const JS = /\.(m?[jt]sx?|c[jt]s|vue|svelte)$/;
const PY = /\.py$/;
const GO = /\.go$/;
const JVM = /\.(java|kt)$/;
export const SOURCE = /\.(m?[jt]sx?|c[jt]s|vue|svelte|py|go|java|kt|rs|rb|php|cs|swift|scala|c|cc|cpp|h|hpp|m|mm|ex|exs|clj|dart|lua|sh)$/;
// Not the project's own design: dependencies, builds, generated and minified code.
const SKIP = /(^|\/)(node_modules|vendor|third_party|dist|build|out|target|coverage|\.next|\.nuxt|__pycache__|\.venv|venv|site-packages|Pods|\.git)\//;
const GENERATED = /(\.min\.[jc]ss?$|\.min\.js$|\.d\.ts$|\.pb\.go$|_pb2\.py$|\.generated\.|\.bundle\.js$)/;

/** The files to read: source code, not dependencies or generated. */
export function designFiles(files) {
  return files.filter((f) => SOURCE.test(f) && !SKIP.test(f) && !GENERATED.test(f)).slice(0, MAX_FILES);
}
export const LIMITS = { MAX_FILES, MAX_BYTES, MAX_BOXES };

// ------------------------------------------------------------------ imports

/** What a file imports, as written: ['./x', 'react', 'a.b.c', ...]. */
export function importSpecs(file, text) {
  const out = [];
  const add = (s) => s && !out.includes(s) && out.push(s);
  if (JS.test(file)) {
    for (const m of text.matchAll(/(?:^|[\s;])(?:import|export)\s+(?:type\s+)?[^'";]*?\sfrom\s*['"]([^'"\n]+)['"]/g)) add(m[1]);
    for (const m of text.matchAll(/(?:^|[\s;])import\s*['"]([^'"\n]+)['"]/g)) add(m[1]);
    for (const m of text.matchAll(/(?:require|import)\(\s*['"]([^'"\n]+)['"]\s*\)/g)) add(m[1]);
  } else if (PY.test(file)) {
    for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm)) {
      // "from . import a, b": each name may be a module of the package.
      if (/^\.+$/.test(m[1])) {
        for (const n of m[2].replace(/[()]/g, '').split(',')) {
          const name = n.trim().split(/\s+/)[0];
          if (/^\w+$/.test(name)) add(`${m[1]}${name}`);
        }
      } else add(m[1]);
    }
    for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm)) for (const n of m[1].split(',')) add(n.trim());
  } else if (GO.test(file)) {
    for (const m of text.matchAll(/^import[ \t]+(?:[\w.]+[ \t]+)?"([^"]+)"/gm)) add(m[1]);
    for (const b of text.matchAll(/^import[ \t]*\(([\s\S]*?)^\)/gm)) for (const m of b[1].matchAll(/"([^"]+)"/g)) add(m[1]);
  } else if (JVM.test(file)) {
    for (const m of text.matchAll(/^import[ \t]+(?:static[ \t]+)?([\w.]+(?:\.\*)?)/gm)) add(m[1]);
  }
  return out;
}

const NODE_BUILTIN = new Set('assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib test'.split(' '));
const PY_STD = new Set('__future__ abc argparse array ast asyncio base64 bisect builtins calendar collections concurrent contextlib copy csv ctypes dataclasses datetime decimal difflib email enum errno functools gc getpass glob gzip hashlib heapq hmac html http importlib inspect io ipaddress itertools json logging math mimetypes multiprocessing numbers operator os pathlib pickle platform pprint queue random re secrets select shlex shutil signal socket sqlite3 ssl stat statistics string struct subprocess sys tempfile textwrap threading time timeit traceback types typing unittest urllib uuid warnings weakref xml zipfile zoneinfo'.split(' '));

/** The package an outside import names: "react", "@aws-sdk/client-s3", "requests", "github.com/x/y". */
function packageOf(spec, lang) {
  if (lang === 'js') {
    const s = spec.replace(/^node:/, '');
    if (spec.startsWith('node:') || NODE_BUILTIN.has(s.split('/')[0])) return null;
    return s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
  }
  if (lang === 'py') {
    const top = spec.split('.')[0];
    return !top || PY_STD.has(top) ? null : top;
  }
  if (lang === 'go') return spec.includes('.') ? spec.split('/').slice(0, 3).join('/') : null; // no dot: the standard library
  if (lang === 'jvm') return /^(java|javax|kotlin|android)\./.test(spec) ? null : spec.split('.').slice(0, 2).join('.');
  return null;
}

const langOf = (f) => (JS.test(f) ? 'js' : PY.test(f) ? 'py' : GO.test(f) ? 'go' : JVM.test(f) ? 'jvm' : null);
const dirOf = (f) => f.split('/').slice(0, -1).join('/');
function norm(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Lookups for resolving imports to the repository's own files. */
export function resolver(files, { goModules = [] } = {}) {
  const set = new Set(files);
  const dirs = new Set(files.map(dirOf));
  // Python: a module by its dotted name from any folder above it ("app.db" for svc/app/db.py), the
  // name from the repository root first.
  const py = new Map();
  for (const f of files.filter((x) => PY.test(x))) {
    const parts = f.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/');
    for (let i = 0; i < parts.length; i++) {
      const k = parts.slice(i).join('.');
      if (!py.has(k) || i === 0) py.set(k, f);
    }
  }
  // Java and Kotlin: by the package path at the end of the file's path.
  const jvm = new Map();
  for (const f of files.filter((x) => JVM.test(x))) {
    const parts = f.replace(/\.(java|kt)$/, '').split('/');
    for (let i = 0; i < parts.length; i++) jvm.set(parts.slice(i).join('.'), f);
  }
  const jsTry = (p) => {
    const bases = [p, p.replace(/\.(m?js|cjs|jsx)$/, '')];
    for (const b of bases) {
      if (set.has(b)) return b;
      for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.jsx', '.cjs', '.mts', '.cts', '.vue', '.svelte']) if (set.has(b + ext)) return b + ext;
      for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.jsx']) if (set.has(`${b}/index${ext}`)) return `${b}/index${ext}`;
    }
    return null;
  };

  /** A file's import as { file } (or { dir } for a Go or Java package), { pkg } for an outside one, or null. */
  return function resolve(from, spec) {
    const lang = langOf(from);
    if (lang === 'js') {
      if (spec.startsWith('.')) {
        const f = jsTry(norm(`${dirOf(from)}/${spec}`));
        return f ? { file: f } : null;
      }
      if (spec.startsWith('/')) {
        // A path from the web root: tried from each folder above the file.
        const parts = dirOf(from).split('/');
        for (let i = parts.length; i >= 0; i--) {
          const f = jsTry(norm(`${parts.slice(0, i).join('/')}/${spec}`));
          if (f) return { file: f };
        }
        return null;
      }
      // An alias for the source folder ("@/x", "~/x", "src/x").
      const alias = spec.match(/^[@~]\/(.*)$/)?.[1] ?? (spec.startsWith('src/') ? spec.slice(4) : null);
      if (alias != null) {
        const f = jsTry(`src/${alias}`) ?? jsTry(alias);
        if (f) return { file: f };
      }
      const pkg = packageOf(spec, 'js');
      return pkg ? { pkg } : null;
    }
    if (lang === 'py') {
      let mod = spec;
      if (spec.startsWith('.')) {
        const dots = spec.match(/^\.+/)[0].length;
        const base = dirOf(from).split('/').filter(Boolean);
        const up = base.slice(0, Math.max(0, base.length - (dots - 1)));
        mod = [...up, ...spec.slice(dots).split('.').filter(Boolean)].join('.');
        const f = py.get(mod);
        return f ? { file: f } : null;
      }
      // "a.b.c": the longest part that is a module here ("from a.b import c" may name a function).
      const parts = mod.split('.');
      for (let i = parts.length; i > 0; i--) {
        const f = py.get(parts.slice(0, i).join('.'));
        if (f) return { file: f };
      }
      const pkg = packageOf(spec, 'py');
      return pkg ? { pkg } : null;
    }
    if (lang === 'go') {
      // A package of a module here (go.mod at the root or in a folder): its folder.
      const m = goModules.find((x) => spec === x.module || spec.startsWith(`${x.module}/`));
      if (m) {
        const d = [m.dir, spec.slice(m.module.length + 1)].filter(Boolean).join('/');
        return dirs.has(d) ? { dir: d } : null;
      }
      const pkg = packageOf(spec, 'go');
      return pkg ? { pkg } : null;
    }
    if (lang === 'jvm') {
      if (spec.endsWith('.*')) {
        const d = spec.slice(0, -2).replace(/\./g, '/');
        const hit = [...dirs].find((x) => x === d || x.endsWith(`/${d}`));
        if (hit) return { dir: hit };
      } else {
        const parts = spec.split('.');
        // a.b.C or a.b.C.member
        for (let i = parts.length; i > 1; i--) {
          const f = jvm.get(parts.slice(0, i).join('.'));
          if (f) return { file: f };
        }
      }
      const pkg = packageOf(spec, 'jvm');
      return pkg ? { pkg } : null;
    }
    return null;
  };
}

// ------------------------------------------------------------------ symbols

/** A file's functions, classes and methods with their lines: [{ name, kind, line }]. */
export function symbolsOf(file, text) {
  const out = [];
  const lang = langOf(file);
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    let m;
    const line = i + 1;
    if (lang === 'js') {
      if ((m = l.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) out.push({ name: m[1], kind: 'function', line });
      else if ((m = l.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) out.push({ name: m[1], kind: 'class', line });
      else if ((m = l.match(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/))) out.push({ name: m[1], kind: 'function', line });
      else if ((m = l.match(/^export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/))) out.push({ name: m[1], kind: 'type', line });
      else if ((m = l.match(/^ {2}(?:static\s+|async\s+|get\s+|set\s+|\*)*([A-Za-z_$#][\w$]*)\s*\([^)]*\)\s*\{\s*$/)) && !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(m[1])) out.push({ name: m[1], kind: 'method', line });
    } else if (lang === 'py') {
      if ((m = l.match(/^(?:async\s+)?def\s+(\w+)/))) out.push({ name: m[1], kind: 'function', line });
      else if ((m = l.match(/^class\s+(\w+)/))) out.push({ name: m[1], kind: 'class', line });
      else if ((m = l.match(/^ {4}(?:async\s+)?def\s+(\w+)/))) out.push({ name: m[1], kind: 'method', line });
    } else if (lang === 'go') {
      if ((m = l.match(/^func\s+\(([^)]*)\)\s*(\w+)/))) out.push({ name: `${m[1].trim().split(/\s+/).pop().replace('*', '')}.${m[2]}`, kind: 'method', line });
      else if ((m = l.match(/^func\s+(\w+)/))) out.push({ name: m[1], kind: 'function', line });
      else if ((m = l.match(/^type\s+(\w+)\s+(struct|interface)/))) out.push({ name: m[1], kind: m[2] === 'interface' ? 'type' : 'class', line });
    } else if (lang === 'jvm') {
      if ((m = l.match(/^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|open\s+|data\s+|sealed\s+|internal\s+|static\s+)*(class|interface|enum|object|record)\s+(\w+)/))) out.push({ name: m[2], kind: m[1] === 'interface' ? 'type' : 'class', line });
      else if ((m = l.match(/^\s+(?:override\s+)?(?:public|private|protected|internal)?\s*(?:static\s+|final\s+|suspend\s+|abstract\s+|synchronized\s+)*(?:fun\s+(\w+)|[\w<>[\],.? ]+\s+(\w+))\s*\([^;]*$/)) && !['if', 'for', 'while', 'switch', 'catch', 'return', 'new'].includes(m[1] ?? m[2])) out.push({ name: m[1] ?? m[2], kind: 'method', line });
    }
  });
  return out.slice(0, 400);
}

/** Where the program starts: a main, a command, a server. */
export function isEntry(file, text, pkgJson = null) {
  if (/(^|\/)__main__\.py$/.test(file) || /^if __name__ == ['"]__main__['"]/m.test(text)) return true;
  if (GO.test(file) && /^package main\b/m.test(text) && /^func main\(\)/m.test(text)) return true;
  if (JVM.test(file) && /\bstatic\s+void\s+main\s*\(|^fun main\(/m.test(text)) return true;
  if (pkgJson) {
    const bins = typeof pkgJson.bin === 'string' ? [pkgJson.bin] : Object.values(pkgJson.bin ?? {});
    if ([...bins, pkgJson.main].filter(Boolean).some((b) => norm(b) === file)) return true;
  }
  return false;
}

// What outside packages are, for "talks to".
const SERVICES = [
  [/^(pg|postgres|psycopg2?|asyncpg|github\.com\/(lib\/pq|jackc\/pgx))/, 'PostgreSQL'],
  [/^(mysql2?|pymysql|mysqlclient|github\.com\/go-sql-driver)/, 'MySQL'],
  [/^(sqlite3|better-sqlite3)$/, 'SQLite'],
  [/^(mongodb|mongoose|pymongo|motor|go\.mongodb\.org)/, 'MongoDB'],
  [/^(redis|ioredis|github\.com\/(go-redis|redis))/, 'Redis'],
  [/^(kafkajs|kafka|confluent_kafka|github\.com\/(segmentio\/kafka-go|IBM\/sarama|Shopify\/sarama))/, 'Kafka'],
  [/^(amqplib|pika)$/, 'RabbitMQ'],
  [/^(@aws-sdk\/|aws-sdk|boto3|botocore|github\.com\/aws)/, 'AWS'],
  [/^(@google-cloud\/|google\.cloud|cloud\.google\.com)/, 'Google Cloud'],
  [/^(@azure\/|azure)/, 'Azure'],
  [/^(stripe)$/, 'Stripe'],
  [/^(openai)$/, 'OpenAI'],
  [/^(@anthropic-ai\/sdk|anthropic)$/, 'Anthropic'],
  [/^(@prisma\/client|prisma|typeorm|sequelize|knex|drizzle-orm|sqlalchemy|django|gorm\.io)/, 'Database (ORM)'],
  [/^(axios|node-fetch|got|undici|requests|httpx|aiohttp)$/, 'HTTP APIs'],
  [/^(@grpc\/|grpc|google\.golang\.org\/grpc)/, 'gRPC'],
  [/^(ws|socket\.io|websockets)$/, 'WebSockets'],
  [/^(nodemailer|smtplib|@sendgrid\/)/, 'Email'],
];
export function serviceOf(pkg) {
  return SERVICES.find(([re]) => re.test(pkg))?.[1] ?? null;
}

// ------------------------------------------------------------------ the graph

/**
 * The repository's code as a graph: { files: { path: { lines, imports: [{ file } | { dir }], pkgs,
 * symbols, entry } } }. `sources` is [{ path, text }] (text null when unread); `goModules` is
 * [{ dir, module }] from each go.mod.
 */
export function buildGraph(sources, { goModules = [], pkgJson = null } = {}) {
  const paths = sources.map((s) => s.path);
  const resolve = resolver(paths, { goModules });
  const files = {};
  for (const { path: p, text } of sources) {
    const t = text ?? '';
    const imports = [];
    const pkgs = [];
    for (const spec of importSpecs(p, t)) {
      const r = resolve(p, spec);
      if (r?.file && r.file !== p) imports.push({ file: r.file });
      else if (r?.dir && r.dir !== dirOf(p)) imports.push({ dir: r.dir });
      else if (r?.pkg && !pkgs.includes(r.pkg)) pkgs.push(r.pkg);
    }
    files[p] = { lines: t ? t.split('\n').length : 0, imports, pkgs, entry: t ? isEntry(p, t, pkgJson) : false, symbols: t ? symbolsOf(p, t) : [] };
  }
  return { files };
}

/** The deepest folder holding all the files ('' for none, or the top). */
export function commonFolder(files) {
  if (!files.length) return '';
  let parts = dirOf(files[0]).split('/').filter(Boolean);
  for (const f of files.slice(1)) {
    const d = dirOf(f).split('/');
    let i = 0;
    while (i < parts.length && parts[i] === d[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join('/');
}

const under = (file, box) => box === '' || file === box || file.startsWith(`${box}/`);
/** The file or folder an import lands on, as a path ("a/b" for a package folder). */
const targetOf = (imp) => imp.file ?? imp.dir;

/** The boxes one level inside `at`: its folders (a chain of single folders as one) and files. */
function childrenOf(paths, at) {
  const prefix = at ? `${at}/` : '';
  const kids = new Map();
  for (const f of paths) {
    if (!under(f, at) || f === at) continue;
    const rest = f.slice(prefix.length);
    const head = rest.split('/')[0];
    const key = prefix + head;
    const k = kids.get(key) ?? kids.set(key, { id: key, kind: rest.includes('/') ? 'folder' : 'file', files: [] }).get(key);
    k.files.push(f);
  }
  // "src" holding only "src/app" shows as one box "src/app".
  for (const k of kids.values()) {
    while (k.kind === 'folder') {
      const sub = new Set(k.files.map((f) => f.slice(k.id.length + 1).split('/')[0]));
      const onlyFolder = sub.size === 1 && k.files.every((f) => f.slice(k.id.length + 1).includes('/'));
      if (!onlyFolder) break;
      k.id = `${k.id}/${[...sub][0]}`;
    }
  }
  return [...kids.values()];
}

/**
 * One layer: the boxes inside `at` with the arrows between them, the agent's changes and what
 * depends on them marked. `changed` is the agent's changed files. A file `at` gives its symbols.
 */
export function layerView(graph, { at = '', changed = [], churn = {} } = {}) {
  const all = Object.keys(graph.files);
  const changedSet = new Set(changed.filter((f) => graph.files[f]));
  // Files that import a changed file (or its package folder) and were not changed themselves.
  const dependents = new Set();
  for (const [f, info] of Object.entries(graph.files)) {
    if (changedSet.has(f)) continue;
    if (info.imports.some((imp) => (imp.file ? changedSet.has(imp.file) : [...changedSet].some((c) => dirOf(c) === imp.dir)))) dependents.add(f);
  }
  const crumbs = [{ id: '', name: 'System' }];
  if (at) at.split('/').forEach((_, i, parts) => crumbs.push({ id: parts.slice(0, i + 1).join('/'), name: parts[i] }));

  if (graph.files[at]) {
    const info = graph.files[at];
    const importedBy = all.filter((f) => graph.files[f].imports.some((imp) => imp.file === at || (imp.dir && imp.dir === dirOf(at))));
    return {
      at, crumbs, kind: 'file',
      file: { path: at, lines: info.lines, entry: info.entry, changed: changedSet.has(at), dependent: dependents.has(at), symbols: info.symbols, imports: info.imports.map(targetOf), importedBy, pkgs: info.pkgs },
    };
  }

  let boxes = childrenOf(all, at);
  if (!boxes.length) return { at, crumbs, kind: 'folder', boxes: [], edges: [], talksTo: [], counts: { files: 0 } };
  // The boxes with the agent's changes or what uses them, then the biggest; the rest as one.
  const size = (b) => b.files.reduce((s, f) => s + (graph.files[f]?.lines ?? 0), 0);
  const touched = (b) => b.files.some((f) => changedSet.has(f) || dependents.has(f));
  boxes.sort((a, b) => touched(b) - touched(a) || size(b) - size(a));
  let more = null;
  if (boxes.length > MAX_BOXES) {
    const rest = boxes.slice(MAX_BOXES - 1);
    boxes = boxes.slice(0, MAX_BOXES - 1);
    more = { id: `${at ? `${at}/` : ''}…`, name: `${rest.length} more`, kind: 'more', files: rest.flatMap((b) => b.files) };
  }
  const list = more ? [...boxes, more] : boxes;
  const of = (file) => list.find((b) => (b.kind === 'more' ? b.files.includes(file) : under(file, b.id)))?.id ?? null;

  const edges = new Map();
  const io = new Map(list.map((b) => [b.id, { in: 0, out: 0 }]));
  for (const [f, info] of Object.entries(graph.files)) {
    const from = under(f, at) ? of(f) : null;
    for (const imp of info.imports) {
      const t = targetOf(imp);
      const to = under(t, at) ? of(t) : null;
      if (from && to && from !== to) {
        const k = `${from}\n${to}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      } else if (from && !to) io.get(from).out++;
      else if (!from && to) io.get(to).in++;
    }
  }
  const pkgsIn = (files) => {
    const n = new Map();
    for (const f of files) for (const p of graph.files[f]?.pkgs ?? []) n.set(p, (n.get(p) ?? 0) + 1);
    return n;
  };
  const talks = (files) => {
    const s = new Map();
    for (const p of pkgsIn(files).keys()) {
      const name = serviceOf(p);
      if (name) s.set(name, [...(s.get(name) ?? []), p].slice(0, 4));
    }
    return [...s].map(([name, pkgs]) => ({ name, pkgs }));
  };
  const inside = all.filter((f) => under(f, at));
  const out = list.map((b) => {
    const files = b.files;
    return {
      id: b.id,
      name: b.kind === 'more' ? b.name : at ? b.id.slice(at.length + 1) : b.id,
      kind: b.kind,
      files: files.length,
      lines: files.reduce((s, f) => s + (graph.files[f]?.lines ?? 0), 0),
      churn: files.reduce((s, f) => s + (churn[f] ?? 0), 0),
      entry: files.filter((f) => graph.files[f]?.entry).slice(0, 5),
      changed: files.filter((f) => changedSet.has(f)),
      dependents: files.filter((f) => dependents.has(f)),
      talksTo: talks(files).map((t) => t.name),
      in: io.get(b.id).in,
      out: io.get(b.id).out,
    };
  });
  return {
    at, crumbs, kind: 'folder',
    boxes: out,
    edges: [...edges].map(([k, count]) => {
      const [from, to] = k.split('\n');
      return { from, to, count };
    }),
    rank: rankOf(out.map((b) => b.id), [...edges.keys()].map((k) => k.split('\n'))),
    talksTo: talks(inside),
    counts: { files: inside.length, changed: inside.filter((f) => changedSet.has(f)).length, dependents: inside.filter((f) => dependents.has(f)).length },
  };
}

/**
 * Rows for drawing: callers above what they use. Each box's row is the longest chain of boxes
 * importing it (a cycle is cut where it closes). Returns { id: row }.
 */
export function rankOf(ids, pairs) {
  const callers = new Map(ids.map((id) => [id, []]));
  for (const [from, to] of pairs) if (from !== to) callers.get(to)?.push(from);
  const rank = {};
  const visiting = new Set();
  const depth = (id) => {
    if (rank[id] != null) return rank[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const c of callers.get(id) ?? []) d = Math.max(d, depth(c) + 1);
    visiting.delete(id);
    return (rank[id] = d);
  };
  for (const id of ids) depth(id);
  return rank;
}
