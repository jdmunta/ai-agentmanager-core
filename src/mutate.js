// Test the tests: do the agent's tests notice when its code is wrong? The app takes the lines the
// agent changed, breaks one at a time in a small way (=== becomes !==, && becomes ||, a number
// goes up by one), runs the tests, and puts the line back. A break the tests fail on is caught;
// one they still pass on shows a line no test checks. Proof (proof.js) says the checks ran; this
// says whether they could have failed.
//
// It is the person's call only (an agent's own request is refused in server.js): the commands run
// here without the agent's permission prompts, and its files are changed for a moment. One line
// of one file is different at a time, never while the agent works; what was changed is written
// down first so a daemon that stops halfway puts it back when it starts again.
import fs from 'node:fs';
import path from 'node:path';
import { briefDir } from './brief.js';
import { changesThings } from './proof.js';

export const MAX_BREAKS = 8;
const JOURNAL = 'mutant.json';
const SOURCE = /\.(m?js|cjs|jsx|tsx?|py|go|rb|java|kt|rs|c|cc|cpp|h|hpp|cs|php|swift|scala)$/i;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures|testdata)\/|[._-](test|spec)\.[a-z]+$|_test\.go$|Tests?\.(java|kt|cs)$|(^|\/)(test_[^/]*|conftest)\.py$/i;
const HASH_COMMENT = /\.(py|rb)$/i;
const SKIP_LINE = /^\s*(import\b|from\s+\S+\s+import\b|export\s+\*|export\s+\{[^}]*\}\s+from\b|package\b|use\b|using\b|#include\b|require\b|@|\*|\/\*|\/\/|<!--)|\brequire\(|^\s*(console|logger?|log|print|println|printf|fmt\.Print\w*|System\.out)\b/;

const clip = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const lastLines = (s, n = 10, max = 800) => String(s ?? '').replace(/\s+$/, '').split('\n').slice(-n).join('\n').slice(-max);

/** The lines a diff adds, by file: Map path -> [{ line, text }] (line numbers in the new file). */
export function addedLines(diff) {
  const out = new Map();
  let file = null;
  let n = 0;
  for (const l of String(diff ?? '').split('\n')) {
    if (l.startsWith('+++ ')) {
      const p = l.slice(4).trim().replace(/^"|"$/g, '');
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    if (l.startsWith('diff --git') || l.startsWith('--- ')) {
      if (l.startsWith('diff --git')) file = null;
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (!file || !n) continue;
    if (l.startsWith('+')) {
      if (!out.has(file)) out.set(file, []);
      out.get(file).push({ line: n, text: l.slice(1) });
      n++;
    } else if (l.startsWith(' ') || l === '') n++;
  }
  return out;
}

/** The line with what is inside strings and comments blanked out, so only code is changed. */
export function codeOf(text, file = '') {
  const out = [...String(text)];
  let quote = null;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (quote) {
      if (c === '\\') {
        out[i] = ' ';
        if (i + 1 < out.length) out[++i] = ' ';
      } else if (c === quote) quote = null;
      else out[i] = ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ((c === '/' && out[i + 1] === '/') || (c === '#' && HASH_COMMENT.test(file)) || (c === '/' && out[i + 1] === '*')) {
      for (let j = i; j < out.length; j++) out[j] = ' ';
      break;
    }
  }
  return out.join('');
}

/**
 * The lines of a file that begin inside a block comment, a docstring or a string over several
 * lines (their numbers, from 1): text there is not code, so a break in it would never be caught.
 */
export function insideBlocks(text, file = '') {
  const out = new Set();
  const py = /\.py$/i.test(file);
  const hash = HASH_COMMENT.test(file);
  const TRIPLE = ['"""', "'''"];
  let state = null; // null (code), a quote, a block comment or a triple quote
  let line = 1;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') {
      line++;
      if (state === "'" || state === '"') state = null; // one-line strings end with the line
      if (state) out.add(line);
      continue;
    }
    if (state === '/*') {
      if (c === '*' && s[i + 1] === '/') (state = null), i++;
    } else if (TRIPLE.includes(state)) {
      if (s.startsWith(state, i)) (state = null), (i += 2);
    } else if (state) {
      if (c === '\\') i++;
      else if (c === state) state = null;
    } else if (py && TRIPLE.some((t) => s.startsWith(t, i))) (state = s.slice(i, i + 3)), (i += 2);
    else if (c === '/' && s[i + 1] === '*' && !py) (state = '/*'), i++;
    else if ((c === '/' && s[i + 1] === '/' && !py) || (c === '#' && hash)) {
      const end = s.indexOf('\n', i);
      i = (end < 0 ? s.length : end) - 1;
    } else if (c === '"' || c === "'" || (c === '`' && !py)) state = c;
  }
  return out;
}

// [what to find in the code, what it becomes, the kind]. The first on a line that fits is used,
// starting from a different rule for each line so one change gets several kinds of break.
const RULES = [
  [/===/, '!==', 'equal'],
  [/!==/, '===', 'equal'],
  [/(?<![=!<>])==(?!=)/, '!=', 'equal'],
  [/!=(?!=)/, '==', 'equal'],
  [/<=/, '>', 'compare'],
  [/>=/, '<', 'compare'],
  [/(?<=\s)<(?=\s)/, '>=', 'compare'],
  [/(?<=\s)>(?=\s)/, '<=', 'compare'],
  [/&&/, '||', 'logic'],
  [/\|\|/, '&&', 'logic'],
  [/\band\b/, 'or', 'logic', /\.py$/i],
  [/\bor\b/, 'and', 'logic', /\.py$/i],
  [/\btrue\b/, 'false', 'truth'],
  [/\bfalse\b/, 'true', 'truth'],
  [/\bTrue\b/, 'False', 'truth'],
  [/\bFalse\b/, 'True', 'truth'],
  [/(?<=[\w)\]]\s)\+(?=\s)/, '-', 'arithmetic'],
  [/(?<=[\w)\]]\s)-(?=\s)/, '+', 'arithmetic'],
  [/\+=/, '-=', 'arithmetic'],
  [/-=/, '+=', 'arithmetic'],
  [/(?<![\w.])\d+(?![\w.])/, (m) => String(Number(m) + 1), 'number'],
];
const KINDS = ['equal', 'compare', 'logic', 'truth', 'arithmetic', 'number'];

/**
 * The small breaks one line allows: [{ kind, from, to, text }] (`text` is the line broken), one
 * for each kind that fits. Lines that are comments, imports or logging give none.
 */
export function breaksOf(text, file = '') {
  if (SKIP_LINE.test(text) || text.length > 400) return [];
  const code = codeOf(text, file);
  const out = [];
  for (const [re, to, kind, only] of RULES) {
    if (only && !only.test(file)) continue;
    if (out.some((b) => b.kind === kind)) continue;
    const m = re.exec(code);
    if (!m) continue;
    const put = typeof to === 'function' ? to(m[0]) : to;
    out.push({ kind, from: m[0], to: put, text: text.slice(0, m.index) + put + text.slice(m.index + m[0].length) });
  }
  return out;
}

/**
 * Which breaks to try for a change: at most `max`, one a line, spread over the changed lines and
 * over the kinds of break. `changes` is addedLines(diff); `read(file)` gives a file's text now
 * (null when it is gone), so only lines that are still as the diff says are used.
 */
export function pickBreaks(changes, { max = MAX_BREAKS, read = () => null } = {}) {
  const lines = [];
  for (const [file, added] of changes) {
    if (!SOURCE.test(file) || TEST_FILE.test(file)) continue;
    const now = read(file);
    if (now === null) continue;
    const cur = now.split('\n');
    const blocks = insideBlocks(now, file);
    for (const a of added) {
      if (cur[a.line - 1] !== a.text || blocks.has(a.line)) continue;
      const breaks = breaksOf(a.text, file);
      if (breaks.length) lines.push({ file, line: a.line, before: a.text, breaks });
    }
  }
  if (!lines.length) return [];
  // Evenly through the change, then a kind for each that the ones before used least.
  const step = Math.max(1, lines.length / max);
  const chosen = [];
  for (let i = 0; chosen.length < max && Math.floor(i) < lines.length; i += step) chosen.push(lines[Math.floor(i)]);
  const used = Object.fromEntries(KINDS.map((k) => [k, 0]));
  return chosen.map((l) => {
    const b = [...l.breaks].sort((x, y) => used[x.kind] - used[y.kind] || KINDS.indexOf(x.kind) - KINDS.indexOf(y.kind))[0];
    used[b.kind]++;
    return { file: l.file, line: l.line, kind: b.kind, from: b.from, to: b.to, before: l.before, after: b.text };
  });
}

/** Put a broken line back. True when the file is as it was (or the line is no longer ours). */
export function putBack(j) {
  let now;
  try {
    now = fs.readFileSync(j.path, 'utf8');
  } catch {
    return true; // the file is gone: nothing of ours is left
  }
  if (now === j.broken) {
    fs.writeFileSync(j.path, j.original);
    return true;
  }
  if (now === j.original) return true;
  // Someone changed the file meanwhile: only our line goes back.
  const lines = now.split('\n');
  if (lines[j.line - 1] === j.after) {
    lines[j.line - 1] = j.before;
    fs.writeFileSync(j.path, lines.join('\n'));
    return true;
  }
  const at = lines.indexOf(j.after);
  if (at >= 0 && lines.indexOf(j.after, at + 1) < 0 && !lines.includes(j.before)) {
    lines[at] = j.before;
    fs.writeFileSync(j.path, lines.join('\n'));
  }
  return true;
}

export const breakCounts = (breaks = []) => ({
  tried: breaks.filter((b) => b.status !== 'skipped').length,
  caught: breaks.filter((b) => b.status === 'caught').length,
  missed: breaks.filter((b) => b.status === 'missed').length,
  skipped: breaks.filter((b) => b.status === 'skipped').length,
});

/** "5 of 6 breaks caught by its tests" */
export function breaksLine(m) {
  if (!m) return '';
  if (m.baseline && !m.baseline.ok) return 'the tests fail before anything is changed';
  const c = breakCounts(m.breaks);
  if (!c.tried) return 'no line of the change could be broken in a small way';
  return `${c.caught} of ${c.tried} break${c.tried === 1 ? '' : 's'} caught by its tests`;
}

/** The lines the review scorecard is given (facts the app measured). */
export function breakFacts(m) {
  if (!m || m.stale) return [];
  if (m.baseline && !m.baseline.ok) return [`the tests, run by the app at the person's request (${m.commands.join(' && ')}): they fail before anything is changed`];
  const c = breakCounts(m.breaks);
  if (!c.tried) return [];
  const missed = m.breaks.filter((b) => b.status === 'missed');
  return [
    `the app broke ${c.tried} changed line${c.tried === 1 ? '' : 's'} one at a time and ran the tests (${m.commands.join(' && ')}): ${c.caught} caught, ${c.missed} not noticed${missed.length ? ` (${missed.map((b) => `${b.file}:${b.line} ${b.from} became ${b.to}`).join('; ')})` : ''}`,
  ];
}

/** What to send the agent about the breaks its tests did not notice. */
export function breaksMessage(m) {
  const missed = (m?.breaks ?? []).filter((b) => b.status === 'missed');
  if (!missed.length) return null;
  return [
    `I broke lines of your change one at a time and ran your tests (${m.commands.join(' && ')}). They still passed with these ${missed.length === 1 ? 'break' : 'breaks'}, so nothing checks ${missed.length === 1 ? 'this line' : 'these lines'}:`,
    ...missed.map((b) => `- ${b.file}:${b.line}: \`${b.from}\` became \`${b.to}\` in \`${clip(b.before, 160)}\``),
    'The lines are back as you wrote them. For each one, add or strengthen a test that fails when the line is wrong, or tell me why no test should cover it (for example the two versions behave the same). Do not change the code just to make this pass.',
  ].join('\n');
}

export function breaksMarkdown(view) {
  const out = [`# Test the tests: ${view.name}`, ''];
  const m = view.last;
  if (!m) return [...out, 'Not run yet.'].join('\n');
  out.push(`Tests: \`${m.commands.join(' && ')}\``, '');
  if (!m.baseline.ok) return [...out, `The tests fail before anything is changed (exit ${m.baseline.code ?? 'none (stopped)'}):`, '', '```', m.baseline.tail ?? '', '```'].join('\n');
  const mark = { caught: '✅ caught', missed: '❌ not noticed', skipped: '➖ not tried' };
  for (const b of m.breaks) out.push(`- ${mark[b.status]} · ${b.file}:${b.line} · \`${b.from}\` became \`${b.to}\`${b.status === 'caught' && b.stopped ? ' (the tests did not finish)' : ''}${b.status === 'skipped' ? ` (${b.why})` : ''}`, `  \`${clip(b.before, 160)}\``);
  if (!m.breaks.length) out.push('No line of the change could be broken in a small way.');
  out.push('', breaksLine(m) + (m.stale ? ' (before the latest changes)' : ''));
  if (m.restored === false) out.push('', 'The folder is not as it was before the run: look at its changes.');
  return out.join('\n');
}

export class Mutate {
  /**
   * `run(command, { cwd, timeoutMs })` resolves { ok, code, ms, tail } (standards.js runCheck);
   * `changes(id)` gives the agent's changes ({ diff, diffHash }, the review screen's).
   */
  constructor({ manager, store, run, changes, config = {}, log = () => {}, dir = briefDir }) {
    Object.assign(this, { manager, store, run, changes, log });
    // Where the line being broken is written down, so a stop halfway can be undone.
    this.journal = (agentId) => path.join(dir(agentId), JOURNAL);
    this.max = config.max ?? MAX_BREAKS;
    this.timeoutMs = config.timeoutMs ?? 300_000;
    this.budgetMs = config.budgetMs ?? 900_000;
    this.running = new Map(); // agentId -> the run in progress
  }

  /** After a daemon that stopped halfway: put back the line it had broken. */
  recover() {
    for (const a of this.store.list()) {
      const file = this.journal(a.id);
      let j;
      try {
        j = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      try {
        putBack(j);
        this.log(`test the tests: ${a.name}: put back ${j.path}:${j.line} after a stop`);
      } catch (e) {
        this.log(`test the tests: ${a.name}: could not put back ${j.path}:${j.line}: ${e.message}`);
        continue;
      }
      fs.rmSync(file, { force: true });
    }
  }

  /** True while an agent's files are being changed by a run: nothing is sent to it meanwhile. */
  holds(agentId) {
    return this.running.has(agentId);
  }

  /** The commands that test: the one given, or the ones the agent recorded that passed and only look. */
  commandsFor(agent, command) {
    const given = String(command ?? '').trim();
    if (given) return [given.slice(0, 500)];
    const seen = new Set();
    return (this.manager.proof?.read(agent.id) ?? [])
      .filter((e) => e.command && (e.exit ?? 0) === 0 && !changesThings(e.command) && !seen.has(e.command) && seen.add(e.command))
      .map((e) => e.command)
      .slice(0, 3);
  }

  cannotRun(agent) {
    if (agent.container) return 'It works in a container: its tests are not run on this computer.';
    if (!agent.workdir || !fs.existsSync(agent.workdir)) return "The agent's folder is not on this computer.";
    return null;
  }

  /** Not while it works: its files are changed for a moment. Asked at the start of a run. */
  working(agent) {
    return this.manager.runtimes?.get(agent.id)?.busy ? 'The agent is working. Its files are changed for a moment during this, so wait until it stops and ask again.' : null;
  }

  async view(ref) {
    const agent = this.manager.mustGet(ref);
    const last = agent.breaks ?? null;
    let stale = false;
    if (last && !this.running.has(agent.id)) stale = ((await this.changes(agent.id).catch(() => null))?.diffHash ?? null) !== last.diffHash;
    const commands = this.commandsFor(agent);
    return {
      id: agent.id,
      name: agent.name,
      commands,
      last: last ? { ...last, stale, ...breakCounts(last.breaks) } : null,
      line: last ? breaksLine(last) : '',
      running: this.running.has(agent.id),
      canRun: this.cannotRun(agent) === null,
      whyNot: this.cannotRun(agent),
      max: this.max,
    };
  }

  /** For the scorecard: the last run, marked stale when the changes are no longer the ones it broke. */
  forScore(agent, diffHash) {
    return agent.breaks ? { ...agent.breaks, stale: agent.breaks.diffHash !== diffHash } : null;
  }

  async tests(agent, commands, timeoutMs) {
    const started = Date.now();
    for (const command of commands) {
      const r = await this.run(command, { cwd: agent.workdir, timeoutMs });
      if (!r.ok) return { ok: false, command, code: r.code, ms: Date.now() - started, tail: lastLines(r.tail) };
    }
    return { ok: true, ms: Date.now() - started };
  }

  async run_(agent, commands, max) {
    const before = await this.changes(agent.id);
    const read = (file) => {
      try {
        return fs.readFileSync(path.join(agent.workdir, file), 'utf8');
      } catch {
        return null;
      }
    };
    const out = { at: null, commands, diffHash: before.diffHash, baseline: null, breaks: [], restored: true };
    this.log(`test the tests: ${agent.name}: ${commands.join(' && ')}`);
    out.baseline = await this.tests(agent, commands, this.timeoutMs);
    if (out.baseline.ok) {
      const picked = pickBreaks(addedLines(before.diff), { max, read });
      // A break that hangs the tests is caught; it need not take the full time to say so.
      const each = Math.min(this.timeoutMs, Math.max(20_000, out.baseline.ms * 4));
      const started = Date.now();
      const until = started + this.budgetMs;
      for (const b of picked) {
        const file = path.join(agent.workdir, b.file);
        const original = read(b.file);
        const lines = original?.split('\n');
        const why =
          Date.now() > until ? 'the time for a run was used up' : (this.manager.inputAt?.get(agent.id) ?? 0) > started ? 'you typed to the agent, so the run stopped' : !lines || lines[b.line - 1] !== b.before ? 'the line changed meanwhile' : null;
        if (why) {
          out.breaks.push({ ...b, status: 'skipped', why });
          continue;
        }
        lines[b.line - 1] = b.after;
        const j = { path: file, line: b.line, before: b.before, after: b.after, original, broken: lines.join('\n') };
        fs.mkdirSync(path.dirname(this.journal(agent.id)), { recursive: true });
        fs.writeFileSync(this.journal(agent.id), JSON.stringify(j));
        let r;
        try {
          fs.writeFileSync(file, j.broken);
          r = await this.tests(agent, commands, each);
        } finally {
          putBack(j);
          fs.rmSync(this.journal(agent.id), { force: true });
        }
        out.breaks.push({ ...b, status: r.ok ? 'missed' : 'caught', ms: r.ms, ...(r.ok ? {} : { by: r.command, code: r.code, stopped: r.code === null, tail: lastLines(r.tail, 6, 500) }) });
      }
      // The folder as it was: the same changes as before the run.
      const after = await this.changes(agent.id).catch(() => null);
      // (Typing to the agent meanwhile changes them for its own reasons.)
      out.restored = !after || after.diffHash === before.diffHash || (this.manager.inputAt?.get(agent.id) ?? 0) > started;
    }
    out.at = new Date().toISOString();
    return out;
  }

  /** Break the changed lines one at a time and run the tests. The person's call. */
  async start(ref, { command, max } = {}) {
    const agent = this.manager.mustGet(ref);
    const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
    if (!this.running.has(agent.id)) {
      const no = this.cannotRun(agent) ?? this.working(agent);
      if (no) throw bad(no);
      const commands = this.commandsFor(agent, command);
      if (!commands.length) throw bad('No test command: the agent recorded none that passed. Give the command that runs the tests.');
      const n = Math.max(1, Math.min(30, Number(max) || this.max));
      const p = this.run_(agent, commands, n)
        .then((breaks) => {
          if (this.store.get(agent.id)) this.manager.patch(agent.id, { breaks });
        })
        .finally(() => this.running.delete(agent.id));
      this.running.set(agent.id, p);
      this.manager.changed?.(agent);
    }
    await this.running.get(agent.id);
    return this.view(agent.id);
  }

  /** Tell the agent which breaks its tests did not notice. */
  async send(ref) {
    const agent = this.manager.mustGet(ref);
    const text = breaksMessage(agent.breaks);
    if (!text) throw Object.assign(new Error('Nothing to send: no break went unnoticed'), { status: 400 });
    this.manager.tell(agent.id, text);
    this.manager.patch(agent.id, { breaks: { ...agent.breaks, sentAt: new Date().toISOString() } });
    return this.view(agent.id);
  }
}
