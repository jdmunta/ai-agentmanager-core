// Skills: the Agent Skills Claude Code has on this computer (yours in ~/.claude/skills, and each
// project's in <project>/.claude/skills), and adding more from a git repository. A skill is a
// folder with a SKILL.md (a name, a description of when to use it, the instructions) and whatever
// scripts and files it needs. Adding one is a look first (what the repository offers, each skill's
// files, which of them are scripts) and then a copy; where it came from and the commit are kept, so
// it can be checked for a newer version and updated, and a skill edited here since says so.
// Which agents used which skill is read from their sessions. No model is called.

import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from './config.js';
import { secretsIn } from './secrets.js';

const err = (status, message) => Object.assign(new Error(message), { status });
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target']);
const SCRIPT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd)$/i;
const MAX_FILES = 400;
const MAX_BYTES = 20 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const LOG_MAX = 1000;

/**
 * The skill policy (config.json "skillPolicy"), with its defaults:
 *   places: where skills may be added or changed: "project" and/or "personal" (both)
 *   projectChanges: "direct" (written into the project folder) or "pr" (a branch and a pull request)
 *   proposals: agents propose skills: true, false, or a list of project shortcuts
 *   sources: installing from a repository: true, false, or address prefixes ("github.com/acme/")
 */
export function skillPolicy(p = {}) {
  const list = (v, all) => (v === true || v == null ? all : v === false ? false : Array.isArray(v) ? v.map(String).filter(Boolean) : all);
  const places = Array.isArray(p.places) ? p.places.filter((x) => x === 'project' || x === 'personal') : ['project', 'personal'];
  return {
    places,
    projectChanges: p.projectChanges === 'pr' ? 'pr' : 'direct',
    proposals: list(p.proposals, true),
    sources: list(p.sources, true),
  };
}

export const personalSkillsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'skills');
export const projectSkillsDir = (dir) => path.join(dir, '.claude', 'skills');

/** SKILL.md's front matter: { name, description } (a folded or literal block as one line), and the body. */
export function parseSkill(text) {
  const m = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const out = { name: null, description: null, body: m ? m[2] : String(text ?? '') };
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value) || value === '') {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      value = block.join(' ').replace(/\s+/g, ' ').trim();
    } else {
      value = value.replace(/^(["'])(.*)\1$/, '$2');
    }
    if (kv[1] === 'name') out.name = value || null;
    if (kv[1] === 'description') out.description = value || null;
  }
  return out;
}

/** A skill folder's files (relative paths, sorted), their size, which are scripts, and a hash of it all. */
export function skillFiles(dir) {
  const files = [];
  let size = 0;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile() && files.length < MAX_FILES) {
        const st = fs.statSync(p);
        size += st.size;
        files.push({ path: r, size: st.size, script: SCRIPT.test(e.name) || Boolean(st.mode & 0o111) });
      }
    }
  };
  walk(dir, '');
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(`${f.path}\0`);
    if (size <= MAX_BYTES) h.update(fs.readFileSync(path.join(dir, f.path)));
  }
  return { files, size, scripts: files.filter((f) => f.script).map((f) => f.path), hash: h.digest('hex').slice(0, 16) };
}

/** One skill folder as a record, or null when it has no SKILL.md. */
export function readSkill(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  const meta = parseSkill(text);
  const f = skillFiles(dir);
  return { name: meta.name || path.basename(dir), folder: path.basename(dir), description: meta.description, dir, files: f.files.length, size: f.size, scripts: f.scripts, hash: f.hash, updatedAt: fs.statSync(path.join(dir, 'SKILL.md')).mtime.toISOString() };
}

/** The skills directly in a skills folder (one folder a skill). */
export function skillsIn(root) {
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP.has(e.name)).map((e) => e.name);
  } catch {}
  return names.sort().map((n) => readSkill(path.join(root, n))).filter(Boolean);
}

/** Every skill in a repository's checkout, wherever it keeps them (up to four folders down). */
export function findSkills(root) {
  const out = [];
  const walk = (d, depth) => {
    if (fs.existsSync(path.join(d, 'SKILL.md'))) {
      const s = readSkill(d);
      if (s) out.push({ ...s, path: path.relative(root, d) || '.' });
      return; // a skill's own folders are its files
    }
    if (depth >= 4) return;
    let list = [];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {}
    for (const e of list) if (e.isDirectory() && !e.isSymbolicLink() && !SKIP.has(e.name)) walk(path.join(d, e.name), depth + 1);
  };
  walk(root, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** "owner/repo", a GitHub page address or a git URL as a URL git can clone (https only), or null. */
export function repoUrl(input) {
  const s = String(input ?? '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s}.git`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  // A GitHub page inside the repository (…/tree/main/skills) is still that repository.
  const repo = u.hostname === 'github.com' ? parts.slice(0, 2) : parts;
  return `https://${u.host}/${repo.join('/')}.git`;
}

/** The skills each session used, from its transcript: { name: times }. */
export function skillUses(text) {
  const out = {};
  for (const m of String(text ?? '').matchAll(/"name":"Skill","input":\{"skill":"([^"\\]{1,120})"/g)) out[m[1]] = (out[m[1]] ?? 0) + 1;
  return out;
}

/**
 * Asked of every agent with a brief: a procedure worth keeping, written as a skill for the person
 * to add or not. Most tasks have none.
 */
export const PROPOSAL_PROMPT =
  'When you finish, think whether you worked out a procedure of several steps that the next agent here will need again and that no ' +
  'skill or CLAUDE.md covers yet (how to run or debug a kind of test, a release step, a migration, setting up a service). If so, add a ' +
  'section "## Skill proposal" to the brief:\n' +
  'Name: <short-kebab-case-name>\n' +
  'When to use: <one line: the tasks it is for>\n' +
  'then the steps as you ran them: the commands, the files, what to check. If a skill you used turned out wrong or out of date, propose ' +
  'its corrected version under the same name, with a line "Changed: <what and why>". Do not write the skill into the repository or ' +
  '~/.claude yourself: the user decides. Leave the section out when there is nothing worth keeping.';

/** Told at the start: skills here the app found out of date ([{ name, drift: [{ ref, why }] }] from drifted()). */
export const staleSkillsPrompt = (stale) =>
  'AI Agent Manager found these skills out of date with the code here:\n' +
  stale
    .slice(0, 10)
    .map((s) => `- ${s.name}: ${s.drift.slice(0, 4).map((d) => `\`${d.ref}\` (${d.why})`).join('; ')}`)
    .join('\n') +
  '\nIf you use one, check it against the code and, once you know what works, propose its corrected version under "## Skill proposal" with a "Changed:" line.';

/** A skill folder's name from a proposed name: "Run E2E tests" -> "run-e2e-tests", or null. */
export const skillSlug = (name) => {
  const s = String(name ?? '').toLowerCase().replace(/[`*_"']/g, '').replace(/[^a-z0-9.]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64).replace(/[-.]+$/, '');
  return NAME.test(s) ? s : null;
};

/** The "## Skill proposal" section: { name, description, changed, body } or null when there is none. */
export function parseProposal(text) {
  const lines = String(text ?? '').split('\n');
  const out = { name: null, description: null, changed: null, body: '' };
  const rest = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*]\s+)?\**\s*(name|when to use|use when|description|changed)\s*\**\s*:\s*\**\s*(.*?)\s*$/i);
    const k = m?.[1].toLowerCase();
    if (k === 'name' && !out.name) out.name = m[2].replace(/[`*]/g, '').trim();
    else if ((k === 'when to use' || k === 'use when' || k === 'description') && !out.description) out.description = m[2].replace(/\s+/g, ' ').slice(0, 300);
    else if (k === 'changed' && !out.changed) out.changed = m[2].slice(0, 300);
    else rest.push(line);
  }
  out.body = rest.join('\n').trim().slice(0, 20_000);
  out.folder = skillSlug(out.name);
  if (!out.folder || !out.body || /^(none|n\/a|nothing)\b/i.test(out.body)) return null;
  return out;
}

/** A SKILL.md for a proposal (front matter Claude Code reads, then its steps). */
export function skillText({ folder, description, body }) {
  // Quoted for YAML; parseSkill reads it back without the quotes.
  const q = (s) => `"${String(s ?? '').replace(/\s+/g, ' ').replace(/\\/g, '/').replace(/"/g, "'")}"`;
  return `---\nname: ${folder}\ndescription: ${q(description || `How to ${folder.replace(/-/g, ' ')} in this project`)}\n---\n\n${body.trim()}\n`;
}

/**
 * The code in a skill's instructions: fenced blocks line by line, and inline spans, each with the
 * prose before it on its line (`lead`: "Write the report to `out/x.md`" names a file to make, not one there).
 */
function codeOf(markdown) {
  const out = [];
  const text = String(markdown ?? '');
  for (const m of text.matchAll(/^\s*(```|~~~)[^\n]*\n([\s\S]*?)^\s*\1\s*$/gm)) out.push(...m[2].split('\n').map((code) => ({ code, lead: '' })));
  const prose = text.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '');
  for (const line of prose.split('\n'))
    for (const m of line.matchAll(/`([^`\n]{1,300})`/g)) out.push({ code: m[1], lead: line.slice(Math.max(0, m.index - 80), m.index) });
  return out;
}

const exists = (base, rel) => Boolean(base) && fs.existsSync(path.join(base, rel));
const isDir = (base, rel) => {
  try {
    return Boolean(base) && fs.statSync(path.join(base, rel)).isDirectory();
  } catch {
    return false;
  }
};
const readOr = (file, fallback = null) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
};
const scriptsIn = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return null;
  }
};
const makefileIn = (dir) => ['Makefile', 'makefile', 'GNUmakefile'].map((f) => readOr(path.join(dir, f))).find((x) => x != null) ?? null;
// Targets made by patterns, variables or other files can't be known from here.
const makeOpen = (make) => /^(?:-?include\b|[^\t#=\n]*%[^=\n]*:|\s*\$[({][^\n]*:)/m.test(make);
const hasTarget = (make, target) => new RegExp(`^(?:[^\\t#:=\\n]*\\s)?${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s[^:=\\n]*)?\\s*::?(?!=)`, 'm').test(make);

// Prose that names a file to make: "write it to `out/x.md`", "creates `dist/`".
const MAKES = /\b(?:creat|writ|generat|output|produc|sav|emit|export|render|build|add|new|becom|lands?\b|will be|goes to|appears?)\w*\b[^.`]*$/i;
// Shell words after which a path is written, not read.
const OUTPUT_AT = /(?:>>?|\btee(?:\s+-a)?|\btouch|\bmkdir(?:\s+-p)?|(?:^|\s)-o|--out(?:put|dir|-dir|file)?(?:=|\s))\s*['"]?([^\s'";|&<>]+)/g;
// npm/pnpm/yarn/bun options that run in another package: its scripts are not the project's.
const IN_WORKSPACE = /(?:^|\s)(?:-w|--workspaces?|-ws|--filter|-F|-r|--recursive|--cwd)\b/;

/** Where a command on a line runs: the last `cd dir &&` before it, relative to the project; null when it can't be told. */
function cdBefore(line, index, projectDir) {
  const cds = [...line.slice(0, index).matchAll(/\bcd\s+([^\s;&|]+)\s*(?:&&|;)/g)];
  if (!cds.length) return projectDir;
  const to = cds.at(-1)[1].replace(/^['"]|['"]$/g, '');
  if (/^[~$/]/.test(to) || to.includes('..')) return null;
  return path.join(projectDir, to);
}

// What git says about a path gone from the project, kept a few minutes: ignored (built, not kept), renamed, or deleted.
const gitMemo = new Map();
function gitFate(projectDir, rel) {
  const key = `${projectDir}\0${rel}`;
  const hit = gitMemo.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.fate;
  let fate = null;
  const git = (args) => execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    git(['check-ignore', '-q', '--', rel]);
    fate = { ignored: true };
  } catch (e) {
    // 1: not ignored; anything else: not a git repository, or no git.
    if (e.status === 1) {
      try {
        // The commit that took it away, then that commit whole: a rename shows only without the path filter.
        const commit = git(['log', '-1', '--format=%h', '--diff-filter=D', '--', rel]).trim() || null;
        if (commit) {
          const row = git(['show', '-M', '--name-status', '--format=', commit]).split('\n').map((l) => l.split('\t')).find((r) => r[0]?.startsWith('R') && r[1] === rel);
          fate = row?.[2] && fs.existsSync(path.join(projectDir, row[2])) ? { renamed: row[2], commit } : { deleted: true, commit };
        }
      } catch {}
    }
  }
  gitMemo.set(key, { at: Date.now(), fate });
  if (gitMemo.size > 2000) gitMemo.delete(gitMemo.keys().next().value);
  return fate;
}

/**
 * What a skill names that is not there any more: an npm script not in package.json, a make target
 * not in the Makefile, a file or folder that is gone. `projectDir` is the project a project's skill
 * belongs to (null for yours: then only paths in its own folder are checked). A path is only taken
 * for one when its first folder is there (`src/x.js` with no src is likely not a path of this
 * project), or when it starts with ./ ; not when the skill says to make it, or git ignores it (a
 * build's output). A file git saw renamed carries `to`, its new path. Commands run in another
 * folder (`cd web && npm run x`, `--prefix`, `-C`) are checked there, and in a workspace not at all.
 * Returns [{ ref, why, to? }], no model involved.
 */
export function skillDrift(markdown, { projectDir = null, skillDir = null } = {}) {
  const out = [];
  const add = (ref, why, to = null) => !out.some((x) => x.ref === ref) && out.length < 20 && out.push(to ? { ref, why, to } : { ref, why });
  const scripts = new Map();
  const makes = new Map();
  const scriptsAt = (dir) => (scripts.has(dir) ? scripts.get(dir) : scripts.set(dir, scriptsIn(dir)).get(dir));
  const makeAt = (dir) => (makes.has(dir) ? makes.get(dir) : makes.set(dir, makefileIn(dir)).get(dir));
  for (const { code: line, lead } of codeOf(parseSkill(markdown).body)) {
    if (projectDir) {
      for (const m of line.matchAll(/\b(npm|pnpm|yarn|bun)\s+((?:-[^\s;&|]+(?:\s+(?!run\b)[^-\s;&|][^\s;&|]*)?\s+)*)run\s+([\w:.@/-]+)/g)) {
        const opts = m[2];
        if (IN_WORKSPACE.test(opts) || IN_WORKSPACE.test(line.slice(m.index + m[0].length).split(/[;&|]/)[0])) continue;
        const at = /(?:--prefix|-C|--dir)[=\s]+([^\s;&|]+)/.exec(opts);
        const dir = at ? (/^[~$/]/.test(at[1]) || at[1].includes('..') ? null : path.join(projectDir, at[1])) : cdBefore(line, m.index, projectDir);
        const list = dir && scriptsAt(dir);
        if (list && !Object.hasOwn(list, m[3])) add(`${m[1]} run ${m[3]}`, `no script "${m[3]}" in ${path.relative(projectDir, path.join(dir, 'package.json'))}`);
      }
      for (const m of line.matchAll(/(?:^|[\s;&|(])make\s+(?:-C\s+([^\s;&|]+)\s+)?([A-Za-z0-9_][\w.-]*)(?=\s|$|[;&|)])/g)) {
        const dir = m[1] ? (/^[~$/]/.test(m[1]) || m[1].includes('..') ? null : path.join(projectDir, m[1])) : cdBefore(line, m.index, projectDir);
        const make = dir && makeAt(dir);
        const target = m[2].replace(/[.]+$/, '');
        if (make != null && !makeOpen(make) && !hasTarget(make, target)) add(`make ${target}`, `no "${target}" target in ${path.relative(projectDir, path.join(dir, 'Makefile'))}`);
      }
    }
    if (lead && MAKES.test(lead)) continue;
    const outputs = new Set([...line.matchAll(OUTPUT_AT)].map((m) => m[1]));
    for (let t of line.split(/[\s'"=(),;|&<>]+/)) {
      t = t.replace(/[.,:;!?]+$/, '').replace(/:\d+(?::\d+)?$/, '');
      if (!t.includes('/') || outputs.has(t) || !/^[\w.@/+-]+$/.test(t) || /^(?:[-~@$]|\/|\.\.\/)/.test(t) || t.split('/').includes('..') || /^[\w-]+:\/\//.test(t)) continue;
      const rel = t.replace(/^\.\//, '').replace(/\/+$/, '');
      if (!rel || exists(skillDir, rel) || exists(projectDir, rel)) continue;
      const first = rel.split('/')[0];
      const inSkill = isDir(skillDir, first) || (!projectDir && t.startsWith('./'));
      if (!t.startsWith('./') && !isDir(skillDir, first) && !isDir(projectDir, first)) continue;
      if (inSkill || !projectDir) {
        add(t, "not in the skill's folder");
        continue;
      }
      const fate = gitFate(projectDir, rel);
      if (fate?.ignored) continue;
      if (fate?.renamed) add(t, `renamed to ${fate.renamed} (${fate.commit})`, t.startsWith('./') ? `./${fate.renamed}` : fate.renamed);
      else add(t, fate?.deleted ? `deleted from the project (${fate.commit})` : 'not in the project');
    }
  }
  return out;
}

/** A skill's text with each renamed path it names put right ({ ref, to } from skillDrift). */
export function fixPaths(markdown, fixes) {
  let text = String(markdown);
  for (const { ref, to } of fixes) {
    if (!to) continue;
    const re = new RegExp(`(^|[\\s\`'"=(,;|&<>])${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s\`'".,:;!?)|&<>])`, 'gm');
    text = text.replace(re, (_, pre) => `${pre}${to}`);
  }
  return text;
}

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...opts, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, errOut) => (e ? reject(new Error(String(errOut || e.message).trim().split('\n').pop())) : resolve(String(out)))),
  );

export class Skills {
  /**
   * `projects()`: [{ key, name, dir }] the projects with a folder here; `sessions()`: [{ id, name,
   * file }] each agent's session transcript; `clone(url, dir)`: fetches a repository (tests pass their own).
   */
  /**
   * `policy()`: the skill policy (skillPolicy in config.json); `plugins`: policies that may refuse a
   * change and listeners told of each (plugins.js); `openPr({ dir, branch, base, title, body })`:
   * opens a pull request and returns its address.
   */
  constructor({ store, projects = () => [], sessions = () => [], clone = null, cache = path.join(paths.home, 'skills-cache'), personal = personalSkillsDir, now = () => new Date().toISOString(), policy = () => ({}), plugins = null, openPr = null }) {
    Object.assign(this, { store, projects, sessions, cache, personal, now, plugins });
    this.policyOf = policy;
    this.clone = clone ?? ((url, dir) => run('git', ['clone', '--depth', '1', '--quiet', url, dir]));
    this.openPr = openPr ?? (async ({ dir, branch, base, title, body }) => (await run('gh', ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body], { cwd: dir })).trim());
    this.usesCache = new Map(); // transcript -> { key, uses }
  }

  /** The skill policy, with its defaults: where changes may go, how a project's are made, what may be installed. */
  get policy() {
    return skillPolicy(this.policyOf());
  }

  /** How a change to this place is made: in place, or as a pull request to its project. */
  viaOf(place) {
    return place.root && this.policy.projectChanges === 'pr' ? 'pr' : 'direct';
  }

  /** Throws 403 when the skill policy, or a plugin's, refuses `action` in `place`. */
  guard(action, place, details = {}) {
    const kind = place.root ? 'project' : 'personal';
    if (!this.policy.places.includes(kind)) throw err(403, `The skill policy does not allow changes to ${kind === 'personal' ? 'your own skills' : "a project's skills"} here`);
    this.plugins?.check(`skill.${action}`, { ...details, place: place.id, project: place.project ?? null, via: this.viaOf(place) });
  }

  /** Whether the policy allows installing from this repository address. */
  guardSource(url) {
    const allow = this.policy.sources;
    if (allow === true) return;
    const bare = String(url).replace(/^[a-z]+:\/\/(?:[^@/]+@)?/i, '').replace(/^git@([^:]+):/, '$1/').toLowerCase();
    if (allow === false || !allow.some((prefix) => bare.startsWith(String(prefix).replace(/^[a-z]+:\/\//i, '').toLowerCase()))) throw err(403, `The skill policy does not allow installing skills from ${url}`);
  }

  /** Kept in the skills history and told to plugins: what changed, where, by whom, and the pull request if one. */
  audit(action, entry, by = null) {
    const e = { at: this.now(), action, ...entry, by: by ?? { person: null, from: 'this computer' } };
    this.state.log.push(e);
    if (this.state.log.length > LOG_MAX) this.state.log.splice(0, this.state.log.length - LOG_MAX);
    this.plugins?.emit(`skill.${action}`, e);
    return e;
  }

  /** The skills history, newest first. */
  history({ limit = 100 } = {}) {
    return this.state.log.slice(-Math.max(1, Math.min(LOG_MAX, Number(limit) || 100))).reverse();
  }

  /**
   * Make a change to a place's skills. `fn(target)` writes into `target.dir` (the place itself, or a
   * fresh worktree of the project's default branch) and returns what it did. In a project whose
   * policy asks for pull requests, the change is committed on its own branch, pushed, and a pull
   * request opened; your checkout is never touched.
   */
  async write(place, { branch, title, body, ids = [] }, fn) {
    if (this.viaOf(place) !== 'pr') {
      const r = await fn(place);
      this.store.save();
      return { ...r, via: 'direct' };
    }
    const root = place.root;
    const g = (args, cwd = root) => run('git', ['-C', cwd, ...args]);
    try {
      await g(['remote', 'get-url', 'origin']);
    } catch {
      throw err(409, `${place.label} has no "origin" remote, and the skill policy asks for a pull request`);
    }
    const base = (await g(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => 'origin/main')).trim().replace(/^origin\//, '');
    try {
      await g(['fetch', '--quiet', 'origin', base]);
    } catch (e) {
      throw err(502, `Could not fetch ${base} from origin: ${e.message}`);
    }
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmgr-skill-'));
    const name = `skills/${branch}-${crypto.randomBytes(3).toString('hex')}`;
    try {
      await g(['worktree', 'add', '--quiet', '-b', name, wt, `origin/${base}`]);
      const r = await fn({ ...place, dir: projectSkillsDir(wt), root: wt });
      await g(['add', '-A', '--', '.claude/skills'], wt);
      if (!(await g(['status', '--porcelain', '--', '.claude/skills'], wt)).trim()) throw err(409, `Nothing to change: ${base} already has it`);
      await g(['commit', '--quiet', '-m', `${title}\n\n${body}`], wt);
      await g(['push', '--quiet', 'origin', `HEAD:refs/heads/${name}`], wt);
      let url;
      try {
        url = await this.openPr({ dir: wt, branch: name, base, title, body });
      } catch (e) {
        throw err(502, `Pushed ${name}, but opening the pull request failed: ${e.message}`);
      }
      url = /https?:\/\/\S+/.exec(url ?? '')?.[0] ?? null;
      // Shown on the skill until the change is in the project (its files no longer what they were).
      for (const id of ids) this.state.pending[id] = { pr: url, branch: name, at: this.now(), before: this.hashOf(id) };
      this.store.save();
      return { ...r, via: 'pr', pr: url, branch: name };
    } finally {
      await g(['worktree', 'remove', '--force', wt]).catch(() => {});
      fs.rmSync(wt, { recursive: true, force: true });
    }
  }

  /** A skill's files' hash where it is now, or null when it is not there. */
  hashOf(id) {
    try {
      return this.find(id).skill.hash;
    } catch {
      return null;
    }
  }

  /** The pull request open for a skill, until its files change here (merged and pulled). */
  pendingOf(id, hash = this.hashOf(id)) {
    const p = this.state.pending[id];
    if (!p) return null;
    if (p.before !== hash) {
      delete this.state.pending[id];
      return null;
    }
    return { pr: p.pr, branch: p.branch, at: p.at };
  }

  get state() {
    const s = (this.store.data.skills ??= {});
    s.sources ??= {};
    s.proposed ??= {}; // skill id -> { agentId, agentName, at }: added from an agent's proposal
    s.upstream ??= {}; // skill id -> { at, changed, latest, gone }: the last look at its repository
    s.dismissed ??= {}; // skill id -> the drift you said not now to (it comes back when that changes)
    s.pending ??= {}; // skill id -> { pr, branch, at, before }: a pull request with a change to it
    s.log ??= []; // the history: [{ at, action, id, place, by, via, pr, ... }]
    return s;
  }

  /** The places skills live: yours, and each project's. */
  places() {
    return [{ id: 'personal', label: 'Yours (every project)', dir: this.personal() }, ...this.projects().filter((p) => p.dir && fs.existsSync(p.dir)).map((p) => ({ id: `project:${p.key}`, label: p.name ?? p.key, dir: projectSkillsDir(p.dir), project: p.key, root: p.dir }))];
  }

  place(id) {
    const p = this.places().find((x) => x.id === id);
    if (!p) throw err(404, 'No such place for skills');
    return p;
  }

  /** The skills one session used: { name: times } (kept until its transcript changes). */
  usesOf(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return {};
    }
    const key = `${st.mtimeMs}:${st.size}`;
    let c = this.usesCache.get(file);
    if (c?.key !== key) {
      // A long session is read from its end: enough to know it used a skill lately.
      let text = '';
      try {
        const max = 24 * 1024 * 1024;
        if (st.size <= max) text = fs.readFileSync(file, 'utf8');
        else {
          const fd = fs.openSync(file, 'r');
          const buf = Buffer.alloc(max);
          fs.readSync(fd, buf, 0, max, st.size - max);
          fs.closeSync(fd);
          text = buf.toString('utf8');
        }
      } catch {}
      c = { key, uses: skillUses(text) };
      this.usesCache.set(file, c);
    }
    return c.uses;
  }

  /** Which agents used which skill: { name: [{ id, name, times }] }. */
  usedBy() {
    const out = {};
    for (const s of this.sessions()) for (const [name, times] of Object.entries(this.usesOf(s.file))) (out[name] ??= []).push({ id: s.id, name: s.name, times });
    return out;
  }

  /**
   * The skills a session used that are here (yours, and its project's), each with what is out of
   * date in it: [{ id, name, drift }]. For the self-review's Conventions answer.
   */
  usedIn(file, projectKey = null) {
    const uses = Object.keys(this.usesOf(file));
    if (!uses.length) return [];
    const out = [];
    for (const p of this.places().filter((x) => x.id === 'personal' || (projectKey && x.id === `project:${projectKey}`)))
      for (const s of skillsIn(p.dir))
        if ((uses.includes(s.name) || uses.includes(s.folder)) && !out.some((x) => x.name === s.name)) out.push({ id: `${p.id}/${s.folder}`, name: s.name, drift: this.health(p, s, `${p.id}/${s.folder}`).drift });
    return out;
  }

  list() {
    const used = this.usedBy();
    const places = this.places().map((p) => ({
      id: p.id,
      label: p.label,
      dir: p.dir,
      // Under the skill policy: whether changes may be made here, and how (in place, or a pull request).
      allowed: this.policy.places.includes(p.root ? 'project' : 'personal'),
      via: this.viaOf(p),
      skills: skillsIn(p.dir).map((s) => {
        const id = `${p.id}/${s.folder}`;
        const src = this.state.sources[id] ?? null;
        const usedBy = used[s.name] ?? used[s.folder] ?? [];
        return { ...s, id, place: p.id, source: src ? { repo: src.repo, path: src.path, commit: src.commit, installedAt: src.installedAt } : null, edited: Boolean(src && src.hash !== s.hash), usedBy, ...this.health(p, s, id, usedBy) };
      }),
    }));
    return { places, count: places.reduce((n, p) => n + p.skills.length, 0), policy: this.policy };
  }

  /** What is off about one skill: { drift, newer, proposedBy, unused }. */
  health(place, s, id, usedBy = []) {
    let drift = [];
    try {
      drift = skillDrift(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'), { projectDir: place.root ?? null, skillDir: s.dir });
    } catch {}
    const up = this.state.upstream[id];
    const since = this.state.sources[id]?.installedAt ?? this.state.proposed[id]?.at ?? s.updatedAt;
    return {
      drift,
      // A newer version in its repository, as of the last look (checkAll).
      newer: up && (up.changed || up.gone) && up.hash === this.state.sources[id]?.hash ? { latest: up.latest, gone: Boolean(up.gone), at: up.at } : null,
      proposedBy: this.state.proposed[id] ?? null,
      pending: this.pendingOf(id, s.hash),
      // Here a month and no agent used it: worth a look whether its description says when to use it.
      unused: !usedBy.length && Date.parse(this.now()) - Date.parse(since) > 30 * 86400_000,
    };
  }

  /** Skills that need a look: out of date with the code, or a newer version upstream. Not now hides one until that changes. */
  drifted() {
    const out = [];
    // Without reading transcripts: cheap enough for every look at the inbox.
    for (const p of this.places())
      for (const one of skillsIn(p.dir)) {
        const id = `${p.id}/${one.folder}`;
        const s = { ...one, id, edited: Boolean(this.state.sources[id] && this.state.sources[id].hash !== one.hash), ...this.health(p, one, id) };
        if (!s.drift.length && !s.newer) continue;
        const sig = crypto.createHash('sha1').update(JSON.stringify([s.hash, s.drift.map((d) => d.ref), s.newer?.latest ?? null])).digest('hex').slice(0, 12);
        if (this.state.dismissed[s.id] === sig) continue;
        out.push({ id: s.id, name: s.name, place: p.id, placeLabel: p.label, drift: s.drift, newer: s.newer, edited: s.edited, pending: s.pending, sig });
      }
    return out;
  }

  dismissDrift(id, { by = null } = {}) {
    const d = this.drifted().find((x) => x.id === id);
    if (!d) throw err(404, 'Nothing to put off for that skill');
    this.state.dismissed[id] = d.sig;
    this.audit('drift.dismissed', { id, place: d.place, refs: d.drift.map((x) => x.ref) }, by);
    this.store.save();
    return this.drifted();
  }

  /** The inbox items: one per skill that needs a look (from `items`, the last drifted(), when given). */
  inbox(items = this.drifted()) {
    return items.map((d) => ({ kind: 'skilldrift', key: `skilldrift:${d.id}`, title: `Skill ${d.name} ${d.drift.length ? 'is out of date with the code' : 'has a newer version'}`, priority: 3, ...d }));
  }

  /** Look at each repository skills came from (once per repository) for newer versions. */
  async checkAll() {
    const byRepo = new Map();
    for (const p of this.places())
      for (const s of skillsIn(p.dir)) {
        const id = `${p.id}/${s.folder}`;
        const src = this.state.sources[id];
        if (src?.repo) (byRepo.get(src.repo) ?? byRepo.set(src.repo, []).get(src.repo)).push({ id, s, src });
      }
    for (const [repo, list] of byRepo) {
      let r;
      try {
        r = await this.fetch(repo);
      } catch {
        continue; // offline, or the repository moved: try again next time
      }
      for (const { id, s, src } of list) {
        const theirs = r.skills.find((x) => x.path === src.path) ?? r.skills.find((x) => x.folder === s.folder);
        this.state.upstream[id] = { at: this.now(), latest: r.commit, changed: Boolean(theirs && theirs.hash !== src.hash), gone: !theirs, hash: src.hash };
      }
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
    this.store.save();
    return this.drifted();
  }

  /** Put right the paths a skill names that git saw renamed. Returns what was fixed, and the skill's drift after. */
  async fixDrift(id, { by = null } = {}) {
    const { place, skill, id: sid } = this.find(id);
    const fixes = skillDrift(fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8'), { projectDir: place.root ?? null, skillDir: skill.dir }).filter((d) => d.to);
    if (!fixes.length) throw err(400, 'Nothing in that skill can be fixed automatically: no path it names was renamed');
    const fixed = fixes.map((f) => ({ ref: f.ref, to: f.to }));
    this.guard('fix', place, { id: sid, fixed });
    const r = await this.write(place, { branch: `fix-${skill.folder}`, title: `Skill ${skill.folder}: fix renamed paths`, body: fixed.map((f) => `- \`${f.ref}\` → \`${f.to}\``).join('\n'), ids: [sid] }, (target) => {
      const file = path.join(target.dir, skill.folder, 'SKILL.md');
      if (!fs.existsSync(file)) throw err(409, `${skill.folder} is not on the default branch yet`);
      fs.writeFileSync(file, fixPaths(fs.readFileSync(file, 'utf8'), fixes));
      return {};
    });
    this.audit('fixed', { id: sid, place: place.id, via: r.via, pr: r.pr ?? null, fixed }, by);
    this.store.save();
    // What is left to fix by hand (by pull request, the fixed paths are still here until it is merged).
    const left = skillDrift(fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8'), { projectDir: place.root ?? null, skillDir: skill.dir }).filter((d) => !fixed.some((f) => f.ref === d.ref));
    return { id: sid, fixed, via: r.via, pr: r.pr ?? null, drift: left };
  }

  /**
   * What to know before adding a proposed skill to a place: anything in it that looks like a key or
   * token (then it is not added), what it names that is not in the project, and the skill already
   * there under that name (`same` when the proposal changes nothing).
   */
  checkProposal({ folder, description, body }, placeId) {
    let p = null;
    try {
      p = this.place(placeId);
    } catch {}
    const text = skillText({ folder, description, body });
    const secrets = [...new Set(secretsIn(text))];
    const drift = p ? skillDrift(text, { projectDir: p.root ?? null, skillDir: path.join(p.dir, folder) }).filter((d) => !d.why.includes("skill's folder")) : [];
    let existing = null;
    const now = p && readOr(path.join(p.dir, folder, 'SKILL.md'));
    if (now != null) existing = { id: `${p.id}/${folder}`, same: parseSkill(now).body.trim() === String(body).trim() && (parseSkill(now).description ?? '') === (parseSkill(text).description ?? '') };
    const allowed = p ? this.policy.places.includes(p.root ? 'project' : 'personal') : false;
    return { secrets, drift, existing, via: p ? this.viaOf(p) : 'direct', allowed, places: this.policy.places };
  }

  /**
   * Write a proposed skill (from an agent's brief) to a place. One already there is kept unless
   * `replace`. In a project whose policy asks for pull requests, it is one.
   */
  async add({ place = 'personal', folder, description, body, replace = false, from = null, by = null } = {}) {
    const p = this.place(place);
    if (!NAME.test(String(folder ?? ''))) throw err(400, 'A skill needs a name of letters, digits, dots and dashes');
    if (!String(body ?? '').trim()) throw err(400, 'The skill has no steps');
    const secrets = secretsIn(`${description ?? ''}\n${body}`);
    if (secrets.length) throw err(400, `Not added: the steps contain what looks like ${secrets[0]}. Remove it first (or ask the agent to)`);
    const id = `${p.id}/${folder}`;
    const there = fs.existsSync(path.join(p.dir, folder));
    if (there && !replace) throw err(409, `${p.label} already has a skill called ${folder}`);
    this.guard('add', p, { id, folder, replace: there, from });
    const r = await this.write(p, { branch: `add-${folder}`, title: `Skill ${folder}: ${there ? 'update' : 'add'}${from?.agentName ? ` (proposed by ${from.agentName})` : ''}`, body: [description ? `When to use: ${description}` : '', from?.changed ? `Changed: ${from.changed}` : ''].filter(Boolean).join('\n\n') || `Adds the ${folder} skill.`, ids: [id] }, (target) => {
      const dir = path.join(target.dir, folder);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), skillText({ folder, description, body }));
      return {};
    });
    // Written from an agent's proposal: no longer the repository's version, if it was one.
    delete this.state.sources[id];
    delete this.state.upstream[id];
    if (from) this.state.proposed[id] = { agentId: from.agentId, agentName: from.agentName, at: this.now() };
    this.audit(there ? 'replaced' : 'added', { id, place: p.id, via: r.via, pr: r.pr ?? null, from: from ? { agentId: from.agentId, agentName: from.agentName } : null }, by);
    this.store.save();
    return { id, place: p.id, dir: path.join(p.dir, folder), via: r.via, pr: r.pr ?? null };
  }

  find(id) {
    const [placeId, folder] = [String(id).slice(0, String(id).lastIndexOf('/')), String(id).slice(String(id).lastIndexOf('/') + 1)];
    if (!NAME.test(folder)) throw err(400, 'No such skill');
    const p = this.place(placeId);
    const s = readSkill(path.join(p.dir, folder));
    if (!s) throw err(404, 'No such skill');
    return { place: p, skill: s, id: `${p.id}/${folder}` };
  }

  /** A skill's instructions and its files. */
  show(id) {
    const { skill, id: sid } = this.find(id);
    const f = skillFiles(skill.dir);
    return { ...skill, id: sid, markdown: fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8').slice(0, 200_000), list: f.files, source: this.state.sources[sid] ?? null };
  }

  /** A repository fetched to look at: its commit and the skills in it. */
  async fetch(input) {
    const url = repoUrl(input);
    if (!url) throw err(400, 'Give a repository: owner/name on GitHub, or an https git address');
    const dir = path.join(this.cache, crypto.createHash('sha1').update(url).digest('hex').slice(0, 12));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(this.cache, { recursive: true });
    try {
      await this.clone(url, dir);
    } catch (e) {
      throw err(502, `Could not fetch ${url}: ${e.message}`);
    }
    let commit = null;
    try {
      commit = (await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'])).trim();
    } catch {}
    return { url, dir, commit, skills: findSkills(dir) };
  }

  /** What a repository offers, before anything is copied: each skill, its files, and which are scripts. */
  async preview(input) {
    const url = repoUrl(input);
    if (url) this.guardSource(url);
    const r = await this.fetch(input);
    const have = new Set(this.list().places.flatMap((p) => p.skills.map((s) => s.id)));
    return { repo: r.url, commit: r.commit, skills: r.skills.map(({ dir, ...s }) => ({ ...s, installedIn: this.places().filter((p) => have.has(`${p.id}/${s.folder}`)).map((p) => p.id) })) };
  }

  copy(from, place, folder, source) {
    if (!NAME.test(folder)) throw err(400, `"${folder}" is not a folder name a skill can have`);
    const f = skillFiles(from);
    if (f.files.length >= MAX_FILES || f.size > MAX_BYTES) throw err(400, `${folder} is too large to add (${f.files.length} files)`);
    const to = path.join(place.dir, folder);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(to, { recursive: true });
    // Its own files only: no links out of the folder.
    for (const file of f.files) {
      fs.mkdirSync(path.dirname(path.join(to, file.path)), { recursive: true });
      fs.copyFileSync(path.join(from, file.path), path.join(to, file.path));
    }
    this.state.sources[`${place.id}/${folder}`] = { ...source, hash: skillFiles(to).hash, installedAt: this.now() };
  }

  /** Copy the named skills of a repository to a place. One already there is left unless `replace`. */
  async install({ repo, names = [], place = 'personal', replace = false, by = null } = {}) {
    const p = this.place(place);
    if (!Array.isArray(names) || !names.length) throw err(400, 'Pick at least one skill');
    const url = repoUrl(repo);
    if (url) this.guardSource(url);
    this.guard('install', p, { repo: url, names });
    const r = await this.fetch(repo);
    try {
      const picked = [];
      const skipped = [];
      for (const n of names) {
        const s = r.skills.find((x) => x.folder === n || x.name === n);
        if (!s) throw err(404, `${n} is not in ${r.url}`);
        if (!replace && fs.existsSync(path.join(p.dir, s.folder))) skipped.push(s.folder);
        else picked.push(s);
      }
      const added = picked.map((s) => s.folder);
      let w = { via: 'direct', pr: null };
      if (picked.length)
        w = await this.write(p, { branch: `install-${added.length === 1 ? added[0] : 'skills'}`, title: `Skills: install ${added.join(', ')}`, body: `From ${r.url}${r.commit ? ` at ${r.commit}` : ''}.`, ids: added.map((f) => `${p.id}/${f}`) }, (target) => {
          for (const s of picked) this.copy(s.dir, target, s.folder, { repo: r.url, path: s.path, commit: r.commit });
          return {};
        });
      if (added.length) this.audit('installed', { ids: added.map((f) => `${p.id}/${f}`), place: p.id, repo: r.url, commit: r.commit, via: w.via, pr: w.pr ?? null }, by);
      this.store.save();
      return { added, skipped, place: p.id, via: w.via, pr: w.pr ?? null, ...this.list() };
    } finally {
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  }

  /** Whether the place a skill came from has a newer version: { id, current, latest, changed, edited }. */
  async check(id) {
    const { skill, id: sid } = this.find(id);
    const src = this.state.sources[sid];
    if (!src) throw err(409, 'This skill was not added from a repository here, so there is nothing to compare it with');
    const r = await this.fetch(src.repo);
    const theirs = r.skills.find((x) => x.path === src.path) ?? r.skills.find((x) => x.folder === skill.folder);
    fs.rmSync(r.dir, { recursive: true, force: true });
    this.state.upstream[sid] = { at: this.now(), latest: r.commit, changed: Boolean(theirs && theirs.hash !== src.hash), gone: !theirs, hash: src.hash };
    this.store.save();
    if (!theirs) return { id: sid, gone: true, current: src.commit, latest: r.commit, changed: false, edited: src.hash !== skill.hash };
    return { id: sid, current: src.commit, latest: r.commit, changed: theirs.hash !== src.hash, edited: src.hash !== skill.hash };
  }

  /** Replace a skill with its repository's current version (your edits to it go). */
  async update(id, { by = null } = {}) {
    const { place, skill, id: sid } = this.find(id);
    const src = this.state.sources[sid];
    if (!src) throw err(409, 'This skill was not added from a repository here');
    this.guardSource(src.repo);
    this.guard('update', place, { id: sid, repo: src.repo });
    const r = await this.fetch(src.repo);
    try {
      const theirs = r.skills.find((x) => x.path === src.path) ?? r.skills.find((x) => x.folder === skill.folder);
      if (!theirs) throw err(404, `${skill.folder} is no longer in ${src.repo}`);
      const w = await this.write(place, { branch: `update-${skill.folder}`, title: `Skill ${skill.folder}: update from its repository`, body: `From ${src.repo}, ${src.commit ?? '?'} → ${r.commit ?? '?'}.`, ids: [sid] }, (target) => {
        this.copy(theirs.dir, target, skill.folder, { repo: src.repo, path: theirs.path, commit: r.commit });
        return {};
      });
      this.audit('updated', { id: sid, place: place.id, repo: src.repo, from: src.commit ?? null, to: r.commit, via: w.via, pr: w.pr ?? null }, by);
      this.store.save();
      return { ...this.list(), via: w.via, pr: w.pr ?? null };
    } finally {
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  }

  /** Delete a skill's folder (in a project whose policy asks for pull requests, one that deletes it). */
  async remove(id, { by = null } = {}) {
    const { skill, place, id: sid } = this.find(id);
    // Only ever a folder directly inside a skills folder.
    if (path.dirname(fs.realpathSync(skill.dir)) !== fs.realpathSync(place.dir)) throw err(400, 'Not a skill folder');
    this.guard('remove', place, { id: sid });
    const w = await this.write(place, { branch: `remove-${skill.folder}`, title: `Skill ${skill.folder}: remove`, body: `Removes the ${skill.folder} skill.`, ids: [sid] }, (target) => {
      fs.rmSync(path.join(target.dir, skill.folder), { recursive: true, force: true });
      return {};
    });
    if (w.via === 'direct') for (const k of ['sources', 'proposed', 'upstream', 'dismissed', 'pending']) delete this.state[k][sid];
    this.audit('removed', { id: sid, place: place.id, via: w.via, pr: w.pr ?? null }, by);
    this.store.save();
    return { ...this.list(), via: w.via, pr: w.pr ?? null };
  }
}
