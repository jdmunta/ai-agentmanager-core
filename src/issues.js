// Issues: every Jira (or Linear) issue an agent works on, one row per agent, with where it stands
// for you: waiting for your review (an open pull request, a finished agent, a question), with the
// agent still on it, or done. The issue's own workflow status comes from Jira when it can be had.

import { leadingJiraKey, landState } from './tracker.js';
import { needsOf } from './standup.js';

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const NEEDS = new Set(['prompt', 'waiting', 'plan', 'question']);

/** Where each stage goes in the summary's filters. */
// In the order they're listed.
export const GROUPS = {
  needs: 'you',
  review: 'you',
  blocked: 'you',
  approved: 'you',
  working: 'agent',
  fixing: 'agent',
  merged: 'done',
  closed: 'done',
};

/** The issue an agent works on: { key, url }, from the link its request starts with or one in it. */
export function issueOf(v) {
  const lead = leadingJiraKey(v.intent);
  const bugs = (v.bugs ?? []).filter((b) => b.source === 'intent' && ISSUE_KEY.test(b.key));
  const key = v.synopsis?.key ?? lead ?? bugs[0]?.key ?? null;
  if (!key) return null;
  const bug = bugs.find((b) => b.key === key) ?? (v.bugs ?? []).find((b) => b.key === key);
  const url = bug?.url ?? String(v.intent ?? '').trimStart().match(/^<?(https?:\/\/\S+)/)?.[1]?.replace(/>$/, '') ?? null;
  return { key, url, title: (v.synopsis?.key === key ? v.synopsis.text : null) ?? bug?.title ?? null };
}

/** Where the work stands for you: { stage, note, pr }. */
export function stageOf(v) {
  const prs = (v.prs ?? []).filter((p) => p.source !== 'mentioned' && p.state);
  const open = prs.filter((p) => p.state === 'OPEN');
  // The newest PR the agent is on.
  const pr = open.at(-1) ?? prs.at(-1) ?? null;
  const needs = needsOf(v).filter((n) => NEEDS.has(n.kind));
  if (needs.length) return { stage: 'needs', note: `Needs your answer: ${needs[0].text}`, pr };
  if (open.length) {
    const land = landState(pr);
    if (pr.isDraft) return { stage: 'working', note: 'Draft pull request', pr };
    if (pr.review === 'APPROVED') return { stage: 'approved', note: 'Approved, not merged yet', pr };
    if (pr.review === 'CHANGES_REQUESTED') return { stage: 'fixing', note: v.runtime?.busy ? 'Working on your review comments' : 'Changes requested', pr };
    if (land === 'fix') return { stage: 'fixing', note: pr.checks?.state === 'failed' ? 'Checks failing' : 'Merge conflict', pr };
    return { stage: 'review', note: pr.checks?.state === 'running' ? 'Ready for your review (checks running)' : 'Ready for your review', pr };
  }
  if (prs.some((p) => p.state === 'MERGED')) return { stage: 'merged', note: 'Merged', pr };
  if (prs.length) return { stage: 'closed', note: 'Pull request closed', pr };
  const outcome = v.results?.outcome;
  if (outcome === 'blocked') return { stage: 'blocked', note: `Blocked${v.results.blockers?.[0]?.text ? `: ${v.results.blockers[0].text}` : ''}`, pr };
  if (outcome === 'done') return { stage: 'review', note: 'Done, no pull request: review it in the session', pr };
  return { stage: 'working', note: v.runtime?.busy ? 'Agent working' : v.runtime?.running ? 'Agent idle' : 'Agent not running', pr };
}

/** The summary's rows from agent views, those waiting for you first. */
export function issueRows(views, jira = new Map()) {
  const rank = Object.fromEntries(Object.keys(GROUPS).map((k, i) => [k, i]));
  const rows = [];
  for (const v of views) {
    if (v.kind === 'assistant') continue;
    const issue = issueOf(v);
    if (!issue) continue;
    const { stage, note, pr } = stageOf(v);
    const j = jira.get(issue.key) ?? null;
    rows.push({
      key: issue.key,
      url: issue.url,
      title: j?.summary ?? issue.title,
      jira: j ? { status: j.status, category: j.category } : null,
      stage,
      group: GROUPS[stage],
      note: note.length > 200 ? `${note.slice(0, 199)}…` : note,
      agent: { id: v.id, name: v.name, project: v.projectInfo?.name ?? null, running: Boolean(v.runtime?.running), busy: Boolean(v.runtime?.busy), from: v.startedBy ? 'assistant' : v.trigger?.source ?? null },
      pr: pr ? { url: pr.url, number: pr.number ?? null, title: pr.title ?? null, state: pr.state, checks: pr.checks?.state ?? null, review: pr.review ?? null } : null,
      aiReview: v.aiReview?.verdict ?? null,
      updatedAt: v.activeAt ?? v.createdAt ?? null,
    });
  }
  return rows.sort((a, b) => rank[a.stage] - rank[b.stage] || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** The rows as a Markdown table, to paste into Slack, Jira or a doc. */
export function issuesMarkdown(rows) {
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const lines = ['| Issue | Jira status | Where it stands | Pull request | Agent |', '|---|---|---|---|---|'];
  for (const r of rows) {
    const issue = r.url ? `[${r.key}](${r.url})` : r.key;
    const pr = r.pr ? (r.pr.url ? `[#${r.pr.number ?? '?'}](${r.pr.url})` : `#${r.pr.number}`) : '';
    lines.push(`| ${issue}${r.title ? ` ${cell(r.title)}` : ''} | ${cell(r.jira?.status ?? '')} | ${cell(r.note)} | ${pr} | ${cell(r.agent.name)} |`);
  }
  return lines.join('\n');
}
