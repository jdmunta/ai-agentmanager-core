// agent.yaml: what an agentkit agent is (docs/agentkit.md). Loaded once at start: paths resolved
// against the agent's folder, ${VAR} filled from the environment, defaults applied, mistakes
// reported in one message.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const ENGINES = new Set(['claude', 'codex', 'muse']);
const DURATION = /^(\d+)\s*(s|m|h|d)$/;
export const toMs = (d) => {
  const m = DURATION.exec(String(d).trim());
  return m ? Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]] : null;
};

/** ${VAR} from the environment (missing ones become empty, and are reported). */
function fillEnv(value, env, missing) {
  if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (_, k) => (k in env ? env[k] : (missing.add(k), '')));
  if (Array.isArray(value)) return value.map((v) => fillEnv(v, env, missing));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillEnv(v, env, missing)]));
  return value;
}

/** Read and check an agent: a folder with agent.yaml (or agent.json), or the file itself. */
export function loadAgent(ref, { env = process.env } = {}) {
  let file = path.resolve(ref);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = ['agent.yaml', 'agent.yml', 'agent.json'].map((n) => path.join(file, n)).find((f) => fs.existsSync(f)) ?? path.join(file, 'agent.yaml');
  }
  if (!fs.existsSync(file)) throw new Error(`No agent.yaml at ${file}`);
  const dir = path.dirname(file);
  const raw = file.endsWith('.json') ? JSON.parse(fs.readFileSync(file, 'utf8')) : YAML.parse(fs.readFileSync(file, 'utf8'));
  return checkAgent(raw ?? {}, { dir, env, file });
}

export function checkAgent(raw, { dir, env = process.env, file = 'agent.yaml' } = {}) {
  const errors = [];
  const missing = new Set();
  const a = fillEnv(raw, env, missing);
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(a.name ?? '')) errors.push('name: lowercase letters, digits and "-" (2-41 characters), starting with a letter');
  if (!String(a.goal ?? '').trim()) errors.push('goal: say what the agent achieves');
  const engine = String(a.engine ?? 'claude');
  if (!ENGINES.has(engine) && !/^acp:[a-z0-9-]+$/.test(engine)) errors.push(`engine: claude, codex, muse or acp:<name> (not "${engine}")`);
  // Instructions: a file next to agent.yaml, or inline text.
  let instructions = String(a.instructions ?? '');
  if (instructions && !instructions.includes('\n') && /\.(md|txt)$/.test(instructions)) {
    const f = path.resolve(dir, instructions);
    if (fs.existsSync(f)) instructions = fs.readFileSync(f, 'utf8');
    else errors.push(`instructions: ${instructions} not found next to the agent`);
  }
  const triggers = (Array.isArray(a.triggers) ? a.triggers : []).map((t, i) => {
    if (t?.every != null) {
      const ms = toMs(t.every);
      if (!ms || ms < 10_000) errors.push(`triggers[${i}].every: a duration of at least 10s, like 10m or 1h`);
      return { kind: 'every', ms, label: `every ${t.every}` };
    }
    if (t?.cron) {
      if (String(t.cron).trim().split(/\s+/).length !== 5) errors.push(`triggers[${i}].cron: five fields (minute hour day month weekday)`);
      return { kind: 'cron', cron: String(t.cron), label: `cron ${t.cron}` };
    }
    if (t?.webhook) return { kind: 'webhook', path: `/${String(t.webhook).replace(/^\/+/, '')}`, label: `webhook ${t.webhook}` };
    if (t?.watch) return { kind: 'watch', dir: path.resolve(dir, String(t.watch)), label: `watch ${t.watch}` };
    errors.push(`triggers[${i}]: every, cron, webhook or watch`);
    return null;
  }).filter(Boolean);
  const approveTimeoutMs = a.approveTimeout != null ? toMs(a.approveTimeout) : 30 * 60_000;
  if (!approveTimeoutMs) errors.push('approveTimeout: a duration, like 30m or 2h');
  // Where it reports its runs and asks for approvals: AI Agent Manager (the environment wins).
  // cert: the SHA-256 fingerprint of its remote-access certificate (self-signed), when over https.
  const report = { url: env.AGENTKIT_REPORT_URL || a.report?.url || null, token: env.AGENTKIT_REPORT_TOKEN || a.report?.token || null, cert: env.AGENTKIT_REPORT_CERT || a.report?.cert || null };
  if (report.url && !/^https?:\/\//.test(report.url)) errors.push('report.url: an http(s) address of AI Agent Manager');
  const loop = { plan: true, check: true, maxSteps: 4, budgetUsd: null, ...(a.loop ?? {}) };
  loop.maxSteps = Math.max(1, Math.min(20, Number(loop.maxSteps) || 4));
  const iface = a.interfaces ?? {};
  const out = {
    name: a.name,
    title: String(a.title ?? a.name ?? ''),
    description: String(a.description ?? ''),
    goal: String(a.goal ?? '').trim(),
    instructions: instructions.trim(),
    engine,
    model: a.model ? String(a.model) : null,
    dir,
    file,
    workdir: path.resolve(dir, String(a.workdir ?? './work')),
    tools: a.tools && typeof a.tools === 'object' ? a.tools : {},
    allow: [a.allow ?? []].flat().map(String),
    approve: [a.approve ?? []].flat().map(String),
    approveTimeoutMs,
    report: report.url ? report : null,
    triggers,
    loop,
    memory: a.memory !== false,
    interfaces: {
      http: iface.http === false ? null : { port: Number(iface.http?.port ?? 7700), host: String(iface.http?.host ?? '127.0.0.1') },
      a2a: iface.a2a !== false,
      acp: iface.acp !== false,
      mcp: iface.mcp !== false,
    },
    missingEnv: [...missing],
  };
  if (errors.length) throw Object.assign(new Error(`${file}:\n- ${errors.join('\n- ')}`), { errors });
  return out;
}

/** The agent's own files: memory, run logs and engine sessions per conversation. */
export function agentPaths(agent) {
  const state = path.join(agent.dir, '.agentkit');
  return { state, memory: path.join(state, 'memory.md'), runs: path.join(state, 'runs'), sessions: path.join(state, 'sessions.json'), mcp: path.join(state, 'mcp.json') };
}
