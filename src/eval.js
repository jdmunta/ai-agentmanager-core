// Eval: how sure we can be of the change an agent made for a Jira issue, from evidence rather than
// the agent's word. It lists the tests the agent ran (from its session, with their results), the
// tests this app ran again itself on the final change, the acceptance criteria and what proves
// each, CI, the AI judge's review, the brief's checks and the micro benchmarks; and what is still
// pending. Confidence is computed by fixed rules from those: 100% only when every item holds up
// (the app's own test run passes on the code as it is now, every criterion is met, CI and the
// judge agree, nothing is pending). A model's say-so can't raise it.
//
// When an agent on a Jira issue says it's done, the project's test command is run in its folder;
// the Eval is worked out again whenever its inputs change (a review, the scorecard, CI).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SLOWER_PCT } from './benchmarks.js';
import { readSpecDoc } from './brief.js';

const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_RUNS = 60;
const now = () => new Date().toISOString();
const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// A command that runs tests (not one that only builds or lints).
export const TEST_COMMAND =
  /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?(test|t)\b|npx\s+(jest|vitest|mocha|playwright\s+test|ava|tap)\b|node\s+(--test|[\w./-]*test[\w./-]*\.m?js)\b|jest\b|vitest\b|mocha\b|go\s+test\b|pytest\b|python3?\s+-m\s+(pytest|unittest)\b|tox\b|cargo\s+(test|nextest)\b|mvn\b[^;&|]*\b(test|verify)\b|(\.\/)?gradlew?\b[^;&|]*\btest\b|make\s+(test|check)\b|dotnet\s+test\b|rspec\b|rake\s+test\b|ctest\b|swift\s+test\b|phpunit\b|mix\s+test\b|deno\s+test\b)/;

/** Passed and failed counts from a test run's output, when it says (node, jest, pytest, go, mvn, cargo…). */
export function countsOf(output) {
  const t = String(output ?? '');
  const num = (re) => {
    const m = re.exec(t);
    return m ? Number(m[1]) : null;
  };
  // node --test (TAP)
  let passed = num(/^# pass (\d+)/m);
  let failed = num(/^# fail (\d+)/m);
  if (passed !== null || failed !== null) return { passed: passed ?? 0, failed: failed ?? 0 };
  // jest / vitest: "Tests: 1 failed, 12 passed, 13 total" / "Tests  12 passed (12)"
  const jest = /Tests:?\s+(?:(\d+) failed,?\s*)?(?:\d+ skipped,?\s*)?(?:(\d+) passed)/.exec(t);
  if (jest) return { passed: Number(jest[2] ?? 0), failed: Number(jest[1] ?? 0) };
  // pytest: "== 3 failed, 41 passed in 2.1s ==" (its last summary line)
  const py = [...t.matchAll(/^=+ ([^=\n]*\b(?:passed|failed)\b[^=\n]*) =+$/gm)].pop()?.[1];
  if (py) return { passed: Number(/(\d+) passed/.exec(py)?.[1] ?? 0), failed: Number(/(\d+) failed/.exec(py)?.[1] ?? 0) + Number(/(\d+) errors?/.exec(py)?.[1] ?? 0) };
  // mvn / surefire: "Tests run: 12, Failures: 1, Errors: 0"
  const mvn = [...t.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+)/g)].pop();
  if (mvn) return { passed: Number(mvn[1]) - Number(mvn[2]) - Number(mvn[3]), failed: Number(mvn[2]) + Number(mvn[3]) };
  // cargo: "test result: ok. 12 passed; 0 failed"
  const cargo = [...t.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length) return cargo.reduce((s, m) => ({ passed: s.passed + Number(m[1]), failed: s.failed + Number(m[2]) }), { passed: 0, failed: 0 });
  // go: "ok  pkg" / "FAIL pkg" lines, and "--- FAIL:" per test
  const ok = (t.match(/^ok\s+\S+/gm) ?? []).length;
  const bad = (t.match(/^--- FAIL:/gm) ?? []).length || (t.match(/^FAIL\s+\S+/gm) ?? []).length;
  if (ok || bad) return { passed: ok, failed: bad, unit: 'packages' };
  return null;
}

/** The text of a tool result (a string, or a list of text parts). */
const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('\n') : '');

/**
 * The test runs in an agent's session (Claude Code's transcript, JSON lines): every Bash call that
 * ran tests, with whether it passed and the counts it printed. Oldest first.
 */
export function testRuns(text) {
  const calls = new Map();
  const runs = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line may be cut
    }
    for (const c of entry.message?.content ?? []) {
      if (c?.type === 'tool_use' && c.name === 'Bash' && typeof c.input?.command === 'string' && TEST_COMMAND.test(c.input.command)) {
        calls.set(c.id, { command: clip(c.input.command.trim(), 300), at: entry.timestamp ?? null });
      } else if (c?.type === 'tool_result' && calls.has(c.tool_use_id)) {
        const call = calls.get(c.tool_use_id);
        calls.delete(c.tool_use_id);
        const out = resultText(c.content);
        const counts = countsOf(out);
        // A command that failed says so (is_error, "Exit code N"); failures counted mean failed too.
        const passed = !c.is_error && !/^Exit code [1-9]/m.test(out) && !(counts?.failed > 0);
        runs.push({ ...call, passed, counts, tail: clip(out.split('\n').slice(-8).join('\n'), 600) });
      }
    }
  }
  return runs.slice(-MAX_RUNS);
}

/** Read the end of a transcript (big sessions: the last few MB, where the final runs are). */
export function readTail(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** The project's test command from its files, or null: `exists(name)` and `read(name)` look in its folder. */
export function detectTestCommand({ exists, read }) {
  if (exists('package.json')) {
    try {
      const t = JSON.parse(read('package.json'))?.scripts?.test;
      if (t && !/no test specified/.test(t)) return exists('pnpm-lock.yaml') ? 'pnpm test' : exists('yarn.lock') ? 'yarn test' : 'npm test';
    } catch {}
  }
  if (exists('go.mod')) return 'go test ./...';
  if (exists('Cargo.toml')) return 'cargo test';
  if (exists('pom.xml')) return exists('mvnw') ? './mvnw -q test' : 'mvn -q test';
  if (exists('gradlew')) return './gradlew test';
  if (['pytest.ini', 'conftest.py', 'tox.ini', 'pyproject.toml', 'setup.cfg'].some(exists)) return 'python3 -m pytest -q';
  if (exists('Makefile') && /^test:/m.test(read('Makefile') ?? '')) return 'make test';
  return null;
}

/** The command the agent ran most (its last run of it wins ties): what it thinks the tests are. */
export function usualCommand(runs) {
  const n = new Map();
  for (const r of runs) n.set(r.command, (n.get(r.command) ?? 0) + 1);
  let best = null;
  for (const [c, k] of n) if (!best || k >= best[1]) best = [c, k];
  return best?.[0] ?? null;
}

// What each item weighs in the confidence; "na" items don't count either way.
export const WEIGHTS = { rerun: 25, criteria: 25, agentTests: 10, coverage: 10, ci: 10, judge: 10, checks: 5, bench: 5 };
export const LABELS = {
  rerun: 'Tests run again by AI Agent Manager',
  criteria: 'Acceptance criteria',
  agentTests: 'Tests the agent ran',
  coverage: 'Tests for the changed code',
  ci: 'CI on the pull request',
  judge: 'AI judge review',
  checks: 'Checks in the brief',
  bench: 'Micro benchmarks',
};

/**
 * The Eval from what is known: { confidence, items: [{ key, label, state, score, detail }],
 * pending: [text], runs, rerun, criteria }. state: ok | partial | pending | failed | na.
 */
export function evaluate({ runs = [], rerun = null, state = null, scorecard = null, hasSpec = false, ci = null, ciFailed = [], review = null, judgeOn = true, checks = [], codeFiles = 0, testFiles = 0, bench = null, testCommand = null, readable = true }) {
  const items = [];
  const add = (key, st, score, detail, extra = {}) => items.push({ key, label: LABELS[key], state: st, score, detail, ...extra });

  // The app's own run, on the code as it is now.
  if (rerun?.running) add('rerun', 'pending', 0, `Running ${rerun.command}…`);
  else if (!rerun) add('rerun', 'pending', 0, testCommand ? `Not run yet (${testCommand})` : 'No test command found for this project: set one');
  else if (state && rerun.state !== state) add('rerun', 'pending', 0, `The code changed after the last run (${rerun.passed ? 'passed' : 'failed'} ${rerun.at}): run again`);
  else if (rerun.passed) add('rerun', 'ok', 1, `${rerun.command} passed${rerun.counts ? `: ${rerun.counts.passed} passed` : ''}`);
  else add('rerun', 'failed', 0, `${rerun.command} failed${rerun.counts ? `: ${rerun.counts.failed} failed, ${rerun.counts.passed} passed` : rerun.timedOut ? ' (timed out)' : ''}`);

  // Acceptance criteria, as the scorecard found them.
  const crit = scorecard?.criteria ?? [];
  if (crit.length) {
    const met = crit.filter((c) => c.status === 'met').length;
    const st = met === crit.length ? 'ok' : crit.some((c) => c.status === 'not_met') ? 'failed' : 'partial';
    add('criteria', st, met / crit.length, `${met} of ${crit.length} met`);
  } else if (scorecard) add('criteria', 'pending', 0, hasSpec ? 'Not assessed by the scorecard' : 'No acceptance criteria written (no spec)');
  else add('criteria', 'pending', 0, hasSpec ? 'Not checked yet: the scorecard checks them' : 'No acceptance criteria written (no spec)');

  // The agent's own runs: the last run of each command.
  const last = new Map();
  for (const r of runs) last.set(r.command, r);
  const finals = [...last.values()];
  if (!readable) add('agentTests', 'na', 0, "This engine's session can't be read for test runs");
  else if (!runs.length) add('agentTests', 'pending', 0, 'The agent ran no tests in its session');
  else if (finals.every((r) => r.passed)) add('agentTests', 'ok', 1, `${runs.length} run${runs.length === 1 ? '' : 's'}; the last of each passed`);
  else add('agentTests', 'failed', 0, `Last run failed: ${finals.filter((r) => !r.passed).map((r) => r.command).join(', ')}`);

  if (!codeFiles) add('coverage', 'na', 0, 'No code changed');
  else if (testFiles) add('coverage', 'ok', 1, `${testFiles} test file${testFiles === 1 ? '' : 's'} changed with ${codeFiles} code file${codeFiles === 1 ? '' : 's'}`);
  else add('coverage', 'pending', 0, `${codeFiles} code file${codeFiles === 1 ? '' : 's'} changed, no test changed or added`);

  if (ci === 'passed') add('ci', 'ok', 1, 'All checks pass');
  else if (ci === 'failed') add('ci', 'failed', 0, `Failing${ciFailed.length ? `: ${ciFailed.join(', ')}` : ''}`);
  else if (ci === 'running') add('ci', 'pending', 0, 'Checks still running');
  else add('ci', 'na', 0, 'No pull request (or no checks) yet');

  if (!judgeOn) add('judge', 'na', 0, 'The AI judge is off');
  else if (review?.pending) add('judge', 'pending', 0, 'Reviewing…');
  else if (!review?.verdict) add('judge', 'pending', 0, 'Not reviewed yet');
  else if (review.verdict === 'complete') add('judge', 'ok', 1, `Complete${review.summary ? `: ${clip(review.summary, 160)}` : ''}`);
  else if (review.verdict === 'partial') add('judge', 'partial', 0.5, `Partly done${review.missing?.length ? `; missing: ${review.missing.join('; ')}` : ''}`);
  else add('judge', 'failed', 0, `Not done${review.missing?.length ? `; missing: ${review.missing.join('; ')}` : ''}`);

  const count = (st) => checks.filter((c) => c.state === st).length;
  if (!checks.length) add('checks', 'na', 0, 'No checks listed');
  else if (count('failed')) add('checks', 'failed', 0, `${count('failed')} of ${checks.length} failed`);
  else if (count('pending') + count('running')) add('checks', 'partial', count('passed') / checks.length, `${count('passed')} of ${checks.length} passed, ${count('pending') + count('running')} pending`);
  else add('checks', 'ok', 1, `${checks.length} passed`);

  if (!bench) add('bench', 'na', 0, 'Not benchmarked');
  else if (!bench.runs.length) add('bench', 'pending', 0, `${bench.modules.join(', ')}: not measured yet`);
  else {
    const slow = bench.runs.filter((r) => r.worst !== null && r.worst > SLOWER_PCT && !r.accepted);
    if (slow.length) add('bench', 'failed', 0, slow.map((r) => `${r.module || 'repository'} ${r.worst}% slower`).join('; '));
    else add('bench', 'ok', 1, bench.runs.map((r) => `${r.module || 'repository'} ${r.worst === null ? 'measured' : r.worst > 0 ? `+${r.worst}%` : `${r.worst}%`}`).join('; '));
  }

  const counted = items.filter((i) => i.state !== 'na');
  const total = counted.reduce((n, i) => n + WEIGHTS[i.key], 0);
  let confidence = total ? Math.floor((100 * counted.reduce((n, i) => n + WEIGHTS[i.key] * i.score, 0)) / total) : 0;
  // 100 only when everything holds up.
  if (counted.some((i) => i.state !== 'ok')) confidence = Math.min(confidence, 99);
  const pending = [
    ...items.filter((i) => i.state !== 'ok' && i.state !== 'na').map((i) => `${i.label}: ${i.detail}`),
    ...crit.filter((c) => c.status !== 'met').map((c) => `${c.status === 'not_met' ? 'Not met' : 'Not verified'}: ${c.criterion}`),
  ];
  return { confidence, items, pending, criteria: crit, runs, rerun, at: now() };
}

const MARK = { ok: '✅', partial: '🟡', pending: '⏳', failed: '❌', na: '—' };

/** Markdown: to copy into Jira or post on the pull request. */
export function evalMarkdown(ev, title = '') {
  const last = new Map();
  for (const r of ev.runs) last.set(r.command, r);
  return [
    `### Eval${title ? `: ${title}` : ''}`,
    '',
    `**Confidence: ${ev.confidence}%**${ev.confidence === 100 ? ' (every check holds up)' : ''}`,
    '',
    '| | Verification | Result |',
    '| --- | --- | --- |',
    ...ev.items.map((i) => `| ${MARK[i.state]} | ${i.label} | ${String(i.detail).replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
    '',
    ...(ev.criteria.length ? ['**Acceptance criteria**', '', ...ev.criteria.map((c) => `- ${c.status === 'met' ? '✅' : c.status === 'not_met' ? '❌' : '⏳'} ${c.criterion}${c.evidence ? ` — ${c.evidence}` : ''}`), ''] : []),
    ...(last.size ? ['**Tests run**', '', ...[...last.values()].map((r) => `- ${r.passed ? '✅' : '❌'} \`${r.command}\`${r.counts ? ` (${r.counts.passed} passed, ${r.counts.failed} failed)` : ''}`), ...(ev.rerun && !ev.rerun.running ? [`- ${ev.rerun.passed ? '✅' : '❌'} \`${ev.rerun.command}\` run again by AI Agent Manager on the final change${ev.rerun.counts ? ` (${ev.rerun.counts.passed} passed, ${ev.rerun.counts.failed} failed)` : ''}`] : []), ''] : []),
    ...(ev.pending.length ? ['**Pending**', '', ...ev.pending.map((p) => `- ${p}`), ''] : ['Nothing pending.', '']),
  ].join('\n');
}

/** "Close the gaps": what the agent is asked to do to bring confidence to 100%. */
export function gapsMessage(ev) {
  return [
    `The Eval of this change is ${ev.confidence}% confident. To make it 100%, close these gaps:`,
    ev.pending.map((p) => `- ${p}`).join('\n'),
    'Add or fix tests for the changed code and run them, meet each acceptance criterion and show what proves it (a test or a check in the brief), and fix what fails. Stay within the task. Update the brief when you are done; the tests are run again and the Eval worked out again then.',
  ].join('\n\n');
}

/** A short hash of the code as it is: HEAD, and what is changed or added on top. */
export const stateHash = (head, status, diff) => crypto.createHash('sha1').update(`${head}\n${status}\n${diff}`).digest('hex').slice(0, 16);

export class Evals {
  /**
   * `run(agent, command)` → { passed, output, timedOut } runs a command in the agent's folder;
   * `state(agent)` → a hash of its code as it is; `changes(agent)` → { files: [{ path }] };
   * `transcript(agent)` → its session's text (Claude Code), or null when it can't be read.
   */
  constructor({ manager, store, run, state, commit = async () => null, changes = async () => ({ files: [] }), transcript, benches = null, log = () => {} }) {
    this.manager = manager;
    this.store = store;
    this.run = run;
    this.state = state;
    // The commit the tests ran on, and whether nothing was left uncommitted: merging relies on it.
    this.commit = commit;
    this.changes = changes;
    this.transcript = transcript;
    this.benches = benches;
    this.log = log;
    this.running = new Set();
    this.onFinished = (agent) => {
      if (agent && this.eligible(agent)) this.verify(agent.id).catch((e) => this.log(`eval: ${e.message}`));
    };
    manager.on('finished', this.onFinished);
    this.timer = null;
  }

  close() {
    this.manager.off('finished', this.onFinished);
    clearInterval(this.timer);
  }

  /** Every minute: work out again the Evals whose inputs changed (a review, the scorecard, CI). */
  startTimer(ms = 60_000) {
    this.timer = setInterval(() => this.refreshAll().catch((e) => this.log(`eval: ${e.message}`)), ms);
    this.timer.unref?.();
  }

  /** Task agents on a Jira issue (not hunters, reviewers, fixers or team members). */
  eligible(agent) {
    return Boolean(agent && agent.kind === 'task' && agent.workdir && !agent.hunting && !agent.reviewing && !agent.fixing && !agent.team && !agent.builds && this.manager.issueKey(agent));
  }

  /** The project's test command: set for the project, else found in its files, else the agent's usual one. */
  testCommand(agent, runs = []) {
    const p = this.manager.projectInfo(agent);
    const set = Object.values(this.store.data.projects ?? {}).find((x) => x.key === p?.key)?.testCommand;
    if (set) return set;
    const dir = agent.workdir;
    const found = dir && fs.existsSync(dir) ? detectTestCommand({ exists: (n) => fs.existsSync(path.join(dir, n)), read: (n) => fs.readFileSync(path.join(dir, n), 'utf8') }) : null;
    return found ?? usualCommand(runs);
  }

  /** Set the test command for an agent's project (empty: back to finding it). */
  setTestCommand(ref, command) {
    const agent = this.manager.mustGet(ref);
    const p = this.manager.projectInfo(agent);
    const entry = Object.values(this.store.data.projects ?? {}).find((x) => x.key === p?.key);
    if (!entry) throw err(409, "This agent's project isn't registered");
    const c = String(command ?? '').trim().slice(0, 300);
    if (c) entry.testCommand = c;
    else delete entry.testCommand;
    this.store.save();
    return { testCommand: this.testCommand(agent) };
  }

  /** Run the tests on the agent's change as it is now, then work the Eval out. */
  async verify(ref) {
    const agent = this.manager.mustGet(ref);
    if (!agent.workdir || !fs.existsSync(agent.workdir)) throw err(409, 'The agent has no folder to run the tests in');
    if (this.running.has(agent.id)) return this.view(agent.id);
    const runs = this.runsOf(agent);
    const command = this.testCommand(agent, runs ?? []);
    if (!command) return this.compute(agent.id);
    this.running.add(agent.id);
    this.manager.patch(agent.id, { eval: { ...(agent.eval ?? {}), rerun: { command, running: true, at: now() } } });
    let rerun = null;
    try {
      const started = Date.now();
      const st = await this.state(agent).catch(() => null);
      const at = await this.commit(agent).catch(() => null);
      const res = await this.run(agent, command);
      rerun = { command, passed: Boolean(res.passed), counts: countsOf(res.output), tail: clip(String(res.output ?? '').split('\n').slice(-15).join('\n'), 2000), timedOut: Boolean(res.timedOut), state: st, head: at?.head ?? null, clean: at?.clean ?? null, at: now(), ms: Date.now() - started };
    } catch (e) {
      rerun = { command, passed: false, counts: null, tail: clip(String(e?.message ?? e), 2000), timedOut: false, state: null, at: now(), ms: 0 };
    } finally {
      this.running.delete(agent.id);
    }
    // The run and what it means are kept together, so no one sees one without the other.
    return this.compute(agent.id, rerun);
  }

  runsOf(agent) {
    const text = this.transcript(agent);
    return text === null ? null : testRuns(text);
  }

  /** Work the Eval out from what is known now (no test run), and keep it on the agent. */
  async compute(id, rerun) {
    const stored = this.store.get(id);
    if (!stored) return null;
    const agent = rerun ? { ...stored, eval: { ...(stored.eval ?? {}), rerun } } : stored;
    const runs = this.runsOf(agent);
    const ch = await this.changes(agent).catch(() => ({ files: [] }));
    const TEST = /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)\.[a-z]+$|_test\.go$|Test\.java$/i;
    const files = (ch?.files ?? []).map((f) => f.path ?? f);
    const testFiles = files.filter((p) => TEST.test(p)).length;
    const codeFiles = files.filter((p) => !TEST.test(p) && !/\.(md|txt|rst|adoc)$/i.test(p) && !/(^|\/)docs?\//i.test(p)).length;
    const pr = Object.values(agent.prs ?? {}).find((p) => p.source !== 'mentioned' && p.state === 'OPEN') ?? Object.values(agent.prs ?? {}).find((p) => p.source !== 'mentioned');
    const benchRuns = this.benches ? this.benches.runs.filter((r) => r.agentId === id) : [];
    const benchMods = [...new Set([...(agent.benchModules ?? []), ...benchRuns.map((r) => r.module)])];
    const ev = evaluate({
      runs: runs ?? [],
      readable: runs !== null,
      rerun: agent.eval?.rerun ?? null,
      state: await this.state(agent).catch(() => null),
      scorecard: agent.docs?.scorecard?.data ?? null,
      hasSpec: Boolean(readSpecDoc(id, 'spec')?.markdown?.trim()),
      ci: pr?.checks?.state ?? null,
      ciFailed: pr?.checks?.failed ?? [],
      review: agent.aiReview ?? null,
      judgeOn: this.manager.judge?.enabled !== false,
      checks: agent.brief?.checks ?? [],
      codeFiles,
      testFiles,
      bench: benchMods.length ? { modules: benchMods, runs: benchRuns } : null,
      testCommand: this.testCommand(agent, runs ?? []),
    });
    ev.sig = this.signature(agent);
    ev.markdown = evalMarkdown(ev, agent.name);
    ev.testCommand = this.testCommand(agent, runs ?? []);
    const cur = this.store.get(id);
    if (!cur) return null;
    // A test run ended while this was worked out: the one it ended with has the newer answer.
    if (!rerun && (cur.eval?.rerun?.at ?? null) !== (agent.eval?.rerun?.at ?? null)) return this.view(id);
    this.manager.patch(id, { eval: { ...ev, rerun: rerun ?? cur.eval?.rerun ?? null, postedTo: cur.eval?.postedTo ?? null } });
    this.manager.emit?.('evaluated', this.store.get(id));
    return this.view(id);
  }

  /** What the Eval was worked out from: when it changes, it's worked out again. */
  signature(agent) {
    const pr = Object.values(agent.prs ?? {}).map((p) => `${p.url}:${p.state}:${p.checks?.state ?? ''}`).join(',');
    const bench = this.benches ? this.benches.runs.filter((r) => r.agentId === agent.id).map((r) => `${r.id}:${r.at}:${r.accepted ?? ''}`).join(',') : '';
    return [agent.aiReview?.at, agent.aiReview?.pending, agent.docs?.scorecard?.at, agent.brief?.updatedAt, pr, bench, agent.eval?.rerun?.at].join('|');
  }

  async refreshAll() {
    for (const a of this.store.list()) {
      if (!a.eval || a.eval.rerun?.running || this.running.has(a.id)) continue;
      if (a.eval.sig !== this.signature(a)) await this.compute(a.id);
    }
  }

  view(id) {
    const a = this.store.get(id);
    return a ? { id: a.id, name: a.name, eval: a.eval ?? null, markdown: a.eval?.markdown ?? null } : null;
  }

  /** Send the gaps to the agent. */
  closeGaps(ref) {
    const agent = this.manager.mustGet(ref);
    if (!agent.eval?.items) throw err(409, 'Work the Eval out first');
    if (!agent.eval.pending.length) throw err(409, 'Nothing is pending');
    this.manager.tell(agent.id, gapsMessage(agent.eval), { source: 'eval' });
    return { ok: true };
  }

  /** Agents done with their issue but not 100% sure, for Today. */
  unsure() {
    return this.store.list().filter((a) => a.eval?.items && a.eval.confidence < 100 && a.brief?.status === 'done' && !a.eval.rerun?.running && !(a.eval.seenAt && a.eval.seenConfidence === a.eval.confidence));
  }

  /** "Seen": off Today until its confidence changes (Undo: seen false). */
  seen(ref, seen = true) {
    const a = this.manager.mustGet(ref);
    if (!a.eval) throw err(409, 'No Eval yet');
    const ev = { ...a.eval };
    if (seen) Object.assign(ev, { seenAt: now(), seenConfidence: ev.confidence });
    else delete ev.seenAt;
    this.manager.patch(a.id, { eval: ev });
    return { ok: true };
  }
}
