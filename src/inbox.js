// Decision inbox: questions agents ask without stopping, answered from one place.
// Agents append questions to QUESTIONS.md next to their brief; answers go back into
// their session as a message. Live prompts (permission menus) are answered with keys.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { briefDir } from './brief.js';

export const QUESTIONS_FILE = 'QUESTIONS.md';
export const questionsPath = (agentId) => path.join(briefDir(agentId), QUESTIONS_FILE);

export const questionsPrompt = (file) =>
  `When you need a decision from the user that doesn't have to stop all your work (a choice between options, ` +
  `a preference, a missing detail), don't wait in the terminal: add it to ${file} and keep going on whatever you can ` +
  'do meanwhile, using your best default. AI Agent Manager collects these into the user\'s inbox. One question per heading, ' +
  'never edit or remove earlier ones:\n' +
  '## <the question, one line>\n' +
  'Options: <option A> | <option B>   (optional)\n' +
  'Default: <what you will assume until answered>   (optional)\n' +
  '<one or two lines of context>   (optional)\n' +
  'Answers arrive in this session as a message starting with "Answer to your question". Apply them when they come. ' +
  'Use the terminal (or your question tool) only when you truly cannot continue without the answer.';

const qid = (text) => crypto.createHash('sha1').update(text.trim().toLowerCase()).digest('hex').slice(0, 10);

/** Parse QUESTIONS.md into [{ id, question, options, default, context }]. */
export function parseQuestions(markdown) {
  const out = [];
  let cur = null;
  for (const raw of String(markdown ?? '').split('\n')) {
    const line = raw.trimEnd();
    const h = /^#{2,3}\s+(?:Q\d*[:.]\s*)?(.+)$/.exec(line);
    if (h) {
      cur = { id: qid(h[1]), question: h[1].trim(), options: [], default: null, context: '' };
      if (!out.some((q) => q.id === cur.id)) out.push(cur);
      else cur = null;
      continue;
    }
    if (!cur) continue;
    const opt = /^\s*options?\s*:\s*(.+)$/i.exec(line);
    const def = /^\s*(?:default|proceeding with|assuming)\s*:\s*(.+)$/i.exec(line);
    if (opt) cur.options = opt[1].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 6);
    else if (def) cur.default = def[1].trim();
    else if (line.trim()) cur.context = `${cur.context ? `${cur.context} ` : ''}${line.trim()}`.slice(0, 600);
  }
  return out;
}

const cache = new Map(); // file -> { mtimeMs, questions }
export function loadQuestions(agentId) {
  const file = questionsPath(agentId);
  try {
    const { mtimeMs } = fs.statSync(file);
    const hit = cache.get(file);
    if (hit?.mtimeMs === mtimeMs) return hit.questions;
    const questions = parseQuestions(fs.readFileSync(file, 'utf8'));
    cache.set(file, { mtimeMs, questions });
    return questions;
  } catch {
    cache.delete(file);
    return [];
  }
}

export const answerMessage = (q, text) => `Answer to your question "${q.question}": ${text}`;

/** Menu entries that are not an answer: free text, or talking it over. */
export const FREE_CHOICE = /^(?:type something|chat about this|other)\b/i;

/**
 * Claude Code's question menu (the agent asking the person to pick): the question, its numbered
 * options with the line under each, and which one is highlighted. Text sent to the terminal while
 * it is open is not read as a message (Enter picks the highlighted option), so it counts as a
 * prompt. Returns { question, choices: [{ key, label, hint }], selected, multi } or null.
 */
export function questionMenu(screen) {
  const text = String(screen ?? '')
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Math.min(Number(n || 1), 8)))
    .replace(/\x1b\[\d*G/g, ' ')
    .replace(/\x1b\[[0-9;]*[ABEFHJf]/g, '\n')
    .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\r/g, '\n');
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const end = lines.findLastIndex((l) => /Enter to select/i.test(l));
  if (end < 0) return null;
  const choices = [];
  let hint = [];
  let selected = null;
  let multi = false;
  let top = -1;
  for (let i = end - 1; i >= 0 && top < 0; i--) {
    const l = lines[i];
    if (!l || /^[─━╌-]+$/.test(l)) continue;
    const m = /^([❯>›]\s*)?(\[[ x✔✓]?\]\s*|[☐☑◻◼]\s*)?(\d)[.)]\s+(.{1,120})$/.exec(l);
    if (!m) {
      if (choices.length) hint.unshift(l);
      else if (!/^(?:\d[.)])?$/.test(l)) hint = [];
      continue;
    }
    if (choices.some((c) => c.key === m[3])) break; // an older menu above this one
    choices.unshift({ key: m[3], label: m[4].trim(), hint: hint.join(' ').slice(0, 200) });
    hint = [];
    if (m[1]) selected = m[3];
    if (m[2]) multi = true;
    if (m[3] === '1') top = i;
  }
  if (top < 0 || choices.length < 2) return null;
  let question = '';
  for (let i = top - 1; i >= 0 && !question; i--) {
    if (lines[i] && !/^[─━╌-]+$/.test(lines[i])) question = lines[i].slice(0, 300);
  }
  return { question, choices, selected, multi };
}

/**
 * Answer choices visible in a live prompt: numbered menu lines ("❯ 1. Yes", "2. No").
 * `screen` is recent terminal output; cursor moves become spaces before matching.
 */
export function promptChoices(screen) {
  const text = String(screen ?? '')
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Math.min(Number(n || 1), 8)))
    // A jump along the line is a gap, not a new line. Claude Code redraws only the cells that
    // changed, so a prompt can arrive as "pro" + jump + "eed?" and "❯ 1" + jump + "Yes".
    .replace(/\x1b\[\d*G/g, ' ')
    .replace(/\x1b\[[0-9;]*[ABDHJKfm]/g, '\n')
    .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\r/g, '\n');
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  // The last menu on screen wins: walk back from the end, collecting "N. label" lines.
  const choices = new Map();
  let question = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    // The highlighted choice can lose its dot to a redraw ("❯ 1 Yes"): the pointer marks it as one.
    const m = /^(?:[❯>›]\s*(\d)[.)]?|(\d)[.)])\s+(.{1,80})$/.exec(lines[i]);
    if (m) {
      const key = m[1] ?? m[2];
      if (!choices.has(key)) choices.set(key, m[3].replace(/\s*·.*$/, '').trim());
    } else if (choices.size && lines[i]) {
      question = lines[i].slice(0, 200);
      break;
    }
  }
  // Newer Claude Code can draw a menu as one run of text ("Do you want to proceed? ❯ 1. Yes 2. Yes,
  // and switch to auto mode 3. No Esc to cancel"): read the flattened screen after the last question.
  if (!choices.size) {
    const flat = lines.join(' ').replace(/\s+/g, ' ');
    const at = flat.search(/\?\s*(?:[❯>›]\s*1[.)]?|1[.)])\s*\S[^?]*$/);
    if (at >= 0) {
      const head = flat.slice(0, at + 1);
      // Drop what's left of the box around it (╌ ─ │ and stray letters before them).
      question = (/([^.?!│]*\?)$/.exec(head)?.[1] ?? '').replace(/^.*[╌─│━]+\s*/, '').trim().slice(-200);
      for (const m of flat.slice(at + 1).matchAll(/(?:[❯>›]\s*(\d)[.)]?|\b(\d)[.)])\s*(.+?)(?=\s+(?:[❯>›]\s*)?\d[.)]\s|\s+Esc to cancel|\s+Enter to|$)/g)) {
        const key = m[1] ?? m[2];
        if (!choices.has(key)) choices.set(key, m[3].replace(/\s*·.*$/, '').trim().slice(0, 80));
      }
    }
  }
  return {
    question,
    choices: [...choices.entries()].sort(([a], [b]) => a - b).map(([key, label]) => ({ key, label })),
  };
}
