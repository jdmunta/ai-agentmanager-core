// Approvals: a tool on the agent's `approve` list runs only after a person says yes. Claude asks
// the approver (an MCP tool, --permission-prompt-tool) before any tool it isn't allowed outright;
// the approver asks this object over a private local address; this asks the people reachable
// (the chat page, AI Agent Manager) and answers with the first decision, or no after a while.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';

/** Does a tool name match a pattern ("mcp__jira__*", "Bash", "Bash(git push:*)" → Bash)? */
export function toolMatches(pattern, tool) {
  const base = String(pattern).replace(/\(.*\)$/, '');
  const re = new RegExp(`^${base.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(String(tool));
}

/** Allow patterns Claude may apply on its own: not ones that also cover a tool that needs approval. */
export function allowedOutright(spec) {
  return spec.allow.filter((p) => !spec.approve.some((q) => toolMatches(p, q.replace(/\(.*\)$/, ''))));
}

export class Approvals extends EventEmitter {
  constructor(spec, { timeoutMs = 30 * 60_000 } = {}) {
    super();
    this.spec = spec;
    this.timeoutMs = timeoutMs;
    this.open = new Map(); // id -> { id, tool, input, run, at, finish }
    this.decided = []; // the latest decisions, for the views
    this.channels = new Set(); // who can answer: 'chat', 'manager'
    this.server = null;
    this.token = crypto.randomBytes(24).toString('hex');
  }

  /** The private address the approver calls (started on first use). */
  async address() {
    if (this.server) return this.url;
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', async () => {
        const ok = req.method === 'POST' && req.headers.authorization === `Bearer ${this.token}`;
        if (!ok) return res.writeHead(401).end();
        let ask = {};
        try {
          ask = JSON.parse(body);
        } catch {}
        const d = await this.request({ tool: String(ask.tool ?? ''), input: ask.input ?? {} });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d));
      });
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.server.unref();
    this.url = `http://127.0.0.1:${this.server.address().port}/`;
    return this.url;
  }

  /** A tool wants to run: yes now if allowed, no if not on the approve list, else ask and wait. */
  request({ tool, input = {} }) {
    const ask = this.spec.approve.some((p) => toolMatches(p, tool));
    if (!ask && this.spec.allow.some((p) => toolMatches(p, tool))) return Promise.resolve({ allow: true });
    if (!ask) return Promise.resolve({ allow: false, message: `${tool} is not in this agent's allow list` });
    if (!this.channels.size) return Promise.resolve({ allow: false, message: `${tool} needs a person's approval and no one can be asked (no chat page, not connected to AI Agent Manager)` });
    const id = `ap-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.decide(id, false, { by: 'timeout', note: `No answer in ${Math.round(this.timeoutMs / 60_000)} min` }), this.timeoutMs);
      const a = { id, tool, input, run: this.run ?? null, at: new Date().toISOString(), finish: (d) => (clearTimeout(timer), resolve(d)) };
      this.open.set(id, a);
      this.emit('request', this.view(a));
      this.emit('change');
    });
  }

  /** A person's (or the timeout's) answer. Returns false if it was already decided. */
  decide(id, allow, { by = 'someone', note = '' } = {}) {
    const a = this.open.get(id);
    if (!a) return false;
    this.open.delete(id);
    const d = { ...this.view(a), allow: Boolean(allow), by, note, decidedAt: new Date().toISOString() };
    this.decided = [d, ...this.decided].slice(0, 20);
    a.finish({ allow: Boolean(allow), message: allow ? '' : `Declined by ${by}${note ? `: ${note}` : ''}` });
    this.emit('decided', d);
    this.emit('change');
    return true;
  }

  view(a) {
    return { id: a.id, tool: a.tool, input: a.input, run: a.run, at: a.at };
  }

  pending() {
    return [...this.open.values()].map((a) => this.view(a));
  }

  close() {
    for (const id of [...this.open.keys()]) this.decide(id, false, { by: 'shutdown' });
    this.server?.close();
  }
}
