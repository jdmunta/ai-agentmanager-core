// Agents built with agentkit report here (src/agentkit/report.js): who they are, each run, and the
// tool approvals they're waiting on. People see them in the Built tab and the Inbox, and their
// decisions go back with the agent's next check-in. Kept in ~/.agentmanager/agentkit-reports.json.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

const ONLINE_MS = 90_000;
const file = () => path.join(paths.home, 'agentkit-reports.json');
const err = (status, message) => Object.assign(new Error(message), { status });
const str = (v, n = 200) => String(v ?? '').slice(0, n);

export class AgentkitReports extends EventEmitter {
  constructor() {
    super();
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    } catch {}
    this.token = saved.token ?? null;
    this.agents = new Map(Object.entries(saved.agents ?? {}));
    this.decisions = new Map(); // key -> [{ id, allow, by, note }] to hand back on its next check-in
    this.saveTimer = null;
  }

  /** The token agents report with (made on first use). */
  reportToken() {
    if (!this.token) {
      this.token = crypto.randomBytes(24).toString('base64url');
      this.save(true);
    }
    return this.token;
  }

  save(now = false) {
    clearTimeout(this.saveTimer);
    const write = () => {
      fs.mkdirSync(paths.home, { recursive: true });
      fs.writeFileSync(file(), JSON.stringify({ token: this.token, agents: Object.fromEntries(this.agents) }, null, 2), { mode: 0o600 });
    };
    if (now) write();
    else this.saveTimer = setTimeout(write, 1000);
  }

  /** A check-in from an agent. Returns the decisions waiting for it. */
  report(body = {}) {
    const a = body.agent ?? {};
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(String(a.name ?? ''))) throw err(400, 'agent.name: required');
    const key = `${a.name}@${str(a.host, 120) || 'unknown'}`;
    const prev = this.agents.get(key) ?? { runs: [], totals: { runs: 0, failed: 0, costUsd: 0 } };
    const known = new Set(prev.runs.map((r) => r.id));
    const fresh = (Array.isArray(body.runs) ? body.runs : []).filter((r) => r?.id && !known.has(r.id)).map((r) => ({ id: str(r.id, 80), status: str(r.status, 20), source: str(r.source, 80), costUsd: Number(r.costUsd) || null, ms: Number(r.ms) || null, result: str(r.result, 2000), at: str(r.at, 40) }));
    const totals = { ...prev.totals };
    for (const r of fresh) {
      totals.runs++;
      if (r.status === 'failed') totals.failed++;
      totals.costUsd = Math.round((totals.costUsd + (r.costUsd ?? 0)) * 1e6) / 1e6;
    }
    const decided = new Set((this.decisions.get(key) ?? []).map((d) => d.id));
    const next = {
      key,
      name: a.name,
      title: str(a.title) || a.name,
      description: str(a.description, 400),
      engine: str(a.engine, 40),
      triggers: (Array.isArray(a.triggers) ? a.triggers : []).slice(0, 10).map((t) => str(t, 80)),
      host: str(a.host, 120),
      pid: Number(a.pid) || null,
      chat: /^https?:\/\//.test(String(a.chat ?? '')) ? str(a.chat, 300) : null,
      version: str(a.version, 40) || null,
      startedAt: str(a.startedAt, 40) || null,
      lastSeen: new Date().toISOString(),
      current: body.current?.id ? { id: str(body.current.id, 80), source: str(body.current.source, 80), startedAt: str(body.current.startedAt, 40) } : null,
      // Approvals already answered here stay hidden until the agent confirms them.
      pending: (Array.isArray(body.pending) ? body.pending : []).filter((p) => p?.id && !decided.has(p.id)).slice(0, 20).map((p) => ({ id: str(p.id, 80), tool: str(p.tool, 200), input: p.input && typeof p.input === 'object' ? p.input : {}, run: p.run ? str(p.run, 80) : null, at: str(p.at, 40) })),
      runs: [...fresh.reverse(), ...prev.runs].slice(0, 50),
      totals,
    };
    this.agents.set(key, next);
    const decisions = this.decisions.get(key) ?? [];
    this.decisions.delete(key);
    this.save();
    this.emit('change');
    return { ok: true, decisions };
  }

  /** A person's answer to an approval; it goes back on the agent's next check-in. */
  decide(key, id, allow, by = 'you') {
    const a = this.agents.get(key);
    if (!a) throw err(404, 'No such agent');
    const p = a.pending.find((x) => x.id === id);
    if (!p) throw err(409, 'Already decided, or no longer waiting');
    this.decisions.set(key, [...(this.decisions.get(key) ?? []), { id, allow: Boolean(allow), by }]);
    a.pending = a.pending.filter((x) => x.id !== id);
    this.emit('change');
    return this.view(a);
  }

  forget(key) {
    this.agents.delete(key);
    this.decisions.delete(key);
    this.save();
    this.emit('change');
    return { ok: true };
  }

  view(a) {
    const online = Date.now() - Date.parse(a.lastSeen) < ONLINE_MS;
    return { ...a, online, pending: online ? a.pending : [], runs: a.runs.slice(0, 10) };
  }

  list() {
    return [...this.agents.values()].map((a) => this.view(a)).sort((x, y) => String(y.lastSeen).localeCompare(String(x.lastSeen)));
  }
}
