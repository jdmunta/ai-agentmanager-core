// One headless turn of an engine's CLI: a prompt in, the answer (and session, cost) out. The agent
// keeps one engine session per conversation, so a follow-up continues it. Tools come from the
// agent's MCP servers; the allow list says what runs without asking, and "approve" tools are kept
// out of reach (a person's approval for them comes in a later phase).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ACP_CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'acp-client.js');
// Overrides for tests and odd installs: AGENTKIT_CLAUDE_BIN, AGENTKIT_CODEX_BIN, AGENTKIT_MUSE_BIN
// (a command, optionally with arguments: "node /path/fake.js").
const binOf = (name, env) => (env[`AGENTKIT_${name.toUpperCase()}_BIN`] ?? name).split(' ');

function run(cmd, args, { input, cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => (clearTimeout(timer), reject(Object.assign(e, { message: `Could not start ${cmd}: ${e.message}` }))));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} exited with ${code}: ${(err || out).trim().slice(-400)}`));
    });
    child.stdin.end(input ?? '');
  });
}

/** The MCP config file the engine loads (Claude's format: { mcpServers: {...} }). */
export function writeMcpConfig(agent, file) {
  if (!Object.keys(agent.tools).length) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: agent.tools }, null, 2), { mode: 0o600 });
  return file;
}

/**
 * One turn. `session`: the engine session to continue (null starts one); returns
 * { text, session, costUsd }. `system` goes in as an extra system prompt where the engine has one,
 * else ahead of the prompt.
 */
export async function turn(agent, { prompt, system = '', session = null, mcpFile = null, env = process.env, timeoutMs = 15 * 60_000 }) {
  fs.mkdirSync(agent.workdir, { recursive: true });
  const cwd = agent.workdir;
  if (agent.engine === 'claude') {
    const [cmd, ...pre] = binOf('claude', env);
    const sid = session ?? crypto.randomUUID();
    const args = [...pre, '-p', '--output-format', 'json', session ? '--resume' : '--session-id', sid];
    if (agent.model) args.push('--model', agent.model);
    if (system) args.push('--append-system-prompt', system);
    // Self-contained: the agent's own MCP servers only (none when it has none), and none of the
    // person's own Claude settings (their MCP servers, hooks, permissions) leak in.
    args.push('--setting-sources', 'project', '--strict-mcp-config');
    if (mcpFile) args.push('--mcp-config', mcpFile);
    if (agent.allow.length) args.push('--allowedTools', ...agent.allow);
    if (agent.approve.length) args.push('--disallowedTools', ...agent.approve);
    const out = await run(cmd, args, { input: prompt, cwd, env, timeoutMs });
    try {
      const j = JSON.parse(out);
      if (j.is_error) throw new Error(String(j.result ?? 'the engine reported an error'));
      return { text: String(j.result ?? ''), session: j.session_id ?? sid, costUsd: j.total_cost_usd ?? null };
    } catch (e) {
      if (e instanceof SyntaxError) return { text: out.trim(), session: sid, costUsd: null };
      throw e;
    }
  }
  if (agent.engine === 'codex') {
    const [cmd, ...pre] = binOf('codex', env);
    const base = ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...(agent.model ? ['--model', agent.model] : [])];
    const args = [...pre, ...(session ? [...base, 'resume', session] : base), '-'];
    const out = await run(cmd, args, { input: system ? `${system}\n\n---\n\n${prompt}` : prompt, cwd, env, timeoutMs });
    // Codex prints its session id in a header line ("session id: …").
    const sid = session ?? /session id:\s*([0-9a-f-]{36})/i.exec(out)?.[1] ?? null;
    return { text: out.trim().split(/\n-{3,}\n|\ntokens used/i)[0].trim(), session: sid, costUsd: null };
  }
  if (agent.engine === 'muse') {
    const [cmd, ...pre] = binOf('muse', env);
    const args = [...pre, 'exec', ...(session ? ['--session-id', session] : []), ...(agent.model ? ['--model', agent.model] : []), '--', system ? `${system}\n\n---\n\n${prompt}` : prompt];
    return { text: (await run(cmd, args, { cwd, env, timeoutMs })).trim(), session, costUsd: null };
  }
  // acp:<name>: our ACP client in one-shot mode, with the agent's command from AGENTKIT_ACP_<NAME>.
  const name = agent.engine.slice(4);
  const command = (env[`AGENTKIT_ACP_${name.toUpperCase().replace(/-/g, '_')}`] ?? name).split(' ');
  const out = await run(process.execPath, [ACP_CLIENT, '--once', '--', ...command], { input: system ? `${system}\n\n---\n\n${prompt}` : prompt, cwd, env, timeoutMs });
  return { text: out.trim(), session: null, costUsd: null };
}
