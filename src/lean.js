#!/usr/bin/env node
// Lean output: long command output, trimmed before the agent reads it, so a plan's limits last
// longer. Claude Code runs this after each shell command of a session started here (a PostToolUse
// hook) with the command and its output as JSON on stdin; when the output is long, what comes back
// is a shorter version: colour codes and progress redraws gone, runs of near-identical lines
// folded, and of a long middle only the lines that look like errors or warnings. The start and the
// end stay, and the whole output is saved to a file the trimmed version names, so nothing is lost:
// the agent reads the file when it needs a part that was left out. No model is called.
// Standalone when run by Claude Code (node built-ins only); the daemon imports the helpers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEAN_DEFAULTS = { enabled: false, minLines: 80, head: 30, tail: 50, keep: 60 };
const MAX_LINE = 400;
const KEEP_DAYS = 2;
// Lines worth keeping from the middle of a long output.
const IMPORTANT = /\b(error|errors|err!|fail(ed|ure|ures|ing)?|fatal|panic(ked)?|exception|traceback|warn(ing|ings)?|denied|refused|timed? ?out|not ok|cannot|can't|unable to|undefined reference|segmentation fault|assert(ion)?|deprecated)\b|✗|✖|×|FAIL|\bE\d{3,4}\b/i;

export const leanScript = () => fileURLToPath(import.meta.url);
export const leanSettings = (config = {}) => ({ ...LEAN_DEFAULTS, ...config.lean, enabled: config.lean?.enabled === true });

/** Colour codes and cursor moves out; of a line redrawn in place (a progress bar), what it ended as. */
export function plain(text) {
  return String(text ?? '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.includes('\r') ? l.split('\r').filter(Boolean).pop() ?? '' : l))
    .join('\n');
}

/** A line with its numbers, hashes and times taken out: lines alike but for those are one kind. */
const kind = (line) => line.replace(/0x[0-9a-f]+|\b[0-9a-f]{7,40}\b|\d+([.,:]\d+)*/gi, '#').replace(/\s+/g, ' ').trim();

/** Runs of three or more lines of one kind: the first, how many followed, and the last. */
export function fold(lines) {
  const out = [];
  for (let i = 0; i < lines.length; ) {
    const k = kind(lines[i]);
    let j = i + 1;
    while (j < lines.length && k && kind(lines[j]) === k) j++;
    if (j - i >= 4 && !IMPORTANT.test(lines[i])) {
      out.push(lines[i], `  … ${j - i - 2} more lines like it …`, lines[j - 1]);
    } else {
      for (let n = i; n < j; n++) out.push(lines[n]);
    }
    i = j;
  }
  return out;
}

/**
 * The trimmed version of a command's output, or null when it is short enough as it is.
 * { text, before, after } with the counts in lines; `where` is the file the whole output is in.
 */
export function leanText(text, { minLines = LEAN_DEFAULTS.minLines, head = LEAN_DEFAULTS.head, tail = LEAN_DEFAULTS.tail, keep = LEAN_DEFAULTS.keep, where = null } = {}) {
  const raw = String(text ?? '');
  const all = plain(raw).split('\n');
  if (all.length < minLines && raw.length < minLines * 100) return null;
  let lines = fold(all.map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)} … (${l.length - MAX_LINE} more characters)` : l)));
  if (lines.length > head + tail + 10) {
    const mid = lines.slice(head, lines.length - tail);
    // From the middle: the lines that look like trouble, each with the line before it.
    const want = new Set();
    for (let i = 0; i < mid.length && want.size < keep; i++) {
      if (!IMPORTANT.test(mid[i])) continue;
      if (i > 0) want.add(i - 1);
      want.add(i);
    }
    const kept = [];
    let last = -1;
    for (const i of [...want].sort((a, b) => a - b)) {
      if (i - last > 1) kept.push(`  … ${i - last - 1} lines left out …`);
      kept.push(mid[i]);
      last = i;
    }
    if (mid.length - last > 1) kept.push(`  … ${mid.length - last - 1} lines left out …`);
    lines = [...lines.slice(0, head), ...kept, ...lines.slice(lines.length - tail)];
  }
  const body = lines.join('\n');
  // Not worth it unless a good part goes.
  if (body.length > raw.length * 0.7) return null;
  const note = `[lean output: ${all.length.toLocaleString('en-US')} lines trimmed to ${lines.length.toLocaleString('en-US')}; errors and warnings kept.${where ? ` The whole output is in ${where}: read it (or search it) if you need a part that was left out.` : ''}]`;
  return { text: `${body}\n${note}`, before: all.length, after: lines.length, saved: raw.length - body.length - note.length };
}

/** What trimming has saved in a folder of agents' outputs: { calls, saved (characters), tokens (about) }. */
export function leanStats(dir) {
  let calls = 0;
  let saved = 0;
  try {
    for (const d of fs.readdirSync(dir)) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, d, 'stats.json'), 'utf8'));
        calls += s.calls ?? 0;
        saved += s.saved ?? 0;
      } catch {}
    }
  } catch {}
  return { calls, saved, tokens: Math.round(saved / 4) };
}

/** Whole outputs older than a couple of days go (the counts stay). */
export function leanSweep(dir, now = Date.now()) {
  let n = 0;
  try {
    for (const d of fs.readdirSync(dir)) {
      for (const f of fs.readdirSync(path.join(dir, d))) {
        if (!f.endsWith('.txt')) continue;
        const file = path.join(dir, d, f);
        if (now - fs.statSync(file).mtimeMs > KEEP_DAYS * 86_400_000) {
          fs.rmSync(file, { force: true });
          n++;
        }
      }
    }
  } catch {}
  return n;
}

/** The hook's answer to one PostToolUse event (the JSON Claude Code gave), or null to leave the output alone. */
export function leanHook(input, { dir = null, settings = LEAN_DEFAULTS } = {}) {
  const r = input?.tool_response;
  if (input?.tool_name !== 'Bash' || !r || typeof r.stdout !== 'string' || r.isImage || !dir) return null;
  const id = String(input.tool_use_id ?? Date.now()).replace(/[^\w-]/g, '').slice(-40) || String(Date.now());
  const file = path.join(dir, `${id}.txt`);
  const out = leanText(r.stdout, { ...settings, where: file });
  if (!out) return null;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `$ ${input.tool_input?.command ?? ''}\n\n${r.stdout}${r.stderr ? `\n\n--- stderr ---\n${r.stderr}` : ''}`);
  const stats = path.join(dir, 'stats.json');
  let s = { calls: 0, saved: 0 };
  try {
    s = JSON.parse(fs.readFileSync(stats, 'utf8'));
  } catch {}
  fs.writeFileSync(stats, JSON.stringify({ calls: (s.calls ?? 0) + 1, saved: (s.saved ?? 0) + Math.max(0, out.saved), at: new Date().toISOString() }));
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...r, stdout: out.text } } };
}

// Run by Claude Code: the event on stdin, the answer on stdout. Any trouble: say nothing, and the output stands.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const n = (v, d) => (Number(v) > 0 ? Number(v) : d);
    const settings = { ...LEAN_DEFAULTS, minLines: n(process.env.AGENTMGR_LEAN_MIN, LEAN_DEFAULTS.minLines) };
    const answer = leanHook(JSON.parse(fs.readFileSync(0, 'utf8')), { dir: process.env.AGENTMGR_LEAN_DIR || null, settings });
    if (answer) process.stdout.write(JSON.stringify(answer));
  } catch {}
}
