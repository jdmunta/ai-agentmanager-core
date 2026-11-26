// Conversation blame: why is this line here? `git blame` names a commit; this names the moment in
// the agent's conversation that wrote the line: what it had been asked, what it said just before,
// the commands it had just run, and the edit itself. Read from its own transcripts (Claude Code's
// JSONL, its subagents' too), so nothing is guessed: a line no edit wrote is said to be not found.
import fs from 'node:fs';
import path from 'node:path';

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const clip = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// Code keeps its indentation: only the line breaks at its ends go.
const clipCode = (s, n) => {
  const t = String(s ?? '').replace(/^\n+|\s+$/g, '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/** Text of a message's content: a string, or its text parts. */
function textOf(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/** What an edit wrote, as lines (each write of a MultiEdit, a file's whole content). */
function written(c) {
  const i = c.input ?? {};
  if (c.name === 'Write') return [{ before: null, after: String(i.content ?? '') }];
  if (c.name === 'MultiEdit') return (i.edits ?? []).map((e) => ({ before: String(e.old_string ?? ''), after: String(e.new_string ?? '') }));
  if (c.name === 'NotebookEdit') return [{ before: null, after: String(i.new_source ?? '') }];
  return [{ before: String(i.old_string ?? ''), after: String(i.new_string ?? '') }];
}

/** A user's own words: not a tool result, not a note the program added (isMeta, reminders). */
function promptOf(entry) {
  if (entry.type !== 'user' || entry.isMeta) return null;
  const content = entry.message?.content;
  if (Array.isArray(content) && content.some((c) => c?.type === 'tool_result')) return null;
  const t = textOf(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t || /^<(command-|local-command)/.test(t)) return null;
  return t;
}

/**
 * The transcript entries, oldest first, from JSONL text. Lines that are not JSON are skipped.
 */
export function parseTranscript(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/**
 * Why `line` (its text) is in `file`: the edits in the transcripts that wrote it, and the last
 * one's moment. `file` is relative to `workdir`; edits name absolute paths or relative ones.
 * Returns { found: false } or { found: true, at, tool, prompt, promptAt, said, ran, edit: { before,
 * after }, times, firstAt, session }.
 */
export function blameLine(transcripts, { file, line, workdir }) {
  const want = norm(line);
  if (!want) return { found: false, why: 'The line is empty' };
  const root = workdir ? path.resolve(workdir) : null;
  const sameFile = (p) => {
    if (typeof p !== 'string') return false;
    const abs = path.isAbsolute(p) ? path.resolve(p) : root ? path.resolve(root, p) : p;
    return root ? abs === path.resolve(root, file) : abs.endsWith(`/${file}`) || abs === file;
  };
  const hits = [];
  for (const { session, entries } of transcripts) {
    let prompt = null;
    let promptAt = null;
    let said = [];
    let ran = [];
    for (const entry of entries) {
      const p = promptOf(entry);
      if (p) {
        prompt = p;
        promptAt = entry.timestamp ?? null;
        said = [];
        ran = [];
        continue;
      }
      if (entry.type !== 'assistant') continue;
      for (const c of entry.message?.content ?? []) {
        if (c?.type === 'text' && c.text?.trim()) said = [...said, c.text.trim()].slice(-2);
        else if (c?.type === 'thinking' && c.thinking?.trim()) said = [...said, c.thinking.trim()].slice(-2);
        else if (c?.type === 'tool_use' && c.name === 'Bash' && typeof c.input?.command === 'string') ran = [...ran, c.input.command].slice(-3);
        else if (c?.type === 'tool_use' && EDITS.has(c.name) && sameFile(c.input?.file_path ?? c.input?.notebook_path)) {
          // An edit that adds the line, not one that only carries it along as context.
          const count = (t) => (t ?? '').split('\n').filter((l) => norm(l) === want).length;
          const edit = written(c).find((w) => count(w.after) > count(w.before));
          if (edit) hits.push({ at: entry.timestamp ?? null, tool: c.name, prompt, promptAt, said: [...said], ran: [...ran], edit, session });
        }
      }
    }
  }
  if (!hits.length) return { found: false, why: 'No edit in its conversation wrote this line: it was there before, or written by a command' };
  hits.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const last = hits.at(-1);
  return {
    found: true,
    at: last.at,
    tool: last.tool,
    prompt: last.prompt ? clip(last.prompt, 1500) : null,
    promptAt: last.promptAt,
    said: last.said.map((s) => clip(s, 800)),
    ran: last.ran.map((s) => clip(s, 300)),
    edit: { before: last.edit.before === null ? null : clipCode(last.edit.before, 1500), after: clipCode(last.edit.after, 1500) },
    times: hits.length,
    firstAt: hits[0].at,
    session: last.session,
  };
}

/** The transcripts of an agent's sessions (and their subagents'), read from disk. */
export function readTranscripts(files) {
  const out = [];
  for (const { session, file } of files) {
    try {
      out.push({ session, entries: parseTranscript(fs.readFileSync(file, 'utf8')) });
    } catch {}
  }
  return out;
}

export function blameMarkdown(b, { file, lineNo, line } = {}) {
  const out = [`# Why is this line here?`, '', `\`${file}${lineNo ? `:${lineNo}` : ''}\`: \`${clip(line, 200)}\``, ''];
  if (!b.found) return [...out, b.why].join('\n');
  out.push(`Written by ${b.tool} at ${b.at}${b.times > 1 ? ` (written ${b.times} times, first at ${b.firstAt})` : ''}.`, '');
  if (b.prompt) out.push('## What it was asked', '', b.prompt, '');
  if (b.said.length) out.push('## What it said just before', '', ...b.said.flatMap((s) => [s, '']));
  if (b.ran.length) out.push('## Commands it had just run', '', ...b.ran.map((c) => `- \`${c}\``), '');
  out.push('## The edit', '');
  if (b.edit.before !== null) out.push('```diff', ...b.edit.before.split('\n').map((l) => `- ${l}`), ...b.edit.after.split('\n').map((l) => `+ ${l}`), '```');
  else out.push('```', b.edit.after, '```');
  return out.join('\n').trimEnd();
}
