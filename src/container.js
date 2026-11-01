// Isolation: an agent that runs in its own Docker container instead of directly on this computer.
// It sees only its own folder (mounted at the same path, so paths, transcripts and git all line up),
// its repository's git data, its brief folder and its uploads; nothing else of yours. Claude Code
// and Codex keep their sessions in your usual folders (mounted in), so tracking, resume and usage
// work as they do on the host. Each engine gets its own config home for containers, with sign-in
// from a token (Claude: `claude setup-token`) or Codex's auth.json, read-only.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './config.js';
import { trustFolder } from './trust.js';

export const DEFAULT_IMAGE = 'ai-agentmanager-agent:1';
export const CONTAINER_ENGINES = new Set(['claude', 'codex']);
const DOCKERFILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docker', 'agent.Dockerfile');
const homes = () => path.join(paths.home, 'containers');
const secretsFile = () => path.join(paths.home, 'secrets.json');

export const containerName = (agentId, kind = 'agent') => `agentmgr-${agentId}${kind === 'agent' ? '' : `-${kind}`}`;
export const isolationSettings = (config = {}) => ({ image: DEFAULT_IMAGE, cpus: null, memory: null, network: null, ...(config.isolation ?? {}) });

// ------------------------------------------------------------ secrets (the Claude token)

export function loadSecrets() {
  try {
    return JSON.parse(fs.readFileSync(secretsFile(), 'utf8'));
  } catch {
    return {};
  }
}

export function saveSecrets(patch) {
  const next = { ...loadSecrets(), ...patch };
  for (const [k, v] of Object.entries(next)) if (v == null || v === '') delete next[k];
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(secretsFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

/** The Claude Code token for containers: saved (Settings, `agentmgr sandbox token`), else CLAUDE_CODE_OAUTH_TOKEN. */
export const claudeToken = (env = process.env) => loadSecrets().claudeOauthToken || env.CLAUDE_CODE_OAUTH_TOKEN || '';

// ------------------------------------------------------------ docker

const docker = (args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile('docker', args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(String(stdout).trim()))),
  );

/** Whether Docker runs here, and whether the agent image is built. */
export async function dockerStatus(config = {}) {
  const { image } = isolationSettings(config);
  try {
    const version = await docker(['version', '--format', '{{.Server.Version}}']);
    const has = await docker(['image', 'inspect', image, '--format', '{{.Id}}']).then(() => true, () => false);
    return { available: true, version, image, imageBuilt: has };
  } catch (err) {
    return { available: false, version: null, image, imageBuilt: false, error: String(err.stderr || err.message).trim().split('\n')[0].slice(0, 200) };
  }
}

let building = null;
/** Build the agent image from docker/agent.Dockerfile (a few minutes the first time). */
export function buildImage(config = {}, { log = () => {} } = {}) {
  if (building) return building;
  const { image } = isolationSettings(config);
  building = new Promise((resolve, reject) => {
    const child = execFile('docker', ['build', '-t', image, '-f', DOCKERFILE, path.dirname(DOCKERFILE)], { timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      building = null;
      if (err) reject(new Error(`docker build failed: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
      else resolve({ image });
    });
    child.stderr?.on('data', (d) => log(String(d)));
  });
  return building;
}
export const isBuilding = () => Boolean(building);

/** Remove a leftover container of this name (a restart reuses the name). */
export function removeContainer(name) {
  try {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 15_000 });
  } catch {}
}

/** Stop a running container, giving the agent time to save (it is removed when it stops). */
export function stopContainer(name, seconds = 10) {
  execFile('docker', ['stop', '-t', String(seconds), name], { timeout: (seconds + 20) * 1000 }, () => {});
}

export function containerRunning(name) {
  try {
    return execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', name], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'true';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ what a container sees

/** A worktree's shared git folder (its .git file points into the main repository's), or null. */
export function gitCommonDir(cwd) {
  const dotgit = path.join(cwd, '.git');
  try {
    if (fs.statSync(dotgit).isDirectory()) return null; // a plain clone: its .git is inside the folder
    const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'))?.[1]?.trim();
    if (!gitdir) return null;
    const abs = path.resolve(cwd, gitdir);
    const common = fs.existsSync(path.join(abs, 'commondir')) ? path.resolve(abs, fs.readFileSync(path.join(abs, 'commondir'), 'utf8').trim()) : abs;
    return fs.realpathSync(common);
  } catch {
    return null;
  }
}

/**
 * The engine's config home for containers (seeded once), with this folder trusted. Claude: a
 * .claude.json with onboarding done; Codex: config.toml. Returns the host folder.
 */
export function engineHome(engineId, cwd) {
  const dir = path.join(homes(), engineId);
  fs.mkdirSync(dir, { recursive: true });
  if (engineId === 'claude') {
    const file = path.join(dir, '.claude.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: {} }, null, 2), { mode: 0o600 });
    trustFolder(cwd, file);
  } else if (engineId === 'codex') {
    const file = path.join(dir, 'config.toml');
    const key = cwd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!raw.includes(`[projects."${key}"]`)) fs.appendFileSync(file, `${raw && !raw.endsWith('\n') ? '\n' : ''}[projects."${key}"]\ntrust_level = "trusted"\n`);
  }
  return dir;
}

/**
 * `docker run` arguments for an agent: the container, its mounts and limits, then the engine's
 * own command (`bin` + `args`). Secrets are passed by name (`-e NAME`, the value from the docker
 * command's environment), never in the arguments.
 */
export function runArgs({ agentId, engineId, cwd, bin, args, config = {}, mounts = [], env = [], user = process.getuid?.() != null ? `${process.getuid()}:${process.getgid()}` : null, name = containerName(agentId) }) {
  const s = isolationSettings(config);
  const out = ['run', '--rm', '-i', '-t', '--init', '--name', name, '--label', `agentmgr.agent=${agentId}`, '-w', cwd];
  if (user) out.push('--user', user);
  if (s.cpus) out.push('--cpus', String(s.cpus));
  if (s.memory) out.push('--memory', String(s.memory));
  if (s.network) out.push('--network', String(s.network));
  const seen = new Set();
  for (const m of [{ host: cwd }, ...mounts]) {
    const inside = m.inside ?? m.host;
    if (!m.host || seen.has(inside)) continue;
    seen.add(inside);
    out.push('-v', `${m.host}:${inside}${m.readOnly ? ':ro' : ''}`);
  }
  for (const e of env) out.push('-e', e);
  out.push(s.image, ...[bin].flat(), ...args);
  return out;
}

/**
 * Everything an engine needs mounted and set in its container: its config home, your session
 * folders (so the manager reads them where it always does) and its sign-in.
 */
export function engineMounts(engineId, cwd, env = process.env) {
  const home = engineHome(engineId, cwd);
  if (engineId === 'claude') {
    const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
    fs.mkdirSync(projects, { recursive: true });
    return {
      mounts: [{ host: home, inside: '/agentmgr/claude' }, { host: projects, inside: '/agentmgr/claude/projects' }],
      env: ['CLAUDE_CONFIG_DIR=/agentmgr/claude', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
      bin: 'claude',
    };
  }
  if (engineId === 'codex') {
    const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const sessions = path.join(codexHome, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const auth = path.join(codexHome, 'auth.json');
    return {
      mounts: [{ host: home, inside: '/agentmgr/codex' }, { host: sessions, inside: '/agentmgr/codex/sessions' }, ...(fs.existsSync(auth) ? [{ host: auth, inside: '/agentmgr/codex/auth.json', readOnly: true }] : [])],
      env: ['CODEX_HOME=/agentmgr/codex', 'OPENAI_API_KEY'],
      bin: 'codex',
    };
  }
  throw Object.assign(new Error(`${engineId} can't run in a container yet (Claude Code and Codex can)`), { status: 400 });
}
