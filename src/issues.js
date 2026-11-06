// Issues: every Jira (or Linear) issue an agent works on, one row per agent, with where it stands
// for you: waiting for your review (an open pull request, a finished agent, a question), with the
// agent still on it, or done. The issue's own workflow status comes from Jira when it can be had.

import { leadingJiraKey, landState } from './tracker.js';
import { wordsAfterLink } from './jira.js';
import { needsOf } from './standup.js';

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const MAX_PROPOSED = 200;
const err = (status, message) => Object.assign(new Error(message), { status });
const NEEDS = new Set(['prompt', 'waiting', 'plan', 'question']);

/** Where each stage goes in the summary's filters. */
// In the order they're listed.
export const GROUPS = {
  proposed: 'new',
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

/** A plan's steps: { done, total } from its "- [x]" and "- [ ]" items. */
export function planSteps(markdown) {
  const items = String(markdown ?? '').match(/^\s*[-*]\s+\[[ xX]\]/gm) ?? [];
  return { done: items.filter((i) => /\[[xX]\]/.test(i)).length, total: items.length };
}

/** The agent's plan: written or not, its steps, and its review when plans are reviewed. */
function planOf(v, read) {
  const written = Boolean(v.specDocs?.plan);
  const review = v.planReview?.status ?? null;
  if (!written && !review) return null;
  const steps = written ? planSteps(read(v.id, 'plan')) : { done: 0, total: 0 };
  return { written, review, ...steps };
}

/** The agent's design doc: written or not, and where it's published. */
function designOf(v) {
  const written = Boolean(v.specDocs?.designdoc);
  const ref = (v.brief?.references ?? []).find((r) => /design page/i.test(r.label));
  const google = v.drive?.files?.designdoc?.url ?? null;
  if (!written && !ref && !google && !v.designDoc) return null;
  return { written, page: ref?.url ?? null, google };
}

/**
 * The summary's rows from agent views, those waiting for you first.
 * `read(agentId, name)` gives one of the agent's documents ('plan'), or null.
 */
export function issueRows(views, jira = new Map(), read = () => null, proposed = []) {
  const rank = Object.fromEntries(Object.keys(GROUPS).map((k, i) => [k, i]));
  const rows = [];
  // Issues proposed for agents, not started yet: they wait for you to tick them.
  for (const p of proposed) {
    const j = jira.get(p.key) ?? null;
    rows.push({
      key: p.key,
      url: p.url,
      title: j?.summary ?? p.title,
      jira: j ? { status: j.status, category: j.category } : null,
      stage: 'proposed',
      group: 'new',
      note: `Not started${p.project ? ` (@${p.project})` : ''}: tick it to start an agent`,
      agent: null,
      proposal: { project: p.project ?? null, repo: p.repo ?? null, by: p.by ?? null, intent: p.intent },
      pr: null,
      aiReview: null,
      plan: null,
      design: null,
      updatedAt: p.at,
    });
  }
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
      plan: planOf(v, read),
      design: designOf(v),
      updatedAt: v.activeAt ?? v.createdAt ?? null,
    });
  }
  return rows.sort((a, b) => rank[a.stage] - rank[b.stage] || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}

const REVIEW = { writing: 'being written', review: 'waiting for your approval', approved: 'approved', changes: 'changes asked' };

/** A plan in a few words: "3/5 steps, approved". */
export function planText(p) {
  if (!p) return '';
  const steps = p.total ? `${p.done}/${p.total} steps` : p.written ? 'written' : '';
  return [steps, p.review ? REVIEW[p.review] ?? p.review : null].filter(Boolean).join(', ');
}

/** A design doc in a few words, with its links. */
function designText(d) {
  if (!d) return '';
  const links = [d.page && `[page](${d.page})`, d.google && `[doc](${d.google})`].filter(Boolean);
  return links.length ? links.join(' ') : d.written ? 'written' : 'not yet';
}

/** The rows as a Markdown table, to paste into Slack, Jira or a doc. */
export function issuesMarkdown(rows) {
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const lines = ['| Issue | Jira status | Where it stands | Plan | Design | Pull request | Agent |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const issue = r.url ? `[${r.key}](${r.url})` : r.key;
    const pr = r.pr ? (r.pr.url ? `[#${r.pr.number ?? '?'}](${r.pr.url})` : `#${r.pr.number}`) : '';
    lines.push(`| ${issue}${r.title ? ` ${cell(r.title)}` : ''} | ${cell(r.jira?.status ?? '')} | ${cell(r.note)} | ${planText(r.plan)} | ${designText(r.design)} | ${pr} | ${cell(r.agent?.name ?? '')} |`);
  }
  return lines.join('\n');
}

/**
 * Issues proposed for agents (by the assistant, when you pick), waiting for you to tick the ones
 * to start. Kept in state.json; dismissed ones are remembered so they aren't proposed again.
 */
export class ProposedIssues {
  constructor({ store, manager }) {
    this.store = store;
    this.manager = manager;
  }

  get all() {
    return (this.store.data.proposedIssues ??= []);
  }

  /** The ones waiting for you, without those an agent has taken up meanwhile. */
  waiting() {
    return this.all.filter((p) => p.status === 'waiting' && !this.agentFor(p.key));
  }

  agentFor(key) {
    const k = key.toLowerCase();
    return this.store.list().find((a) => a.kind === 'task' && (a.name.toLowerCase() === k || leadingJiraKey(a.intent)?.toLowerCase() === k)) ?? null;
  }

  /** Propose an issue: the request starts with its link. */
  add({ intent, project = null, repo = null, by = null } = {}) {
    const text = String(intent ?? '').trim();
    const key = leadingJiraKey(text);
    if (!key) throw err(400, 'Start the request with the issue link (a Jira /browse/KEY-1 or Linear /issue/KEY-1 link)');
    const agent = this.agentFor(key);
    if (agent) throw err(409, `An agent for ${key} already exists: ${agent.name} (${agent.id})`);
    const prev = this.all.find((p) => p.key === key);
    if (prev?.status === 'dismissed') throw err(409, `${key} was dismissed; not proposed again`);
    if (prev?.status === 'started') throw err(409, `${key} was started already`);
    project = project ? String(project).trim().replace(/^@/, '') || null : null;
    if (project && !this.manager.resolveProject(project)) throw err(400, `No project @${project}; see agentmgr project ls`);
    const item = {
      key,
      url: text.match(/^<?(https?:\/\/\S+)/)[1].replace(/>$/, ''),
      title: wordsAfterLink(text),
      intent: text.slice(0, 4000),
      project,
      repo: repo || null,
      by: by || null,
      status: 'waiting',
      at: prev?.at ?? new Date().toISOString(),
    };
    if (prev) Object.assign(prev, item);
    else this.all.push(item);
    // Old decisions go first when the list grows long.
    while (this.all.length > MAX_PROPOSED) {
      const i = this.all.findIndex((p) => p.status !== 'waiting');
      this.all.splice(i < 0 ? 0 : i, 1);
    }
    this.store.save();
    return item;
  }

  /** Start agents for the ticked issues: { started: [{ key, agent }], failed: [{ key, reason }] }. */
  start(keys = []) {
    const started = [];
    const failed = [];
    for (const key of new Set(keys)) {
      const p = this.all.find((x) => x.key === key && x.status === 'waiting');
      if (!p) {
        failed.push({ key, reason: 'not waiting to be started' });
        continue;
      }
      const agent = this.agentFor(key);
      if (agent) {
        p.status = 'started';
        p.agentId = agent.id;
        failed.push({ key, reason: `${agent.name} (${agent.id}) already works on it` });
        continue;
      }
      try {
        const [a] = this.manager.createMany([p.intent], { ...(p.project ? { project: p.project } : {}), ...(p.repo ? { repo: p.repo } : {}) });
        p.status = 'started';
        p.agentId = a.id;
        p.startedAt = new Date().toISOString();
        started.push({ key, agent: { id: a.id, name: a.name } });
      } catch (e) {
        failed.push({ key, reason: e.message });
      }
    }
    this.store.save();
    return { started, failed };
  }

  /** Not for an agent: off the list, and not proposed again. */
  dismiss(keys = []) {
    const want = new Set(keys);
    let n = 0;
    for (const p of this.all) {
      if (want.has(p.key) && p.status === 'waiting') {
        p.status = 'dismissed';
        p.dismissedAt = new Date().toISOString();
        n++;
      }
    }
    this.store.save();
    return { dismissed: n };
  }
}
