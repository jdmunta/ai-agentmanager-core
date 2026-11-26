// Your calibration: before an agent starts you can guess, in one tap each, whether it will finish,
// how long it will take, and how much reading its work will need. Once the work settles, the guess
// is set against what happened: the outcome it wrote, the time from start to its finished brief,
// and the Read first level its work got (readfirst.js). Over weeks this says what you judge well
// and what you don't, by kind of work, next to how the agents' own confidence held up. It stays on
// this computer, for you: no one else's numbers, and nothing is sent anywhere.
import { kindOf, KIND_LABEL } from './record.js';

export const REVIEW = ['skim', 'look', 'close'];
const REVIEW_WORD = { skim: 'skim', look: 'look', close: 'read closely' };
const HOUR = 3_600_000;

/** A guess as given (from the form or the command line), or null when nothing was guessed. */
export function cleanGuess(g) {
  if (!g || typeof g !== 'object') return null;
  const out = {};
  if (g.finish === true || g.finish === 'yes') out.finish = 'yes';
  else if (g.finish === false || g.finish === 'no') out.finish = 'no';
  const h = Number(g.hours);
  if (g.hours !== undefined && g.hours !== '' && g.hours !== null) {
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 30) throw Object.assign(new Error('hours is a number above 0'), { status: 400 });
    out.hours = h;
  }
  if (g.review) {
    if (!REVIEW.includes(g.review)) throw Object.assign(new Error('review is skim, look or close'), { status: 400 });
    out.review = g.review;
  }
  return Object.keys(out).length ? { ...out, at: new Date().toISOString() } : null;
}

/** What happened, once the work settled; null before. `a` is the agent's view. */
export function actualOf(a) {
  const b = a.brief ?? {};
  const outcome = b.results?.outcome ?? null;
  const merged = Object.values(a.prs ?? {}).some((p) => p.state === 'MERGED' && p.source !== 'mentioned');
  // Settled: an outcome it wrote (not "in progress"), a merged pull request, or a brief marked done.
  if (!['done', 'partial', 'blocked'].includes(outcome) && !merged && b.status !== 'done') return null;
  // What it says of its outcome first: "done" with part of it left is not finished.
  const finish = outcome === 'blocked' || outcome === 'partial' ? 'no' : outcome === 'done' || merged || b.status === 'done' ? 'yes' : null;
  const end = Date.parse(b.updatedAt ?? a.activeAt ?? '');
  const start = Date.parse(a.createdAt ?? '');
  const hours = Number.isFinite(end - start) && end > start ? Math.max(0.1, Math.round(((end - start) / HOUR) * 10) / 10) : null;
  const review = a.readFirst?.level ?? a.guess?.actual?.review ?? null;
  return { finish, hours, review };
}

const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x) => Math.round(x * 10) / 10;

/**
 * Your guesses against what happened: { rows, finish: { right, of }, time: { ratio, of }, review:
 * { right, heavier, lighter, of }, kinds: [{ kind, label, of, missed }], agents: { held, of } }.
 */
export function calibration(views) {
  const rows = views
    .filter((a) => a.guess)
    .map((a) => ({ id: a.id, name: a.name, kind: kindOf(a.intent), guess: a.guess, actual: actualOf(a) }))
    .filter((r) => r.actual);
  const pick = (k) => rows.filter((r) => r.guess[k] != null && r.actual[k] != null);
  const fin = pick('finish');
  const time = pick('hours');
  const rev = pick('review');
  const idx = (l) => REVIEW.indexOf(l);
  const missed = (r) =>
    (r.guess.finish && r.actual.finish && r.guess.finish !== r.actual.finish) ||
    (r.guess.review && r.actual.review && r.guess.review !== r.actual.review) ||
    (r.guess.hours && r.actual.hours && (r.actual.hours / r.guess.hours > 2 || r.actual.hours / r.guess.hours < 0.5));
  const kinds = [...new Set(rows.map((r) => r.kind))]
    .map((kind) => {
      const of = rows.filter((r) => r.kind === kind);
      return { kind, label: KIND_LABEL[kind] ?? kind, of: of.length, missed: of.filter(missed).length };
    })
    .sort((x, y) => y.missed / y.of - x.missed / x.of || y.of - x.of);
  // The agents' own confidence, on the same settled work: 80% or more said, and it finished.
  const conf = views.map((a) => ({ c: a.brief?.results?.confidence?.percent, act: actualOf(a) })).filter((x) => Number.isFinite(x.c) && x.c >= 80 && x.act?.finish);
  return {
    rows,
    finish: { right: fin.filter((r) => r.guess.finish === r.actual.finish).length, of: fin.length },
    time: { ratio: time.length ? round(median(time.map((r) => r.actual.hours / r.guess.hours))) : null, of: time.length },
    review: { right: rev.filter((r) => r.guess.review === r.actual.review).length, heavier: rev.filter((r) => idx(r.actual.review) > idx(r.guess.review)).length, lighter: rev.filter((r) => idx(r.actual.review) < idx(r.guess.review)).length, of: rev.length },
    kinds,
    agents: { held: conf.filter((x) => x.act.finish === 'yes').length, of: conf.length },
  };
}

/** The few sentences it comes to. */
export function calibrationLines(c) {
  if (!c.rows.length) return ['No guess has settled yet. Guess when you start an agent (New agent, Your guess), and come back once its work is done.'];
  const out = [];
  if (c.finish.of) out.push(`Whether it finishes: right ${c.finish.right} of ${c.finish.of} times.`);
  if (c.time.of) {
    const r = c.time.ratio;
    out.push(r >= 1.3 ? `Time: it takes ${r}× what you guess (the middle of ${c.time.of}).` : r <= 0.77 ? `Time: it takes ${r}× what you guess: quicker than you think (the middle of ${c.time.of}).` : `Time: about what you guess (${r}×, the middle of ${c.time.of}).`);
  }
  if (c.review.of) out.push(`Reading it needs: right ${c.review.right} of ${c.review.of}${c.review.heavier ? `; ${c.review.heavier} needed more than you guessed` : ''}${c.review.lighter ? `; ${c.review.lighter} less` : ''}.`);
  const worst = c.kinds.find((k) => k.missed && k.of >= 2);
  if (worst) out.push(`Most often off: ${worst.label.toLowerCase()} (${worst.missed} of ${worst.of}). Spend your attention there, or write those briefs more fully.`);
  if (c.agents.of) out.push(`For comparison, the agents' own confidence of 80% or more held up ${c.agents.held} of ${c.agents.of} times.`);
  return out;
}

export function calibrationMarkdown(c) {
  const out = ['# Your calibration', '', ...calibrationLines(c), ''];
  if (c.rows.length) {
    out.push('| Agent | Kind | Finishes | Hours | Reading |', '|---|---|---|---|---|');
    const cell = (g, a, word = (x) => x) => (g == null ? '–' : `${word(g)} → ${a == null ? '?' : word(a)}`);
    for (const r of c.rows) out.push(`| ${r.name} | ${KIND_LABEL[r.kind] ?? r.kind} | ${cell(r.guess.finish, r.actual.finish)} | ${cell(r.guess.hours, r.actual.hours)} | ${cell(r.guess.review, r.actual.review, (x) => REVIEW_WORD[x])} |`);
  }
  return out.join('\n').trimEnd();
}
