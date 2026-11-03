// Requests you keep making: the asks you type (new agents and backlog items, not ones a playbook,
// trigger or the assistant started) are remembered, the last 500 in ~/.agentmanager/asks.json. When
// 3 or more read alike (the same words once numbers, quoted names, URLs, issue keys and filler are
// set aside), the inbox offers to save them as a playbook: the words they share become the request,
// the part that changes a {{what}} placeholder, and the projects they ran in its projects.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

export const SUGGEST_AFTER = 3;
const KEEP = 500;
const ALIKE = 0.5; // share of distinct words two asks must have in common
const STOP = new Set('a an and are as at be by do does for from get have in into is it its make me my of on or our please should so that the their them then this to up use we with you your'.split(' '));
const err = (status, message) => Object.assign(new Error(message), { status });

/** The words that say what an ask is about, without the parts that change from one to the next. */
export function words(text) {
  const w = String(text ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(^|\s)["'`“‘][^"'`”’\n]{1,80}["'`”’](?=[\s.,;:!?)]|$)/g, ' ')
    .replace(/\b[a-z][a-z0-9]+-\d+\b/g, ' ')
    .replace(/#\d+|\b\d[\w.]*/g, ' ')
    .split(/[^a-z0-9_]+/)
    .filter((x) => x.length > 1 && !STOP.has(x));
  return [...new Set(w)];
}

export function alike(a, b) {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const both = a.filter((x) => sb.has(x)).length;
  return both / (a.length + b.length - both);
}

/** Groups of asks that read alike, newest first; each group's seed is its newest ask. */
export function groups(asks, { threshold = ALIKE } = {}) {
  const out = [];
  // Newest first; asks recorded together keep their order.
  const order = asks.map((a, i) => [a, i]).sort(([x, i], [y, j]) => y.at.localeCompare(x.at) || j - i);
  for (const [ask] of order) {
    const w = words(ask.text);
    if (w.length < 2) continue;
    const g = out.find((x) => alike(x.words, w) >= threshold);
    if (g) g.asks.push(ask);
    else out.push({ words: w, asks: [ask] });
  }
  return out;
}

/**
 * A playbook request from asks that read alike: the words they all start and end with, around a
 * {{what}} for the part that differs ("Upgrade react to the latest" / "Upgrade vite to the latest" →
 * "Upgrade {{what}} to the latest"). When they share too little, the newest ask as it was written.
 */
export function template(texts) {
  const split = texts.map((t) => String(t).trim().split(/\s+/));
  if (texts.every((t) => t.trim() === texts[0].trim())) return texts[0].trim();
  const shortest = Math.min(...split.map((s) => s.length));
  const same = (get) => split.every((s) => get(s) === get(split[0]));
  let pre = 0;
  while (pre < shortest && same((s) => s[pre].toLowerCase())) pre++;
  let suf = 0;
  while (suf < shortest - pre && same((s) => s[s.length - 1 - suf].toLowerCase())) suf++;
  if (pre + suf < Math.max(2, Math.ceil(shortest / 2))) return texts[0].trim();
  const head = split[0].slice(0, pre).join(' ');
  const tail = split[0].slice(split[0].length - suf).join(' ');
  return [head, '{{what}}', tail].filter(Boolean).join(' ');
}

/** A short name for the playbook, from its request. */
export function nameFor(intent) {
  const plain = intent.replace(/\{\{\w+\}\}/g, ' ').replace(/\s+/g, ' ').trim();
  const w = plain.split(' ').slice(0, 6);
  while (w.length > 1 && STOP.has(w[w.length - 1].toLowerCase())) w.pop();
  const name = w.join(' ');
  return (name.charAt(0).toUpperCase() + name.slice(1)).replace(/[.,:;]+$/, '').slice(0, 60) || 'Repeated request';
}

export class Repeats extends EventEmitter {
  constructor({ file = path.join(paths.home, 'asks.json'), suggestAfter = SUGGEST_AFTER, enabled = true, playbooks = () => [], projects = () => ({}) } = {}) {
    super();
    Object.assign(this, { file, suggestAfter, enabled, playbooks, projects });
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
    this.data.asks ??= [];
    this.data.dismissed ??= [];
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    this.changed();
  }

  changed() {
    this.emit('change', this.view());
  }

  /** Asks the person typed: [{ text, projectKey }]. */
  record(asks) {
    const at = new Date().toISOString();
    const list = asks.map((a) => ({ text: String(a.text ?? '').trim().slice(0, 2000), projectKey: a.projectKey ?? null, at })).filter((a) => a.text);
    if (!list.length) return;
    this.data.asks = [...this.data.asks, ...list].slice(-KEEP);
    this.save();
  }

  /** Requests asked for at least suggestAfter times, not already a playbook and not dismissed. */
  suggestions() {
    if (!this.enabled) return [];
    const books = this.playbooks().map((p) => words(p.intent));
    const projects = this.projects();
    const out = [];
    for (const g of groups(this.data.asks)) {
      if (g.asks.length < this.suggestAfter) continue;
      if (books.some((b) => alike(b, g.words) >= ALIKE)) continue;
      if (this.data.dismissed.some((d) => alike(d, g.words) >= ALIKE)) continue;
      const intent = template(g.asks.map((a) => a.text));
      const names = [...new Set(g.asks.map((a) => projects[a.projectKey]).filter(Boolean))];
      out.push({
        key: crypto.createHash('sha1').update([...g.words].sort().join(' ')).digest('hex').slice(0, 12),
        name: nameFor(intent),
        intent,
        projects: names,
        count: g.asks.length,
        examples: [...new Set(g.asks.map((a) => a.text))].slice(0, 3),
        lastAt: g.asks[0].at,
      });
    }
    return out;
  }

  /** "Not now": stop offering this one (asks like it keep counting, but it isn't offered again). */
  dismiss(key) {
    const g = groups(this.data.asks).find((x) => crypto.createHash('sha1').update([...x.words].sort().join(' ')).digest('hex').slice(0, 12) === key);
    if (!g) throw err(404, 'No such suggestion');
    this.data.dismissed = [...this.data.dismissed, g.words].slice(-100);
    this.save();
    return this.view();
  }

  view() {
    return { suggestions: this.suggestions(), suggestAfter: this.suggestAfter };
  }

  inbox() {
    return this.suggestions().map((s) => ({ ...s, kind: 'repeat', key: `repeat:${s.key}`, title: `Save "${s.name}" as a playbook?`, priority: 3 }));
  }
}
