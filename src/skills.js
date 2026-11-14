// Skills: the Agent Skills Claude Code has on this computer (yours in ~/.claude/skills, and each
// project's in <project>/.claude/skills), and adding more from a git repository. A skill is a
// folder with a SKILL.md (a name, a description of when to use it, the instructions) and whatever
// scripts and files it needs. Adding one is a look first (what the repository offers, each skill's
// files, which of them are scripts) and then a copy; where it came from and the commit are kept, so
// it can be checked for a newer version and updated, and a skill edited here since says so.
// Which agents used which skill is read from their sessions. No model is called.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from './config.js';

const err = (status, message) => Object.assign(new Error(message), { status });
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target']);
const SCRIPT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd)$/i;
const MAX_FILES = 400;
const MAX_BYTES = 20 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

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

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...opts, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, errOut) => (e ? reject(new Error(String(errOut || e.message).trim().split('\n').pop())) : resolve(String(out)))),
  );

export class Skills {
  /**
   * `projects()`: [{ key, name, dir }] the projects with a folder here; `sessions()`: [{ id, name,
   * file }] each agent's session transcript; `clone(url, dir)`: fetches a repository (tests pass their own).
   */
  constructor({ store, projects = () => [], sessions = () => [], clone = null, cache = path.join(paths.home, 'skills-cache'), personal = personalSkillsDir, now = () => new Date().toISOString() }) {
    Object.assign(this, { store, projects, sessions, cache, personal, now });
    this.clone = clone ?? ((url, dir) => run('git', ['clone', '--depth', '1', '--quiet', url, dir]));
    this.usesCache = new Map(); // transcript -> { key, uses }
  }

  get state() {
    const s = (this.store.data.skills ??= {});
    s.sources ??= {};
    return s;
  }

  /** The places skills live: yours, and each project's. */
  places() {
    return [{ id: 'personal', label: 'Yours (every project)', dir: this.personal() }, ...this.projects().filter((p) => p.dir && fs.existsSync(p.dir)).map((p) => ({ id: `project:${p.key}`, label: p.name ?? p.key, dir: projectSkillsDir(p.dir), project: p.key }))];
  }

  place(id) {
    const p = this.places().find((x) => x.id === id);
    if (!p) throw err(404, 'No such place for skills');
    return p;
  }

  /** Which agents used which skill: { name: [{ id, name, times }] }. */
  usedBy() {
    const out = {};
    for (const s of this.sessions()) {
      let st;
      try {
        st = fs.statSync(s.file);
      } catch {
        continue;
      }
      const key = `${st.mtimeMs}:${st.size}`;
      let c = this.usesCache.get(s.file);
      if (c?.key !== key) {
        // A long session is read from its end: enough to know it used a skill lately.
        let text = '';
        try {
          const max = 24 * 1024 * 1024;
          if (st.size <= max) text = fs.readFileSync(s.file, 'utf8');
          else {
            const fd = fs.openSync(s.file, 'r');
            const buf = Buffer.alloc(max);
            fs.readSync(fd, buf, 0, max, st.size - max);
            fs.closeSync(fd);
            text = buf.toString('utf8');
          }
        } catch {}
        c = { key, uses: skillUses(text) };
        this.usesCache.set(s.file, c);
      }
      for (const [name, times] of Object.entries(c.uses)) (out[name] ??= []).push({ id: s.id, name: s.name, times });
    }
    return out;
  }

  list() {
    const used = this.usedBy();
    const places = this.places().map((p) => ({
      id: p.id,
      label: p.label,
      dir: p.dir,
      skills: skillsIn(p.dir).map((s) => {
        const id = `${p.id}/${s.folder}`;
        const src = this.state.sources[id] ?? null;
        return { ...s, id, place: p.id, source: src ? { repo: src.repo, path: src.path, commit: src.commit, installedAt: src.installedAt } : null, edited: Boolean(src && src.hash !== s.hash), usedBy: used[s.name] ?? used[s.folder] ?? [] };
      }),
    }));
    return { places, count: places.reduce((n, p) => n + p.skills.length, 0) };
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
  async install({ repo, names = [], place = 'personal', replace = false } = {}) {
    const p = this.place(place);
    if (!Array.isArray(names) || !names.length) throw err(400, 'Pick at least one skill');
    const r = await this.fetch(repo);
    const added = [];
    const skipped = [];
    for (const n of names) {
      const s = r.skills.find((x) => x.folder === n || x.name === n);
      if (!s) throw err(404, `${n} is not in ${r.url}`);
      if (!replace && fs.existsSync(path.join(p.dir, s.folder))) {
        skipped.push(s.folder);
        continue;
      }
      this.copy(s.dir, p, s.folder, { repo: r.url, path: s.path, commit: r.commit });
      added.push(s.folder);
    }
    this.store.save();
    fs.rmSync(r.dir, { recursive: true, force: true });
    return { added, skipped, place: p.id, ...this.list() };
  }

  /** Whether the place a skill came from has a newer version: { id, current, latest, changed, edited }. */
  async check(id) {
    const { skill, id: sid } = this.find(id);
    const src = this.state.sources[sid];
    if (!src) throw err(409, 'This skill was not added from a repository here, so there is nothing to compare it with');
    const r = await this.fetch(src.repo);
    const theirs = r.skills.find((x) => x.path === src.path) ?? r.skills.find((x) => x.folder === skill.folder);
    fs.rmSync(r.dir, { recursive: true, force: true });
    if (!theirs) return { id: sid, gone: true, current: src.commit, latest: r.commit, changed: false, edited: src.hash !== skill.hash };
    return { id: sid, current: src.commit, latest: r.commit, changed: theirs.hash !== src.hash, edited: src.hash !== skill.hash };
  }

  /** Replace a skill with its repository's current version (your edits to it go). */
  async update(id) {
    const { place, skill, id: sid } = this.find(id);
    const src = this.state.sources[sid];
    if (!src) throw err(409, 'This skill was not added from a repository here');
    const r = await this.fetch(src.repo);
    const theirs = r.skills.find((x) => x.path === src.path) ?? r.skills.find((x) => x.folder === skill.folder);
    if (!theirs) throw err(404, `${skill.folder} is no longer in ${src.repo}`);
    this.copy(theirs.dir, place, skill.folder, { repo: src.repo, path: theirs.path, commit: r.commit });
    this.store.save();
    fs.rmSync(r.dir, { recursive: true, force: true });
    return this.list();
  }

  /** Delete a skill's folder. */
  remove(id) {
    const { skill, place, id: sid } = this.find(id);
    // Only ever a folder directly inside a skills folder.
    if (path.dirname(fs.realpathSync(skill.dir)) !== fs.realpathSync(place.dir)) throw err(400, 'Not a skill folder');
    fs.rmSync(skill.dir, { recursive: true, force: true });
    delete this.state.sources[sid];
    this.store.save();
    return this.list();
  }
}
