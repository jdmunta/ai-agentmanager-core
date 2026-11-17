// Review rounds: an agent's changes are reviewed before they become a pull request, so the bugs
// are found here and not by the reviewers of the pull request (people, or GitHub Copilot).
//
// When an agent says it is done, critics on other models of the engine it runs on (Claude Code's
// opus and sonnet, say: another provider may not be installed) each read the diff in the background and
// report defects: wrong logic, missed edge cases, error handling, behavior callers rely on,
// missing tests, and what the task asked for that isn't there. Their findings go to the agent's
// session as one message; it fixes them and says done again, and the critics look again: at what
// they raised, and at the new diff. That repeats until they approve or the rounds run out (4 by
// default, 5 at most). Approved: the changes are committed, pushed and opened as a pull request
// whose description says what was found and fixed. Not approved in time: it waits for you, with
// what is still open.
//
// A finding blocks when it is a blocker or major; minor ones and nits are passed on but don't
// hold the pull request. Config: "preReview": { "enabled", "rounds", "critics", "models", "openPr" }.

import { parseDiff } from '../public/review.js';
import { parseJsonReply, readSpecDoc, walkthroughHunks } from './brief.js';
import { DEFAULT_ENGINE, ENGINES, installed } from './engines/index.js';

export const PREREVIEW_DEFAULTS = { enabled: true, rounds: 4, critics: 2, openPr: true };
export const MAX_ROUNDS = 5;
export const MAX_CRITICS = 3;
export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];
const BLOCKING = new Set(['blocker', 'major']);
/**
 * The models of an engine that critics run on, strongest first. For another engine, name them in
 * config.json: "engines": { "codex": { "reviewModels": ["…", "…"] } }.
 */
const CRITIC_MODELS = { claude: ['opus', 'sonnet', 'haiku'] };
/** Rounds under way: the agent's other reviews wait for their end. */
export const ACTIVE = new Set(['reviewing', 'fixing']);

const now = () => new Date().toISOString();
const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const whole = (v, lo, hi, or) => (Number.isInteger(Number(v)) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, Number(v))) : or);

/** The settings from config.json, with defaults. `models`: critics you chose, [{ engine, model }]. */
export function preReviewSettings(config = {}) {
  const c = config.preReview ?? {};
  const models = Array.isArray(c.models) ? c.models.filter((m) => m && typeof m.engine === 'string').map((m) => ({ engine: m.engine, model: m.model ? String(m.model) : null })) : [];
  return {
    enabled: c.enabled !== false,
    rounds: whole(c.rounds, 1, MAX_ROUNDS, PREREVIEW_DEFAULTS.rounds),
    critics: whole(c.critics, 1, MAX_CRITICS, PREREVIEW_DEFAULTS.critics),
    models,
    openPr: c.openPr !== false,
  };
}

export const blocking = (findings = []) => findings.filter((f) => f.status === 'open' && BLOCKING.has(f.severity));

/** What an agent is told when it starts: the pull request waits for the review. */
export const preReviewPrompt = () =>
  [
    'Review before a pull request: when your work is done, do not open a pull request yourself. Mark your brief as done.',
    'Your changes are then reviewed by other models. You get their findings to fix, they look again, and the pull request is opened for you when they approve.',
  ].join(' ');

/** One critic's prompt: the diff, what was asked, and what earlier rounds raised. */
export function criticPrompt({ intent, briefMarkdown, specDoc, hunks, cut, round, max, earlier = [] }) {
  return [
    "You review an AI coding agent's changes before they become a pull request.",
    `This is round ${round} of at most ${max}. Other reviewers read the same diff independently, and after this the pull request goes to its human reviewers: a defect you miss is found by them.`,
    'Find what is wrong or missing in the CHANGED code. Be exact and skeptical; do not praise.',
    '',
    'Reply with one JSON object only:',
    '{"verdict": "approve|changes", "summary": "<one or two sentences>",',
    ' "findings": [{"severity": "blocker|major|minor|nit", "hunk": "H3", "line": "<the changed line it is on, copied, or empty>", "title": "<the defect in a few words>", "why": "<the input or sequence that goes wrong, and what happens then>", "fix": "<what to change>"}],',
    ' "missing": ["<something the task or spec asks for that the change does not do>"],',
    ' "earlier": [{"id": "R1-2", "status": "resolved|open", "note": "<if open: what is still wrong>"}]}',
    '',
    'What to look for, in the changed lines and what they affect:',
    '- wrong results: logic errors, off-by-one, wrong operator or condition, wrong variable, a case the code forgets (empty, null, zero, negative, very large, duplicate, unicode, concurrent)',
    '- errors: swallowed, unchecked, or handled in a way that hides the failure; resources not released',
    '- behavior that callers, saved data or the public interface relied on and that this changes without saying',
    '- security: input trusted that should not be, secrets, injection, paths, permissions',
    '- new or changed behavior with no test, a test that cannot fail, docs or configuration not updated to match',
    '- leftovers: debug output, commented-out code, TODOs for work the task needed',
    '',
    'Rules:',
    '- severity: blocker = data loss, a security hole, or a crash on the main path. major = a bug a user would hit, or a required part of the task missing. minor = an unlikely edge case, or a small gap in tests or docs. nit = style or naming.',
    '- Every finding needs evidence from the diff: name the input or sequence in "why". If it depends on code you cannot see, say so and rate it minor at most.',
    '- One finding per defect; at most 12, the most serious first. No general advice.',
    '- "earlier": one entry for every finding in EARLIER FINDINGS. "resolved" when the diff now fixes it, or the agent\'s reply in the brief shows it was not a defect; else "open". Do not list an earlier finding again under "findings".',
    '- verdict "approve" only when you have no blocker or major finding, nothing missing, and no earlier blocker or major finding still open.',
    cut ? '- The diff was too long to send whole: review what is here, and say in "summary" that you saw part of it.' : null,
    '',
    '<task>',
    intent || '(none)',
    '</task>',
    '<spec>',
    specDoc || '(no spec written)',
    '</spec>',
    '<brief>',
    (briefMarkdown || '(none)').slice(-12_000),
    '</brief>',
    '<earlier_findings>',
    earlier.length ? earlier.map((f) => `${f.id} [${f.severity}] ${f.file ? `${f.file}: ` : ''}${f.title}\n  why: ${f.why}${f.note ? `\n  still open last round because: ${f.note}` : ''}`).join('\n') : '(none: this is the first round)',
    '</earlier_findings>',
    '<hunks>',
    ...hunks.map((h) => `<hunk id="${h.id}" file="${h.file}">\n${h.head}\n${h.text}\n</hunk>`),
    '</hunks>',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** A critic's reply made safe to use: known severities, hunks mapped to files, text cut to size. */
export function normalizeCritique(reply, hunks = []) {
  if (!reply || typeof reply !== 'object') throw new Error('The reply was not a JSON object');
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const findings = [];
  for (const f of Array.isArray(reply.findings) ? reply.findings : []) {
    const title = clip(f?.title, 160);
    if (!title) continue;
    const h = byId.get(String(f.hunk ?? '').trim());
    findings.push({
      severity: SEVERITIES.includes(f.severity) ? f.severity : 'minor',
      file: h?.file ?? (clip(f.file, 300) || null),
      head: h?.head ?? null,
      line: clip(f.line, 200),
      title,
      why: clip(f.why, 600),
      fix: clip(f.fix, 600),
    });
    if (findings.length === 12) break;
  }
  // Something the task asked for that isn't there holds the pull request like a bug does.
  for (const m of Array.isArray(reply.missing) ? reply.missing.slice(0, 6) : []) {
    const title = clip(m, 160);
    if (title) findings.push({ severity: 'major', file: null, head: null, line: '', title: `Missing: ${title}`, why: 'The task or spec asks for this and the change does not do it.', fix: '' });
  }
  const earlier = {};
  for (const e of Array.isArray(reply.earlier) ? reply.earlier : []) {
    const id = clip(e?.id, 20);
    if (id) earlier[id] = { status: e.status === 'open' ? 'open' : 'resolved', note: clip(e.note, 400) };
  }
  const verdict = reply.verdict === 'approve' && !findings.some((f) => BLOCKING.has(f.severity)) ? 'approve' : 'changes';
  return { verdict, summary: clip(reply.summary, 400), findings, earlier };
}

const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
/**
 * Two critics describing one defect: titles that mostly share their words, or share a third of
 * them on the same line (one line can have two defects: when unsure they stay two findings, since
 * one told twice costs less than one lost).
 */
function sameDefect(a, b) {
  if ((a.file ?? '') !== (b.file ?? '')) return false;
  const [x, y] = [words(a.title), words(b.title)];
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length / Math.min(x.size, y.size);
  return shared >= (a.line && a.line === b.line ? 1 / 3 : 0.6);
}

/**
 * A round's result from its critics' replies ({ by, verdict, findings, earlier } or { by, error }):
 * the earlier findings with where they stand now, then the new ones (one per defect, with who
 * raised it). An earlier finding stays open when any critic says it is.
 */
export function mergeRound(replies, earlier = [], round = 1) {
  const ok = replies.filter((r) => !r.error);
  const carried = earlier.map((f) => {
    if (f.status !== 'open') return { ...f };
    const said = ok.map((r) => r.earlier?.[f.id]).filter(Boolean);
    const open = said.find((s) => s.status === 'open');
    return open ? { ...f, note: open.note || f.note || '' } : { ...f, status: 'resolved', resolvedIn: round, note: '' };
  });
  const fresh = [];
  for (const r of ok) {
    for (const f of r.findings) {
      // The same thing raised again under a new name stays the earlier finding.
      const old = carried.find((c) => sameDefect(c, f));
      if (old) {
        if (old.status !== 'open') Object.assign(old, { status: 'open', resolvedIn: null, note: f.why });
        continue;
      }
      const dup = fresh.find((x) => sameDefect(x, f));
      if (dup) {
        if (!dup.by.includes(r.by)) dup.by.push(r.by);
        if (SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(dup.severity)) dup.severity = f.severity;
        continue;
      }
      fresh.push({ ...f, by: [r.by], round, status: 'open' });
    }
  }
  fresh.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  fresh.forEach((f, i) => (f.id = `R${round}-${i + 1}`));
  return [...carried, ...fresh];
}

const findingLines = (f, i) =>
  [`${i + 1}. [${f.id}] ${f.severity}${f.file ? ` · ${f.file}` : ''}: ${f.title}`, f.line ? `   Line: ${f.line}` : null, f.why ? `   Why: ${f.note || f.why}` : null, f.fix ? `   Fix: ${f.fix}` : null].filter(Boolean).join('\n');

/** The message that takes a round's findings to the agent's session. */
export function fixMessage({ round, max, by = [], findings = [], pushed = false }) {
  const open = findings.filter((f) => f.status === 'open');
  const must = open.filter((f) => BLOCKING.has(f.severity));
  const rest = open.filter((f) => !BLOCKING.has(f.severity));
  return [
    `Before a pull request is opened, your changes were reviewed${by.length ? ` by ${by.join(' and ')}` : ''} (round ${round} of ${max}). ${must.length} ${must.length === 1 ? 'finding has' : 'findings have'} to be dealt with:`,
    '',
    ...must.map(findingLines),
    ...(rest.length ? ['', 'Smaller things, to fix where you agree:', '', ...rest.map(findingLines)] : []),
    '',
    'For each one: fix it, or if the finding is wrong leave the code and say why. Look for the same mistake elsewhere in your changes, and add or update tests for what you fix. Then run the tests.',
    `When all of it is done, add a "## Review round ${round}" section to your brief with one line per finding id (what you changed, or why it stands), ${pushed ? 'commit and push, ' : ''}and mark the brief as done again. The changes are then reviewed again.`,
    pushed ? '' : 'Do not open a pull request yourself: it is opened when the review approves.',
  ]
    .join('\n')
    .trim();
}

/** For the pull request's description: how the review went. */
export function prNote(state = {}) {
  const all = state.findings ?? [];
  const fixed = all.filter((f) => f.status === 'resolved');
  const open = all.filter((f) => f.status === 'open');
  const by = [...new Set((state.rounds ?? []).flatMap((r) => r.critics.filter((c) => !c.error).map((c) => c.by)))];
  const line = (f) => `- ${f.severity}${f.file ? ` · \`${f.file}\`` : ''}: ${f.title}`;
  const head =
    state.status === 'approved'
      ? `Approved in round ${state.round} of ${state.max}${by.length ? ` by ${by.join(' and ')}` : ''}. ${all.length ? `${fixed.length} of ${all.length} findings were dealt with before this was opened.` : 'Nothing was found.'}`
      : `Not approved after ${state.round} ${state.round === 1 ? 'round' : 'rounds'}${by.length ? ` (${by.join(', ')})` : ''}: opened anyway.`;
  const out = ['### Reviewed before opening', '', head];
  const hold = open.filter((f) => BLOCKING.has(f.severity));
  const small = open.filter((f) => !BLOCKING.has(f.severity));
  if (hold.length) out.push('', '**Still open:**', '', ...hold.map(line));
  if (small.length) out.push('', 'Smaller things left as they are:', '', ...small.map(line));
  if (fixed.length) out.push('', `<details><summary>Found and dealt with (${fixed.length})</summary>`, '', ...fixed.map(line), '', '</details>');
  return out.join('\n');
}

export class PreReview {
  /**
   * `ship(agentId, { body })` commits, pushes and opens the pull request. `managed(agentId)`: true
   * when something else opens it (autopilot, for backlog work). `skip(agent)`: agents this isn't for.
   */
  constructor({ manager, config, ship, managed = () => false, skip = () => false, log = () => {} }) {
    Object.assign(this, { manager, config, ship, managed, skip, log, running: new Set() });
    manager.preReview = this;
    // A round cut short by a restart can be run again.
    for (const a of manager.store.list()) {
      if (a.preReview?.status === 'reviewing') manager.patch(a.id, { preReview: { ...a.preReview, status: 'error', round: Math.max(0, a.preReview.round - 1), error: 'The review was interrupted when the app restarted' } });
    }
  }

  get settings() {
    return preReviewSettings(this.config);
  }

  /** Task agents with changes of their own that something here can review: not reviewers, bug hunts and their fixers, teams or agent builders (those have their own checks). */
  applies(agent) {
    return Boolean(this.settings.enabled && agent.kind === 'task' && agent.workdir && !agent.hunting && !agent.fixing && !agent.reviewing && !agent.team && !agent.builds && !agent.raceId && !this.skip(agent) && this.candidates(agent).length);
  }

  /** Told at launch that the pull request waits for the review? */
  instructs(agent) {
    return this.applies(agent) && this.settings.openPr && !this.managed(agent.id);
  }

  /**
   * Who can review, best first: other models of the engine the agent runs on (another provider may
   * not be there at all), the one it runs on left out when that is known. `models` in config.json
   * names critics yourself, on any engine installed. A round takes the first `critics` of these;
   * one that fails is replaced by the next. An agent on an engine that can't make a one-shot call
   * (a local model, an ACP agent) is reviewed by the engine that writes its summaries.
   */
  candidates(agent) {
    const usable = (e) => e?.supports.oneShot && installed(e, this.config);
    const own = this.manager.writerFor(agent);
    const fallback = (e) => (e.id === DEFAULT_ENGINE ? this.config.explainModel : this.config.engines?.[e.id]?.explainModel) ?? null;
    const picked = this.settings.models.filter((m) => usable(ENGINES[m.engine])).map((m) => ({ engine: ENGINES[m.engine], model: m.model ?? fallback(ENGINES[m.engine]) }));
    const same = [];
    if (usable(own.engine)) {
      const mine = (agent.engine ?? DEFAULT_ENGINE) === own.engine.id ? String(agent.model ?? '').toLowerCase() : '';
      const names = this.config.engines?.[own.engine.id]?.reviewModels ?? CRITIC_MODELS[own.engine.id] ?? [];
      const other = names.map(String).filter((n) => !mine || !mine.includes(n.toLowerCase()));
      // No other model known for this engine: the one it is set up with, once.
      same.push(...(other.length ? other.map((model) => ({ engine: own.engine, model })) : [{ engine: own.engine, model: own.model ?? null }]));
    }
    const out = [];
    for (const c of [...picked, ...same]) {
      if (!out.some((x) => x.engine.id === c.engine.id && x.model === c.model)) out.push(c);
    }
    return out;
  }

  critics(agent) {
    return this.candidates(agent).slice(0, this.settings.critics);
  }

  /**
   * From the manager, when an agent's brief changes. True while rounds are under way: its AI
   * review and score wait for their end, so each is made once, of the changes that go out.
   */
  brief(agent, { finished = false } = {}) {
    const st = agent.preReview;
    // Rounds already under way carry on (also ones you started by hand with the switch off).
    if (st?.status === 'reviewing') return true;
    if (st?.status === 'fixing') {
      if (agent.brief?.status === 'done' && agent.brief.updatedAt !== st.briefAt) this.run(agent.id);
      return true;
    }
    if (!finished || !this.applies(agent)) return false;
    this.begin(agent.id);
    return true;
  }

  begin(id) {
    this.manager.patch(id, { preReview: { status: 'reviewing', round: 0, max: this.settings.rounds, findings: [], rounds: [], startedAt: now(), endedAt: null, pr: null, error: null } });
    this.run(id);
  }

  /** On request: review this agent's changes now, from round one. */
  start(ref) {
    const agent = this.manager.mustGet(ref);
    if (agent.kind !== 'task' || !agent.workdir || this.skip(agent)) throw err(400, 'This agent has no changes of its own to review');
    if (this.running.has(agent.id)) throw err(409, 'Its changes are being reviewed now');
    this.begin(agent.id);
    return this.manager.view(this.manager.store.get(agent.id));
  }

  /** The next round, in the background. */
  run(id) {
    if (this.running.has(id)) return;
    this.running.add(id);
    this.round(id)
      .catch((e) => {
        const cur = this.manager.store.get(id);
        this.log(`review rounds: ${cur?.name ?? id}: ${e.message}`);
        if (cur?.preReview) this.manager.patch(id, { preReview: { ...cur.preReview, status: 'error', round: Math.max(0, cur.preReview.round - 1), error: e.message.slice(0, 300) } });
      })
      .finally(() => this.running.delete(id));
  }

  async round(id) {
    const m = this.manager;
    const agent = m.mustGet(id);
    const prev = agent.preReview ?? {};
    const n = (prev.round ?? 0) + 1;
    const max = Math.max(prev.max ?? this.settings.rounds, n);
    m.patch(id, { preReview: { ...prev, status: 'reviewing', round: n, max, error: null, endedAt: null } });
    const data = await m.changesSource(id);
    const { hunks, cut } = walkthroughHunks(parseDiff(data.diff), { maxLines: 300, maxChars: 80_000 });
    if (!hunks.length) {
      // Nothing changed: nothing to review, and no pull request to open.
      m.patch(id, { preReview: null });
      return this.after(id);
    }
    const pool = this.candidates(agent);
    if (!pool.length) throw new Error('Nothing here can review these changes: the engine has to make one-shot calls (Claude Code and Codex do), or critics have to be named in config.json (preReview.models)');
    const ctx = await m.explainContext(agent);
    const earlier = (prev.findings ?? []).filter((f) => f.status === 'open');
    const prompt = criticPrompt({ intent: readSpecDoc(id, 'intent')?.markdown || agent.intent, briefMarkdown: ctx.briefMarkdown, specDoc: readSpecDoc(id, 'spec')?.markdown ?? '', hunks, cut, round: n, max, earlier });
    const label = (c) => `${c.engine.label}${c.model ? ` (${c.model})` : ''}`;
    const ask = async (c) => {
      try {
        return { by: label(c), ...normalizeCritique(parseJsonReply(await m.oneShot(agent, prompt, { ...c, timeoutMs: 600_000 })), hunks) };
      } catch (e) {
        return { by: label(c), error: e.message.slice(0, 300) };
      }
    };
    // A critic that fails (no answer, or not what was asked for) is replaced by the next who can review.
    const spare = pool.slice(this.settings.critics);
    const stand = async (c) => {
      const r = await ask(c);
      return r.error && spare.length ? [r, ...(await stand(spare.shift()))] : [r];
    };
    const replies = (await Promise.all(pool.slice(0, this.settings.critics).map(stand))).flat();
    const cur = m.store.get(id);
    if (!cur?.preReview || cur.preReview.status !== 'reviewing') return; // deleted, or stopped meanwhile
    if (replies.every((r) => r.error)) throw new Error(`The review failed: ${replies[0].error}`);
    const findings = mergeRound(replies, prev.findings ?? [], n);
    const hold = blocking(findings);
    const rounds = [...(prev.rounds ?? []), { n, at: now(), cut, critics: replies.map((r) => ({ by: r.by, verdict: r.verdict ?? null, summary: r.summary ?? '', error: r.error ?? null })), raised: findings.filter((f) => f.round === n).length, open: hold.length }];
    const state = { ...cur.preReview, round: n, max, findings, rounds, error: null };
    if (!hold.length) return this.end(id, { ...state, status: 'approved', endedAt: now() });
    if (n >= max) return this.end(id, { ...state, status: 'stalled', endedAt: now() });
    this.send(id, state);
  }

  /** The open findings into the agent's session; the next round runs when it says done again. */
  send(id, state) {
    const m = this.manager;
    const agent = m.store.get(id);
    const pushed = Object.values(agent.prs ?? {}).some((p) => p.state === 'OPEN' && p.source !== 'mentioned');
    m.patch(id, { preReview: { ...state, status: 'fixing', briefAt: agent.brief?.updatedAt ?? null, sentAt: now() } });
    m.tell(id, fixMessage({ round: state.round, max: state.max, by: state.rounds.at(-1)?.critics.filter((c) => !c.error).map((c) => c.by), findings: state.findings, pushed }), { source: 'prereview' });
  }

  /** Approved, or out of rounds: the reviews that waited are made, and an approved change is opened. */
  async end(id, state) {
    this.manager.patch(id, { preReview: state });
    this.log(`review rounds: ${this.manager.store.get(id)?.name ?? id} ${state.status === 'approved' ? 'approved' : 'not approved'} in round ${state.round} of ${state.max}`);
    await this.after(id);
    if (state.status === 'approved' && this.settings.openPr && !this.managed(id)) await this.open(id).catch(() => {});
  }

  /** What waited for the rounds: the AI review, and the score (which goes in the pull request's description). */
  async after(id) {
    const m = this.manager;
    if (m.judge.enabled) m.requestReview(id, { trigger: 'brief' }).catch(() => {});
    if (this.config.scorecard?.auto !== false) await m.summarize(id, 'scorecard').catch(() => {});
  }

  /** Commit, push and open the pull request, with how the review went in its description. */
  async open(ref) {
    const m = this.manager;
    const agent = m.mustGet(ref);
    const st = agent.preReview;
    if (!st || ACTIVE.has(st.status)) throw err(409, 'The review is still under way');
    try {
      const r = await this.ship(agent.id, { body: prNote(st) });
      const cur = m.store.get(agent.id);
      if (cur?.preReview) m.patch(agent.id, { preReview: { ...cur.preReview, pr: r.url ?? null, prError: null, status: cur.preReview.status === 'stalled' ? 'opened' : cur.preReview.status } });
      return m.view(m.store.get(agent.id));
    } catch (e) {
      const cur = m.store.get(agent.id);
      if (cur?.preReview) m.patch(agent.id, { preReview: { ...cur.preReview, prError: e.message.split('\n')[0].slice(0, 300) } });
      throw e;
    }
  }

  /** Out of rounds, or it failed: one more round. What is open goes to the agent again first. */
  again(ref) {
    const agent = this.manager.mustGet(ref);
    const st = agent.preReview;
    if (!st || !['stalled', 'error'].includes(st.status)) throw err(409, 'There is no review to carry on with');
    if (this.running.has(agent.id)) throw err(409, 'Its changes are being reviewed now');
    if (st.status === 'error' || !blocking(st.findings).length) {
      this.manager.patch(agent.id, { preReview: { ...st, status: 'reviewing', max: Math.max(st.max, Math.min(MAX_ROUNDS, st.round + 1)), error: null } });
      this.run(agent.id);
    } else this.send(agent.id, { ...st, max: st.round + 1 });
    return this.manager.view(this.manager.store.get(agent.id));
  }

  /** Leave it: no more rounds for this work, and the reviews that waited are made. */
  stop(ref) {
    const agent = this.manager.mustGet(ref);
    const st = agent.preReview;
    if (!st) throw err(404, 'This agent has no review rounds');
    const was = ACTIVE.has(st.status);
    this.manager.patch(agent.id, { preReview: { ...st, status: 'stopped', endedAt: now() } });
    if (was) this.after(agent.id).catch(() => {});
    return this.manager.view(this.manager.store.get(agent.id));
  }

  view() {
    const s = this.settings;
    const usable = Object.values(ENGINES).filter((e) => e.supports.oneShot && installed(e, this.config)).map((e) => ({ id: e.id, label: e.label }));
    return { ...s, maxRounds: MAX_ROUNDS, maxCritics: MAX_CRITICS, engines: usable };
  }

  /** Changes from the API: `enabled`, `rounds`, `critics`, `openPr`, `models: [{ engine, model }]`. */
  change(b = {}) {
    const next = { ...this.config.preReview };
    for (const k of ['enabled', 'openPr']) if (k in b) next[k] = b[k] === true || b[k] === 'on';
    for (const [k, hi] of [['rounds', MAX_ROUNDS], ['critics', MAX_CRITICS]]) {
      if (!(k in b)) continue;
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < 1 || n > hi) throw err(400, `${k} is a number from 1 to ${hi}`);
      next[k] = n;
    }
    if ('models' in b) {
      if (!Array.isArray(b.models)) throw err(400, 'models is a list of { engine, model }');
      for (const m of b.models) if (!ENGINES[m?.engine]?.supports.oneShot) throw err(400, `"${m?.engine}" can't review: choose from ${Object.values(ENGINES).filter((e) => e.supports.oneShot).map((e) => e.id).join(', ')}`);
      next.models = b.models.map((m) => ({ engine: m.engine, ...(m.model ? { model: String(m.model) } : {}) }));
    }
    this.config.preReview = next;
    return next;
  }
}
