// Ground rules: the person's own rules for every agent, in every repository and on every engine,
// given with each session's instructions next to (not instead of) the repository's memory and
// standards. Memory is what agents learned; standards are per repository; these are how this
// person wants agents to work anywhere ("ask before adding a dependency", "never force-push").
// One Markdown file, ~/.agentmanager/ground-rules.md, one rule per line. Only the person sets
// them: an agent's own calls to change them are refused (server.js).
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

export const MAX_RULES = 40;
export const MAX_RULE_CHARS = 400;
const err = (status, message) => Object.assign(new Error(message), { status });

export const groundRulesFile = () => path.join(paths.home, 'ground-rules.md');

/** The rules in a text: one per line, list marks and numbers dropped, no empty lines, no repeats. */
export function parseRules(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\s+/g, ' ').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
    if (!line || /^#/.test(line) || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(line);
  }
  return out;
}

/** The rules the person sent, checked: a text or a list. Throws with a status when one is too long or there are too many. */
export function cleanRules(input) {
  const rules = parseRules(Array.isArray(input) ? input.join('\n') : input);
  const long = rules.find((r) => r.length > MAX_RULE_CHARS);
  if (long) throw err(400, `A ground rule is one short line (${MAX_RULE_CHARS} characters at most): "${long.slice(0, 60)}…"`);
  if (rules.length > MAX_RULES) throw err(400, `At most ${MAX_RULES} ground rules: a long list is not followed, keep the ones that matter`);
  return rules;
}

/** What every session is told, or '' when there are none. */
export function groundRulesPrompt(rules) {
  if (!rules?.length) return '';
  return [
    'Ground rules from the user, for everything you do in this session. They come before your own preferences and before what the repository\'s memory suggests. ' +
      'If the task cannot be done without breaking one, stop and say which and why (in the brief, or as a question) instead of working around it:',
    ...rules.map((r) => `- ${r}`),
  ].join('\n');
}

/** For a session that is already running when the rules change. */
export const groundRulesMessage = (rules) =>
  rules.length
    ? `The user changed their ground rules. From now on, these apply to everything you do in this session (they replace any ground rules you were given before):\n${rules.map((r) => `- ${r}`).join('\n')}`
    : 'The user removed their ground rules: the ones you were given at the start no longer apply.';

export class GroundRules {
  constructor({ file = groundRulesFile() } = {}) {
    this.file = file;
    this.cache = null; // { mtimeMs, rules }
  }

  /** The rules now (read again when the file changed: it can be edited by hand). */
  list() {
    try {
      const { mtimeMs } = fs.statSync(this.file);
      if (this.cache?.mtimeMs !== mtimeMs) this.cache = { mtimeMs, rules: parseRules(fs.readFileSync(this.file, 'utf8')).slice(0, MAX_RULES) };
      return this.cache.rules;
    } catch {
      this.cache = null;
      return [];
    }
  }

  view() {
    const rules = this.list();
    let updatedAt = null;
    try {
      updatedAt = fs.statSync(this.file).mtime.toISOString();
    } catch {}
    return { rules, text: rules.join('\n'), file: this.file, max: MAX_RULES, maxChars: MAX_RULE_CHARS, updatedAt };
  }

  /** Replace the rules. Returns { changed, ...view }. */
  set(input) {
    const rules = cleanRules(input);
    const changed = JSON.stringify(rules) !== JSON.stringify(this.list());
    if (changed) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, rules.length ? `${rules.map((r) => `- ${r}`).join('\n')}\n` : '');
      this.cache = null;
    }
    return { changed, ...this.view() };
  }

  prompt() {
    return groundRulesPrompt(this.list());
  }
}
