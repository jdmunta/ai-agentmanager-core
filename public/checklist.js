// Self-review checklist: before it calls its work done, the agent answers the same few
// first-principles questions every time (does it do what was asked, only that, is it seen working,
// would a test catch it breaking, edges, what depends on it, safety, undo), each with its evidence.
// Then the app sets each answer against what it measured itself: the proof it recorded and ran
// again, its tests tested, the files it changed against its task, CI and what it says it left out.
// An answer the facts back says so; one they contradict says why. The same questions in the same
// order make it quick to read: a person looks at the "no"s and the contradictions first.
// Shared by the daemon (the view, Read first) and the page.

export const PRINCIPLES = [
  { key: 'asked', label: 'Asked', question: 'It does all that was asked, and what done means is met' },
  { key: 'scope', label: 'Scope', question: 'Nothing beyond what was asked: the smallest change that does it' },
  { key: 'works', label: 'Works', question: 'Seen working: run, not only read' },
  { key: 'tests', label: 'Tests', question: 'A test fails if this breaks' },
  { key: 'edges', label: 'Edges', question: 'Empty, wrong, large and failing inputs are handled' },
  { key: 'ripple', label: 'Ripple', question: 'What uses the changed code still works' },
  { key: 'safe', label: 'Safe', question: 'No secret, unchecked input or wider access added' },
  { key: 'undo', label: 'Undo', question: 'It can be undone without losing data' },
];

const ALIASES = {
  asked: ['asked', 'complete', 'completeness', 'requirements', 'does what was asked', 'correct'],
  scope: ['scope', 'minimal', 'simplest', 'simple', 'only what was asked'],
  works: ['works', 'working', 'verified', 'runs'],
  tests: ['tests', 'test', 'tested', 'regression'],
  edges: ['edges', 'edge cases', 'edge', 'inputs', 'errors', 'error handling'],
  ripple: ['ripple', 'callers', 'dependents', 'compatibility', 'side effects', 'blast radius'],
  safe: ['safe', 'safety', 'security', 'secrets'],
  undo: ['undo', 'reversible', 'rollback', 'data', 'migration'],
};

export const CHECKLIST_PROMPT =
  'Before you set the outcome to partial or done, review your own work from first principles and add a section "## Self-review" to the ' +
  'brief: one line for each of these, in this order, as "- [x] <Name>: <the evidence>":\n' +
  PRINCIPLES.map((p) => `${p.label}: ${p.question}.`).join('\n') +
  '\nMark "[x]" when it holds and say how you know (the command and what it showed, the test, the file:line), "[!]" when it does not hold ' +
  '(say what is missing), "[-]" when it does not apply to this task (say why), and "[ ]" when you did not check it. A reviewer reads this ' +
  'list first, and the app checks several lines against what it measured (your recorded runs, your tests, the files you changed, CI, ' +
  'what you say is not done), so mark only what you checked; "[x]" with no evidence counts as not checked. Update it when the work ' +
  'changes. If you open a pull request, put the same list in its description.';

const STATES = { x: 'yes', X: 'yes', '!': 'no', '-': 'na', ' ': 'unchecked', '~': 'unchecked' };

function keyOf(label) {
  const l = label.toLowerCase().replace(/[*_`]/g, '').trim();
  for (const p of PRINCIPLES) if (l === p.key || ALIASES[p.key].includes(l)) return p.key;
  return null;
}

/** The "## Self-review" section as written: [{ key (or null for one of its own), label, state, evidence }]. */
export function parseChecklist(body) {
  const out = [];
  for (const line of String(body ?? '').split('\n')) {
    const m = line.match(/^\s*[-*]\s+\[([ xX!~-])\]\s+(.+?)\s*$/);
    if (!m || out.length >= 16) continue;
    const [, mark, rest] = m;
    const c = rest.match(/^\**([^:]{1,40}?)\**\s*:\s*\**\s*(.*)$/);
    const key = c ? keyOf(c[1]) : null;
    if (key && out.some((x) => x.key === key)) continue;
    out.push({ key, label: c ? c[1].replace(/[*_`]/g, '').trim() : rest.slice(0, 60), state: STATES[mark], evidence: (c ? c[2] : '').trim().slice(0, 400) });
  }
  return out;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s, n = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** What the app measured about one principle: { verdict: 'backs' | 'contradicts', why } or null (only its word). */
function measured(key, a, fence) {
  const b = a.brief ?? {};
  const contra = (why) => ({ verdict: 'contradicts', why });
  const backs = (why) => ({ verdict: 'backs', why });
  const prs = Object.values(a.prs ?? {}).filter((p) => p.source !== 'mentioned');
  const ciFailed = prs.some((p) => p.state === 'OPEN' && p.checks?.state === 'failed');
  const f = a.docs?.scorecard?.data?.facts;
  if (key === 'asked') {
    const notDone = b.results?.notDone ?? [];
    if (notDone.length) return contra(`It lists as not done: ${clip(notDone.join('; '))}`);
    if (b.results?.outcome === 'partial') return contra('It says the work is partial');
    const sc = a.docs?.scorecard?.data;
    if (sc?.recommendation === 'not_ready') return contra(`The scorecard says not ready${sc.reasons?.length ? `: ${clip(sc.reasons[0])}` : ''}`);
    if (sc?.recommendation === 'ready') return backs('The scorecard says ready');
    return null;
  }
  if (key === 'scope') {
    const drift = fence?.drift ?? [];
    if (drift.length) return contra(`It changed code outside its task: ${clip(drift.map((d) => d.area).join(', '))}`);
    if (fence?.judged) return backs('Every area it changed is named in its task or plan');
    return null;
  }
  if (key === 'works') {
    const failed = (b.checks ?? []).filter((c) => c.state === 'failed');
    if (failed.length) return contra(`${plural(failed.length, 'check')} of its own failed: ${clip(failed.map((c) => c.text).join('; '))}`);
    const rerun = a.proof && a.proof.proofAt === (a.proofDoc?.updatedAt ?? null) ? a.proof.results ?? [] : [];
    const differs = rerun.filter((r) => r.status === 'differs').length;
    if (differs) return contra(`${plural(differs, 'recorded command')} gave a different result when run again`);
    if (ciFailed) return contra('CI is failing on its pull request');
    const n = a.proofDoc?.commands ?? 0;
    if (n) return backs(`${plural(n, 'recorded run')}${rerun.some((r) => r.status === 'same') ? ', the same when run again' : ''}`);
    return null;
  }
  if (key === 'tests') {
    const m = a.breaks;
    if (m && !m.baseline?.ok) return contra('Its tests failed when the app ran them');
    const missed = (m?.breaks ?? []).filter((x) => x.status === 'missed');
    const caught = (m?.breaks ?? []).filter((x) => x.status === 'caught').length;
    if (missed.length) return contra(`${missed.length} of ${plural(missed.length + caught, 'deliberate break')} went unnoticed by its tests: ${clip(missed.slice(0, 3).map((x) => `${x.file}:${x.line}`).join(', '))}`);
    if (caught) return backs(`Its tests caught all ${plural(caught, 'deliberate break')}`);
    if (f && (f.codeFiles ?? 0) > 0 && !f.testFiles) return contra('Code changed with no test file');
    return null;
  }
  if (key === 'ripple') {
    if (ciFailed) return contra('CI is failing on its pull request');
    if (a.nightWatch?.status === 'broken') return contra(`No longer holds on main: ${clip((a.nightWatch.broken ?? []).join('; '))}`);
    if (prs.some((p) => p.state === 'OPEN' && p.checks?.state === 'passed')) return backs('CI passes on its pull request');
    return null;
  }
  return null;
}

/**
 * The checklist as written and as measured: { items: [{ key, label, question, state, evidence,
 * app }], extra: [lines of its own], counts: { yes, no, na, unchecked, missing, backs, contradicts },
 * written } or null when it wrote none and is not finished. `state` is the agent's: yes, no, na,
 * unchecked, or missing (no line for it); a "yes" with no evidence is unchecked.
 */
export function checklistOf(a, fence = a.fence) {
  const written = a.brief?.checklist ?? [];
  const outcome = a.brief?.results?.outcome;
  const finished = a.brief?.status === 'done' || outcome === 'done' || outcome === 'partial';
  if (!written.length && !finished) return null;
  const items = PRINCIPLES.map((p) => {
    const w = written.find((x) => x.key === p.key);
    let state = w?.state ?? 'missing';
    if (state === 'yes' && !w.evidence) state = 'unchecked';
    const app = state === 'na' ? null : measured(p.key, a, fence);
    return { key: p.key, label: p.label, question: p.question, state, evidence: w?.evidence ?? '', app };
  });
  const n = (k, v) => items.filter((i) => (k === 'app' ? i.app?.verdict === v : i.state === v)).length;
  return {
    items,
    extra: written.filter((x) => !x.key),
    counts: { yes: n('state', 'yes'), no: n('state', 'no'), na: n('state', 'na'), unchecked: n('state', 'unchecked'), missing: n('state', 'missing'), backs: n('app', 'backs'), contradicts: n('app', 'contradicts') },
    written: written.length > 0,
  };
}

/** "6 hold, 1 no, 1 not applicable · the app backs 3, contradicts 1" */
export function checklistLine(c) {
  if (!c) return '';
  if (!c.written) return 'Not written';
  const k = c.counts;
  const said = [k.yes && `${k.yes} hold`, k.no && `${k.no} no`, k.na && `${k.na} not applicable`, k.unchecked + k.missing && `${k.unchecked + k.missing} not checked`].filter(Boolean).join(', ');
  const app = [k.backs && `backs ${k.backs}`, k.contradicts && `contradicts ${k.contradicts}`].filter(Boolean).join(', ');
  return `${said}${app ? ` · the app ${app}` : ''}`;
}

const WORD = { yes: ['proof-ok', 'Holds'], no: ['proof-bad', 'No'], na: ['', 'Not applicable'], unchecked: ['', 'Not checked'], missing: ['', 'Not answered'] };

/** The rows in the results card. */
export function checklistRows(a, esc) {
  const c = a.checklist;
  if (!c) return '';
  if (!c.written) return '<p class="hint checklist-none">The agent has not reviewed its work against the checklist (## Self-review in its brief).</p>';
  const k = c.counts;
  const row = (i) => `<li class="${i.app?.verdict === 'contradicts' ? 'cl-contra' : ''}"><span class="tag ${WORD[i.state][0]}">${WORD[i.state][1]}</span> <b title="${esc(i.question)}">${esc(i.label)}</b> ${i.evidence ? esc(i.evidence) : `<span class="hint">${esc(i.question)}</span>`}${i.app ? `<div class="cl-app"><span class="tag ${i.app.verdict === 'backs' ? 'proof-ok' : 'proof-bad'}">${i.app.verdict === 'backs' ? 'Backed' : 'Contradicted'}</span> <span class="hint">${esc(i.app.why)}</span></div>` : ''}</li>`;
  const extra = c.extra.map((x) => `<li><span class="tag ${WORD[x.state === 'yes' && !x.evidence ? 'unchecked' : x.state][0]}">${WORD[x.state === 'yes' && !x.evidence ? 'unchecked' : x.state][1]}</span> ${esc(x.label)}${x.evidence ? ` ${esc(x.evidence)}` : ''}</li>`).join('');
  const open = k.no || k.contradicts || k.missing || k.unchecked;
  return `<details class="checklist"${open ? ' open' : ''}><summary><b>Self-review</b> <span class="hint">${esc(checklistLine(c))}</span></summary><ul>${c.items.map(row).join('')}${extra}</ul><p class="hint">The agent's answers to the same first-principles questions every time; Backed and Contradicted are what the app measured itself. Read the No and Contradicted ones first.</p></details>`;
}

/** The checklist as Markdown, for a pull request or the command line. */
export function checklistMarkdown(c, name = '') {
  if (!c) return `# Self-review${name ? `: ${name}` : ''}\n\nNot finished yet, and no checklist written.`;
  const box = { yes: '[x]', no: '[!]', na: '[-]', unchecked: '[ ]', missing: '[ ]' };
  const out = [`# Self-review${name ? `: ${name}` : ''}`, '', checklistLine(c), ''];
  for (const i of c.items) {
    out.push(`- ${box[i.state]} **${i.label}**: ${i.evidence || `_${i.state === 'missing' ? 'not answered' : 'no evidence'}_ (${i.question})`}`);
    if (i.app) out.push(`  - ${i.app.verdict === 'backs' ? 'Backed' : '**Contradicted**'} by the app: ${i.app.why}`);
  }
  for (const x of c.extra) out.push(`- ${box[x.state]} ${x.label}${x.evidence ? `: ${x.evidence}` : ''}`);
  return out.join('\n');
}
