// The review scorecard: an agent's changes scored against what was asked (intent), what done means
// (spec), staying on task (scope), its plan, the tests and safety, with an overall readiness and the
// few places a person should actually read. A model judges; facts the app measures (CI, test files,
// plan ticks, the spec's criteria) cap and correct it, and the recommendation follows fixed rules,
// so a confident-sounding model can't talk a change into "ready".

export const DIMENSIONS = [
  ['intent', 'Intent', 'Does it do what was asked?'],
  ['spec', 'Spec', 'Are the acceptance criteria met?'],
  ['tests', 'Tests', 'Is it verified: CI, tests for the changed code, checks run?'],
  ['safety', 'Safety', 'Risky areas handled: security, data, migrations, dependencies, public APIs (higher is safer)'],
  ['scope', 'Scope', 'Only what the task needs, in proportion?'],
  ['plan', 'Plan', 'Done as planned, departures explained?'],
];
const WEIGHTS = { intent: 25, spec: 20, tests: 20, safety: 15, scope: 10, plan: 10 };
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)\.[a-z]+$|_test\.go$|Test\.java$/i;

/** Facts the app knows without a model: CI, test files touched, the agent's checks, plan and spec progress. */
export function facts({ files = [], prs = [], brief = null, plan = '', spec = '' }) {
  const paths = files.map((f) => f.path);
  const tests = paths.filter((p) => TEST_FILE.test(p));
  const code = paths.filter((p) => !TEST_FILE.test(p) && !/\.(md|txt|rst|adoc)$/i.test(p) && !/(^|\/)docs?\//i.test(p));
  const open = prs.find((p) => p.state === 'OPEN') ?? prs[0];
  const checks = brief?.checks ?? [];
  const count = (st) => checks.filter((c) => c.state === st).length;
  const steps = [...String(plan).matchAll(/^\s*[-*]\s+\[([ xX~!])\]/gm)].map((m) => m[1].toLowerCase());
  const criteriaBlock = /^##\s*Acceptance criteria\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(String(spec))?.[1] ?? '';
  return {
    files: paths.length,
    added: files.reduce((s, f) => s + (f.added ?? 0), 0),
    removed: files.reduce((s, f) => s + (f.removed ?? 0), 0),
    testFiles: tests.length,
    codeFiles: code.length,
    ci: open?.checks?.state ?? null, // passed | failed | running | null (no PR or no checks)
    ciFailed: open?.checks?.failed ?? [],
    checks: { passed: count('passed'), failed: count('failed'), pending: count('pending') + count('running') },
    plan: steps.length ? { steps: steps.length, done: steps.filter((s) => s === 'x').length } : null,
    criteria: criteriaBlock.split('\n').filter((l) => /^\s*[-*\d]/.test(l) && /\w/.test(l)).length,
    hasSpec: Boolean(String(spec).trim()),
  };
}

const factLines = (f) =>
  [
    `files changed: ${f.files} (+${f.added} -${f.removed}); code files: ${f.codeFiles}; test files: ${f.testFiles}`,
    `CI on the pull request: ${f.ci ?? 'no pull request or no checks yet'}${f.ciFailed.length ? ` (failing: ${f.ciFailed.join(', ')})` : ''}`,
    `the agent's own checks (from its brief): ${f.checks.passed} passed, ${f.checks.failed} failed, ${f.checks.pending} pending`,
    `plan: ${f.plan ? `${f.plan.done} of ${f.plan.steps} steps ticked` : 'no plan written'}`,
    `spec: ${f.hasSpec ? `${f.criteria} acceptance criteria` : 'no spec written'}`,
  ].join('\n');

export function scorecardPrompt({ intent, status, digest, briefMarkdown, intentDoc, specDoc, planDoc, hunks, facts: f }) {
  return [
    "You score an AI coding agent's changes for a reviewer who wants to approve with confidence and read as little as possible.",
    'Be skeptical: a claim without evidence in the diff, the tests or the checks counts as unverified. Base everything on the material below.',
    '',
    'Reply with one JSON object only:',
    '{"summary": "<two sentences: what the change does and how sure you are>",',
    ' "scores": {"intent": {"score": 0-100, "why": "<one sentence>"}, "scope": {...}, "plan": {...}, "tests": {...}, "safety": {...}},',
    ' "criteria": [{"criterion": "<an acceptance criterion from the spec>", "status": "met|not_met|unverified", "evidence": "<where: file, test, check>"}],',
    ' "look": [{"id": "H3", "reason": "<why a person should read this hunk>"}]}',
    '',
    'Scoring (100 is best; be calibrated, not generous):',
    '- intent: how fully the change does what INTENT asks. Missing parts of the ask pull it down hard.',
    '- scope: 100 when every change serves the task; lower for unrelated edits, drive-by refactors, or a change far larger than the task needs.',
    '- plan: how closely the change follows PLAN (steps done, departures explained). Without a plan, judge whether the work is coherent.',
    '- tests: whether the changed behavior is verified: tests added or updated for it, CI, checks the agent ran. Code changes with no tests and no passing checks score low.',
    '- safety: 100 when nothing risky is touched or risks are handled; lower for security, auth, data loss, migrations, concurrency, money, new dependencies or public API changes without care.',
    '- criteria: one entry per acceptance criterion in SPEC, in its order; leave the list empty if there is no spec.',
    '- look: at most 5 hunks a person must read (the risky, subtle or unverified ones), most important first. Not the obvious ones.',
    '',
    '<facts_measured_by_the_app>',
    factLines(f),
    '</facts_measured_by_the_app>',
    '<intent>',
    intentDoc || intent || '(none)',
    '</intent>',
    '<spec>',
    specDoc || '(no spec written)',
    '</spec>',
    '<plan>',
    planDoc || '(no plan written)',
    '</plan>',
    '<agent_status>',
    status,
    '</agent_status>',
    '<conversation>',
    (digest || '(none)').slice(-12_000),
    '</conversation>',
    '<brief>',
    briefMarkdown || '(none)',
    '</brief>',
    '<hunks>',
    ...hunks.map((h) => `<hunk id="${h.id}" file="${h.file}">\n${h.head}\n${h.text}\n</hunk>`),
    '</hunks>',
  ].join('\n');
}

const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

/**
 * The scorecard from the model's reply and the facts: scores capped by what was measured, the spec
 * score computed from the criteria, the overall weighted, and a recommendation by rule.
 */
export function combine(reply, f, hunks) {
  const s = reply?.scores ?? {};
  const score = (k) => (s[k] && Number.isFinite(Number(s[k].score)) ? { score: clamp(s[k].score), why: String(s[k].why ?? '').slice(0, 300), notes: [] } : null);
  const out = { intent: score('intent'), scope: score('scope'), plan: score('plan'), tests: score('tests'), safety: score('safety'), spec: null };
  const cap = (k, max, note) => {
    if (out[k] && out[k].score > max) {
      out[k].score = max;
      out[k].notes.push(note);
    }
  };
  // Tests: failing CI or failing checks, or code changed with nothing verifying it.
  if (f.ci === 'failed') cap('tests', 30, `CI is failing${f.ciFailed.length ? ` (${f.ciFailed.join(', ')})` : ''}`);
  if (f.checks.failed) cap('tests', 40, `${f.checks.failed} of the agent's checks failed`);
  if (f.codeFiles && !f.testFiles && !f.checks.passed && f.ci !== 'passed') cap('tests', 45, 'code changed with no tests and no passing checks');
  // Plan: bounded by the steps ticked.
  if (f.plan && out.plan) cap('plan', Math.round(40 + (60 * f.plan.done) / f.plan.steps), `${f.plan.done} of ${f.plan.steps} plan steps ticked`);
  if (!f.plan && out.plan) out.plan.notes.push('no plan written');
  // Spec: computed from the criteria (met 1, unverified ½, not met 0); none without a spec.
  const criteria = (Array.isArray(reply?.criteria) ? reply.criteria : [])
    .filter((c) => c?.criterion)
    .slice(0, 20)
    .map((c) => ({ criterion: String(c.criterion).slice(0, 300), status: ['met', 'not_met', 'unverified'].includes(c.status) ? c.status : 'unverified', evidence: String(c.evidence ?? '').slice(0, 300) }));
  // A spec with criteria the model didn't assess: they count as unverified, not as passed.
  if (f.hasSpec && f.criteria && !criteria.length) out.spec = { score: 50, why: `${f.criteria} acceptance criteri${f.criteria === 1 ? 'on' : 'a'} not assessed`, notes: ['treated as unverified'] };
  if (f.hasSpec && criteria.length) {
    const pts = criteria.reduce((n, c) => n + (c.status === 'met' ? 1 : c.status === 'unverified' ? 0.5 : 0), 0);
    const met = criteria.filter((c) => c.status === 'met').length;
    out.spec = { score: clamp((100 * pts) / criteria.length), why: `${met} of ${criteria.length} acceptance criteri${criteria.length === 1 ? 'on' : 'a'} met${criteria.some((c) => c.status === 'not_met') ? ', some not met' : ''}`, notes: [] };
  }
  // Overall: weighted over the scores there are.
  const have = Object.entries(WEIGHTS).filter(([k]) => out[k]);
  const total = have.reduce((n, [, w]) => n + w, 0);
  const overall = total ? Math.round(have.reduce((n, [k, w]) => n + out[k].score * w, 0) / total) : null;
  const notMet = criteria.filter((c) => c.status === 'not_met');
  const reasons = [];
  if (f.ci === 'failed') reasons.push('CI is failing');
  if (notMet.length) reasons.push(`${notMet.length} acceptance criteri${notMet.length === 1 ? 'on' : 'a'} not met`);
  if (out.intent && out.intent.score < 50) reasons.push('it does not do enough of what was asked');
  if (out.tests && out.tests.score < 40 && f.ci !== 'failed') reasons.push('it is barely verified');
  let recommendation;
  if (reasons.length) recommendation = 'not_ready';
  else if (overall != null && overall >= 80 && (out.tests?.score ?? 0) >= 70 && (out.safety?.score ?? 100) >= 70 && (out.spec?.score ?? 100) >= 70 && f.ci !== 'running') recommendation = 'ready';
  else recommendation = 'look';
  // Where to look, mapped back to hunks.
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const look = (Array.isArray(reply?.look) ? reply.look : [])
    .map((l) => ({ h: byId.get(String(l?.id ?? '').trim()), reason: String(l?.reason ?? '').slice(0, 300) }))
    .filter((l) => l.h)
    .slice(0, 5)
    .map(({ h, reason }) => ({ file: h.file, head: h.head, reason }));
  return { summary: String(reply?.summary ?? '').slice(0, 600), overall, recommendation, reasons, scores: out, criteria, look, facts: f };
}

export const RECOMMENDATION = { ready: 'Ready to approve', look: 'Look at these first', not_ready: 'Not ready' };

/** Markdown: for Copy / Download, the pull request's description and a PR comment. */
export function scorecardMarkdown(sc, title = '') {
  const bar = (n) => (n == null ? '—' : `${n}`);
  const rows = DIMENSIONS.map(([k, label]) => {
    const d = sc.scores[k];
    return `| ${label} | ${bar(d?.score)} | ${d ? [d.why, ...d.notes].filter(Boolean).join('; ').replace(/\|/g, '/') : k === 'spec' ? 'no spec written' : '—'} |`;
  });
  const out = [
    `### Review scorecard${title ? `: ${title}` : ''}`,
    '',
    `**${sc.overall ?? '—'}/100 · ${RECOMMENDATION[sc.recommendation]}**${sc.reasons.length ? ` (${sc.reasons.join('; ')})` : ''}`,
    '',
    sc.summary,
    '',
    '| Score | /100 | Why |',
    '| --- | --- | --- |',
    ...rows,
  ];
  if (sc.criteria.length) {
    out.push('', '**Acceptance criteria**', '');
    for (const c of sc.criteria) out.push(`- ${c.status === 'met' ? '✅' : c.status === 'not_met' ? '❌' : '❔'} ${c.criterion}${c.evidence ? ` (${c.evidence})` : ''}`);
  }
  if (sc.look.length) {
    out.push('', '**Where to look**', '');
    for (const l of sc.look) out.push(`- \`${l.file}\` \`${l.head.replace(/^(@@[^@]*@@).*/, '$1')}\`: ${l.reason}`);
  }
  const f = sc.facts;
  out.push('', `<sub>Measured: ${f.files} files (+${f.added} −${f.removed}), ${f.testFiles} test files, CI ${f.ci ?? 'n/a'}, checks ${f.checks.passed}✓ ${f.checks.failed}✗${f.plan ? `, plan ${f.plan.done}/${f.plan.steps}` : ''}. Scored by AI Agent Manager.</sub>`);
  return out.join('\n');
}
