// Local models: what runs on this computer. Ollama, LM Studio, llama.cpp, MLX and any other server
// that speaks the OpenAI API are found by asking their usual addresses (and any in config.json's
// "localModels": { "servers": { "<name>": "<address>" } }), and their models are offered to the
// "Local model" engine (engines/local.js) as "<server>/<model>", say "ollama/qwen3-coder:30b".
// Nothing is sent anywhere but those addresses.

import os from 'node:os';

export const LOCAL_DEFAULTS = { enabled: true, context: 32768 };
export const LOCAL_PRESETS = {
  ollama: { label: 'Ollama', url: 'http://127.0.0.1:11434' },
  lmstudio: { label: 'LM Studio', url: 'http://127.0.0.1:1234' },
  // llama.cpp's llama-server and MLX's mlx_lm.server both start here.
  llamacpp: { label: 'llama.cpp or MLX', url: 'http://127.0.0.1:8080' },
};
const KIND_LABEL = { ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp', mlx: 'MLX', openai: 'OpenAI API' };
export const HARNESSES = ['codex', 'opencode', 'claude'];
const SERVER_ID = /^[a-z][a-z0-9-]{0,30}$/;
const MIN_CONTEXT = 8192;
const MAX_CONTEXT = 1_048_576;

/** An address as kept: http(s), no path but what a proxy needs, no trailing "/v1". Null when it isn't one. */
export function cleanUrl(v) {
  try {
    const u = new URL(String(v ?? '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}`;
  } catch {
    return null;
  }
}

export function localSettings(config = {}) {
  const c = config.localModels ?? {};
  const servers = {};
  for (const [id, p] of Object.entries(LOCAL_PRESETS)) servers[id] = { ...p, preset: true };
  for (const [id, v] of Object.entries(c.servers ?? {})) {
    if (!SERVER_ID.test(id)) continue;
    if (v === false) {
      delete servers[id];
      continue;
    }
    const url = cleanUrl(typeof v === 'string' ? v : v?.url);
    if (url) servers[id] = { label: (typeof v === 'object' && v?.label) || servers[id]?.label || id, url, preset: false };
  }
  const n = Number(c.context);
  return {
    enabled: c.enabled !== false,
    // The room Ollama gives a model for an agent (it starts models with far less); 0 leaves Ollama's own.
    context: n === 0 ? 0 : Number.isInteger(n) && n >= MIN_CONTEXT && n <= MAX_CONTEXT ? n : LOCAL_DEFAULTS.context,
    default: typeof c.default === 'string' && c.default.includes('/') ? c.default : null,
    // The harness "local" stands for; null is the first installed (engines/index.js).
    harness: HARNESSES.includes(c.harness) ? c.harness : null,
    servers,
  };
}

/** "ollama/qwen3-coder:30b" as { server, name }; a model's own name may have slashes. */
export function parseModel(id) {
  const s = String(id ?? '').trim();
  const at = s.indexOf('/');
  if (at < 1 || at === s.length - 1) return null;
  return { server: s.slice(0, at), name: s.slice(at + 1) };
}

/**
 * The copy of an Ollama model with room for an agent: "gpt-oss:20b" with 32768 tokens is
 * "gpt-oss-am32k:20b". A copy is a few lines in Ollama's list; the weights are shared.
 */
export function variantName(name, context) {
  const at = name.lastIndexOf(':');
  const tagged = at > name.lastIndexOf('/');
  return `${tagged ? name.slice(0, at) : name}-am${Math.round(context / 1024)}k:${tagged ? name.slice(at + 1) : 'latest'}`;
}
const VARIANT = /-am\d+k(:[^/]*)?$/;
const untagged = (name) => name.replace(/:latest$/, '');

/** "20.9B" or "568M" as billions of parameters. */
const billions = (v) => {
  const m = /^([\d.]+)\s*([BM])/i.exec(String(v ?? ''));
  return m ? Number(m[1]) / (m[2].toUpperCase() === 'M' ? 1000 : 1) : null;
};

/** Ollama's /api/tags (and /api/ps, for what is in memory) as models; the copies this app makes are left out. */
export function ollamaModels(tags, ps = null) {
  // A copy of ours in memory is its model in memory.
  const loaded = new Set((ps?.models ?? []).map((m) => untagged(String(m.name ?? '').replace(/-am\d+k(?=:[^/]*$|$)/, ''))));
  const out = [];
  for (const m of tags?.models ?? []) {
    const name = String(m?.name ?? '');
    if (!name || VARIANT.test(name)) continue;
    const caps = Array.isArray(m.capabilities) ? m.capabilities : null;
    if (caps && !caps.includes('completion')) continue; // an embedding model
    out.push({
      name: untagged(name),
      sizeBytes: Number(m.size) || null,
      params: m.details?.parameter_size ?? null,
      quant: m.details?.quantization_level ?? null,
      // Older Ollama doesn't say here; null is "not known".
      tools: caps ? caps.includes('tools') : null,
      maxContext: Number(m.details?.context_length) || null,
      loaded: loaded.has(untagged(name)),
    });
  }
  return out;
}

/** LM Studio's /api/v0/models as models. */
export function lmstudioModels(list) {
  return (list?.data ?? [])
    .filter((m) => m?.id && m.type !== 'embeddings')
    .map((m) => ({
      name: String(m.id),
      sizeBytes: null,
      params: null,
      quant: m.quantization ?? null,
      tools: Array.isArray(m.capabilities) ? m.capabilities.includes('tool_use') : null,
      maxContext: Number(m.max_context_length) || null,
      context: Number(m.loaded_context_length) || null,
      loaded: m.state === 'loaded',
    }));
}

/** Any server's /v1/models as models (llama.cpp adds sizes under "meta"). */
export function openaiModels(list) {
  return (list?.data ?? [])
    .filter((m) => m?.id)
    .map((m) => ({
      name: String(m.id),
      sizeBytes: Number(m.meta?.size) || null,
      params: m.meta?.n_params ? `${(m.meta.n_params / 1e9).toFixed(1)}B` : null,
      quant: null,
      tools: null,
      maxContext: Number(m.meta?.n_ctx_train) || null,
      loaded: m.owned_by === 'llamacpp' ? true : null,
    }));
}

/** Whether a model can do an agent's work here, and what to know before choosing it. */
export function judgeModel(m, { memory = os.totalmem() } = {}) {
  const notes = [];
  if (m.tools === false) return { usable: false, notes: ["Can't call tools, which an agent needs to read and change files"] };
  if (m.sizeBytes && m.sizeBytes > memory * 0.7) notes.push('Large for the memory of this computer: expect it to be slow');
  const b = billions(m.params);
  if (b != null && b < 7) notes.push('Small: fine for a quick question, unlikely to manage a task of many steps');
  if (m.tools == null) notes.push("The server doesn't say whether it can call tools");
  return { usable: true, notes };
}

async function getJson(url, { timeoutMs = 1500 } = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** One address: what answers there and its models, or `running: false`. */
export async function probeServer(id, server, { get = getJson, memory = os.totalmem() } = {}) {
  const base = { id, label: server.label, url: server.url, preset: Boolean(server.preset) };
  const done = (kind, models, more = {}) => ({
    ...base,
    label: server.preset && id === 'llamacpp' ? KIND_LABEL[kind] ?? server.label : server.label,
    kind,
    running: true,
    ...more,
    models: models.map((m) => ({ id: `${id}/${m.name}`, ...m, ...judgeModel(m, { memory }) })).sort((a, b) => a.name.localeCompare(b.name)),
  });
  const tags = await get(`${server.url}/api/tags`);
  if (Array.isArray(tags?.models)) {
    const [ps, version] = await Promise.all([get(`${server.url}/api/ps`), get(`${server.url}/api/version`)]);
    return done('ollama', ollamaModels(tags, ps), { version: version?.version ?? null });
  }
  const v0 = await get(`${server.url}/api/v0/models`);
  if (Array.isArray(v0?.data)) return done('lmstudio', lmstudioModels(v0));
  const list = await get(`${server.url}/v1/models`);
  if (Array.isArray(list?.data)) {
    const kind = list.data.some((m) => m?.owned_by === 'llamacpp') ? 'llamacpp' : list.data.some((m) => /^mlx-community\//.test(m?.id ?? '')) ? 'mlx' : 'openai';
    return done(kind, openaiModels(list));
  }
  return { ...base, kind: null, running: false, models: [] };
}

// What the last look found, for checks that can't wait for a new one (engines/local.js).
let seen = null;
export const lastSeen = () => seen;

/** The servers and their models, looked up again when the last look is older than a few seconds. */
export class LocalModels {
  constructor({ config, save = () => {}, probe = probeServer, now = () => Date.now(), keepMs = 10_000 }) {
    Object.assign(this, { config, save, probe, now, keepMs, at: 0, pending: null, found: [] });
  }

  get settings() {
    return localSettings(this.config);
  }

  async look() {
    const s = this.settings;
    this.found = s.enabled ? await Promise.all(Object.entries(s.servers).map(([id, server]) => this.probe(id, server))) : [];
    this.at = this.now();
    seen = this.found;
    return this.found;
  }

  async view({ fresh = false } = {}) {
    if (fresh || this.now() - this.at > this.keepMs) await (this.pending ??= this.look().finally(() => (this.pending = null)));
    const s = this.settings;
    const models = this.found.flatMap((x) => x.models);
    return {
      enabled: s.enabled,
      context: s.context,
      default: s.default,
      memory: os.totalmem(),
      // A server at its usual address that isn't running is not worth a row; one you added is.
      servers: this.found.filter((x) => x.running || !x.preset),
      models: models.filter((m) => m.usable).map((m) => m.id),
    };
  }

  /** Changes from the API: `enabled`, `context`, `default`, `add: { name, url }`, `remove: name`. */
  change(b = {}) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    const next = { ...this.config.localModels, servers: { ...this.config.localModels?.servers } };
    if ('enabled' in b) next.enabled = b.enabled === true || b.enabled === 'on';
    if ('context' in b) {
      const n = Number(b.context);
      if (!(n === 0 || (Number.isInteger(n) && n >= MIN_CONTEXT && n <= MAX_CONTEXT))) throw bad(`The context is a number of tokens from ${MIN_CONTEXT} to ${MAX_CONTEXT}, or 0 to leave the server's own`);
      next.context = n;
    }
    if ('default' in b) {
      const id = String(b.default ?? '').trim();
      if (id && !parseModel(id)) throw bad('A model is written "<server>/<model>", say "ollama/qwen3-coder:30b"');
      next.default = id || null;
    }
    if ('harness' in b) {
      const h = String(b.harness ?? '').trim().toLowerCase();
      if (h && !HARNESSES.includes(h)) throw bad(`The harness is one of ${HARNESSES.join(', ')}`);
      next.harness = h || null;
    }
    if (b.add) {
      const name = String(b.add.name ?? '').trim().toLowerCase();
      const url = cleanUrl(b.add.url);
      if (!SERVER_ID.test(name)) throw bad('A server\'s name is lowercase letters, digits and "-", starting with a letter');
      if (!url) throw bad('The address is an http or https one, say http://127.0.0.1:8081');
      next.servers[name] = url;
    }
    if (b.remove) {
      const name = String(b.remove).trim().toLowerCase();
      if (!localSettings({ localModels: next }).servers[name]) throw bad(`No server named "${name}"`);
      // One of the usual addresses is switched off; one you added is forgotten.
      if (LOCAL_PRESETS[name]) next.servers[name] = false;
      else delete next.servers[name];
    }
    this.config.localModels = next;
    this.save({ localModels: next });
    this.at = 0;
  }
}
