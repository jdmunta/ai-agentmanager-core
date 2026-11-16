#!/usr/bin/env node
// Starts a harness (the Codex CLI, Claude Code or OpenCode) on a model served on this computer
// (engines/local.js):
//   local-run.js --harness <codex|claude|opencode> --url <server> --model <name> --context <tokens> -- <command> [arguments]
// It checks that the server answers and has the model, and tells the harness to talk to it. Ollama
// starts a model with little context whatever the model can take, so for Ollama it first makes a
// copy of the model with room for an agent (a few lines in Ollama's list; the weights are shared).
import { spawn } from 'node:child_process';
import { variantName } from '../src/localmodels.js';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const opt = {};
for (let i = 0; i < split; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1];
const [bin, ...rest] = argv.slice(split + 1);
const url = String(opt.url ?? '').replace(/\/+$/, '');
const context = Number(opt.context) || 0;

const say = (m) => process.stderr.write(`\x1b[2m[agentmgr] ${m}\x1b[0m\r\n`);
const stop = (m) => {
  process.stderr.write(`[agentmgr] ${m}\r\n`);
  process.exit(1);
};
async function call(path, body, timeoutMs = 5000) {
  try {
    const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(timeoutMs), ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { ok: res.ok, json, text };
  } catch (err) {
    return { ok: false, json: null, text: err.message };
  }
}

if (split < 0 || !bin || !url || !opt.model) stop('local-run: --url, --model and a command after "--" are needed');

let model = opt.model;
let window = null;
const tags = await call('/api/tags');
if (Array.isArray(tags.json?.models)) {
  // Ollama.
  const mine = tags.json.models.find((m) => m.name === model || m.name === `${model}:latest`);
  if (!mine) stop(`Ollama has no model "${model}". Get it with: ollama pull ${model}`);
  if (context > 0) {
    const most = Number(mine.details?.context_length) || context;
    window = Math.min(context, most);
    const copy = variantName(model, window);
    if (!tags.json.models.some((m) => m.name === copy)) {
      say(`Giving ${model} room for ${window} tokens (as ${copy})…`);
      const made = await call('/api/create', { model: copy, from: mine.name, parameters: { num_ctx: window }, stream: false }, 60_000);
      if (!made.ok || made.json?.error) stop(`Ollama couldn't make ${copy}: ${made.json?.error ?? made.text}`);
    }
    model = copy;
  }
} else {
  const list = await call('/v1/models');
  if (!Array.isArray(list.json?.data)) stop(`No model server answers at ${url}. Start it, then start this agent again.`);
  // llama.cpp says how much context it was started with.
  window = Number((await call('/props')).json?.default_generation_settings?.n_ctx) || null;
}

const env = { ...process.env };
let args = rest;
if (opt.harness === 'claude') {
  // Claude Code, talking to the server's Anthropic-style API; every role it has a model for gets this one
  // (named in its environment: its command may be more than one word, so no argument is added here).
  Object.assign(env, { ANTHROPIC_BASE_URL: url, ANTHROPIC_MODEL: model, ANTHROPIC_AUTH_TOKEN: 'local', ANTHROPIC_API_KEY: '', ANTHROPIC_SMALL_FAST_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  // It takes the context for a Claude model's 200,000 tokens: summarize before this one's is full.
  if (window) env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(Math.max(1, Math.min(90, Math.floor((window * 0.75 * 100) / 200_000))));
} else if (opt.harness === 'opencode') {
  // OpenCode, given the server as a provider of its own for this run.
  const limit = window ? { limit: { context: window, output: Math.min(8192, Math.floor(window / 4)) } } : {};
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { agentmgr: { npm: '@ai-sdk/openai-compatible', name: 'Local', options: { baseURL: `${url}/v1` }, models: { [model]: { name: opt.model, ...limit } } } }, model: `agentmgr/${model}`, small_model: `agentmgr/${model}` });
} else {
  // Codex, with the server as its model provider. It takes options after `resume`.
  // Open models tend to give every command a `justification`, Codex answers that one needs
  // `sandbox_permissions`, and the model then asks to leave the sandbox for `ls` and `cat`: a
  // prompt for you at every step. Told this, they mostly stop.
  const quiet = 'Shell commands already run in a sandbox that can read every file and write in the project, so they need no approval. When you call exec_command, give `cmd` and leave out `justification` and `sandbox_permissions`. Only if a command has failed because the sandbox blocked it (network access, or writing outside the project), repeat it with `sandbox_permissions` set to "require_escalated" and a `justification`.';
  const flags = ['-c', `model_providers.agentmgr={name="Local",base_url="${url}/v1"}`, '-c', 'model_provider="agentmgr"', ...(window ? ['-c', `model_context_window=${window}`] : []), '-c', `developer_instructions=${JSON.stringify(quiet)}`, '--model', model];
  args = rest[0] === 'resume' ? ['resume', ...flags, ...rest.slice(1)] : [...flags, ...rest];
}
const child = spawn(bin, args, { stdio: 'inherit', env });
for (const sig of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('error', (err) => stop(`Couldn't start ${bin}: ${err.message}`));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
