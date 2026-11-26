// Read first: where a person's attention goes. Finished work waiting for review is ranked by how
// much it needs reading, from what the app already measured: files marked high risk, the review
// scorecard, checks and CI, whether the tests notice a mistake (mutate.js), whether the recorded
// commands held when run again (proof.js), what the agent says it left out, the risks it named
// and did not check, its own confidence, the size of the change, and whether it ran without the
// person. Each piece gets a level (read closely, look, skim), the reasons, and where to start.
// No model is called: every reason is a fact the app holds, so the ranking can be checked.
import { keptPrivate } from './private.js';

export const LEVELS = { close: 'Read closely', look: 'Look', skim: 'Skim' };
const CLOSE = 45;
const LOOK = 20;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * True for work that is finished and still to be reviewed: done or partial, with no merged pull
 * request, and not marked as reviewed by the person since it last changed.
 */
export function awaitsReview(agent) {
  if (agent?.kind !== 'task' || agent.team || agent.reviewing || agent.hunting) return false;
  const outcome = agent.brief?.results?.outcome;
  const done = agent.brief?.status === 'done' || outcome === 'done' || outcome === 'partial';
  const prs = Object.values(agent.prs ?? {}).filter((p) => p.source !== 'mentioned');
  // Marked as reviewed by the person, and not changed since: done with.
  if (agent.reviewed?.at && !(Date.parse(agent.brief?.updatedAt) > Date.parse(agent.reviewed.at))) return false;
  return done && !prs.some((p) => p.state === 'MERGED') && !(prs.length && prs.every((p) => p.state === 'CLOSED'));
}

/**
 * How much a finished piece of work needs reading: { score (0-100), level, reasons: [{ text,
 * points }] (heaviest first), calm: [what speaks for it], start: [where to begin] }.
 */
export function readFirst(agent, trace = null) {
  const reasons = [];
  const calm = [];
  const start = [];
  const add = (points, text) => reasons.push({ points, text });
  const b = agent.brief ?? {};
  const sc = agent.docs?.scorecard?.data;
  const f = sc?.facts;

  // Files the person marked high risk.
  const risk = (agent.standards?.risk ?? []).map((r) => r.path ?? r).filter(Boolean);
  if (risk.length) {
    add(30, `Touches ${plural(risk.length, 'file')} you marked high risk: ${clip(risk.join(', '), 120)}`);
    start.push(...risk.slice(0, 3));
  }
  // The repository's quality bar, CI and its own checks.
  const barFailed = (agent.standards?.bar?.results ?? []).filter((r) => !r.ok).map((r) => r.name);
  if (barFailed.length) add(25, `The quality bar is not met: ${clip(barFailed.join(', '), 100)}`);
  const pr = Object.values(agent.prs ?? {}).find((p) => p.state === 'OPEN');
  if (pr?.checks?.state === 'failed') add(25, 'CI is failing on its pull request');
  const failed = (b.checks ?? []).filter((c) => c.state === 'failed').length;
  const passed = (b.checks ?? []).filter((c) => c.state === 'passed').length;
  if (failed) add(20, `${plural(failed, 'check')} of its own failed`);

  // The review scorecard.
  if (!sc) add(10, 'Not scored yet');
  else if (sc.recommendation === 'not_ready') add(30, `The scorecard says not ready${sc.reasons?.length ? `: ${clip(sc.reasons[0], 100)}` : ''}`);
  else if (sc.recommendation === 'look') add(15, `The scorecard says to look first${Number.isFinite(sc.overall) ? ` (${sc.overall} of 100)` : ''}`);
  else if (sc.recommendation === 'ready') calm.push(`The scorecard says ready${Number.isFinite(sc.overall) ? ` (${sc.overall} of 100)` : ''}`);
  for (const l of sc?.look ?? []) if (!start.includes(l.file)) start.push(l.file);

  // Do its tests notice a mistake?
  const m = agent.breaks;
  if (m && !m.baseline?.ok) add(25, 'Its tests failed when the app ran them');
  else if (m) {
    const missed = (m.breaks ?? []).filter((x) => x.status === 'missed');
    const caught = (m.breaks ?? []).filter((x) => x.status === 'caught').length;
    if (missed.length) {
      add(Math.min(20, 8 + 4 * missed.length), `${missed.length} of ${plural(missed.length + caught, 'deliberate break')} in its code went unnoticed by its tests`);
      for (const x of missed.slice(0, 3)) start.push(`${x.file}:${x.line}`);
    } else if (caught) calm.push(`Its tests caught all ${plural(caught, 'deliberate break')}`);
  } else if ((f?.codeFiles ?? 0) > 0) add(5, 'Its tests have not been tested');

  // Its recorded commands, run again.
  const rerun = agent.proof && agent.proof.proofAt === (agent.proofDoc?.updatedAt ?? null) ? agent.proof.results ?? [] : [];
  const differs = rerun.filter((r) => r.status === 'differs').length;
  if (differs) add(25, `${plural(differs, 'recorded command')} gave a different result when run again`);
  else if (rerun.some((r) => r.status === 'same')) calm.push('Its recorded commands gave the same result when run again');
  if (passed && !agent.proofDoc?.commands) add(8, `No proof recorded for its ${plural(passed, 'passed check')}`);

  // What done means, point by point (trace.js): points with nothing that shows them.
  const gaps = (trace?.rows ?? []).filter((r) => r.gap && r.status !== 'not_met');
  const notMet = (trace?.rows ?? []).filter((r) => r.status === 'not_met');
  if (notMet.length) add(Math.min(30, 15 * notMet.length), `${plural(notMet.length, 'point')} of what done means ${notMet.length === 1 ? 'is' : 'are'} not met: ${clip(notMet.map((r) => `${r.id} ${r.text}`).join('; '), 120)}`);
  if (gaps.length) add(Math.min(18, 6 * gaps.length), `${plural(gaps.length, 'point')} of what done means ${gaps.length === 1 ? 'has' : 'have'} no recorded run behind ${gaps.length === 1 ? 'it' : 'them'}: ${clip(gaps.map((r) => r.id).join(', '), 60)}`);
  if (trace?.rows.length && !notMet.length && !gaps.length) calm.push(trace.rows.length === 1 ? 'The one point of what done means is shown by a recorded run' : `All ${trace.rows.length} points of what done means are shown by a recorded run`);

  // What it says itself.
  const notDone = b.results?.notDone ?? [];
  if (notDone.length) add(Math.min(18, 6 * notDone.length), `It lists ${plural(notDone.length, 'thing')} as not done: ${clip(notDone.join('; '), 120)}`);
  const happened = (b.risks ?? []).filter((r) => r.state === 'happened');
  const open = (b.risks ?? []).filter((r) => r.state === 'open');
  if (happened.length) add(Math.min(20, 10 * happened.length), `${plural(happened.length, 'risk')} it named happened: ${clip(happened.map((r) => r.text).join('; '), 120)}`);
  if (open.length) add(Math.min(15, 5 * open.length), `${plural(open.length, 'risk')} it named ${open.length === 1 ? 'was' : 'were'} not checked: ${clip(open.map((r) => r.text).join('; '), 120)}`);
  // Its self-review (checklist.js): what it answers no, and what the app's facts contradict.
  const cl = agent.checklist;
  if (cl?.written) {
    const no = cl.items.filter((i) => i.state === 'no');
    const contra = cl.items.filter((i) => i.app?.verdict === 'contradicts' && i.state === 'yes');
    const unanswered = cl.items.filter((i) => i.state === 'missing' || i.state === 'unchecked');
    if (no.length) add(Math.min(20, 8 * no.length), `Its self-review says no to ${plural(no.length, 'principle')}: ${clip(no.map((i) => `${i.label}${i.evidence ? ` (${i.evidence})` : ''}`).join('; '), 120)}`);
    if (contra.length) add(Math.min(24, 12 * contra.length), `It says ${contra.map((i) => i.label).join(', ')} ${contra.length === 1 ? 'holds' : 'hold'}, and the app's facts say otherwise: ${clip(contra.map((i) => i.app.why).join('; '), 120)}`);
    if (unanswered.length >= 3) add(5, `Its self-review leaves ${plural(unanswered.length, 'principle')} unchecked`);
    if (cl.stale) add(5, 'Its self-review was written before its latest changes');
    if (!no.length && !contra.length && !unanswered.length && !cl.stale && cl.counts.backs >= 2) calm.push(`Its self-review holds on every principle, and the app's facts back ${cl.counts.backs} of them`);
  } else if (cl) add(5, 'It wrote no self-review');
  const conf = b.results?.confidence?.percent;
  if (!Number.isFinite(conf)) add(5, 'It gave no confidence');
  else if (conf < 65) add(15, `Its own confidence is ${conf}%${b.results.confidence.why ? `: ${clip(b.results.confidence.why, 100)}` : ''}`);
  else if (conf < 85) add(5, `Its own confidence is ${conf}%`);
  if (b.results?.outcome === 'partial') add(10, 'It says the work is partial');

  // Size, and how far it ran without the person.
  const lines = (f?.added ?? 0) + (f?.removed ?? 0);
  if (lines > 1500) add(20, `A large change: ${lines} lines in ${plural(f.files, 'file')}`);
  else if (lines > 400) add(10, `${lines} lines changed in ${plural(f.files, 'file')}`);
  if (f && (f.codeFiles ?? 0) > 0 && !f.testFiles) add(8, 'Code changed with no test file');
  const answered = (agent.autonomy?.log ?? []).filter((e) => e.kind === 'answer').length;
  if (answered) add(Math.min(12, 4 + 2 * answered), `${plural(answered, 'question')} answered for you while it ran without you`);

  reasons.sort((x, y) => y.points - x.points);
  const score = Math.min(100, reasons.reduce((n, r) => n + r.points, 0));
  return { score, level: score >= CLOSE ? 'close' : score >= LOOK ? 'look' : 'skim', reasons, calm, start: [...new Set(start)].slice(0, 5) };
}

/** The queue: finished work still to be reviewed, the pieces that need reading most first. */
export function readQueue(agents, view = () => ({})) {
  return agents
    .filter(awaitsReview)
    .map((a) => {
      const v = view(a);
      const pr = Object.values(a.prs ?? {}).find((p) => p.state === 'OPEN' && p.source !== 'mentioned');
      const kept = keptPrivate(a);
      // (The view already ranked it with its trace; this is for callers that only have the agent.)
      return { agentId: a.id, name: a.name, project: v.projectInfo?.name ?? null, title: clip(String(a.intent ?? a.name).split('\n')[0], 120), pr: pr ? { url: pr.url, number: pr.number ?? null } : null, finishedAt: a.brief?.updatedAt ?? null, keptPrivate: Boolean(kept), ...(v.readFirst ?? readFirst(a)) };
    })
    .sort((x, y) => y.score - x.score || String(x.finishedAt).localeCompare(String(y.finishedAt)));
}

export function queueMarkdown(items) {
  const out = ['# Read first', ''];
  if (!items.length) return [...out, 'No finished work is waiting for review.'].join('\n');
  const n = (l) => items.filter((i) => i.level === l).length;
  out.push(`${plural(items.length, 'piece')} of finished work waiting for review: ${n('close')} to read closely, ${n('look')} to look at, ${n('skim')} to skim.`, '');
  for (const it of items) {
    out.push(`## ${LEVELS[it.level]} (${it.score}): ${it.name}${it.project ? ` · ${it.project}` : ''}`, '', it.title, '');
    for (const r of it.reasons.slice(0, 6)) out.push(`- ${r.text}`);
    for (const c of it.calm) out.push(`- In its favour: ${c}`);
    if (it.start.length) out.push('', `Start with: ${it.start.join(', ')}`);
    if (it.pr) out.push('', it.pr.url);
    out.push('');
  }
  return out.join('\n').trimEnd();
}
