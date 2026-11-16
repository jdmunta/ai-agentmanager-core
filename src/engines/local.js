// Models that run on this computer (Ollama, LM Studio, llama.cpp, MLX: see localmodels.js) as
// agent engines, one for each harness that can drive them:
//   local-codex     the Codex CLI, pointed at the local server instead of OpenAI
//   local-opencode  OpenCode (over ACP), given the server as a provider
//   local-claude    Claude Code, pointed at the server's Anthropic-style API (Ollama has one;
//                   Anthropic doesn't support Claude Code on other models)
// Each is its harness's engine (sessions, resume, usage, the inbox) with these differences:
//   - The agent's model names the server: "ollama/qwen3-coder:30b".
//   - bin/local-run.js starts the harness: it checks the server answers, on Ollama gives the
//     model room for an agent's context first, and tells the harness where the model is.
//   - Codex runs from a home of its own (~/.agentmanager/codex-local): your plugins and MCP
//     servers would fill a local model's small context before the task starts. Its sessions are
//     kept where Codex keeps yours, and your AGENTS.md is used. Claude Code leaves MCP servers out.
//   - Summaries and reviews stay with an engine that is sure to manage them, and nothing is costed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../config.js';
import { lastSeen, localSettings, parseModel } from '../localmodels.js';
import { acpEngine } from './acp.js';
import claude from './claude.js';
import codex from './codex.js';

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'local-run.js');
const SETUP = '--agentmgr-local';
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const localHome = () => path.join(paths.home, 'codex-local');

/** The home Codex runs local models from: its sessions folder and AGENTS.md are your Codex's own. */
export function ensureLocalHome() {
  const home = localHome();
  fs.mkdirSync(home, { recursive: true });
  const link = (name, { dir = false } = {}) => {
    const target = path.join(codexHome(), name);
    const at = path.join(home, name);
    if (dir) fs.mkdirSync(target, { recursive: true });
    else if (!fs.existsSync(target)) return;
    try {
      if (fs.readlinkSync(at) === target) return;
      fs.unlinkSync(at);
    } catch (err) {
      if (err.code !== 'ENOENT') return; // something of its own is there: leave it
    }
    fs.symlinkSync(target, at, dir ? 'junction' : 'file');
  };
  link('sessions', { dir: true });
  link('AGENTS.md');
  return home;
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** What a launch needs from the config (the servers, the context, the harness's command), carried in the extra arguments. */
const setupArgs = (config, command) => {
  const s = localSettings(config);
  return [SETUP, JSON.stringify({ command, context: s.context, servers: Object.fromEntries(Object.entries(s.servers).map(([id, x]) => [id, x.url])) })];
};
/** The starter's own arguments for a launch, the harness's command, and the other extra arguments. */
function starter(harness, extra, model) {
  const at = extra.indexOf(SETUP);
  const setup = at < 0 ? null : JSON.parse(extra[at + 1]);
  const m = parseModel(model);
  if (!setup || !m || !setup.servers[m.server]) throw bad('A local agent needs a model, written "<server>/<model>" (see `agentmgr models`)');
  return { head: [RUNNER, '--harness', harness, '--url', setup.servers[m.server], '--model', m.name, '--context', String(setup.context), '--'], command: setup.command, rest: extra.filter((_, i) => i !== at && i !== at + 1) };
}

/** What every local engine shares. */
const shared = {
  local: true,
  bin: () => process.execPath,

  /** The model an agent is created with: given or the default, on a known server, able to call tools. */
  checkModel(model, config) {
    const s = localSettings(config);
    const id = String(model ?? '').trim() || s.default;
    if (!id) throw bad('Choose a model for a local agent, written "<server>/<model>": `agentmgr models` lists what runs here');
    const m = parseModel(id);
    if (!m) throw bad(`"${id}" isn't a local model: write "<server>/<model>", say "ollama/${id}"`);
    if (!s.servers[m.server]) throw bad(`No local server named "${m.server}" (known: ${Object.keys(s.servers).join(', ')})`);
    const known = lastSeen()?.find((x) => x.id === m.server)?.models.find((x) => x.id === id);
    if (known && !known.usable) throw bad(`${id}: ${known.notes[0]}`);
    return id;
  },

  /** Offered in pickers only while a server with a model an agent can use is running here. */
  available: (config) => localSettings(config).enabled && Boolean(lastSeen()?.some((x) => x.models.some((m) => m.usable))),
};

const localCodex = {
  ...codex,
  ...shared,
  id: 'local-codex',
  harness: 'codex',
  label: 'Local · Codex',
  supports: { ...codex.supports, oneShot: false },
  install: 'Install the Codex CLI, which runs the local model (npm install -g @openai/codex)',
  installedBin: (config) => codex.bin(config),
  extraArgs: (config) => setupArgs(config, [codex.bin(config), ...codex.extraArgs(config)]),
  launchArgs({ extra = [], model, ...opts }) {
    const s = starter('codex', extra, model);
    return [...s.head, s.command[0], ...codex.launchArgs({ ...opts, extra: [...s.command.slice(1), ...s.rest], model: null })];
  },
  env: () => ({ CODEX_HOME: ensureLocalHome() }),
  trust: (dir) => codex.trust(dir, ensureLocalHome()),
};

const localClaude = {
  ...claude,
  ...shared,
  id: 'local-claude',
  harness: 'claude',
  label: 'Local · Claude Code',
  // The cost Claude Code works out for a model it doesn't know means nothing.
  supports: { ...claude.supports, cost: false, oneShot: false, planHandoff: false },
  install: 'Install Claude Code, which runs the local model (https://docs.claude.com/en/docs/claude-code)',
  notice: () => "Anthropic doesn't support Claude Code on other models: expect rough edges. The server has to speak Anthropic's API (Ollama does)",
  installedBin: (config) => claude.bin(config),
  extraArgs: (config) => setupArgs(config, [claude.bin(config), ...claude.extraArgs(config)]),
  launchArgs({ extra = [], model, ...opts }) {
    const s = starter('claude', extra, model);
    // MCP servers' tool lists would take much of a local model's context.
    return [...s.head, s.command[0], ...claude.launchArgs({ ...opts, extra: [...s.command.slice(1), ...s.rest, '--strict-mcp-config'], model: null })];
  },
  scan(file, cursor, bugPatterns) {
    const r = claude.scan(file, cursor, bugPatterns);
    return r && 'cost' in r ? { ...r, cost: null } : r;
  },
};

const opencode = acpEngine('local-opencode', { command: ['opencode', 'acp'], label: 'Local · OpenCode' });
/** OpenCode's command: the one config.json gives its ACP engine, if any. */
const opencodeCommand = (config) => {
  const c = config.acp?.opencode;
  return c?.command ? [c.command, ...(c.args ?? [])].flat().map(String) : ['opencode', 'acp'];
};
const localOpencode = {
  ...opencode,
  ...shared,
  id: 'local-opencode',
  harness: 'opencode',
  // Not one of config's ACP agents: it stays when those are read again.
  acp: false,
  supports: { ...opencode.supports, oneShot: false },
  install: 'Install OpenCode, which runs the local model (npm install -g opencode-ai)',
  installedBin: (config) => opencodeCommand(config)[0],
  extraArgs: (config) => setupArgs(config, opencodeCommand(config)),
  launchArgs({ extra = [], model, ...opts }) {
    const s = starter('opencode', extra, model);
    const client = opencode.launchArgs(opts);
    // Our ACP client, then the agent's command in place of the one the engine was made with.
    return [...s.head, process.execPath, ...client.slice(0, client.lastIndexOf('--') + 1), ...s.command];
  },
};

export const LOCAL_ENGINES = [localCodex, localOpencode, localClaude];
