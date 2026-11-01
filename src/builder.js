// The agent builder: a task or workflow in words → an analysis and an agentkit agent
// (docs/agentkit.md) with test cases, which the person reviews, tests, runs and downloads. Built
// agents live in ~/.agentmanager/built/<name>/ as ordinary agentkit folders.
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

export function designPrompt({ task, engine, attachments = [] }) {
  return [
    'You design an autonomous agent that will run continuously on its own and do one job well. It runs through',
    `${engine === 'claude' ? 'Claude Code' : engine} as its engine, uses tools through MCP servers, and is reached by people (chat) and other agents (A2A, MCP).`,
    'From the task below, write the analysis and the agent. Be concrete; do not invent systems the task does not mention.',
    '',
    'Reply with one JSON object only:',
    '{',
    '  "analysis": {"problem": "<what the job is and why>", "inputs": ["<what it receives>"], "outputs": ["<what it produces>"], "risks": ["<what could go wrong, and what needs a person>"]},',
    '  "name": "<lowercase-with-dashes, 2-40 chars>", "title": "<short>", "description": "<one line>",',
    '  "goal": "<what is true when it has done its job, for each input; one or two sentences>",',
    '  "instructions": "<Markdown: how to do the job, step by step; what to never do; when to ask>",',
    '  "tools": [{"name": "<short id>", "why": "<what it needs it for>", "command": "<MCP server command, e.g. npx>", "args": ["…"], "env": {"VAR": "${VAR}"}}],',
    '  "allow": ["<engine tool names it may use without asking, e.g. Read, Grep, mcp__<tool>__*>"],',
    '  "approve": ["<tools that change things in the outside world and need a person\'s yes>"],',
    '  "triggers": [{"every": "30m"} | {"cron": "0 9 * * 1-5"} | {"webhook": "/hooks/<name>"} | {"watch": "./inbox"}],',
    '  "tests": [{"input": "<a realistic input>", "expect": "<what a good result does or contains>"}]',
    '}',
    '',
    'Rules: 3 to 5 tests that cover the normal case, an edge case and a case it should refuse or escalate.',
    'Only MCP servers that really exist and fit (leave "tools" empty when none is needed). Secrets only as "${VAR}".',
    'Triggers only when the task implies running on its own (a schedule, events); chat-only agents have none.',
    '',
    '<task>',
    task,
    '</task>',
    ...(attachments.length ? ['<attached_files>', ...attachments.map((a) => `--- ${a.name}\n${a.text}`), '</attached_files>'] : []),
  ].join('\n');
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

/** agent.yaml text from a design. */
export function yamlOf(d, engine) {
  const tools = Object.fromEntries((d.tools ?? []).filter((t) => t?.name && t.command).map((t) => [slug(t.name), { command: t.command, ...(t.args?.length ? { args: t.args } : {}), ...(t.env && Object.keys(t.env).length ? { env: t.env } : {}) }]));
  const doc = {
    name: slug(d.name),
    title: d.title || d.name,
    description: d.description ?? '',
    goal: d.goal,
    instructions: 'instructions.md',
    engine,
    tools,
    allow: d.allow ?? [],
    approve: d.approve ?? [],
    triggers: d.triggers ?? [],
    loop: { plan: true, check: true, maxSteps: 4 },
    memory: true,
    interfaces: { http: { port: 0 }, a2a: true, acp: true, mcp: true },
  };
  return YAML.stringify(doc, { lineWidth: 0 });
}

export class Builder {
  /** `oneShot(prompt)` answers a design or judge prompt (the daemon's writer engine). */
  /** `reportEnv()`: settings that make an agent started here report to this daemon. */
  constructor({ oneShot, env = process.env, runTurn = engineTurn, pack = packageAgent, reportEnv = () => ({}) }) {
    this.reportEnv = reportEnv;
    this.oneShot = oneShot;
    this.env = env;
    this.runTurn = runTurn;
    this.pack = pack;
    this.procs = new Map(); // name -> child process of `agentkit run`
    this.pending = new Map(); // name -> what's in progress (designing, testing)
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
    try {
      spec = loadAgent(dir, { env: this.env });
    } catch (e) {
      specError = e.message;
    }
    const p = this.procs.get(name);
    let runs = [];
    if (spec) runs = new Agent(spec, { env: this.env }).runs(20);
    return {
      ...m,
      name,
      title: spec?.title ?? name,
      description: spec?.description ?? '',
      dir,
      yaml: read('agent.yaml'),
      instructionsText: read('instructions.md'),
      specError,
      engine: spec?.engine ?? null,
      triggers: spec?.triggers.map((t) => t.label) ?? [],
      missingEnv: spec?.missingEnv ?? [],
      pending: this.pending.get(name) ?? null,
      running: p ? { pid: p.child.pid, url: p.url, since: p.since } : null,
      runs,
      platforms: PLATFORMS.filter((x) => process.platform === 'darwin' || !x.startsWith('macos-')),
      host: HOST,
      // Executables built since the last edit that are still there.
      executables: Object.fromEntries(Object.entries(m.executables ?? {}).filter(([, x]) => fs.existsSync(path.join(dir, 'dist', x.file)))),
    };
  }

  /** Design an agent from a task (one model call); writes the folder and returns it. */
  async design({ task, engine = 'claude', attachments = [] }) {
    task = String(task ?? '').trim();
    if (!task) throw err(400, 'Describe the task or workflow');
    if (!['claude', 'codex', 'muse'].includes(engine) && !/^acp:[a-z0-9-]+$/.test(engine)) throw err(400, 'engine: claude, codex, muse or acp:<name>');
    const d = parseJsonReply(await this.oneShot(designPrompt({ task, engine, attachments })));
    if (!d.goal || !d.name) throw err(502, 'The design was missing a name or goal; try again');
    let name = slug(d.name);
    for (let i = 2; fs.existsSync(path.join(root(), name)); i++) name = `${slug(d.name).slice(0, 36)}-${i}`;
    const dir = path.join(root(), name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.yaml'), yamlOf({ ...d, name }, engine));
    fs.writeFileSync(path.join(dir, 'instructions.md'), String(d.instructions ?? '').trim() + '\n');
    const tests = (d.tests ?? []).filter((t) => t?.input).slice(0, 8).map((t) => ({ input: String(t.input), expect: String(t.expect ?? '') }));
    fs.writeFileSync(path.join(dir, 'tests.yaml'), YAML.stringify(tests));
    // Check it loads; a broken design is kept so the person can fix it.
    let specError = null;
    try {
      checkAgent(YAML.parse(fs.readFileSync(path.join(dir, 'agent.yaml'), 'utf8')), { dir, env: this.env });
    } catch (e) {
      specError = e.message;
    }
    this.saveMeta(name, { task, analysis: d.analysis ?? null, tools: (d.tools ?? []).map((t) => ({ name: t.name, why: t.why ?? '' })), tests, results: null, status: specError ? 'needs-fixing' : 'designed', createdAt: now() });
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
    fs.rmSync(this.dir(name), { recursive: true, force: true });
    return { ok: true };
  }
}
