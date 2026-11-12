// MCP servers and their tools as Claude Code sees them in a folder: user, project and local
// servers, claude.ai connectors and plugins' servers. Listed through Claude Code's own control
// protocol (no model call), and run in an agent's session, or once in its workspace with only
// that one tool allowed.
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DEFAULT_ENGINE, ENGINES } from './engines/index.js';

export const LIST_TTL_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 5 * 60_000;

/** Claude Code's name for a tool: mcp__<server>__<tool>, other characters in the server name as "_". */
export const toolId = (server, tool) => `mcp__${String(server).replace(/[^\w-]/g, '_')}__${tool}`;

const SECRET = /key|token|secret|passw|auth|bearer|cookie|credential/i;

/** Where a server runs, without secrets: the command line (values of secret-looking flags hidden), or the URL without its query. */
export function targetOf(config = {}) {
  if (config.url) {
    try {
      const u = new URL(config.url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return '';
    }
  }
  if (!config.command) return '';
  const args = (config.args ?? []).map(String);
  const shown = args.map((a, i) => {
    const flag = a.match(/^(--?[\w-]+)=/)?.[1];
    if (flag) return SECRET.test(flag) ? `${flag}=•••` : a;
    if (/^-/.test(args[i - 1] ?? '') && SECRET.test(args[i - 1])) return '•••';
    return /^[\w-]{32,}$/.test(a) ? '•••' : a;
  });
  return [config.command, ...shown].join(' ');
}

/** One server for the UI: no env, headers or other config values. */
export function serverView(s) {
  return {
    name: String(s.name),
    status: s.status ?? 'unknown',
    scope: s.scope ?? null,
    source: s.source ?? null,
    transport: s.transport ?? s.config?.type ?? null,
    target: targetOf(s.config),
    version: s.serverInfo?.version ?? null,
    error: s.error ? String(s.error).slice(0, 300) : null,
    tools: (s.tools ?? []).map((t) => ({
      name: String(t.name),
      id: toolId(s.name, t.name),
      title: t.annotations?.title ?? null,
      readOnly: t.annotations?.readOnlyHint === true,
      destructive: t.annotations?.destructiveHint === true,
    })),
  };
}

/**
 * Ask Claude Code in `cwd` for its MCP servers: start it in stream-json mode, initialize, and ask
 * for their status until none is still connecting. No message is sent, so no model call is made.
 */
export function mcpStatus({ bin, args = [], cwd, env, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let err = '';
    let last = null;
    let n = 0;
    let done = false;
    let poll = null;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(poll);
      child.kill();
      fn(value);
    };
    const send = (request) => child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `r${++n}`, request })}\n`);
    const timer = setTimeout(() => (last ? finish(resolve, last) : finish(reject, new Error('Claude Code did not list its MCP servers in time'))), timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type !== 'control_response') continue;
        const r = m.response ?? {};
        if (r.subtype === 'error') return finish(reject, new Error(`Claude Code: ${r.error ?? 'error'}`));
        if (r.request_id === 'r1') {
          send({ subtype: 'mcp_status' });
          continue;
        }
        const servers = r.response?.mcpServers;
        if (!Array.isArray(servers)) continue;
        last = servers;
        if (servers.some((s) => s.status === 'pending')) poll = setTimeout(() => send({ subtype: 'mcp_status' }), 1000);
        else finish(resolve, servers);
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.stdin.on('error', () => {});
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => (last ? finish(resolve, last) : finish(reject, new Error(`Claude Code stopped before listing its MCP servers (exit ${code}): ${err.trim().slice(-300)}`))));
    send({ subtype: 'initialize' });
  });
}

/** The one-off call in a workspace: use the tool for the request, and report what it returned. */
export function runPrompt(id, input) {
  return [
    `Use the MCP tool ${id} for the request below, calling it as few times as needed (once if you can).`,
    "Work out its arguments from the request and the tool's description.",
    '',
    `Request: ${input?.trim() || '(none: call it with no arguments, or the simplest valid ones)'}`,
    '',
    'Then reply with what the tool returned, as it is (for long output, the part that answers the request),',
    'and one last line with the arguments you used. If the tool fails or is not available, say so and why.',
  ].join('\n');
}

/** What an agent is told to run a tool in its session. */
export const sessionMessage = (id, input) => `Use the MCP tool ${id}${input?.trim() ? ` for this: ${input.trim()}` : ''}. Show me what it returned.`;

export class Mcp {
  constructor({ manager, homeDir = os.homedir() }) {
    this.manager = manager;
    this.homeDir = homeDir;
    this.cache = new Map(); // folder -> { at, servers } | { pending }
  }

  /** Where the tools run: an agent's folder, or the home folder (user servers and connectors). */
  where(ref) {
    if (!ref || ref === 'home') return { agent: null, dir: this.homeDir };
    const agent = this.manager.mustGet(ref);
    return { agent, dir: agent.workdir ?? agent.planning?.dir ?? this.homeDir };
  }

  async list(ref, { refresh = false } = {}) {
    const { agent, dir } = this.where(ref);
    let hit = this.cache.get(dir);
    if (refresh || !hit || (hit.at && Date.now() - hit.at > LIST_TTL_MS) || hit.error) {
      if (!hit?.pending) {
        const engine = ENGINES[DEFAULT_ENGINE];
        const pending = mcpStatus({ bin: engine.bin(this.manager.config), args: engine.extraArgs(this.manager.config), cwd: dir, env: this.manager.childEnv(agent) })
          .then((servers) => ({ at: Date.now(), servers: servers.map(serverView).sort((a, b) => a.name.localeCompare(b.name)) }))
          .catch((e) => ({ at: Date.now(), servers: [], error: e.message }));
        hit = { pending };
        this.cache.set(dir, hit);
        pending.then((r) => this.cache.set(dir, r));
      }
      hit = await this.cache.get(dir).pending;
    }
    return {
      agent: agent ? { id: agent.id, name: agent.name, engine: agent.engine ?? DEFAULT_ENGINE, running: Boolean(this.manager.runtimes.get(agent.id)?.pty) } : null,
      dir,
      at: new Date(hit.at).toISOString(),
      servers: hit.servers,
      error: hit.error ?? null,
    };
  }

  /** The tool, checked against the last list for that folder. */
  tool(dir, server, tool) {
    const s = this.cache.get(dir)?.servers?.find((x) => x.name === server);
    const t = s?.tools.find((x) => x.name === tool);
    if (!t) throw Object.assign(new Error(`No tool "${tool}" on the MCP server "${server}" here; refresh the list`), { status: 404 });
    if (s.status !== 'connected') throw Object.assign(new Error(`The MCP server "${server}" is ${s.status}`), { status: 409 });
    return t;
  }

  /** Run a tool: "session" tells the agent to use it; "workspace" runs it once, apart from the session. */
  async run(ref, { server, tool, input = '', where = 'workspace' } = {}) {
    const { agent, dir } = this.where(ref);
    if (!this.cache.get(dir)?.servers) await this.list(ref);
    const t = this.tool(dir, String(server ?? ''), String(tool ?? ''));
    input = String(input ?? '').slice(0, 8000);
    if (where === 'session') {
      if (!agent) throw Object.assign(new Error('Pick an agent to run it in its session'), { status: 400 });
      if ((agent.engine ?? DEFAULT_ENGINE) !== DEFAULT_ENGINE) throw Object.assign(new Error('Running MCP tools in the session works for Claude Code agents'), { status: 409 });
      return { where, tool: t.id, agent: this.manager.tell(agent.id, sessionMessage(t.id, input), { source: 'mcp' }) };
    }
    if (where !== 'workspace') throw Object.assign(new Error('where must be "session" or "workspace"'), { status: 400 });
    const scope = { agent: agent ? this.manager.auditView(agent) : null, dir, tool: t.id, input };
    this.manager.plugins.check('mcp.run', scope);
    this.manager.plugins.emit('mcp.run', scope);
    const engine = ENGINES[DEFAULT_ENGINE];
    const t0 = Date.now();
    const text = await this.manager.oneShot(agent, runPrompt(t.id, input), {
      engine,
      model: this.manager.config.explainModel,
      tools: [t.id],
      cwd: dir,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    return { where, tool: t.id, text, ms: Date.now() - t0, at: new Date().toISOString() };
  }
}
