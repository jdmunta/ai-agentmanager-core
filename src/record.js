// Track record: was the confidence right? Quality (quality.js) knows what happened to each merged
// pull request: held up, or reverted, fixed afterwards, failed checks. This keeps, for each one,
// what was said about it when it merged (the agent's own confidence, the review scorecard, whether
// its tests were tested, the model, how far it ran without the person) and compares the two:
// "said 85% on average, 6 of 10 held up". Per project it also says what level of "Without you"
// the record supports. The level stays the person's to set; this only suggests. No model is called.

import { costOf } from './budgets.js';

export const MIN_TO_SAY = 5; // fewer settled pull requests than this say nothing
const LEVELS = ['ask', 'run', 'pr', 'merge'];
const LEVEL_LABEL = { ask: 'Ask me', run: 'Agree, then run', pr: 'Run to pull request', merge: 'Run to merge' };
const PROBLEMS = new Set(['incident', 'reverted', 'fixed', 'broke', 'problem']);
const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);

// Kinds of work, read from the request's words (first match wins). No model: a rough sort that is
// stable and can be checked; work it cannot place is a feature.
export const KINDS = [
  ['docs', 'Documentation', /\b(docs?|readme|documentation|changelog|comments?)\b/i],
  ['tests', 'Tests', /\b(tests?|test cases?|coverage|e2e|unit tests?)\b/i],
  ['upgrade', 'Upgrades and migrations', /\b(upgrade|bump|migrat(e|ion)|dependenc(y|ies)|deprecat)/i],
  ['fix', 'Bug fixes', /\b(fix(es|ed)?|bugs?|crash(es)?|errors?|broken|regression|fails?|failing|exception)\b/i],
  ['refactor', 'Refactoring', /\b(refactor|clean ?up|rename|simplif(y|ies)|restructure|dedupe)\b/i],
  ['investigate', 'Investigation', /\b(investigate|explore|analy[sz]e|research|look into|find out|why)\b/i],
];
export const KIND_LABEL = { ...Object.fromEntries(KINDS.map(([k, l]) => [k, l])), feature: 'Features' };

/** The kind of a piece of work from its request or title. */
export function kindOf(text) {
  const t = String(text ?? '').split('\n')[0].replace(/^<?https?:\/\/\S+>?\s*/, '');
  return KINDS.find(([, , re]) => re.test(t))?.[0] ?? 'feature';
}

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
    // What the AI work cost as it merged, kept only to compare models with each other (never shown as money).
    cost: costOf(agent) || null,
    kind: kindOf(agent.intent ?? agent.name),
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

const modelKey = (it) => `${it.said?.engine ?? 'unknown'}${it.said?.model ? ` · ${it.said.model}` : ''}`;

/**
 * Model fit: which model held up as well as the most used one at a lower cost. Per model: how many
 * settled pieces, the share that held up, the average review scorecard, and the cost per piece
 * against the most used model's (a ratio, not money). A suggestion needs MIN_TO_SAY settled pieces
 * for both, a share that held up within 5 points of the most used model's, and a cost at most
 * three quarters of it. `settled`: the settled pull requests.
 */
export function modelFit(settled) {
  const keys = [...new Set(settled.map(modelKey))];
  const rows = keys.map((k) => {
    const list = settled.filter((it) => modelKey(it) === k);
    const held = list.filter((it) => it.held).length;
    const costs = list.map((it) => it.said?.cost).filter((c) => Number.isFinite(c) && c > 0);
    const scores = list.map((it) => it.said?.score).filter(Number.isFinite);
    return { model: k, n: list.length, held, heldPct: round((held / list.length) * 100), avgCost: costs.length ? costs.reduce((a, c) => a + c, 0) / costs.length : null, costed: costs.length, score: scores.length ? round(scores.reduce((a, c) => a + c, 0) / scores.length) : null };
  }).sort((a, b) => b.n - a.n);
  const base = rows[0] ?? null;
  const out = rows.map((r) => ({ ...r, costVsMain: base?.avgCost && r.avgCost ? Math.round((r.avgCost / base.avgCost) * 100) / 100 : null, avgCost: undefined }));
  let suggestion = null;
  if (base && base.n >= MIN_TO_SAY && base.avgCost) {
    const better = out
      .slice(1)
      .filter((r) => r.n >= MIN_TO_SAY && r.costed >= MIN_TO_SAY && r.costVsMain != null && r.costVsMain <= 0.75 && r.heldPct >= base.heldPct - 5)
      .sort((a, b) => a.costVsMain - b.costVsMain)[0];
    if (better) suggestion = { model: better.model, main: base.model, costVsMain: better.costVsMain, heldPct: better.heldPct, mainHeldPct: base.heldPct, n: better.n };
  }
  return { rows: out, suggestion };
}

/**
 * Delegation map: by kind of work, how much went to agents, how far it ran without the person,
 * and how it held up. A kind that held up at 9 in 10 over 5 settled pull requests while most of it
 * still asked the person is the next worth handing over more of; one under 7 in 10 is worth
 * keeping close. `settled`: the settled pull requests.
 */
export function delegationMap(settled) {
  const kindOfItem = (it) => it.said?.kind ?? kindOf(it.title);
  const rows = Object.keys(KIND_LABEL)
    .map((k) => {
      const list = settled.filter((it) => kindOfItem(it) === k);
      if (!list.length) return null;
      const held = list.filter((it) => it.held).length;
      const asked = list.filter((it) => (it.said?.level ?? 'ask') === 'ask').length;
      const heldPct = round((held / list.length) * 100);
      const advice =
        list.length < MIN_TO_SAY ? null : heldPct >= 90 && asked * 2 > list.length ? 'hand over more' : heldPct < 70 ? 'keep close' : null;
      return { kind: k, label: KIND_LABEL[k], n: list.length, held, heldPct, withoutYou: list.length - asked, advice };
    })
    .filter(Boolean)
    .sort((a, b) => b.n - a.n);
  const next = rows.filter((r) => r.advice === 'hand over more').sort((a, b) => b.heldPct - a.heldPct || b.n - a.n)[0] ?? null;
  return { rows, next: next ? { kind: next.kind, label: next.label, heldPct: next.heldPct, n: next.n } : null };
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
    fit: modelFit(settled),
    delegation: delegationMap(settled),
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
  if (r.delegation.rows.length) {
    out.push('## Delegation map', '', ...r.delegation.rows.map((d) => `- ${d.label}: ${d.held} of ${d.n} held up (${d.heldPct}%), ${d.withoutYou} ran without you${d.advice ? `: ${d.advice}` : ''}`));
    if (r.delegation.next) out.push('', `Next to hand over more of: **${r.delegation.next.label}** (${r.delegation.next.heldPct}% held up over ${r.delegation.next.n}, most of it still asking you).`);
    out.push('');
  }
  if (r.fit.rows.length > 1) {
    out.push('## Model fit', '', ...r.fit.rows.map((m) => `- ${m.model}: ${m.held} of ${m.n} held up (${m.heldPct}%)${m.score != null ? `, scorecard ${m.score} on average` : ''}${m.costVsMain != null && m !== r.fit.rows[0] ? `, ${m.costVsMain} times the cost of ${r.fit.rows[0].model}` : ''}`));
    if (r.fit.suggestion) out.push('', `**${r.fit.suggestion.model}** held up as well as ${r.fit.suggestion.main} (${r.fit.suggestion.heldPct}% against ${r.fit.suggestion.mainHeldPct}%) at ${r.fit.suggestion.costVsMain} times the cost, over ${r.fit.suggestion.n} settled pull requests: worth trying for more of the work.`);
    out.push('');
  }
  if (r.projects.length) {
    out.push('## Projects', '');
    for (const p of r.projects) {
      out.push(`- ${line(p)}. New agents: ${LEVEL_LABEL[p.current]}${p.level ? '' : ' (the default)'}.${p.suggestion ? ` The record supports **${LEVEL_LABEL[p.suggestion.level]}**: ${p.suggestion.why}.` : ''}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}
