// Timeline: an agent's work from its start to now, as dated milestones in order. A milestone is an
// ask closed (a request to the agent and the end of its turn on it: when the work on it stopped)
// or a pull request opened, merged or closed; under each, what it changed (files, commits) and the
// agent's last word on it. Asks that changed nothing are folded together, so the changes stand
// out. Everything comes from records: the session transcripts (Claude Code), the branch's commits
// and the pull requests. No model is called.
import fs from 'node:fs';
import { run } from './git.js';
import { transcriptPath } from './tracker.js';

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const firstLine = (s) =>
  String(s ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) ?? '';
const stripNoise = (s) =>
  String(s ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-[\w-]+|local-command-[\w-]+)>[\s\S]*?<\/\1>/g, '')
    .trim();
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** A prompt typed or sent to the agent (not a tool's result, not bookkeeping): its text, or null. */
function promptText(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain || rec.isCompactSummary) return null;
  const c = rec.message?.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b.type === 'tool_result')) return null;
    text = c
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  } else return null;
  text = stripNoise(text);
  if (!text || /^\[Request interrupted/.test(text)) return null;
  return text;
}

/**
 * The asks in one transcript, in order: [{ at, endAt, ended, text, reply, files, prs }]. endAt is
 * the agent's last message on it (null while it hasn't answered); ended, that its turn on it ended;
 * files are those it edited.
 */
export function asksFromLines(lines) {
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.isSidechain) continue;
    const text = promptText(rec);
    if (text !== null) {
      cur = { at: rec.timestamp ?? null, endAt: null, ended: false, text, reply: '', files: [], prs: [] };
      out.push(cur);
      continue;
    }
    // The turn on it ended (Claude Code writes its duration then); a later message starts it again.
    if (cur && rec.type === 'system' && rec.subtype === 'turn_duration') cur.ended = true;
    if (!cur || (rec.type !== 'assistant' && rec.type !== 'user')) continue;
    if (rec.type === 'assistant') cur.ended = ['end_turn', 'stop_sequence'].includes(rec.message?.stop_reason);
    if (rec.timestamp && rec.type === 'assistant') cur.endAt = rec.timestamp;
    const blocks = Array.isArray(rec.message?.content) ? rec.message.content : [];
    for (const b of blocks) {
      if (rec.type === 'assistant' && b.type === 'text' && stripNoise(b.text)) cur.reply = stripNoise(b.text);
      if (rec.type === 'assistant' && b.type === 'tool_use' && EDITS.has(b.name)) {
        const f = b.input?.file_path ?? b.input?.notebook_path;
        if (f && !cur.files.includes(f)) cur.files.push(f);
      }
      const t = b.type === 'text' ? b.text : b.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')) : '';
      for (const u of String(t ?? '').match(PR_URL) ?? []) if (!cur.prs.includes(u)) cur.prs.push(u);
    }
  }
  return out;
}

// Transcripts are only read again when they grew.
const cache = new Map();
export function asksOf(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.asks;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const asks = asksFromLines(text.split('\n'));
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, asks });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return asks;
}

/** The branch's commits since it started, oldest first: [{ sha, at, subject, files (a count), paths }]. */
export async function branchCommits(dir, baseSha) {
  if (!dir || !baseSha) return [];
  try {
    const out = await run('git', ['log', '--reverse', '--max-count=500', '--format=%x1e%H%x1f%cI%x1f%s', '--name-only', `${baseSha}..HEAD`], { cwd: dir, timeout: 15_000 });
    return out
      .split('\x1e')
      .filter((c) => c.trim())
      .map((c) => {
        const [head, ...rest] = c.split('\n');
        const [sha, at, subject] = head.split('\x1f');
        const paths = rest.map((l) => l.trim()).filter(Boolean);
        return { sha, at, subject, files: paths.length, paths };
      });
  } catch {
    return [];
  }
}

const t = (s) => Date.parse(s ?? '') || null;

/**
 * The milestones, oldest first. Each { kind, at, title, ... }:
 *   start    the request it was given (at: when it was made)
 *   ask      an ask with changes (at: when its turn ended; startedAt; open while it works on it)
 *   talk     asks in a row that changed nothing, folded (asks: [{ at, title }])
 *   commits  commits made outside any ask the transcripts show, by day
 *   pr       a pull request opened, merged or closed (event)
 *   done     its brief said done
 */
export function buildTimeline(agent, { asks = [], commits = [], busy = false } = {}) {
  const rel = (f) => (agent.workdir && f.startsWith(`${agent.workdir}/`) ? f.slice(agent.workdir.length + 1) : f);
  const nodes = [];
  const intent = firstLine(agent.intent) || agent.name;
  nodes.push({ kind: 'start', at: agent.createdAt ?? null, title: clip(intent, 200), branch: agent.git?.branch ?? null, base: agent.baseRef ?? null });

  // Commits go under the ask they were made in: from its start to the next ask's start.
  const sorted = [...asks].sort((a, b) => (t(a.at) ?? 0) - (t(b.at) ?? 0));
  const loose = [];
  const per = sorted.map(() => []);
  for (const c of commits) {
    const ct = t(c.at);
    let i = -1;
    for (let k = 0; k < sorted.length; k++) if (ct != null && (t(sorted[k].at) ?? Infinity) <= ct) i = k;
    if (i >= 0) per[i].push(c);
    else loose.push(c);
  }

  let talk = null;
  sorted.forEach((a, i) => {
    const first = i === 0 && Math.abs((t(a.at) ?? 0) - (t(agent.createdAt) ?? 0)) < 30 * 60_000;
    // Busy alone isn't enough: a session resumed redraws its screen with nothing asked.
    const open = i === sorted.length - 1 && busy && !a.ended;
    const title = first ? '' : clip(firstLine(a.text), 200);
    const changed = a.files.length || per[i].length || a.prs.length;
    if (!changed && !open && !first) {
      if (!talk) nodes.push((talk = { kind: 'talk', at: null, asks: [] }));
      talk.asks.push({ at: a.endAt ?? a.at, title, reply: clip(firstLine(a.reply), 300) });
      talk.at = a.endAt ?? a.at;
      return;
    }
    talk = null;
    nodes.push({
      kind: 'ask',
      first,
      open,
      startedAt: a.at,
      at: open ? null : (a.endAt ?? a.at),
      title,
      reply: clip(firstLine(a.reply), 300),
      // What it edited with its tools, and what its commits changed (shell commands write files too).
      files: [...new Set([...a.files.map(rel), ...per[i].flatMap((c) => c.paths ?? [])])],
      commits: per[i].map((c) => ({ sha: c.sha.slice(0, 7), at: c.at, subject: clip(c.subject, 160), files: c.files })),
    });
  });

  // Commits the transcripts don't place (another engine, or made by hand): one milestone a day.
  const days = new Map();
  for (const c of loose) {
    const day = String(c.at).slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(c);
  }
  for (const list of days.values()) nodes.push({ kind: 'commits', at: list.at(-1).at, commits: list.map((c) => ({ sha: c.sha.slice(0, 7), at: c.at, subject: clip(c.subject, 160), files: c.files })) });

  for (const p of Object.values(agent.prs ?? {})) {
    if (p.source === 'mentioned' || !p.url) continue;
    const name = `${p.number ? `#${p.number} ` : ''}${p.title ?? p.url}`;
    if (p.openedAt) nodes.push({ kind: 'pr', event: 'opened', at: p.openedAt, title: name, url: p.url });
    if (p.state === 'MERGED') nodes.push({ kind: 'pr', event: 'merged', at: p.mergedAt ?? null, title: name, url: p.url });
    if (p.state === 'CLOSED') nodes.push({ kind: 'pr', event: 'closed', at: p.closedAt ?? null, title: name, url: p.url });
  }
  // Done is dated when the ask it was set in closed (the brief is written before the turn ends).
  const doneAt = (at) => {
    const d = t(at);
    if (d == null) return at ?? null;
    const inAsk = sorted.findLast((a) => (t(a.at) ?? Infinity) <= d);
    const closes = inAsk ? (inAsk.endAt ?? inAsk.at) : null;
    return (t(closes) ?? 0) > d ? closes : at;
  };
  if (agent.brief?.status === 'done' || agent.brief?.results?.outcome === 'done') nodes.push({ kind: 'done', at: doneAt(agent.brief?.updatedAt), title: clip(firstLine(agent.brief?.solution ?? ''), 300) });

  // In order of when each closed; an open ask (still being worked on) and undated ones last.
  const key = (n) => (n.open ? 2e15 : (t(n.at) ?? 1e15));
  const ordered = nodes.map((n, i) => [n, i]).sort(([a, i], [b, j]) => (a.kind === 'start' ? -1 : b.kind === 'start' ? 1 : key(a) - key(b) || i - j));
  const out = ordered.map(([n]) => n);
  const counts = {
    asks: sorted.length,
    changes: out.filter((n) => n.kind === 'ask' && (n.files.length || n.commits.length)).length,
    commits: commits.length,
    prs: out.filter((n) => n.kind === 'pr' && n.event === 'opened').length,
    merged: out.filter((n) => n.kind === 'pr' && n.event === 'merged').length,
  };
  return { agent: { id: agent.id, name: agent.name }, nodes: out, counts, transcripts: agent.engine == null || agent.engine === 'claude' };
}

/** The timeline of an agent as it is now (reads its transcripts and branch). */
export async function timelineOf(agent, { busy = false } = {}) {
  const claude = agent.engine == null || agent.engine === 'claude';
  const asks = claude && agent.workdir ? (agent.sessions ?? []).flatMap((s) => asksOf(transcriptPath(agent.workdir, s.id))) : [];
  const commits = await branchCommits(agent.workdir, agent.baseRef?.split(' @ ')[1]);
  return buildTimeline(agent, { asks, commits, busy });
}

// In this computer's time, as the page shows it.
const pad = (n) => String(n).padStart(2, '0');
const WHEN = (s) => {
  const d = new Date(s ?? '');
  return s && !Number.isNaN(d.getTime()) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : 'no date';
};
const PR_WORD = { opened: 'Pull request opened', merged: 'Pull request merged', closed: 'Pull request closed' };

/** As Markdown: a dated list, details nested under each milestone. */
export function timelineMarkdown(tl) {
  const lines = [`# Timeline: ${tl.agent.name}`, ''];
  for (const n of tl.nodes) {
    if (n.kind === 'start') {
      lines.push(`- **${WHEN(n.at)} · Started:** ${n.title}`);
      if (n.branch) lines.push(`  - Branch \`${n.branch}\`${n.base ? ` from ${n.base}` : ''}`);
    } else if (n.kind === 'ask') {
      lines.push(`- **${n.open ? 'Now · Working on' : `${WHEN(n.at)} · ${n.first ? 'The request done' : 'Ask done'}`}${n.title ? `:** ${n.title}` : '**'}`);
      if (n.reply) lines.push(`  - It said: ${n.reply}`);
      if (n.files.length) lines.push(`  - Changed ${n.files.length} file${n.files.length === 1 ? '' : 's'}: ${n.files.slice(0, 8).map((f) => `\`${f}\``).join(', ')}${n.files.length > 8 ? ` and ${n.files.length - 8} more` : ''}`);
      for (const c of n.commits) lines.push(`  - Commit \`${c.sha}\` ${c.subject}`);
    } else if (n.kind === 'talk') {
      lines.push(`- **${WHEN(n.at)} · ${n.asks.length} ask${n.asks.length === 1 ? '' : 's'} with no changes:** ${n.asks.map((a) => a.title).join(' / ')}`);
      if (n.asks.length === 1 && n.asks[0].reply) lines.push(`  - It said: ${n.asks[0].reply}`);
    } else if (n.kind === 'commits') {
      lines.push(`- **${WHEN(n.at)} · ${n.commits.length} commit${n.commits.length === 1 ? '' : 's'}**`);
      for (const c of n.commits) lines.push(`  - \`${c.sha}\` ${c.subject}`);
    } else if (n.kind === 'pr') lines.push(`- **${WHEN(n.at)} · ${PR_WORD[n.event]}:** [${n.title}](${n.url})`);
    else if (n.kind === 'done') lines.push(`- **${WHEN(n.at)} · Finished**${n.title ? `: ${n.title}` : ''}`);
  }
  return lines.join('\n');
}
