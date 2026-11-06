// Explain the review, by voice: a short spoken briefing on an agent's pull request for the person
// about to review it. What the work is, the PR and its checks, what the AI review found, the
// riskiest changes, and what's left before it can merge. Built from what the page already has,
// so it starts at once; the change-by-change walkthrough in Review goes deeper.

import { speakable } from './speak.js';

const VERDICT = { complete: 'complete', partial: 'partly done', not_done: 'not done' };
const list = (xs, n = 3) => {
  const items = xs.filter(Boolean).slice(0, n);
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return items.join(' and ');
  return `${items.slice(0, -1).join('; ')}; and ${items.at(-1)}`;
};
/** "a, b and c": for short items inside a sentence. */
const and = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const said = (s) => speakable(String(s ?? '')).replace(/\s+/g, ' ').trim();
// One stop at the end, and none after a question mark.
const sentence = (s) => {
  const t = said(s);
  return !t ? '' : /[.?!]$/.test(t) ? t : `${t}.`;
};

/** The pull request a review is about: the agent's newest open one, else its newest. */
export function reviewedPr(a) {
  const prs = (a.prs ?? []).filter((p) => p.source !== 'mentioned' && p.state);
  return prs.filter((p) => p.state === 'OPEN').at(-1) ?? prs.at(-1) ?? null;
}

/** The PR's state in words: "is open, checks pass, no review yet". */
function prState(p) {
  if (p.state === 'MERGED') return 'is merged';
  if (p.state === 'CLOSED') return 'was closed without merging';
  const out = [p.isDraft ? 'is a draft' : 'is open'];
  const checks = p.checks?.state;
  if (checks === 'passed') out.push('checks pass');
  else if (checks === 'failed') out.push(`checks fail${p.checks.failed?.length ? ` (${and(p.checks.failed.slice(0, 3).map((c) => c.name ?? c))})` : ''}`);
  else if (checks === 'running') out.push('checks are still running');
  if (p.mergeable === 'CONFLICTING' || p.mergeState === 'DIRTY') out.push('it has merge conflicts');
  else if (p.mergeState === 'BEHIND') out.push("it's behind its base branch");
  if (p.review === 'APPROVED') out.push("it's approved");
  else if (p.review === 'CHANGES_REQUESTED') out.push('changes were requested');
  else out.push('no review yet');
  return out.length <= 1 ? out.join('') : `${out.slice(0, -1).join(', ')}, and ${out.at(-1)}`;
}

/** What's left before it can merge, as one sentence. */
function nextStep(a, p) {
  if (!p) return a.results?.outcome === 'done' ? 'There is no pull request: the agent says it is done, so review its changes in the session.' : 'There is no pull request yet.';
  if (p.state === 'MERGED') return 'Nothing left: it is merged.';
  if (p.state === 'CLOSED') return 'Nothing left on this pull request.';
  if (p.isDraft) return 'It is still a draft: the agent is working on it.';
  if (p.checks?.state === 'failed') return 'Next: the failing checks need fixing; ask the agent to fix them from Land.';
  if (p.mergeable === 'CONFLICTING' || p.mergeState === 'DIRTY') return 'Next: the merge conflicts need resolving; Update in Land, or ask the agent.';
  if (p.review === 'CHANGES_REQUESTED') return a.runtime?.busy ? 'The agent is working on the requested changes.' : 'Changes were requested and the agent is idle: send them to it.';
  if (p.review === 'APPROVED') return 'Next: merge it when you are ready.';
  return 'Next: your review. Open Review to go through each change, then approve or ask for changes.';
}

/**
 * The briefing as parts to speak. `designSummary` is the summary from the agent's design doc, when
 * the page has it; `issueKey` names the issue.
 */
export function reviewSpeech(a, { designSummary = null, issueKey = null } = {}) {
  if (!a) return [];
  const p = reviewedPr(a);
  const key = issueKey ?? a.synopsis?.key ?? null;
  const what = a.synopsis?.text ?? String(a.intent ?? '').split('\n')[0].replace(/^<?https?:\/\/\S+>?\s*/, '');
  const parts = [];
  parts.push(sentence(`Review of ${key ? `${key}, ` : ''}${what || a.name}`));
  if (p) parts.push(sentence(`Pull request ${p.number ?? ''}${p.title ? `, ${p.title},` : ''} ${prState(p)}`));
  // What it does: the design doc's summary, else the walkthrough's, else the agent's own words.
  const walk = a.docs?.walkthrough?.data;
  // (Only what the agent wrote: the tracked PR is said above.)
  const does = designSummary || walk?.summary || (a.results?.delivered ?? []).filter((d) => d.source === 'agent').slice(0, 2).map((d) => d.text).join('. ');
  if (does) parts.push(sentence(`What it does: ${does}`));
  const r = a.aiReview;
  if (r?.verdict) {
    parts.push(sentence(`The AI review says it is ${VERDICT[r.verdict] ?? r.verdict}. ${r.summary ?? ''}`));
    if (r.met?.length) parts.push(sentence(`Met: ${list(r.met)}`));
    if (r.missing?.length) parts.push(sentence(`Missing: ${list(r.missing)}`));
    if (r.risks?.length) parts.push(sentence(`Risks: ${list(r.risks)}`));
  } else {
    parts.push('There is no AI review yet; Review with AI checks the work against the request.');
  }
  if (walk?.changes?.length) {
    const high = walk.changes.filter((c) => c.risk === 'high');
    const n = walk.changes.length;
    parts.push(
      sentence(
        high.length
          ? `The walkthrough has ${n} change${n === 1 ? '' : 's'}; ${high.length} ${high.length === 1 ? 'is' : 'are'} high risk: ${list(high.map((c) => `${c.title}, in ${String(c.file).split('/').pop()}`))}`
          : `The walkthrough has ${n} change${n === 1 ? '' : 's'}, none high risk`,
      ),
    );
  }
  const blockers = (a.results?.blockers ?? []).filter((b) => b.source === 'agent').map((b) => b.text);
  if (blockers.length) parts.push(sentence(`The agent is blocked: ${list(blockers, 2)}`));
  const open = (a.questions ?? []).filter((q) => !q.answer).map((q) => q.question);
  if (open.length) parts.push(sentence(`It asks you: ${list(open, 2)}`));
  parts.push(nextStep(a, p));
  return parts.filter(Boolean);
}
