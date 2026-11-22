// Proof: what the agent ran to verify its work, kept so it can be checked. Next to its brief the
// agent keeps PROOF.md: for each check it ticked (or each agreed point of what done means), the
// exact command, its exit code and the last lines of real output. The app shows it, gives it to
// the review scorecard as the agent's own record, and, when the person asks, runs the commands
// again in the agent's folder and says which gave the same result.
//
// Running them again is the person's call only (an agent's own request is refused in server.js):
// the commands were written by the agent, and here they run without its permission prompts. A
// command that changes things (deleting, committing, pushing, publishing, installing) is not run.
import fs from 'node:fs';
import path from 'node:path';
import { briefDir } from './brief.js';

export const PROOF_FILE = 'PROOF.md';
export const proofPath = (agentId) => path.join(briefDir(agentId), PROOF_FILE);
export const MAX_ENTRIES = 30;
export const MAX_RERUN = 12;
const RERUN_TIMEOUT_MS = 120_000;

export const proofPrompt = (file) =>
  `Keep the proof of your checks in ${file} (Markdown), next to the brief, so the user can verify them without ` +
  'taking your word. One section for each check you tick as passed, and for each agreed acceptance point:\n' +
  '## <the check, starting with the acceptance point id when there is one, e.g. "A2 output is plain text">\n' +
  'Command: <the exact command you ran, on one line, runnable from the repository root; "none" when you verified by reading>\n' +
  'Exit: <its exit code>\n' +
  'then a fenced code block with the last lines of its real output (15 at most), or one line on what you read when there was no command.\n' +
  'Record only commands you really ran, with the output you really got: never write output from memory or as you expect it to be. ' +
  'Prefer commands that only look (tests, a build, a run of the program): the user may run them again. ' +
  'Update a section when you run its check again. The file is outside the repository: never commit it.\n' +
  'In the Results section of the brief, also list what you did not do: one "- Not done: ..." line for each thing the request asked or ' +
  'clearly implied that you skipped, stubbed, left untested or only assumed, and "- Not done: nothing" when there is none.';

const clip = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const lastLines = (s, n = 15, max = 1500) => String(s ?? '').replace(/\s+$/, '').split('\n').slice(-n).join('\n').slice(-max);

/**
 * PROOF.md as entries: [{ title, point, command, exit, output, note }]. `point` is the agreed
 * acceptance point a title starts with ("A2"), `command` null when it was verified by reading.
 */
export function parseProof(markdown) {
  const parts = String(markdown ?? '').split(/^##\s+(.+?)\s*#*\s*$/m);
  const out = [];
  for (let i = 1; i < parts.length && out.length < MAX_ENTRIES; i += 2) {
    const title = clip(parts[i].replace(/[*_`]/g, ''), 200);
    const body = parts[i + 1] ?? '';
    if (!title) continue;
    const fence = /```[^\n]*\n([\s\S]*?)```/.exec(body);
    const rest = fence ? body.replace(fence[0], '') : body;
    const field = (name) => new RegExp(`^\\s*[-*]?\\s*\\**${name}\\**\\s*:\\s*\\**\\s*(.*)$`, 'im').exec(rest)?.[1]?.trim() ?? '';
    const raw = field('command').replace(/^`+|`+$/g, '').trim();
    const command = raw && !/^(none|n\/a|-|—)\b/i.test(raw) ? raw.slice(0, 500) : null;
    const code = /^-?\d+/.exec(field('exit'))?.[0];
    const note = rest
      .split('\n')
      .filter((l) => l.trim() && !/^\s*[-*]?\s*\**(command|exit)\**\s*:/i.test(l))
      .join(' ')
      .trim();
    out.push({ title, point: /^(A\d+)\b/i.exec(title)?.[1].toUpperCase() ?? null, command, exit: code === undefined ? null : Number(code), output: lastLines(fence?.[1] ?? ''), note: clip(note, 300) });
  }
  return out;
}

const CHANGES = [
  [/(^|[;&|(]\s*)(sudo|doas)\b/, 'it runs as administrator'],
  [/(^|[;&|(]\s*)(rm|rmdir|mv|dd|chmod|chown|kill|pkill|killall|truncate|shred)\b/, 'it deletes, moves or stops things'],
  [/\bgit\s+(?:-\S+\s+)*(push|commit|reset|clean|checkout|switch|restore|rebase|merge|tag|stash|rm|mv|apply|am|cherry-pick|revert|pull|fetch|gc|branch\s+-[dDmM])\b/, 'it changes the repository'],
  [/\bgh\s+\w+\s+(create|merge|close|delete|edit|comment|review|reopen|ready)\b|\bgh\s+release\b|\bgh\s+api\b.*(-X|--method)/i, 'it changes things on GitHub'],
  [/\b(npm|pnpm|yarn|bun)\s+(publish|install|i|add|remove|uninstall|update|upgrade|link|login|ci)\b|\b(pip3?|uv|poetry|cargo|gem|brew|apt|apt-get|go)\s+(install|add|remove|uninstall|publish|upgrade|get)\b/, 'it installs or publishes'],
  [/\b(deploy|kubectl|helm|terraform|pulumi|ansible|docker\s+(push|rm|rmi|run|compose|kill|stop)|vercel|netlify|fly|railway|heroku|aws|gcloud|az)\b/, 'it deploys or reaches a service'],
  [/\b(curl|wget|nc|ssh|scp|rsync|ftp)\b/, 'it reaches the network'],
  [/(^|[^0-9&>])>{1,2}(?!\s*(\/dev\/null|&\d))/, 'it writes to a file'],
  [/\b(drop|truncate)\s+(table|database)\b|\bdelete\s+from\b/i, 'it changes data'],
  [/\$\(|`/, 'it runs a command inside the command'],
];

/** Why a recorded command is not run again by the app (a short phrase), or null when it only looks. */
export function changesThings(command) {
  const c = String(command ?? '');
  return CHANGES.find(([re]) => re.test(c))?.[1] ?? null;
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * A run by the app against what the agent recorded: "same" when the exit code is the one it wrote
 * (or success when it wrote none), "differs" otherwise. `output` says whether the last line it
 * recorded was printed again (durations and dates make output differ without anything being wrong).
 */
export function compareRun(entry, run) {
  const want = entry.exit ?? 0;
  const last = squash(entry.output.split('\n').filter((l) => l.trim()).at(-1));
  return {
    status: run.code === want ? 'same' : 'differs',
    output: !last ? null : squash(run.tail).includes(last) ? 'same' : 'differs',
  };
}

/** Counts for the agent's view: { entries, commands, points }. */
export const proofCounts = (entries) => ({ entries: entries.length, commands: entries.filter((e) => e.command).length, points: entries.filter((e) => e.point).length });

/** "3 of 4 checks with a recorded run" for a brief with `passed` ticked checks. */
export function proofLine(doc, passed = 0) {
  if (!doc?.entries) return passed ? `none recorded for ${passed} passed check${passed === 1 ? '' : 's'}` : 'none recorded';
  return `${doc.commands} recorded run${doc.commands === 1 ? '' : 's'}${doc.entries > doc.commands ? `, ${doc.entries - doc.commands} by reading` : ''}`;
}

/** The lines the review scorecard is given (facts the app measured). */
export function proofFacts(doc, rerun) {
  if (!doc?.entries) return ["the agent's proof of its checks: none recorded"];
  const lines = [`the agent's proof of its checks (its own record, not run by the app): ${doc.commands} with a command and output, ${doc.entries - doc.commands} verified by reading`];
  if (rerun?.results?.length && !rerun.stale) {
    const same = rerun.results.filter((r) => r.status === 'same').length;
    const differs = rerun.results.filter((r) => r.status === 'differs');
    const skipped = rerun.results.filter((r) => r.status === 'skipped').length;
    lines.push(
      `those commands run again by the app, at the person's request: ${same} gave the recorded exit code, ${differs.length} did not${differs.length ? ` (${differs.map((r) => r.title).join('; ')})` : ''}${skipped ? `, ${skipped} not run (they change things)` : ''}`,
    );
  }
  return lines;
}

/** PROOF.md for the scorecard prompt, cut to size. */
export function proofBlock(entries, max = 6000) {
  const out = [];
  let used = 0;
  for (const e of entries) {
    const text = [`## ${e.title}`, `Command: ${e.command ?? 'none (verified by reading)'}`, e.exit === null ? '' : `Exit: ${e.exit}`, e.output ? lastLines(e.output, 8, 600) : e.note].filter(Boolean).join('\n');
    if (used + text.length > max) {
      out.push(`(${entries.length - out.length} more not shown)`);
      break;
    }
    used += text.length;
    out.push(text);
  }
  return out.join('\n\n');
}

export function proofMarkdown(view) {
  const out = [`# Proof: ${view.name}`, ''];
  if (!view.entries.length) return [...out, 'The agent recorded no proof of its checks.'].join('\n');
  const mark = { same: '✅ same result when run again', differs: '❌ a different result when run again', skipped: '➖ not run again' };
  for (const e of view.entries) {
    out.push(`## ${e.title}`, '', e.command ? `Command: \`${e.command}\`${e.exit === null ? '' : ` (exit ${e.exit})`}` : `Verified by reading${e.note ? `: ${e.note}` : ''}`);
    if (e.output) out.push('', '```', e.output, '```');
    if (e.rerun) out.push('', `${mark[e.rerun.status]}${e.rerun.status === 'differs' ? `: exit ${e.rerun.code ?? 'none (stopped)'}` : e.rerun.status === 'skipped' ? `: ${e.rerun.why}` : ''}`);
    out.push('');
  }
  return out.join('\n');
}

export class Proof {
  /** `run(command, { cwd, timeoutMs })` resolves { ok, code, ms, tail } (standards.js runCheck). */
  constructor({ manager, store, run, log = () => {}, timeoutMs = RERUN_TIMEOUT_MS }) {
    Object.assign(this, { manager, store, run, log, timeoutMs });
    this.running = new Map(); // agentId -> the run in progress
  }

  read(agentId) {
    try {
      return parseProof(fs.readFileSync(proofPath(agentId), 'utf8'));
    } catch {
      return [];
    }
  }

  /** Pick up changes to PROOF.md: the counts go on the agent (for the list and the results card). */
  reload(agentId) {
    const agent = this.store.get(agentId);
    if (!agent) return;
    let st;
    try {
      st = fs.statSync(proofPath(agentId));
    } catch {
      return;
    }
    if (agent.proofDoc?.mtimeMs === st.mtimeMs) return;
    this.manager.patch(agentId, { proofDoc: { ...proofCounts(this.read(agentId)), mtimeMs: st.mtimeMs, updatedAt: st.mtime.toISOString() } });
  }

  /** What an agent recorded, with the last run by the app beside each entry. */
  view(ref) {
    const agent = this.manager.mustGet(ref);
    const entries = this.read(agent.id);
    const rerun = agent.proof ?? null;
    // A run made before the agent changed its proof no longer speaks for it.
    const stale = Boolean(rerun) && rerun.proofAt !== (agent.proofDoc?.updatedAt ?? null);
    const by = new Map((stale ? [] : rerun?.results ?? []).map((r) => [`${r.title}\n${r.command}`, r]));
    return {
      id: agent.id,
      name: agent.name,
      entries: entries.map((e) => ({ ...e, runnable: e.command ? !changesThings(e.command) : false, why: e.command ? changesThings(e.command) : null, rerun: by.get(`${e.title}\n${e.command}`) ?? null })),
      counts: proofCounts(entries),
      passed: (agent.brief?.checks ?? []).filter((c) => c.state === 'passed').length,
      notDone: agent.brief?.results?.notDone ?? [],
      rerun: rerun ? { at: rerun.at, stale, same: rerun.results.filter((r) => r.status === 'same').length, differs: rerun.results.filter((r) => r.status === 'differs').length, skipped: rerun.results.filter((r) => r.status === 'skipped').length } : null,
      running: this.running.has(agent.id),
      canRun: this.cannotRun(agent) === null,
      whyNot: this.cannotRun(agent),
    };
  }

  cannotRun(agent) {
    if (agent.container) return 'It works in a container: its commands are not run on this computer.';
    if (!agent.workdir || !fs.existsSync(agent.workdir)) return "The agent's folder is not on this computer.";
    return null;
  }

  /** For the scorecard: the counts, the entries and the last run, or null when nothing is recorded. */
  forScore(agent) {
    const entries = this.read(agent.id);
    const rerun = agent.proof ? { ...agent.proof, stale: agent.proof.proofAt !== (agent.proofDoc?.updatedAt ?? null) } : null;
    return { doc: proofCounts(entries), entries, rerun };
  }

  /** Run the recorded commands again, one after the other, in the agent's folder. The person's call. */
  async run_(agent) {
    const entries = this.read(agent.id).filter((e) => e.command);
    const results = [];
    let ran = 0;
    for (const e of entries) {
      const why = changesThings(e.command) ?? (ran >= MAX_RERUN ? `only the first ${MAX_RERUN} are run` : null);
      if (why) {
        results.push({ title: e.title, command: e.command, status: 'skipped', why });
        continue;
      }
      ran++;
      this.log(`proof: ${agent.name}: ${e.command}`);
      const r = await this.run(e.command, { cwd: agent.workdir, timeoutMs: this.timeoutMs });
      results.push({ title: e.title, command: e.command, code: r.code, ms: r.ms, tail: lastLines(r.tail, 12, 1000), ...compareRun(e, r) });
    }
    return results;
  }

  async rerun(ref) {
    const agent = this.manager.mustGet(ref);
    const no = this.cannotRun(agent);
    if (no) throw Object.assign(new Error(no), { status: 400 });
    if (!this.read(agent.id).some((e) => e.command)) throw Object.assign(new Error('The agent recorded no commands to run again'), { status: 400 });
    if (!this.running.has(agent.id)) {
      const proofAt = agent.proofDoc?.updatedAt ?? null;
      const p = this.run_(agent)
        .then((results) => {
          if (this.store.get(agent.id)) this.manager.patch(agent.id, { proof: { at: new Date().toISOString(), proofAt, results } });
        })
        .finally(() => this.running.delete(agent.id));
      this.running.set(agent.id, p);
      this.manager.changed?.(agent);
    }
    await this.running.get(agent.id);
    return this.view(agent.id);
  }
}
