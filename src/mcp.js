// MCP servers and their tools as Claude Code sees them in a folder: user, project and local
// servers, claude.ai connectors and plugins' servers. Each folder gets its own MCP session: one
// Claude Code process, apart from any agent's, spoken to through Claude Code's control protocol.
// It lists the servers, signs in to one, reconnects one and calls a tool directly, all without a
// model call. A tool can also run in an agent's session, or once through Claude Code (which works
// out the arguments from plain words) with only that tool allowed.
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DEFAULT_ENGINE, ENGINES } from './engines/index.js';

/** An MCP session closes after this long unused (it starts again when next asked). */
export const IDLE_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 5 * 60_000;
const KEEP_RUNS = 30;
const err = (status, message) => Object.assign(new Error(message), { status });

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
  const transport = s.transport ?? s.config?.type ?? null;
  return {
    name: String(s.name),
    status: s.status ?? 'unknown',
    scope: s.scope ?? null,
    source: s.source ?? null,
    transport,
    target: targetOf(s.config),
    version: s.serverInfo?.version ?? null,
    error: s.error ? String(s.error).slice(0, 300) : null,
    // Signing in is OAuth, which only servers reached over HTTP have.
    canSignIn: ['http', 'sse', 'claudeai-proxy'].includes(transport) || Boolean(s.config?.url),
    tools: (s.tools ?? []).map((t) => ({
      name: String(t.name),
      id: toolId(s.name, t.name),
      title: t.annotations?.title ?? null,
      readOnly: t.annotations?.readOnlyHint === true,
      destructive: t.annotations?.destructiveHint === true,
    })),
  };
}

/** What a tool returned, as text: its text parts, other parts named, and whether it reported an error. */
export function resultText(result = {}) {
  const parts = (result.content ?? []).map((c) =>
    c.type === 'text' ? String(c.text ?? '') : c.type === 'resource' ? String(c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`) : `[${c.type ?? 'content'}${c.mimeType ? ` ${c.mimeType}` : ''}]`,
  );
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return { text: parts.join('\n').slice(0, 200_000) || '(no output)', isError: result.isError === true };
}

/**
 * The arguments typed for a direct call: empty or a JSON object means "call it with these"; anything
 * else is a request in plain words, for Claude Code to work the arguments out from.
 */
export function parseArgs(input) {
  const text = String(input ?? '').trim();
  if (!text) return {};
  if (!text.startsWith('{')) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * One folder's MCP session: a Claude Code process in stream-json mode that is only ever sent
 * control requests (never a message, so it makes no model call). It stays up between requests, so
 * servers stay connected and a sign-in's callback has somewhere to land.
 */
export class McpSession {
  constructor({ bin, args = [], cwd, env, onClose = () => {} }) {
    this.waiting = new Map(); // request id -> { resolve, reject, timer }
    this.n = 0;
    this.closed = false;
    this.startedAt = Date.now();
    this.usedAt = Date.now();
    this.child = spawn(bin, [...args, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // An idle session never keeps the daemon from exiting; it ends when its input closes.
    this.child.unref();
    for (const pipe of [this.child.stdin, this.child.stdout, this.child.stderr]) pipe.unref?.();
    let buf = '';
    let stderr = '';
    this.child.stdout.on('data', (d) => {
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
        const w = this.waiting.get(r.request_id);
        if (!w) continue;
        this.waiting.delete(r.request_id);
        clearTimeout(w.timer);
        if (r.subtype === 'error') w.reject(err(502, String(r.error ?? 'Claude Code refused the request')));
        else w.resolve(r.response ?? {});
      }
    });
    this.child.stderr.on('data', (d) => (stderr = `${stderr}${d}`.slice(-2000)));
    this.child.stdin.on('error', () => {});
    const end = (why) => {
      if (this.closed) return;
      this.closed = true;
      for (const w of this.waiting.values()) {
        clearTimeout(w.timer);
        w.reject(err(502, why));
      }
      this.waiting.clear();
      onClose();
    };
    this.child.on('error', (e) => end(`Claude Code could not start: ${e.message}`));
    this.child.on('close', (code) => end(`Claude Code's MCP session stopped (exit ${code})${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ''}`));
    this.ready = this.request({ subtype: 'initialize' }, 30_000);
    this.ready.catch(() => this.close());
  }

  request(request, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(err(502, "Claude Code's MCP session has stopped; refresh the list"));
    this.usedAt = Date.now();
    const id = `r${++this.n}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(err(504, `Claude Code did not answer (${request.subtype}) in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request })}\n`);
    });
  }

  /** The servers, asked again while any is still connecting (up to `waitMs`). */
  async status({ waitMs = 20_000 } = {}) {
    await this.ready;
    const until = Date.now() + waitMs;
    for (;;) {
      const servers = (await this.request({ subtype: 'mcp_status' })).mcpServers ?? [];
      if (!servers.some((s) => s.status === 'pending') || Date.now() > until) return servers;
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  async call(tool, args, timeoutMs = RUN_TIMEOUT_MS) {
    await this.ready;
    return this.request({ subtype: 'mcp_call', tool, arguments: args }, timeoutMs);
  }

  async reconnect(serverName) {
    await this.ready;
    return this.request({ subtype: 'mcp_reconnect', serverName }, 60_000);
  }

  /** Start signing in: { authUrl, callbackExpected, callbackPort } (the callback lands on this process). */
  async authenticate(serverName) {
    await this.ready;
    return this.request({ subtype: 'mcp_authenticate', serverName }, 60_000);
  }

  /** The address the sign-in ended on, when its redirect could not reach this computer. */
  async callback(serverName, callbackUrl) {
    await this.ready;
    return this.request({ subtype: 'mcp_oauth_callback_url', serverName, callbackUrl }, 60_000);
  }

  close() {
    if (!this.closed) this.child.kill();
  }
}

/** The one-off call through Claude Code: use the tool for the request, and report what it returned. */
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
  constructor({ manager, homeDir = os.homedir(), idleMs = IDLE_MS }) {
    this.manager = manager;
    this.homeDir = homeDir;
    this.idleMs = idleMs;
    this.sessions = new Map(); // folder -> McpSession
    this.lists = new Map(); // folder -> { at, servers }
    this.runs = new Map(); // folder -> the last runs, newest first
    this.sweep = setInterval(() => {
      for (const s of this.sessions.values()) if (Date.now() - s.usedAt > this.idleMs && !s.waiting.size) s.close();
    }, 60_000);
    this.sweep.unref?.();
  }

  /** Where the tools run: an agent's folder, or the home folder (user servers and connectors). */
  where(ref) {
    if (!ref || ref === 'home') return { agent: null, dir: this.homeDir };
    const agent = this.manager.mustGet(ref);
    return { agent, dir: agent.workdir ?? agent.planning?.dir ?? this.homeDir };
  }

  /** The folder's MCP session, started if it has none (or `fresh`: a new one, which reads the configuration again). */
  session(agent, dir, { fresh = false } = {}) {
    let s = this.sessions.get(dir);
    if (s && (fresh || s.closed)) {
      s.close();
      s = null;
    }
    if (!s) {
      const engine = ENGINES[DEFAULT_ENGINE];
      s = new McpSession({
        bin: engine.bin(this.manager.config),
        args: engine.extraArgs(this.manager.config),
        cwd: dir,
        env: this.manager.childEnv(agent),
        onClose: () => this.sessions.get(dir) === s && this.sessions.delete(dir),
      });
      this.sessions.set(dir, s);
    }
    return s;
  }

  view(agent, dir, extra = {}) {
    const list = this.lists.get(dir);
    const s = this.sessions.get(dir);
    return {
      agent: agent ? { id: agent.id, name: agent.name, engine: agent.engine ?? DEFAULT_ENGINE, running: Boolean(this.manager.runtimes.get(agent.id)?.pty) } : null,
      dir,
      at: list ? new Date(list.at).toISOString() : null,
      servers: list?.servers ?? [],
      session: s && !s.closed ? { startedAt: new Date(s.startedAt).toISOString() } : null,
      runs: this.runs.get(dir) ?? [],
      error: null,
      ...extra,
    };
  }

  async list(ref, { refresh = false } = {}) {
    const { agent, dir } = this.where(ref);
    try {
      const servers = await this.session(agent, dir, { fresh: refresh }).status();
      this.lists.set(dir, { at: Date.now(), servers: servers.map(serverView).sort((a, b) => a.name.localeCompare(b.name)) });
      return this.view(agent, dir);
    } catch (e) {
      return this.view(agent, dir, { error: e.message });
    }
  }

  /** The server, from the last list for that folder. */
  server(dir, name) {
    const s = this.lists.get(dir)?.servers.find((x) => x.name === name);
    if (!s) throw err(404, `No MCP server "${name}" here; refresh the list`);
    return s;
  }

  /** The tool, checked against the last list for that folder. */
  tool(dir, server, tool) {
    const s = this.server(dir, server);
    const t = s.tools.find((x) => x.name === tool);
    if (!t) throw err(404, `No tool "${tool}" on the MCP server "${server}" here; refresh the list`);
    if (s.status !== 'connected') throw err(409, `The MCP server "${server}" is ${s.status}`);
    return t;
  }

  /** Connect one server again (after signing in, or when it failed), and list them all. */
  async reconnect(ref, name) {
    const { agent, dir } = this.where(ref);
    if (!this.lists.has(dir)) await this.list(ref);
    this.server(dir, String(name ?? ''));
    await this.session(agent, dir).reconnect(name);
    return this.list(ref);
  }

  /**
   * Start signing in to a server: the address to open. Claude Code keeps the tokens (the app never
   * sees them); its sign-in page comes back to a port on this computer, which the session listens on.
   */
  async signIn(ref, name) {
    const { agent, dir } = this.where(ref);
    if (!this.lists.has(dir)) await this.list(ref);
    const s = this.server(dir, String(name ?? ''));
    if (!s.canSignIn) throw err(409, `"${s.name}" runs as a command on this computer; it has no sign-in`);
    const r = await this.session(agent, dir).authenticate(s.name);
    if (!r.authUrl) return { server: s.name, url: null, signedIn: true };
    return { server: s.name, url: String(r.authUrl), callback: r.callbackExpected === true, local: r.callbackExpected === true && r.redirectScheme !== 'custom' };
  }

  /** Finish a sign-in whose redirect could not reach this computer: the address the browser ended on. */
  async signInCallback(ref, name, url) {
    const { agent, dir } = this.where(ref);
    this.server(dir, String(name ?? ''));
    await this.session(agent, dir).callback(name, String(url ?? '').trim());
    return this.list(ref);
  }

  record(dir, run) {
    const list = [run, ...(this.runs.get(dir) ?? [])].slice(0, KEEP_RUNS);
    this.runs.set(dir, list);
    return run;
  }

  /**
   * Run a tool. "direct": called in the folder's MCP session with these arguments (no model call).
   * "workspace": once through Claude Code, which works the arguments out from plain words, with
   * only that tool allowed. "session": the agent is told to use it.
   */
  async run(ref, { server, tool, input = '', where = 'direct' } = {}) {
    const { agent, dir } = this.where(ref);
    if (!this.lists.has(dir)) await this.list(ref);
    const t = this.tool(dir, String(server ?? ''), String(tool ?? ''));
    input = String(input ?? '').slice(0, 8000);
    if (where === 'session') {
      if (!agent) throw err(400, 'Pick an agent to run it in its session');
      if ((agent.engine ?? DEFAULT_ENGINE) !== DEFAULT_ENGINE) throw err(409, 'Running MCP tools in the session works for Claude Code agents');
      return { where, tool: t.id, agent: this.manager.tell(agent.id, sessionMessage(t.id, input), { source: 'mcp' }) };
    }
    if (where !== 'workspace' && where !== 'direct') throw err(400, 'where must be "direct", "workspace" or "session"');
    const args = where === 'direct' ? parseArgs(input) : null;
    if (where === 'direct' && !args) throw err(400, 'To call it directly, give its arguments as a JSON object (or nothing); plain words go through Claude Code');
    const scope = { agent: agent ? this.manager.auditView(agent) : null, dir, tool: t.id, input, where };
    this.manager.plugins.check('mcp.run', scope);
    this.manager.plugins.emit('mcp.run', scope);
    const t0 = Date.now();
    const base = { where, server: String(server), name: t.name, tool: t.id, input };
    const done = (out) => this.record(dir, { ...base, ...out, ms: Date.now() - t0, at: new Date().toISOString() });
    try {
      if (where === 'direct') return done(resultText(await this.session(agent, dir).call(t.id, args)));
      const engine = ENGINES[DEFAULT_ENGINE];
      const text = await this.manager.oneShot(agent, runPrompt(t.id, input), { engine, model: this.manager.config.explainModel, tools: [t.id], cwd: dir, timeoutMs: RUN_TIMEOUT_MS });
      return done({ text, isError: false });
    } catch (e) {
      done({ text: e.message, isError: true });
      throw e;
    }
  }

  close() {
    clearInterval(this.sweep);
    for (const s of this.sessions.values()) s.close();
  }
}
