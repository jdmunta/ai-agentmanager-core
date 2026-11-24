// Requirement trace: each point of what done means, followed to what shows it. For every agreed
// acceptance point (acceptance.js), or the scorecard's criteria when none were agreed: whether the
// review scorecard found it met, with its evidence; the checks the agent recorded for it in its
// proof (the command, its exit code, and whether it gave the same result when the app ran it
// again); and what is missing. A point with nothing behind it stands out. No model is called: it
// joins what the scorecard and the proof already hold.

const STATUS = { met: 'Met', not_met: 'Not met', unverified: 'Not verified', unscored: 'Not scored yet' };
const plain = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const clip = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** What is missing behind a point, in a few words, or null when it is shown by a run that held. */
export function gapOf(row) {
  if (row.status === 'not_met') return 'the scorecard found it not met';
  const runs = row.proof.filter((p) => p.command);
  if (runs.some((p) => p.rerun === 'differs')) return 'its recorded command gave a different result when run again';
  if (!row.proof.length) return row.status === 'met' ? 'met by the scorecard, with no check recorded for it' : 'nothing recorded for it';
  if (!runs.length) return 'checked by reading only: no command was run';
  if (runs.some((p) => p.exit !== null && p.exit !== 0 && !/fail|error|reject|invalid|usage|throw/i.test(`${row.text} ${p.title}`))) return 'its recorded command did not exit with success';
  if (row.status === 'unverified') return 'the scorecard could not verify it';
  return null;
}

/**
 * The trace of an agent's points. `entries`: its proof (proof.js parseProof), `rerun`: the app's
 * last run of it ({ results, stale }). Returns { source, rows, counts }.
 */
export function traceOf(agent, entries = [], rerun = null) {
  const agreed = agent.acceptance?.status === 'agreed' ? agent.acceptance.points ?? [] : [];
  const criteria = agent.docs?.scorecard?.data?.criteria ?? [];
  const points = agreed.length ? agreed.map((p) => ({ id: p.id, text: p.text })) : criteria.map((c, i) => ({ id: c.id || `C${i + 1}`, text: c.criterion }));
  const again = new Map((rerun && !rerun.stale ? rerun.results ?? [] : []).map((r) => [`${r.title}\n${r.command}`, r.status]));
  const rows = points.map((p) => {
    const c = criteria.find((x) => x.id && x.id === p.id) ?? criteria.find((x) => plain(x.criterion) === plain(p.text));
    // Its proof: sections that start with its id ("A2 …"), or whose title says the same as the point.
    const proof = entries
      .filter((e) => (e.point && e.point === String(p.id).toUpperCase()) || plain(e.title) === plain(p.text))
      .map((e) => ({ title: e.title, command: e.command, exit: e.exit, note: e.command ? '' : clip(e.note, 160), rerun: again.get(`${e.title}\n${e.command}`) ?? null }));
    const row = { id: p.id, text: p.text, status: c?.status ?? 'unscored', evidence: clip(c?.evidence, 240), proof };
    return { ...row, gap: gapOf(row) };
  });
  const n = (f) => rows.filter(f).length;
  return {
    source: agreed.length ? 'agreed' : criteria.length ? 'scorecard' : 'none',
    rows,
    counts: { points: rows.length, met: n((r) => r.status === 'met'), notMet: n((r) => r.status === 'not_met'), shown: n((r) => !r.gap), gaps: n((r) => r.gap) },
  };
}

/** "4 of 5 points shown by a check that held; 1 with a gap" */
export function traceLine(t) {
  if (!t?.rows.length) return '';
  return `${t.counts.shown} of ${t.counts.points} point${t.counts.points === 1 ? '' : 's'} shown by a recorded run${t.counts.gaps ? `; ${t.counts.gaps} with a gap` : ''}`;
}

export function traceMarkdown(name, t) {
  const out = [`# Requirement trace: ${name}`, ''];
  if (!t.rows.length) return [...out, 'No points to trace: nothing was agreed as what done means, and the scorecard holds no criteria.'].join('\n');
  out.push(t.source === 'agreed' ? 'The points agreed with you as what done means.' : "The scorecard's criteria (no points were agreed).", '', `${traceLine(t)}.`, '');
  for (const r of t.rows) {
    out.push(`## ${r.id} ${r.text}`, '', `- Scorecard: ${STATUS[r.status]}${r.evidence ? `: ${r.evidence}` : ''}`);
    for (const p of r.proof) out.push(`- Check: ${p.command ? `\`${p.command}\`${p.exit === null ? '' : ` (exit ${p.exit})`}${p.rerun ? `, ${p.rerun === 'same' ? 'the same result when run again' : p.rerun === 'differs' ? 'a different result when run again' : 'not run again'}` : ''}` : `by reading${p.note ? `: ${p.note}` : ''}`}`);
    out.push(r.gap ? `- **Gap:** ${r.gap}` : '- Shown by a recorded run.', '');
  }
  return out.join('\n').trimEnd();
}
