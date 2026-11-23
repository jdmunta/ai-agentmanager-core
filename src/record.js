// Track record: was the confidence right? Quality (quality.js) knows what happened to each merged
// pull request: held up, or reverted, fixed afterwards, failed checks. This keeps, for each one,
// what was said about it when it merged (the agent's own confidence, the review scorecard, whether
// its tests were tested, the model, how far it ran without the person) and compares the two:
// "said 85% on average, 6 of 10 held up". Per project it also says what level of "Without you"
// the record supports. The level stays the person's to set; this only suggests. No model is called.

export const MIN_TO_SAY = 5; // fewer settled pull requests than this say nothing
const LEVELS = ['ask', 'run', 'pr', 'merge'];
const LEVEL_LABEL = { ask: 'Ask me', run: 'Agree, then run', pr: 'Run to pull request', merge: 'Run to merge' };
const PROBLEMS = new Set(['reverted', 'fixed', 'broke', 'problem']);
const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);

/** What is said about an agent's work now, kept when its pull request merges. */
export function saidOf(agent, { engine = null } = {}) {
  const sc = agent.docs?.scorecard?.data;
  const b = agent.breaks?.baseline?.ok ? agent.breaks.breaks ?? [] : null;
  const n = (st) => b.filter((x) => x.status === st).length;
  const pct = agent.brief?.results?.confidence?.percent;
  return {
    confidence: Number.isFinite(pct) ? pct : null,
    score: Number.isFinite(sc?.overall) ? sc.overall : null,
    recommendation: sc?.recommendation ?? null,
    breaks: b && n('caught') + n('missed') ? { caught: n('caught'), tried: n('caught') + n('missed') } : null,
    notDone: agent.brief?.results?.notDone?.length ?? 0,
    engine: engine ?? agent.engine ?? 'claude',
    model: agent.model ?? null,
    level: LEVELS.includes(agent.autonomy?.level) ? agent.autonomy.level : 'ask',
  };
}

const BANDS = [
  ['90', '90 to 100%', (c) => c >= 90],
  ['70', '70 to 89%', (c) => c >= 70 && c < 90],
  ['50', '50 to 69%', (c) => c >= 50 && c < 70],
  ['0', 'under 50%', (c) => c < 50],
];
const RECOMMENDATION = { ready: 'Ready to approve', look: 'Look at these first', not_ready: 'Not ready' };

/** How what was said compares with what held: a few words, or that there are too few to say. */
export function readOf(row) {
  if (row.n < MIN_TO_SAY) return 'too few to say';
  if (row.said == null) return '';
  if (row.said - row.heldPct >= 15) return 'said more than held up';
  if (row.heldPct - row.said >= 15) return 'held up better than said';
  return 'about right';
}

function rowsOf(settled, groups) {
  return groups
    .map(([key, label, test]) => {
      const list = settled.filter((it) => test(it));
      const held = list.filter((it) => it.held).length;
      const conf = list.map((it) => it.said?.confidence).filter(Number.isFinite);
      const row = { key, label, n: list.length, held, heldPct: list.length ? round((held / list.length) * 100) : null, said: conf.length ? round(conf.reduce((a, c) => a + c, 0) / conf.length) : null };
      return { ...row, read: readOf(row) };
    })
    .filter((r) => r.n);
}

/**
 * The level of "Without you" a project's record supports: { level, why } when it differs from the
 * one it has, else null. One step at a time; down after a recent problem, up only on a clean run.
 * `settled`: the project's settled pull requests, newest first.
 */
export function suggestLevel(settled, current = 'ask') {
  const i = LEVELS.indexOf(current);
  const last = (n) => settled.slice(0, n);
  const bad3 = last(3).filter((it) => !it.held).length;
  if (bad3 && i > 0) return { level: LEVELS[i - 1], direction: 'down', why: `${bad3} of its last ${last(3).length} merged pull request${last(3).length === 1 ? '' : 's'} did not hold up` };
  const held = settled.filter((it) => it.held).length;
  const pct = settled.length ? (held / settled.length) * 100 : 0;
  if (current === 'pr') {
    if (settled.length >= 10 && pct >= 95 && last(10).every((it) => it.held)) return { level: 'merge', direction: 'up', why: `${held} of ${settled.length} held up, and all of the last 10` };
    return null;
  }
  if (i < LEVELS.indexOf('pr') && settled.length >= MIN_TO_SAY && pct >= 90 && last(5).every((it) => it.held)) return { level: LEVELS[i + 1], direction: 'up', why: `${held} of ${settled.length} held up, and all of the last 5` };
  return null;
}

/**
 * The record from Quality's items. `verdict(it)` is quality.js's verdictOf; a pull request counts
 * once it is settled: held up after the watch days, or a problem. `levels`: { default, projects }.
 */
export function trackRecord(items, verdict, { levels = {} } = {}) {
  const all = items.map((it) => ({ ...it, verdict: verdict(it) }));
  const settled = all
    .filter((it) => it.verdict === 'clean' || PROBLEMS.has(it.verdict))
    .map((it) => ({ ...it, held: it.verdict === 'clean' }))
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  const held = settled.filter((it) => it.held).length;
  const withConf = settled.filter((it) => Number.isFinite(it.said?.confidence));
  const uniq = (f) => [...new Set(settled.map(f))];
  const overall = rowsOf(withConf, [['all', 'all with a confidence', () => true]])[0] ?? null;
  const projects = uniq((it) => it.project ?? 'No project').map((name) => {
    const list = settled.filter((it) => (it.project ?? 'No project') === name);
    const row = rowsOf(list, [[name, name, () => true]])[0];
    const level = levels.projects?.[name] ?? null;
    const current = level ?? levels.default ?? 'ask';
    return { ...row, level, current, suggestion: name === 'No project' ? null : suggestLevel(list, current) };
  });
  return {
    settled: settled.length,
    open: all.length - settled.length,
    held,
    heldPct: settled.length ? round((held / settled.length) * 100) : null,
    // The agent's own confidence against what held: overall, then by what it said.
    confidence: overall,
    bands: rowsOf(withConf, BANDS.map(([k, label, test]) => [k, label, (it) => test(it.said.confidence)])),
    noConfidence: settled.length - withConf.length,
    scorecard: rowsOf(settled, [...Object.entries(RECOMMENDATION).map(([k, label]) => [k, label, (it) => it.said?.recommendation === k]), ['none', 'No scorecard', (it) => !it.said?.recommendation]]),
    tests: rowsOf(settled, [
      ['all', 'Tests tested: every break caught', (it) => it.said?.breaks && it.said.breaks.caught === it.said.breaks.tried],
      ['some', 'Tests tested: a break not noticed', (it) => it.said?.breaks && it.said.breaks.caught < it.said.breaks.tried],
      ['none', 'Tests not tested', (it) => !it.said?.breaks],
    ]),
    models: rowsOf(settled, uniq((it) => `${it.said?.engine ?? 'unknown'}${it.said?.model ? ` · ${it.said.model}` : ''}`).map((k) => [k, k, (it) => `${it.said?.engine ?? 'unknown'}${it.said?.model ? ` · ${it.said.model}` : ''}` === k])),
    levels: rowsOf(settled, LEVELS.map((l) => [l, LEVEL_LABEL[l], (it) => (it.said?.level ?? 'ask') === l])),
    projects: projects.sort((a, b) => b.n - a.n),
    defaultLevel: levels.default ?? 'ask',
  };
}

const line = (r) => `${r.label}: ${r.held} of ${r.n} held up${r.heldPct == null ? '' : ` (${r.heldPct}%)`}${r.said != null ? `, said ${r.said}% on average` : ''}${r.read ? `: ${r.read}` : ''}`;

export function recordMarkdown(r) {
  const out = ['# Track record', ''];
  if (!r.settled) return [...out, `No merged pull request is settled yet${r.open ? ` (${r.open} still watched or not looked at)` : ''}. One counts once it held up for the watch days, or was reverted, fixed afterwards or failed its checks.`].join('\n');
  out.push(`${r.held} of ${r.settled} merged pull requests held up (${r.heldPct}%).${r.open ? ` ${r.open} more are still watched or not looked at.` : ''}`, '');
  const part = (title, rows, note = '') => {
    if (!rows.length) return;
    out.push(`## ${title}`, '', ...rows.map((x) => `- ${line(x)}`), ...(note ? ['', note] : []), '');
  };
  part("The agent's own confidence", [...(r.confidence ? [r.confidence] : []), ...r.bands], r.noConfidence ? `${r.noConfidence} had no confidence written.` : '');
  part('The review scorecard', r.scorecard);
  part('Tests tested', r.tests);
  part('Model', r.models);
  part('Without you', r.levels);
  if (r.projects.length) {
    out.push('## Projects', '');
    for (const p of r.projects) {
      out.push(`- ${line(p)}. New agents: ${LEVEL_LABEL[p.current]}${p.level ? '' : ' (the default)'}.${p.suggestion ? ` The record supports **${LEVEL_LABEL[p.suggestion.level]}**: ${p.suggestion.why}.` : ''}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}
