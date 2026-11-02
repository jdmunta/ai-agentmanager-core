// The agent builder: a task or workflow in words → an agentkit agent (docs/agentkit.md), developed
// in an agent session that works in the agent's folder: it writes the analysis, spec, instructions
// and tests, and makes the changes the person asks for. The person tests, runs, packages and
// downloads it here. Built agents live in ~/.agentmanager/built/<name>/ as ordinary agentkit folders.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Agent } from './agentkit/agent.js';
import { turn as engineTurn } from './agentkit/engines.js';
import { HOST, PLATFORMS, packageAgent } from './agentkit/package.js';
import { checkAgent, loadAgent } from './agentkit/spec.js';
import { parseJsonReply } from './brief.js';
import { paths } from './config.js';

const AGENTKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentkit.js');
const root = () => path.join(paths.home, 'built');
const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'agentkit.md');
const ENGINES = ['claude', 'codex', 'muse'];

/** The agent's name from the task: its first few words. */
export function nameFrom(task) {
  const words = String(task).toLowerCase().replace(/https?:\/\/\S+/g, ' ').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
  const n = slug(words.slice(0, 4).join('-')).slice(0, 32).replace(/-+$/, '');
  return /^[a-z][a-z0-9-]{1,}$/.test(n) ? n : `agent-${n}`.replace(/-+$/, '').slice(0, 32);
}
const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'by', 'with', 'from', 'that', 'this', 'it', 'is', 'are', 'be', 'i', 'we', 'my', 'our', 'want', 'need', 'agent', 'build', 'make', 'create', 'please', 'which', 'who']);

/** The commands its session uses to check and try the agent. */
export function agentkitCommands(dir) {
  return { check: `${process.execPath} ${AGENTKIT} check`, run: `${process.execPath} ${AGENTKIT} run ${dir} --once` };
}

/**
 * What a session that builds an agent is told (appended to its system prompt on every launch):
 * the folder is the agent, the files it keeps, the format, and how to check and try it.
 */
export function builderPrompt({ dir, name, engine = 'claude' }) {
  const cmd = agentkitCommands(dir);
  return [
    `You are building an autonomous agent together with the person: an agentkit agent that runs on its own, continuously, and does one job well. This folder (${dir}) is the agent. Its name is "${name}"; keep it (it is the folder's name).`,
    '',
    'Keep these files current:',
    '- agent.yaml: the spec (below).',
    '- instructions.md: how to do the job, step by step; what it must never do; when it asks a person.',
    '- tests.yaml: 3 to 8 test cases, a YAML list of {input, expect}: the normal case, an edge case, and a case it should refuse or escalate. The person runs them from the Built tab; each result is judged against `expect`.',
    '- analysis.json: {"analysis": {"problem": "<the job and why>", "inputs": [...], "outputs": [...], "risks": ["<what could go wrong, what needs a person>"]}, "tools": [{"name": "<MCP server id>", "why": "<what for>"}]}. The person reads it in the Built tab; update it when the design changes.',
    '',
    `agent.yaml has: name, title, description (one line), goal (what is true when it has done its job, for each input), instructions: instructions.md, engine: ${engine},`,
    '  tools (MCP servers by id: {command, args, env}; only servers that really exist; secrets only as "${VAR}"),',
    '  allow (engine tools it may use without asking, e.g. Read, Grep, "mcp__<id>__*"), approve (tools that change things in the outside world and need a person\'s yes),',
    '  triggers (only when the task implies running on its own: {every: 30m}, {cron: "0 9 * * 1-5"}, {webhook: /hooks/<name>}, {watch: ./inbox}; a chat-only agent has none),',
    '  loop: {plan: true, check: true, maxSteps: 4}, memory: true, interfaces: {http: {port: 0}, a2a: true, acp: true, mcp: true}.',
    `The full reference: ${DOCS}.`,
    '',
    `After every change, check it loads: ${cmd.check} ${dir}`,
    `To try one input for real (it runs with its allowed tools; tools that need approval are refused): ${cmd.run} "<input>". Only with inputs that are safe to run for real.`,
    'Be concrete; do not invent systems the task does not mention. When something only the person knows is missing (an account, a team name, a label set), ask.',
    'The person tests, starts, packages and downloads it from the Built tab; you do not start it continuously or package it. When they ask for a change, make it in these files, check, and say in a sentence what changed.',
  ].join('\n');
}

/** The first message of a build session. */
export function buildIntent({ task, name, engine }) {
  return `Build the agent "${name}" (engine: ${engine}) for this task:\n\n${task}\n\nWrite analysis.json, agent.yaml, instructions.md and tests.yaml in this folder, check it, then tell me what it does and what I should decide or provide.`;
}

export function judgePrompt({ goal, input, expect, result }) {
  return [
    "You check one test of an autonomous agent. Decide if the agent's result meets the expectation for the input.",
    'Be strict about substance, lenient about wording. Reply with JSON only: {"pass": true|false, "why": "<one sentence>"}.',
    `<goal>\n${goal}\n</goal>`,
    `<input>\n${input}\n</input>`,
    `<expectation>\n${expect}\n</expectation>`,
    `<result>\n${result}\n</result>`,
  ].join('\n');
}

export class Builder {
  /** `oneShot(prompt)` answers a judge prompt (the daemon's writer engine). */
  /** `sessions`: the daemon's agent sessions ({ create, get, tell, stop }); each built agent is developed in one. */
  /** `reportEnv()`: settings that make an agent started here report to this daemon. */
  constructor({ oneShot, sessions, env = process.env, runTurn = engineTurn, pack = packageAgent, reportEnv = () => ({}) }) {
    this.reportEnv = reportEnv;
    this.oneShot = oneShot;
    this.sessions = sessions;
    this.env = env;
    this.runTurn = runTurn;
    this.pack = pack;
    this.procs = new Map(); // name -> child process of `agentkit run`
    this.pending = new Map(); // name -> what's in progress (testing, packaging)
  }

  dir(name) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(String(name))) throw err(400, 'Unknown agent');
    return path.join(root(), name);
  }

  meta(name) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(name), 'build.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  saveMeta(name, patch) {
    const next = { ...this.meta(name), ...patch, updatedAt: now() };
    fs.writeFileSync(path.join(this.dir(name), 'build.json'), JSON.stringify(next, null, 2));
    return next;
  }

  list() {
    let names = [];
    try {
      names = fs.readdirSync(root()).filter((n) => fs.existsSync(path.join(root(), n, 'build.json')));
    } catch {}
    return names.map((n) => this.view(n)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  view(name) {
    const m = this.meta(name);
    if (!m) throw err(404, `No built agent "${name}"`);
    const dir = this.dir(name);
    const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
    let spec = null;
    let specError = null;
    const yaml = read('agent.yaml');
    if (yaml) {
      try {
        spec = loadAgent(dir, { env: this.env });
      } catch (e) {
        specError = e.message;
      }
    }
    const p = this.procs.get(name);
    let runs = [];
    if (spec) runs = new Agent(spec, { env: this.env }).runs(20);
    // Its session keeps analysis.json and tests.yaml current; read them as they are now.
    let design = {};
    try {
      design = JSON.parse(read('analysis.json') || '{}');
    } catch {}
    let tests = m.tests ?? [];
    try {
      tests = (YAML.parse(read('tests.yaml') || '[]') ?? []).filter((t) => t?.input).map((t) => ({ input: String(t.input), expect: String(t.expect ?? '') }));
    } catch {}
    // Until its spec loads, the status follows the files: designing, then designed or needs fixing.
    let status = m.status;
    if (!yaml) status = 'designing';
    else if (specError) status = 'needs-fixing';
    else if (['designing', 'needs-fixing'].includes(status)) status = 'designed';
    const s = m.session ? this.sessions?.get(m.session) : null;
    // When its files last changed (its session edits them): results and executables from before are out of date.
    const changedAt = new Date(Math.max(0, ...['agent.yaml', 'instructions.md', 'tests.yaml'].map((f) => fs.statSync(path.join(dir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0))).toISOString();
    return {
      ...m,
      name,
      status,
      title: spec?.title ?? name,
      description: spec?.description ?? '',
      dir,
      yaml,
      instructionsText: read('instructions.md'),
      analysis: design.analysis ?? m.analysis ?? null,
      tools: design.tools ?? m.tools ?? [],
      tests,
      specError,
      engine: spec?.engine ?? m.engine ?? null,
      triggers: spec?.triggers.map((t) => t.label) ?? [],
      missingEnv: spec?.missingEnv ?? [],
      pending: this.pending.get(name) ?? null,
      running: p ? { pid: p.child.pid, url: p.url, since: p.since } : null,
      session: s ? { id: s.id, name: s.name, status: s.status, running: s.runtime.running, busy: s.runtime.busy, attention: s.runtime.attention ?? s.runtime.waiting?.text ?? null } : null,
      runs,
      platforms: PLATFORMS.filter((x) => process.platform === 'darwin' || !x.startsWith('macos-')),
      host: HOST,
      changedAt,
      // Executables built since the last edit that are still there.
      executables: Object.fromEntries(Object.entries(m.executables ?? {}).filter(([, x]) => fs.existsSync(path.join(dir, 'dist', x.file)))),
    };
  }

  /**
   * Start building an agent for a task: its folder, and an agent session working in it that
   * analyses the task and writes the agent (analysis, spec, instructions, tests). The person
   * keeps developing it in that session.
   */
  design({ task, engine = 'claude', name, attachments, permissionMode, model }) {
    task = String(task ?? '').trim();
    if (!task) throw err(400, 'Describe the task or workflow');
    if (!ENGINES.includes(engine) && !/^acp:[a-z0-9-]+$/.test(engine)) throw err(400, 'engine: claude, codex, muse or acp:<name>');
    if (!this.sessions) throw err(503, 'Agent sessions are not available');
    const want = name ? slug(name) : nameFrom(task);
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(want)) throw err(400, 'name: lowercase letters, digits and dashes, starting with a letter');
    let n = want;
    for (let i = 2; fs.existsSync(path.join(root(), n)); i++) n = `${want.slice(0, 36)}-${i}`;
    const dir = path.join(root(), n);
    fs.mkdirSync(dir, { recursive: true });
    this.saveMeta(n, { task, engine, results: null, status: 'designing', createdAt: now() });
    try {
      const s = this.sessions.create({ name: n, dir, intent: buildIntent({ task, name: n, engine }), builds: { name: n, engine }, attachments, permissionMode, model });
      this.saveMeta(n, { session: s.id });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    return this.view(n);
  }

  /**
   * Ask its session for a change (typed in when it's idle; started if it's closed). An agent with
   * no session yet (built before sessions, or its session deleted) gets a new one.
   */
  change(name, text) {
    const dir = this.dir(name);
    const m = this.meta(name);
    if (!m) throw err(404, `No built agent "${name}"`);
    text = String(text ?? '').trim();
    const s = m.session ? this.sessions.get(m.session) : null;
    if (s) {
      if (!text) throw err(400, 'Say what to change');
      this.sessions.tell(s.id, text);
    } else {
      const engine = this.view(name).engine ?? 'claude';
      const intent = `This folder is the agent "${name}"${m.task ? `, built for this task:\n\n${m.task}\n\n` : '. '}Read agent.yaml, instructions.md and tests.yaml${fs.existsSync(path.join(dir, 'analysis.json')) ? ' and analysis.json' : ' and write analysis.json'}. ${text || 'Then tell me briefly what it does and wait for what to change.'}`;
      const created = this.sessions.create({ name, dir, intent, builds: { name, engine } });
      this.saveMeta(name, { session: created.id });
    }
    return this.view(name);
  }

  /** Save edits to agent.yaml, the instructions or the tests (each checked before it's written). */
  update(name, { yaml, instructions, tests } = {}) {
    const dir = this.dir(name);
    if (!this.meta(name)) throw err(404, `No built agent "${name}"`);
    if (yaml != null) {
      let raw;
      try {
        raw = YAML.parse(String(yaml));
      } catch (e) {
        throw err(400, `agent.yaml: ${e.message.split('\n')[0]}`);
      }
      if (raw?.name !== name) throw err(400, `agent.yaml: keep the name "${name}" (it is the agent's folder)`);
      fs.writeFileSync(path.join(dir, 'instructions.md'), instructions != null ? String(instructions) : fs.readFileSync(path.join(dir, 'instructions.md'), 'utf8'));
      try {
        checkAgent(raw, { dir, env: this.env });
      } catch (e) {
        throw err(400, e.message);
      }
      fs.writeFileSync(path.join(dir, 'agent.yaml'), String(yaml));
    } else if (instructions != null) fs.writeFileSync(path.join(dir, 'instructions.md'), String(instructions));
    if (tests != null) {
      const list = (Array.isArray(tests) ? tests : []).filter((t) => t?.input).slice(0, 8).map((t) => ({ input: String(t.input), expect: String(t.expect ?? '') }));
      fs.writeFileSync(path.join(dir, 'tests.yaml'), YAML.stringify(list));
      this.saveMeta(name, { tests: list });
    }
    // Executables built before carry the old files; build them again after an edit.
    if (yaml != null || instructions != null || tests != null) {
      fs.rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
      this.saveMeta(name, { executables: {} });
    }
    return this.view(name);
  }

  /** Run every test through the real runtime, and judge each result against its expectation. */
  async test(name) {
    const dir = this.dir(name);
    if (this.pending.get(name)) throw err(409, `Already ${this.pending.get(name)}`);
    const spec = loadAgent(dir, { env: this.env });
    const tests = YAML.parse(fs.readFileSync(path.join(dir, 'tests.yaml'), 'utf8') || '[]') ?? [];
    if (!tests.length) throw err(400, 'No test cases; add some first');
    this.pending.set(name, 'testing');
    this.saveMeta(name, { status: 'testing' });
    try {
      // Tests don't wait for people: approval tools are simply not available in them.
      const agent = new Agent({ ...spec, triggers: [], report: null }, { env: this.env, engineTurn: this.runTurn, approvals: 'deny' });
      const results = [];
      for (const t of tests) {
        const r = await agent.run(t.input, { source: 'test' });
        let verdict = { pass: false, why: 'The run failed' };
        if (r.status !== 'failed') {
          try {
            const v = parseJsonReply(await this.oneShot(judgePrompt({ goal: spec.goal, input: t.input, expect: t.expect, result: r.result })));
            verdict = { pass: v.pass === true, why: String(v.why ?? '') };
          } catch (e) {
            verdict = { pass: false, why: `Could not judge: ${e.message}` };
          }
        }
        results.push({ input: t.input, expect: t.expect, result: r.result, status: r.status, costUsd: r.costUsd, ...verdict });
      }
      const passed = results.filter((r) => r.pass).length;
      this.saveMeta(name, { results: { at: now(), passed, total: results.length, list: results }, status: passed === results.length ? 'tested' : 'failing' });
    } catch (e) {
      this.saveMeta(name, { status: 'failing', results: { at: now(), passed: 0, total: 0, list: [], error: e.message } });
    } finally {
      this.pending.delete(name);
    }
    return this.view(name);
  }

  /** Build its single executable for a platform into dist/ (in the background; the view says when). */
  package(name, platform = HOST) {
    const dir = this.dir(name);
    if (!this.meta(name)) throw err(404, `No built agent "${name}"`);
    if (this.pending.get(name)) throw err(409, `Already ${this.pending.get(name)}`);
    if (!PLATFORMS.includes(platform)) throw err(400, `platform: one of ${PLATFORMS.join(', ')}`);
    if (platform.startsWith('macos-') && process.platform !== 'darwin') throw err(400, 'macOS executables are built on a Mac');
    loadAgent(dir, { env: this.env });
    this.pending.set(name, `packaging for ${platform}`);
    this.saveMeta(name, { packageError: null });
    return this.#pack(name, dir, platform);
  }

  async #pack(name, dir, platform) {
    try {
      const r = await this.pack(dir, { outDir: path.join(dir, 'dist'), platform });
      const executables = { ...this.meta(name).executables, [platform]: { file: path.basename(r.file), size: r.size, at: now() } };
      this.saveMeta(name, { executables });
    } catch (e) {
      this.saveMeta(name, { packageError: `${platform}: ${e.message}` });
    } finally {
      this.pending.delete(name);
    }
    return this.view(name);
  }

  /** The path of a built executable, for download. */
  executable(name, platform) {
    const x = this.view(name).executables[platform];
    if (!x) throw err(404, `No ${platform} executable built yet`);
    return path.join(this.dir(name), 'dist', x.file);
  }

  /** Run it continuously on this computer (`agentkit run`); its output goes to agent.log. */
  start(name) {
    const dir = this.dir(name);
    if (this.procs.has(name)) return this.view(name);
    loadAgent(dir, { env: this.env });
    const log = fs.openSync(path.join(dir, 'agent.log'), 'a');
    const child = spawn(process.execPath, [AGENTKIT, 'run', dir], { env: { ...this.env, ...this.reportEnv() }, stdio: ['ignore', log, log], detached: false });
    const entry = { child, url: null, since: now() };
    this.procs.set(name, entry);
    // Its chat address, from the log line it prints when listening.
    const watch = setInterval(() => {
      const m = /chat and API: (http:\/\/\S+)/.exec(fs.readFileSync(path.join(dir, 'agent.log'), 'utf8').split('\n').slice(-40).join('\n'));
      if (m) {
        entry.url = m[1];
        clearInterval(watch);
      }
    }, 300);
    setTimeout(() => clearInterval(watch), 20_000);
    child.on('exit', () => {
      clearInterval(watch);
      if (this.procs.get(name) === entry) this.procs.delete(name);
      this.saveMeta(name, { lastStoppedAt: now() });
    });
    this.saveMeta(name, { status: this.meta(name).status === 'tested' ? 'running' : this.meta(name).status, lastStartedAt: now() });
    return this.view(name);
  }

  stop(name) {
    const p = this.procs.get(name);
    if (p) p.child.kill('SIGTERM');
    this.procs.delete(name);
    return this.view(name);
  }

  stopAll() {
    for (const name of [...this.procs.keys()]) this.stop(name);
  }

  remove(name) {
    this.stop(name);
    // Its session works in the folder about to go; close it (the conversation is kept).
    const sid = this.meta(name)?.session;
    if (sid && this.sessions?.get(sid)) this.sessions.stop(sid);
    fs.rmSync(this.dir(name), { recursive: true, force: true });
    return { ok: true };
  }
}
