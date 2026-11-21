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
export function facts({ files = [], prs = [], brief = null, plan = '', spec = '', standards = null, agreed = null }) {
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
    // What done means, agreed with the person (acceptance.js): these are checked, whatever the spec says now.
    agreed: agreed?.length ? agreed.map((p) => ({ id: p.id, text: p.text })) : null,
    // The repository's standards (standards.js): high-risk files touched, and the bar the app ran.
    risk: (standards?.risk ?? []).map((r) => r.path),
    bar: standards?.bar ? { passed: standards.bar.results.filter((r) => r.ok).length, failed: standards.bar.results.filter((r) => !r.ok).map((r) => r.name) } : null,
  };
}

export const factLines = (f) =>
  [
    `files changed: ${f.files} (+${f.added} -${f.removed}); code files: ${f.codeFiles}; test files: ${f.testFiles}`,
    `CI on the pull request: ${f.ci ?? 'no pull request or no checks yet'}${f.ciFailed.length ? ` (failing: ${f.ciFailed.join(', ')})` : ''}`,
    `the agent's own checks (from its brief): ${f.checks.passed} passed, ${f.checks.failed} failed, ${f.checks.pending} pending`,
    `plan: ${f.plan ? `${f.plan.done} of ${f.plan.steps} steps ticked` : 'no plan written'}`,
    `spec: ${f.hasSpec ? `${f.criteria} acceptance criteria` : 'no spec written'}`,
    ...(f.agreed ? [`acceptance agreed with the person: ${f.agreed.length} point${f.agreed.length === 1 ? '' : 's'}`] : []),
    ...(f.bar ? [`the repository's quality bar, run by the app: ${f.bar.passed} passed, ${f.bar.failed.length} failed${f.bar.failed.length ? ` (${f.bar.failed.join(', ')})` : ''}`] : []),
    ...(f.risk?.length ? [`files under paths the person marked high risk: ${f.risk.join(', ')}`] : []),
  ].join('\n');

export function scorecardPrompt({ intent, status, digest, briefMarkdown, intentDoc, specDoc, planDoc, hunks, facts: f, lessons = [] }) {
  return [
    "You score an AI coding agent's changes for a reviewer who wants to approve with confidence and read as little as possible.",
    'Be skeptical: a claim without evidence in the diff, the tests or the checks counts as unverified. Base everything on the material below.',
    '',
    'Reply with one JSON object only:',
    '{"summary": "<two sentences: what the change does and how sure you are>",',
    ' "scores": {"intent": {"score": 0-100, "why": "<one sentence>"}, "scope": {...}, "plan": {...}, "tests": {...}, "safety": {...}},',
    f.agreed
      ? ' "criteria": [{"id": "A1", "criterion": "<the point, as written>", "status": "met|not_met|unverified", "evidence": "<where: file, test, check>"}],'
      : ' "criteria": [{"criterion": "<an acceptance criterion from the spec>", "status": "met|not_met|unverified", "evidence": "<where: file, test, check>"}],',
    ` "look": [{"id": "H3", "reason": "<why a person should read this hunk>"}]${lessons.length ? ',' : '}'}`,
    ...(lessons.length ? [' "lessons": [{"id": "L1", "status": "followed|broken|not_applicable", "evidence": "<where in the diff>"}]}'] : []),
    '',
    'Scoring (100 is best; be calibrated, not generous):',
    '- intent: how fully the change does what INTENT asks. Missing parts of the ask pull it down hard.',
    '- scope: 100 when every change serves the task; lower for unrelated edits, drive-by refactors, or a change far larger than the task needs.',
    '- plan: how closely the change follows PLAN (steps done, departures explained). Without a plan, judge whether the work is coherent.',
    '- tests: whether the changed behavior is verified: tests added or updated for it, CI, checks the agent ran. Code changes with no tests and no passing checks score low.',
    '- safety: 100 when nothing risky is touched or risks are handled; lower for security, auth, data loss, migrations, concurrency, money, new dependencies or public API changes without care.',
    f.agreed
      ? '- criteria: one entry per point in AGREED_ACCEPTANCE, with its id, in its order. The person agreed on these with the agent, so judge the work against them as written, not against the criteria in SPEC. "met" only when the diff, a test or a check shows it; "not_met" when the change does not do it or goes against it; otherwise "unverified".'
      : '- criteria: one entry per acceptance criterion in SPEC, in its order; leave the list empty if there is no spec.',
    '- look: at most 5 hunks a person must read (the risky, subtle or unverified ones), most important first. Not the obvious ones.',
    ...(lessons.length ? ['- lessons: one entry per lesson in LESSONS. "broken" only when the diff shows the change going against it; "not_applicable" when the change has nothing to do with it.'] : []),
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
    ...(f.agreed ? ['<agreed_acceptance>', ...f.agreed.map((p) => `${p.id}: ${p.text}`), '</agreed_acceptance>'] : []),
    '<plan>',
    planDoc || '(no plan written)',
    '</plan>',
    ...(lessons.length ? ['<lessons>', ...lessons.map((l, i) => `L${i + 1}: ${l.text}`), '</lessons>'] : []),
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
const plain = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const sameText = (a, b) => plain(a) === plain(b);

/**
 * The scorecard from the model's reply and the facts: scores capped by what was measured, the spec
 * score computed from the criteria, the overall weighted, and a recommendation by rule.
 */
export function combine(reply, f, hunks, { lessons = [], bar = null } = {}) {
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
  // The repository's quality bar, run by the app: a failed check is not verified, whatever else passed.
  const barFailed = (bar?.results ?? []).filter((r) => !r.ok);
  if (barFailed.length) cap('tests', 30, `the quality bar is not met (${barFailed.map((r) => r.name).join(', ')})`);
  // Plan: bounded by the steps ticked.
  if (f.plan && out.plan) cap('plan', Math.round(40 + (60 * f.plan.done) / f.plan.steps), `${f.plan.done} of ${f.plan.steps} plan steps ticked`);
  if (!f.plan && out.plan) out.plan.notes.push('no plan written');
  // Spec: computed from the criteria (met 1, unverified ½, not met 0); none without a spec.
  const told = (Array.isArray(reply?.criteria) ? reply.criteria : [])
    .filter((c) => c?.criterion || c?.id)
    .slice(0, 20)
    .map((c) => ({ id: String(c.id ?? '').trim().toUpperCase(), criterion: String(c.criterion ?? '').slice(0, 300), status: ['met', 'not_met', 'unverified'].includes(c.status) ? c.status : 'unverified', evidence: String(c.evidence ?? '').slice(0, 300) }));
  // Points agreed with the person: exactly those, in their words; one the model skipped is unverified.
  const criteria = f.agreed
    ? f.agreed.map((p) => {
        const c = told.find((t) => t.id === p.id) ?? told.find((t) => !t.id && sameText(t.criterion, p.text));
        return { id: p.id, criterion: p.text, status: c?.status ?? 'unverified', evidence: c?.evidence ?? '', agreed: true };
      })
    : told.filter((c) => c.criterion).map(({ id, ...c }) => c);
  // A spec with criteria the model didn't assess: they count as unverified, not as passed.
  if (!f.agreed && f.hasSpec && f.criteria && !criteria.length) out.spec = { score: 50, why: `${f.criteria} acceptance criteri${f.criteria === 1 ? 'on' : 'a'} not assessed`, notes: ['treated as unverified'] };
  if ((f.hasSpec || f.agreed) && criteria.length) {
    const pts = criteria.reduce((n, c) => n + (c.status === 'met' ? 1 : c.status === 'unverified' ? 0.5 : 0), 0);
    const met = criteria.filter((c) => c.status === 'met').length;
    out.spec = { score: clamp((100 * pts) / criteria.length), why: `${met} of ${criteria.length} acceptance criteri${criteria.length === 1 ? 'on' : 'a'} met${criteria.some((c) => c.status === 'not_met') ? ', some not met' : ''}`, notes: f.agreed ? ['the points agreed with the person'] : [] };
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
  if (barFailed.length) reasons.push(`the quality bar is not met: ${barFailed.map((r) => r.name).join(', ')}`);
  // Lessons of the repository, as the model found them in the diff: one it says is broken holds the change.
  const said = new Map((Array.isArray(reply?.lessons) ? reply.lessons : []).map((l) => [String(l?.id ?? '').trim().toUpperCase(), l]));
  const checked = lessons.map((l, i) => {
    const r = said.get(`L${i + 1}`);
    return { id: l.id, text: l.text, status: ['followed', 'broken', 'not_applicable'].includes(r?.status) ? r.status : 'unverified', evidence: String(r?.evidence ?? '').slice(0, 300) };
  });
  const broken = checked.filter((l) => l.status === 'broken');
  if (broken.length) reasons.push(`${broken.length} lesson${broken.length === 1 ? '' : 's'} of this repository not followed`);
  if (out.tests && out.tests.score < 40 && f.ci !== 'failed' && !barFailed.length) reasons.push('it is barely verified');
  let recommendation;
  if (reasons.length) recommendation = 'not_ready';
  else if (overall != null && overall >= 80 && (out.tests?.score ?? 0) >= 70 && (out.safety?.score ?? 100) >= 70 && (out.spec?.score ?? 100) >= 70 && f.ci !== 'running') recommendation = 'ready';
  else recommendation = 'look';
  // High-risk paths: never "ready" on a score alone; a person reads it.
  if (f.risk?.length) {
    if (recommendation === 'ready') recommendation = 'look';
    const shown = f.risk.slice(0, 4).join(', ');
    reasons.push(`touches high-risk paths (${shown}${f.risk.length > 4 ? `, and ${f.risk.length - 4} more` : ''})`);
  }
  // Where to look, mapped back to hunks.
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const look = (Array.isArray(reply?.look) ? reply.look : [])
    .map((l) => ({ h: byId.get(String(l?.id ?? '').trim()), reason: String(l?.reason ?? '').slice(0, 300) }))
    .filter((l) => l.h)
    .slice(0, 5)
    .map(({ h, reason }) => ({ file: h.file, head: h.head, reason }));
  return { summary: String(reply?.summary ?? '').slice(0, 600), overall, recommendation, reasons, scores: out, criteria, look, lessons: checked, bar: bar ? { ok: !barFailed.length, results: bar.results.map((r) => ({ name: r.name, ok: r.ok, ...(r.command ? { command: r.command } : {}), tail: String(r.tail ?? '').slice(-600) })) } : null, facts: f };
}

export const RECOMMENDATION = { ready: 'Ready to approve', look: 'Look at these first', not_ready: 'Not ready' };
const IMPROVE_BELOW = 80; // scores under this are named in the Improve message

/**
 * Improve: the agent's own scorecard sent back to it before a person reviews the work. The scores
 * to raise (lowest first, with why), the acceptance criteria not met or not verified, and where a
 * reviewer would look.
 */
export function improveMessage(sc) {
  const weak = DIMENSIONS.filter(([k]) => sc.scores[k] && sc.scores[k].score < IMPROVE_BELOW)
    .sort(([a], [b]) => sc.scores[a].score - sc.scores[b].score)
    .map(([k, label]) => `- ${label} ${sc.scores[k].score}/100: ${[sc.scores[k].why, ...sc.scores[k].notes].filter(Boolean).join('; ')}`);
  const criteria = sc.criteria.filter((c) => c.status !== 'met').map((c) => `- ${c.status === 'not_met' ? 'Not met' : 'Not verified'}: ${c.criterion}${c.evidence ? ` (${c.evidence})` : ''}`);
  const look = sc.look.map((l) => `- ${l.file}: ${l.reason}`);
  const bar = (sc.bar?.results ?? []).filter((r) => !r.ok).map((r) => `- ${r.name}${r.command ? ` (\`${r.command}\`)` : ''} failed${r.tail ? `:\n${r.tail.split('\n').slice(-12).map((l) => `    ${l}`).join('\n')}` : ''}`);
  const lessons = (sc.lessons ?? []).filter((l) => l.status === 'broken').map((l) => `- ${l.text}${l.evidence ? ` (${l.evidence})` : ''}`);
  return [
    `Before this goes to review: the review scorecard rates your changes ${sc.overall ?? '?'}/100 (${RECOMMENDATION[sc.recommendation]}${sc.reasons.length ? `: ${sc.reasons.join('; ')}` : ''}). Improve them where they fall short.`,
    weak.length ? `Scores to raise:\n${weak.join('\n')}` : '',
    criteria.length ? `Acceptance criteria:\n${criteria.join('\n')}` : '',
    bar.length ? `The repository's quality bar, run on your changes (run the same commands yourself until they pass):\n${bar.join('\n')}` : '',
    lessons.length ? `Lessons of this repository your changes do not follow:\n${lessons.join('\n')}` : '',
    look.length ? `Where a reviewer would look first:\n${look.join('\n')}` : '',
    'Fix what these point at: add or fix tests and run them, meet the criteria, handle the risky spots. Stay within the task, and say in the brief what you left as it is and why. Update the brief when you are done; the changes are scored again then.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

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
  const f = sc.facts;
  if (sc.bar) {
    out.push('', '**Quality bar** (run by the app)', '');
    for (const r of sc.bar.results) out.push(`- ${r.ok ? '✅' : '❌'} ${r.name}${r.command ? ` (\`${r.command}\`)` : ''}`);
  }
  if (sc.lessons?.length) {
    out.push('', '**Lessons of this repository**', '');
    for (const l of sc.lessons) out.push(`- ${l.status === 'followed' ? '✅' : l.status === 'broken' ? '❌' : l.status === 'not_applicable' ? '➖' : '❔'} ${l.text}${l.evidence ? ` (${l.evidence})` : ''}`);
  }
  if (f.risk?.length) out.push('', `**High-risk paths touched**: ${f.risk.map((p) => `\`${p}\``).join(', ')}`);
  if (sc.look.length) {
    out.push('', '**Where to look**', '');
    for (const l of sc.look) out.push(`- \`${l.file}\` \`${l.head.replace(/^(@@[^@]*@@).*/, '$1')}\`: ${l.reason}`);
  }
  out.push('', `<sub>Measured: ${f.files} files (+${f.added} −${f.removed}), ${f.testFiles} test files, CI ${f.ci ?? 'n/a'}, checks ${f.checks.passed}✓ ${f.checks.failed}✗${f.plan ? `, plan ${f.plan.done}/${f.plan.steps}` : ''}. Scored by AI Agent Manager.</sub>`);
  return out.join('\n');
}
