// Approval rules learned from your answers: when you keep saying yes to the same command in a repo
// ("npm test", three times), the inbox offers to always allow it there. Allowed rules go to every
// agent in that repo at launch (Claude Code's --allowedTools) and answer its live prompts, so the
// same question isn't asked again. Kept in ~/.agentmanager/rules.json, per repo (the repo-memory key).
// A rule allowed in two or more repos is offered for every repo ("*"), and a few read-only
// commands never ask anywhere (config.json "rules": { "readOnly": false } turns that off).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

export const SUGGEST_AFTER = 3;
export const EVERY_REPO = '*';
// Repos that allow the same rule before it is offered for every repo.
const SUGGEST_EVERYWHERE_AFTER = 2;
// Commands that only look: allowed in every repo from the start.
export const READ_ONLY = ['ls', 'pwd', 'wc', 'git status', 'git diff', 'git log', 'git show', 'git blame', 'git rev-parse'].map((c) => `Bash(${c}:*)`);
// Commands whose first words name a subcommand: "npm test" is a rule, "npm" alone would allow anything npm does.
const SUBCOMMANDS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'node', 'deno', 'git', 'gh', 'cargo', 'go', 'make', 'python', 'python3', 'uv', 'pip', 'poetry', 'pytest', 'mvn', 'gradle', './gradlew', 'dotnet', 'swift', 'xcodebuild', 'bundle', 'rake', 'rails', 'mix', 'composer', 'php', 'docker', 'kubectl', 'terraform', 'just', 'task']);
// Never offered as a standing rule, however often approved: they delete, escalate, publish or reach out.
const NEVER = /^(rm|sudo|su|chmod|chown|dd|mkfs|kill|killall|pkill|shutdown|reboot|curl|wget|ssh|scp|rsync|eval|exec|sh|bash|zsh|env|xargs|find|git (push|reset|clean|rebase|checkout|branch|tag)|gh (pr merge|release|repo|api|secret)|npm (publish|unpublish|login|adduser|token)|docker (rm|rmi|system|push|login)|kubectl (delete|apply)|terraform (apply|destroy))$/;
// Anything that chains, redirects or substitutes isn't one command, so no rule covers it.
const COMPOUND = /[;&|<>`$(){}\n\\]/;

/** The words of a plain command, or null when it chains, redirects, substitutes or sets variables. */
function words(command) {
  const cmd = String(command ?? '').trim();
  if (!cmd || COMPOUND.test(cmd)) return null;
  const w = cmd.split(/\s+/);
  return /^\w+=/.test(w[0]) ? null : w;
}

/**
 * The rule that would allow a tool call, as Claude Code writes it, with a label for people:
 * Bash → "Bash(npm test:*)", WebFetch → "WebFetch(domain:docs.x.com)", an MCP tool → its name.
 * Null for calls that shouldn't become a standing rule (file edits: use Accept edits instead).
 */
export function ruleFor(tool) {
  const input = tool?.input ?? {};
  if (tool?.name === 'Bash') {
    const w = words(input.command);
    if (!w) return null;
    const prefix = (SUBCOMMANDS.has(w[0]) && w[1] && !w[1].startsWith('-') ? w.slice(0, 2) : w.slice(0, 1)).join(' ');
    if (NEVER.test(prefix) || NEVER.test(w[0])) return null;
    return { rule: `Bash(${prefix}:*)`, label: prefix };
  }
  if (tool?.name === 'WebFetch') {
    try {
      const host = new URL(input.url).hostname;
      return host ? { rule: `WebFetch(domain:${host})`, label: `fetch from ${host}` } : null;
    } catch {
      return null;
    }
  }
  if (/^mcp__[\w-]+__[\w-]+$/.test(tool?.name ?? '')) return { rule: tool.name, label: tool.name.replace(/^mcp__/, '').replace('__', ': ') };
  return null;
}

/** Whether an allowed rule covers this tool call. */
export function covers(rule, tool) {
  const m = /^Bash\((.+):\*\)$/.exec(rule);
  if (m) {
    const w = words(tool?.input?.command);
    return tool?.name === 'Bash' && Boolean(w) && (w.join(' ') === m[1] || w.join(' ').startsWith(`${m[1]} `));
  }
  return ruleFor(tool)?.rule === rule;
}

/** What a pending tool call is, in a few words for an inbox card. */
export function describeTool(tool) {
  const input = tool?.input ?? {};
  if (tool?.name === 'Bash') return { name: 'Bash', text: String(input.command ?? '').slice(0, 300) };
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'].includes(tool?.name)) return { name: tool.name, text: String(input.file_path ?? input.notebook_path ?? '') };
  if (tool?.name === 'WebFetch') return { name: 'WebFetch', text: String(input.url ?? '') };
  return { name: String(tool?.name ?? ''), text: JSON.stringify(input).slice(0, 300) };
}

export class Rules extends EventEmitter {
  constructor({ file = path.join(paths.home, 'rules.json'), suggestAfter = SUGGEST_AFTER, readOnly = true } = {}) {
    super();
    this.file = file;
    this.suggestAfter = suggestAfter;
    this.readOnly = readOnly !== false;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
    this.data.repos ??= {};
    this.data.everywhere ??= { allow: [], dismissed: [] };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    this.emit('change', this.view());
  }

  repo(key) {
    return (this.data.repos[key] ??= { allow: [], dismissed: [], seen: {} });
  }

  /** Where a repo key's rules live: a repo, or every repo. */
  scope(key) {
    return key === EVERY_REPO ? this.data.everywhere : this.data.repos[key];
  }

  /** The rules allowed in a repo (its own, every repo's, the read-only ones), as Claude Code allow rules. */
  allowed(key) {
    const own = (this.data.repos[key]?.allow ?? []).map((r) => r.rule);
    const all = this.data.everywhere.allow.map((r) => r.rule);
    return [...new Set([...own, ...all, ...(this.readOnly ? READ_ONLY : [])])];
  }

  /** The allowed rule that covers this call in this repo, if any. */
  allows(key, tool) {
    return this.allowed(key).find((r) => covers(r, tool)) ?? null;
  }

  /** An allowed rule answered a prompt by itself: count it, so the list shows what it saves. */
  used(key, rule) {
    const a = this.data.repos[key]?.allow.find((x) => x.rule === rule) ?? this.data.everywhere.allow.find((x) => x.rule === rule);
    if (!a) return;
    a.uses = (a.uses ?? 0) + 1;
    a.lastUsedAt = new Date().toISOString();
    this.save();
  }

  /** You said yes to this call in this repo; count it toward a suggestion. */
  approved(key, tool) {
    const r = ruleFor(tool);
    if (!r) return null;
    if (this.allowed(key).includes(r.rule)) return null;
    const repo = this.repo(key);
    const seen = (repo.seen[r.rule] ??= { label: r.label, n: 0 });
    seen.n++;
    seen.at = new Date().toISOString();
    this.save();
    return { ...r, n: seen.n };
  }

  accept(key, rule) {
    if (key === EVERY_REPO) {
      const e = this.data.everywhere;
      const from = Object.values(this.data.repos).flatMap((r) => r.allow).find((x) => x.rule === rule);
      if (!from && !e.allow.some((x) => x.rule === rule)) throw Object.assign(new Error('No such suggestion'), { status: 404 });
      if (!e.allow.some((x) => x.rule === rule)) e.allow.push({ rule, label: from.label, at: new Date().toISOString(), uses: 0 });
      // One rule for every repo replaces the repos' own copies (their uses carry over).
      for (const r of Object.values(this.data.repos)) {
        const own = r.allow.find((x) => x.rule === rule);
        if (own) e.allow.find((x) => x.rule === rule).uses += own.uses ?? 0;
        r.allow = r.allow.filter((x) => x.rule !== rule);
      }
      this.save();
      return;
    }
    const repo = this.data.repos[key];
    const seen = repo?.seen[rule];
    if (!seen && !repo?.allow.some((x) => x.rule === rule)) throw Object.assign(new Error('No such suggestion'), { status: 404 });
    if (!repo.allow.some((x) => x.rule === rule)) repo.allow.push({ rule, label: seen.label, at: new Date().toISOString() });
    delete repo.seen[rule];
    this.save();
  }

  /** "Not now": stop suggesting it (it can still be allowed later from the list). */
  dismiss(key, rule) {
    if (key === EVERY_REPO) {
      if (!this.view().suggestions.some((s) => s.repo === EVERY_REPO && s.rule === rule)) throw Object.assign(new Error('No such suggestion'), { status: 404 });
      this.data.everywhere.dismissed.push(rule);
      this.save();
      return;
    }
    const repo = this.data.repos[key];
    if (!repo?.seen[rule]) throw Object.assign(new Error('No such suggestion'), { status: 404 });
    if (!repo.dismissed.includes(rule)) repo.dismissed.push(rule);
    this.save();
  }

  remove(key, rule) {
    const repo = this.scope(key);
    if (!repo?.allow.some((x) => x.rule === rule)) throw Object.assign(new Error('No such rule'), { status: 404 });
    repo.allow = repo.allow.filter((x) => x.rule !== rule);
    repo.dismissed = repo.dismissed.filter((x) => x !== rule);
    this.save();
  }

  /** Every repo's allowed rules and the suggestions waiting for an answer. */
  view() {
    const allowed = [];
    const suggestions = [];
    for (const [repo, r] of Object.entries(this.data.repos)) {
      for (const a of r.allow) allowed.push({ repo, ...a });
      for (const [rule, s] of Object.entries(r.seen)) if (s.n >= this.suggestAfter && !r.dismissed.includes(rule)) suggestions.push({ repo, rule, label: s.label, n: s.n, at: s.at });
    }
    // Allowed in several repos: offer it for every repo.
    const repos = new Map();
    for (const a of allowed) repos.set(a.rule, [...(repos.get(a.rule) ?? []), a]);
    for (const [rule, list] of repos) {
      if (list.length >= SUGGEST_EVERYWHERE_AFTER && !this.data.everywhere.dismissed.includes(rule)) {
        suggestions.push({ repo: EVERY_REPO, rule, label: list[0].label, n: list.length, everywhere: true, at: list.map((x) => x.at).sort().at(-1) });
      }
    }
    for (const a of this.data.everywhere.allow) allowed.push({ repo: EVERY_REPO, ...a });
    return { allowed, suggestions, suggestAfter: this.suggestAfter, readOnly: this.readOnly ? READ_ONLY.map((r) => r.slice(5, -3)) : [] };
  }
}
