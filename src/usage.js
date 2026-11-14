// Engine usage: how much of each engine's plan limits is used and how much is left, so you know
// before an agent stops, and can hold new work or move it to another engine.
//   Claude Code - its 5-hour and 7-day windows (percent used, when each resets), which it gives its
//                 status line command for Pro, Max and Ultra plans once a session has had a reply.
//                 Sessions started here get a status line that records them (statusline.js).
//   Codex       - the rate limits Codex writes in its session logs, when it reports them.
//   any engine  - a limit an agent actually hit ("usage limit reached… resets 3pm") counts as used
//                 up until it resets.
// Engines that report nothing are listed as that. Nothing is asked of any service, and no model is
// called: these are numbers the engines already hand out on this computer.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './config.js';

export const USAGE_DEFAULTS = { enabled: true, warnAt: 80, holdAt: null };
export const usageFile = () => path.join(paths.home, 'usage', 'claude.json');
export const statusLineScript = () => path.join(path.dirname(fileURLToPath(import.meta.url)), 'statusline.js');
const STALE_MS = 6 * 3_600_000;
const err = (status, message) => Object.assign(new Error(message), { status });
const pct = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 10) / 10)) : null);
const iso = (sec) => (typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : null);

export function usageSettings(config = {}) {
  const u = { ...USAGE_DEFAULTS, ...config.usage };
  const level = (v) => (v === null || v === '' || v === undefined || v === 'off' ? null : Math.max(1, Math.min(100, Math.round(Number(v)) || 0)) || null);
  return { enabled: u.enabled !== false, warnAt: level(u.warnAt), holdAt: level(u.holdAt) };
}

/** Claude Code's `rate_limits` (from its status line input) as windows. */
export function claudeWindows(limits) {
  const out = [];
  for (const [id, label] of [['five_hour', '5-hour session'], ['seven_day', 'Week']]) {
    const used = pct(limits?.[id]?.used_percentage);
    if (used !== null) out.push({ id, label, used, resetsAt: iso(limits[id].resets_at) });
  }
  return out;
}

/** Codex's `rate_limits` (from a token_count record of its session log, written at `at`) as windows. */
export function codexWindows(limits, at = Date.now()) {
  const out = [];
  for (const [id, fallback] of [['primary', '5-hour session'], ['secondary', 'Week']]) {
    const w = limits?.[id];
    const used = pct(w?.used_percent);
    if (used === null) continue;
    const min = Number(w.window_minutes) || null;
    const label = !min ? fallback : min >= 10_000 ? 'Week' : min >= 1440 ? `${Math.round(min / 1440)}-day` : min % 60 === 0 ? `${min / 60}-hour session` : `${min}-minute window`;
    const resetsAt = iso(w.resets_at) ?? (typeof w.resets_in_seconds === 'number' ? new Date(at + w.resets_in_seconds * 1000).toISOString() : null);
    out.push({ id, label, used, resetsAt });
  }
  return out;
}

/** "in 2h 10m", "in 3 days", "now". */
export function untilWords(when, now = Date.now()) {
  const ms = Date.parse(when) - now;
  if (!(ms > 0)) return 'now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  if (m < 48 * 60) return `in ${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `in ${Math.round(m / 1440)} days`;
}

const NOTES = {
  claude: 'Claude Code reports this for Pro, Max and Ultra plans, to sessions started here, once a session has had its first reply.',
  codex: 'Read from Codex\'s session logs when Codex reports its limits (ChatGPT plans).',
};

export class EngineUsage {
  /**
   * `engines()`: the engines as listEngines gives them ({ id, label, installed }); `notify(text,
   * plain)`: an alert; `store`: where the readings are kept between restarts.
   */
  constructor({ store, config, engines, notify = null, onChange = () => {}, file = usageFile(), now = () => Date.now(), log = (m) => console.log(`[agentmgr] ${m}`), timer = true }) {
    Object.assign(this, { store, config, engines, notify, onChange, file, now, log });
    this.fileAt = null;
    if (timer) {
      this.timer = setInterval(() => this.tick(), 20_000);
      this.timer.unref?.();
    }
  }

  close() {
    clearInterval(this.timer);
  }

  get settings() {
    return usageSettings(this.config);
  }

  get state() {
    const s = (this.store.data.usage ??= {});
    s.engines ??= {};
    s.alerted ??= {};
    return s;
  }

  update(patch = {}) {
    const next = { ...this.config.usage };
    for (const k of ['warnAt', 'holdAt']) {
      if (!(k in patch)) continue;
      const v = patch[k];
      if (v === null || v === '' || v === 'off') next[k] = null;
      else if (!(Number(v) >= 1 && Number(v) <= 100)) throw err(400, `${k} must be 1 to 100, or off`);
      else next[k] = Math.round(Number(v));
    }
    if ('enabled' in patch) next.enabled = patch.enabled !== false;
    this.config.usage = next;
    this.onChange();
    return next;
  }

  /** A reading for an engine: its windows as they are at `at`. A window not in this reading keeps its last one. */
  record(engineId, windows, { at = new Date(this.now()).toISOString(), source = null } = {}) {
    if (!windows.length) return false;
    const e = (this.state.engines[engineId] ??= { windows: {} });
    if (e.at && at < e.at) return false; // an older log read late
    let changed = false;
    for (const w of windows) {
      const prev = e.windows[w.id];
      if (!prev || prev.used !== w.used || prev.resetsAt !== w.resetsAt) changed = true;
      e.windows[w.id] = { id: w.id, label: w.label, used: w.used, resetsAt: w.resetsAt ?? null, at };
    }
    Object.assign(e, { at, source });
    if (changed) {
      this.store.save();
      this.onChange();
      this.alert(engineId);
    }
    return changed;
  }

  /** An agent on this engine stopped at a usage limit: used up until it resets. */
  limited(engineId, { text, resetAt = null } = {}) {
    const e = (this.state.engines[engineId] ??= { windows: {} });
    if (e.limited?.text === text && e.limited?.until === resetAt) return;
    e.limited = { text: String(text ?? '').slice(0, 200), until: resetAt, at: new Date(this.now()).toISOString() };
    this.store.save();
    this.onChange();
  }

  /** Claude Code's numbers, as its status line last wrote them. */
  readClaude() {
    let at;
    try {
      at = fs.statSync(this.file).mtimeMs;
    } catch {
      return false;
    }
    if (at === this.fileAt) return false;
    this.fileAt = at;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return this.record('claude', claudeWindows(d.rate_limits), { at: d.at ?? new Date(at).toISOString(), source: `Claude Code${d.version ? ` ${d.version}` : ''}` });
    } catch {
      return false;
    }
  }

  tick() {
    if (!this.settings.enabled) return;
    this.readClaude();
  }

  /** One engine as it stands now: its windows with what is left, and how worried to be. */
  engineView(def) {
    const now = this.now();
    const { warnAt, holdAt } = this.settings;
    const e = this.state.engines[def.id] ?? { windows: {} };
    const windows = Object.values(e.windows).map((w) => {
      // Past its reset, the old number no longer holds: unknown until the next reading.
      const reset = Boolean(w.resetsAt && Date.parse(w.resetsAt) <= now);
      return { id: w.id, label: w.label, used: reset ? null : w.used, left: reset ? null : Math.round((100 - w.used) * 10) / 10, resetsAt: w.resetsAt, resetsIn: w.resetsAt && !reset ? untilWords(w.resetsAt, now) : null, reset, at: w.at, stale: !reset && now - Date.parse(w.at) > STALE_MS };
    });
    const limited = e.limited && (!e.limited.until || Date.parse(e.limited.until) > now) && now - Date.parse(e.limited.at) < 24 * 3_600_000 ? { ...e.limited, resetsIn: e.limited.until ? untilWords(e.limited.until, now) : null } : null;
    const top = Math.max(-1, ...windows.filter((w) => w.used !== null).map((w) => w.used));
    const level = limited ? 'limited' : top < 0 ? 'unknown' : holdAt && top >= holdAt ? 'held' : top >= 95 ? 'high' : warnAt && top >= warnAt ? 'warn' : 'ok';
    return { id: def.id, label: def.label, installed: def.installed !== false, windows, limited, level, top: top < 0 ? null : top, at: e.at ?? null, source: e.source ?? null, note: windows.length ? null : NOTES[def.id] ?? 'This engine does not report its limits here. A limit it hits is still noticed, and shown until it resets.' };
  }

  view() {
    const defs = this.engines();
    const list = defs.filter((d) => d.installed !== false || this.state.engines[d.id]).map((d) => this.engineView(d));
    return { settings: this.settings, default: this.config.engine ?? 'claude', engines: list, worst: list.reduce((a, b) => (rank(b.level) > rank(a?.level) ? b : a), null) };
  }

  /** Near a limit, once per window and reset: an alert. */
  alert(engineId) {
    const { warnAt } = this.settings;
    if (!warnAt) return;
    const def = this.engines().find((d) => d.id === engineId) ?? { id: engineId, label: engineId };
    const v = this.engineView(def);
    for (const w of v.windows) {
      if (w.used === null || w.used < warnAt) continue;
      const key = `${engineId}:${w.id}:${w.resetsAt ?? ''}`;
      if (this.state.alerted[key]) continue;
      this.state.alerted[key] = new Date(this.now()).toISOString();
      const keys = Object.keys(this.state.alerted);
      for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete this.state.alerted[k];
      this.store.save();
      const words = `${def.label}: ${Math.round(w.used)}% of the ${w.label.toLowerCase()} limit is used (${Math.round(w.left)}% left)${w.resetsIn ? `; it resets ${w.resetsIn}` : ''}`;
      this.log(words);
      this.notify?.(`:hourglass_flowing_sand: *${words}*`, words)?.catch?.(() => {});
    }
  }

  /** With "hold new work" set: no new agent on an engine at or past that much of a limit. */
  policy(action, details) {
    if (action !== 'agent.create') return undefined;
    const { enabled, holdAt } = this.settings;
    if (!enabled || !holdAt) return undefined;
    const id = details.input?.engine ?? 'claude';
    const def = this.engines().find((d) => d.id === id);
    if (!def) return undefined;
    const v = this.engineView(def);
    const w = v.windows.filter((x) => x.used !== null && x.used >= holdAt).sort((a, b) => b.used - a.used)[0];
    if (!w && !v.limited) return undefined;
    const why = w ? `${Math.round(w.used)}% of its ${w.label.toLowerCase()} limit is used${w.resetsIn ? ` (resets ${w.resetsIn})` : ''}` : `it stopped at a limit${v.limited.resetsIn ? ` (resets ${v.limited.resetsIn})` : ''}`;
    return { allow: false, reason: `${def.label} is held for new work: ${why}. Start it on another engine, wait for the reset, or change "hold new work" in Usage` };
  }
}

const rank = (level) => ({ unknown: 0, ok: 1, warn: 2, high: 3, held: 4, limited: 5 }[level] ?? -1);
