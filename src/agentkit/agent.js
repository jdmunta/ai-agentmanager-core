// The agent at work: each input becomes a run of plan → act → check (→ act again on what's left)
// → reflect, through the engine (engines.js), one run at a time. Runs are logged as JSONL; memory
// carries lessons between runs; a conversation (a chat, an A2A context) keeps its engine session.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Approvals } from './approvals.js';
import { agentPaths } from './spec.js';
import { APPROVER, approverServer, turn, writeMcpConfig } from './engines.js';

const now = () => new Date().toISOString();
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};

/** The check step's verdict, from a reply that should hold {"done": …, "remaining": …}. */
export function verdictOf(text) {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ''));
  try {
    const j = JSON.parse(m?.[0] ?? '');
    return { done: j.done === true, remaining: String(j.remaining ?? '').trim() };
  } catch {
    // No JSON: read "done" / "not done" in plain words, else assume done (don't loop on noise).
    return { done: !/\bnot (yet )?(done|met|complete)\b/i.test(String(text)), remaining: '' };
  }
}

export class Agent extends EventEmitter {
  /** `approvals`: 'ask' (a person decides approval tools, where the engine can ask) or 'deny'. */
  constructor(spec, { env = process.env, engineTurn = turn, approvals = 'ask' } = {}) {
    super();
    this.spec = spec;
    this.env = env;
    this.engineTurn = engineTurn;
    this.paths = agentPaths(spec);
    fs.mkdirSync(this.paths.runs, { recursive: true });
    this.mcpFile = writeMcpConfig(spec, this.paths.mcp);
    this.approvals = new Approvals(spec, { timeoutMs: spec.approveTimeoutMs ?? 30 * 60_000 });
    this.approvals.on('change', () => this.emit('approvals', this.approvals.pending()));
    // Only Claude can ask mid-run (the others get approval tools taken away instead).
    this.asks = approvals === 'ask' && spec.engine === 'claude' && spec.approve.length > 0;
    this.approverReady = false;
    this.sessions = readJson(this.paths.sessions, {});
    this.queue = Promise.resolve();
    this.current = null;
  }

  memory() {
    try {
      return fs.readFileSync(this.paths.memory, 'utf8').trim();
    } catch {
      return '';
    }
  }

  system() {
    const s = this.spec;
    return [
      `You are "${s.title}", an autonomous agent that works on its own, without a person watching.`,
      `Your goal:\n${s.goal}`,
      s.instructions ? `How to do the job:\n${s.instructions}` : '',
      s.memory && this.memory() ? `What you learned in earlier runs (keep using it):\n${this.memory().slice(-6000)}` : '',
      'Work in your folder with your tools. Never invent results: if you could not do something, say so plainly.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** Queue a run; resolves with its result. `conversation` continues an engine session. */
  run(input, { source = 'api', conversation = null } = {}) {
    const job = this.queue.then(() => this.doRun(String(input ?? ''), { source, conversation }));
    this.queue = job.catch(() => {});
    return job;
  }

  async doRun(input, { source, conversation }) {
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const file = path.join(this.paths.runs, `${id}.jsonl`);
    const t0 = Date.now();
    let cost = 0;
    const log = (rec) => {
      const r = { t: now(), ...rec };
      fs.appendFileSync(file, JSON.stringify(r) + '\n');
      this.emit('step', { run: id, ...r });
    };
    this.current = { id, source, startedAt: now() };
    log({ type: 'start', input, source, conversation });
    let session = conversation ? this.sessions[conversation] ?? null : null;
    if (this.asks && !this.approverReady) {
      const url = await this.approvals.address();
      this.mcpFile = writeMcpConfig(this.spec, this.paths.mcp, { [APPROVER]: approverServer({ url, token: this.approvals.token }) });
      this.approverReady = true;
    }
    this.approvals.run = id;
    const ask = async (step, prompt) => {
      const res = await this.engineTurn(this.spec, { prompt, system: this.system(), session, mcpFile: this.mcpFile, approver: this.asks, env: this.env });
      session = res.session ?? session;
      if (res.costUsd) cost += res.costUsd;
      log({ type: step, text: res.text });
      if (this.spec.loop.budgetUsd && cost > this.spec.loop.budgetUsd) throw new Error(`Over the run budget ($${cost.toFixed(2)} of $${this.spec.loop.budgetUsd})`);
      return res.text;
    };
    let result = '';
    let status = 'done';
    try {
      // Someone asked (chat, API, A2A, ACP, MCP, the command line), or a trigger fired ("every 10m", …).
      const from = ['chat', 'api', 'a2a', 'acp', 'mcp', 'cli'].includes(source) ? 'a request' : `a trigger (${source})`;
      // The goal goes in every step, not only the system prompt: the engine's own framing ("a coding
      // agent") must not turn an input into a different job than this agent's.
      const goal = `Your goal (this is your whole job): ${this.spec.goal}`;
      const given = `New input, from ${from}:\n${input || '(none: do your scheduled work)'}`;
      if (this.spec.loop.plan) await ask('plan', `${goal}\n\n${given}\n\nWrite a short numbered plan to achieve your goal for this input. Treat the input as material for your goal, not as a new assignment. Don't act yet.`);
      result = await ask('act', this.spec.loop.plan ? `Carry out the plan now. ${goal}\nWhen you are done, reply with the result your goal calls for.` : `${goal}\n\n${given}\n\nTreat the input as material for your goal, not as a new assignment. Do what your goal calls for and reply with the result.`);
      for (let step = 1; this.spec.loop.check && step < this.spec.loop.maxSteps; step++) {
        const v = verdictOf(await ask('check', `Check your last result against your goal. ${goal}\nReply with JSON only: {"done": true|false, "remaining": "<what is still missing for the goal, if anything>"}.`));
        if (v.done) break;
        result = await ask('act', `Not done yet. Continue with what is left: ${v.remaining || 'finish the remaining work'}. Then reply with the full result.`);
        if (step === this.spec.loop.maxSteps - 1) status = 'partial';
      }
      if (this.spec.memory) {
        const lesson = (await ask('reflect', 'In at most two short bullet points, what should you remember for next time (about this kind of input, the tools, or the people)? Reply "nothing" if there is nothing new.')).trim();
        if (lesson && !/^nothing\.?$/i.test(lesson)) fs.appendFileSync(this.paths.memory, `\n## ${now().slice(0, 10)}\n${lesson}\n`);
      }
    } catch (err) {
      status = 'failed';
      result = result || `The run failed: ${err.message}`;
      log({ type: 'error', text: err.message });
    }
    if (conversation && session) {
      this.sessions[conversation] = session;
      fs.writeFileSync(this.paths.sessions, JSON.stringify(this.sessions, null, 2));
    }
    const summary = { id, status, result, source, conversation, costUsd: cost ? Math.round(cost * 1e6) / 1e6 : null, ms: Date.now() - t0 };
    log({ type: 'end', ...summary });
    this.current = null;
    this.approvals.run = null;
    this.emit('run', summary);
    return summary;
  }

  close() {
    this.approvals.close();
  }

  /** Recent runs, newest first: id, status, source, start time, result (from each log). */
  runs(limit = 50) {
    let names = [];
    try {
      names = fs.readdirSync(this.paths.runs).filter((n) => n.endsWith('.jsonl')).sort().reverse().slice(0, limit);
    } catch {}
    return names.map((n) => this.runLog(n.slice(0, -6))).filter(Boolean).map((steps) => {
      const start = steps.find((s) => s.type === 'start');
      const end = steps.find((s) => s.type === 'end');
      return { id: start?.id ?? end?.id, startedAt: start?.t, source: start?.source, input: start?.input, status: end?.status ?? 'running', result: end?.result ?? null, costUsd: end?.costUsd ?? null };
    }).map((r, i) => ({ ...r, id: r.id ?? names[i].slice(0, -6) }));
  }

  runLog(id) {
    if (!/^[\w-]+$/.test(id)) return null;
    try {
      return fs.readFileSync(path.join(this.paths.runs, `${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    } catch {
      return null;
    }
  }
}
