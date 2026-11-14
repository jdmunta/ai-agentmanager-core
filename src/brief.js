// The agent's living brief: Problem, Solution, Diagram and Checks, written by
// Claude to a Markdown file outside the repository and shown in the UI.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

export const BRIEF_FILE = 'BRIEF.md';

export function briefDir(agentId) {
  return path.join(paths.briefs, agentId);
}

export function briefPath(agentId) {
  return path.join(briefDir(agentId), BRIEF_FILE);
}

export const briefPrompt = (file) =>
  `Keep a short, living brief of this task in ${file} (Markdown). AI Agent Manager shows it to the user ` +
  'next to your terminal. Start it with one status line, then use exactly these four sections:\n' +
  'Status: planning | working | blocked | done\n' +
  'Set "done" only when the task is complete and its checks pass; set "blocked" when you need the user.\n' +
  '## Problem\nWhat is wrong or what is needed, and why (2-5 sentences).\n' +
  '## Solution\nThe approach and the key changes (files, components). Keep it current as the plan evolves.\n' +
  '## Diagram\nOne ```mermaid code block showing the flow, sequence or architecture of the solution. ' +
  'Keep it small and valid Mermaid syntax.\n' +
  '## Checks\nA task list of how the work is verified, one line per check with the command or evidence: ' +
  '"- [ ]" pending, "- [~]" running, "- [x]" passed, "- [!]" failed.\n' +
  '## Results\nThe end result so far. First line "Outcome: in progress | partial | done | blocked". Then bullets:\n' +
  '"- Delivered: ..." for each concrete result (PR or commit links, files, documents, answers), and\n' +
  '"- Blocked by: ... (needs: who or what)" for anything blocking progress, and\n' +
  '"- Filed: <issue link> <title>" for each bug or issue you opened (GitHub, Jira, ...). Keep it current; it is what reviewers read first.\n' +
  'Add a fifth section only when the task links Jira issues (or other tickets):\n' +
  '## References\nLook each linked issue up (use your Jira / Atlassian tools if you have them) and list the ' +
  'documents its fields point to, above all its PRD and Tech Spec fields, plus design docs or Confluence pages. ' +
  'One line per document: "- **PRD**: [title](url) — the 1-2 points that matter for this task". If a field is ' +
  'empty, say so ("- **Tech Spec**: none on IDEA-872"). If you cannot reach Jira, say that in one line. ' +
  'Read the PRD and Tech Spec before settling the Solution.\n' +
  'Write it as soon as you understand the task, then update it when the plan changes and whenever a check ' +
  'runs. Keep it concise. The file is outside the repository: never copy it into the repo or commit it.';

const SECTION_ALIASES = {
  problem: ['problem', 'problem statement', 'issue', 'context'],
  solution: ['solution', 'approach', 'proposed solution', 'plan'],
  diagram: ['diagram', 'design', 'flow', 'architecture', 'design/flow/architecture', 'design / flow / architecture'],
  checks: ['checks', 'verification', 'tests', 'testing', 'validation'],
  references: ['references', 'links', 'documents', 'docs', 'specs', 'prd / tech spec', 'prd/tech spec'],
  results: ['results', 'result', 'outcome', 'status and results', 'results and status'],
};

// "- **PRD**: [Title](https://...) — highlight", tolerating ":" / "-" / "–" separators and bare URLs.
const REF_LINE =
  /^\s*[-*]\s+(?:\*\*|__)?([^*_:\[\]]+?)(?:\*\*|__)?\s*:\s*(?:\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|<?(https?:\/\/[^\s>]+)>?)?\s*(?:[—–-]\s*)?(.*)$/;

export function parseReference(line) {
  const m = line.match(REF_LINE);
  if (!m) return null;
  const [, label, title, url1, url2, rest] = m;
  const url = url1 ?? url2 ?? null;
  const highlight = rest.trim();
  // A key spec document (PRD / tech spec / design) is highlighted in the UI.
  const key = /\b(prd|product requirements?|tech(nical)? spec|design (doc|spec)|architecture)\b/i.test(label);
  return { label: label.trim(), title: title ?? null, url, highlight, key, missing: !url && /^none\b|^n\/a\b|^not (set|filled)/i.test(highlight) };
}

function sectionKey(heading) {
  const h = heading.toLowerCase().replace(/[`*_:]/g, '').trim();
  for (const [key, names] of Object.entries(SECTION_ALIASES)) {
    if (names.includes(h) || names.some((n) => h.startsWith(`${n} `))) return key;
  }
  return null;
}

const CHECK_STATES = { ' ': 'pending', '~': 'running', x: 'passed', X: 'passed', '!': 'failed' };

/** Parse the brief Markdown into its four sections. Unknown sections are ignored. */
export function parseBrief(markdown) {
  const out = { status: null, problem: '', solution: '', diagram: null, diagramNotes: '', checks: [], references: [], results: null };
  const st = markdown.split(/^##\s/m)[0].match(/^\s*\**status\**\s*:\s*\**\s*(planning|working|blocked|done)\b/im);
  if (st) out.status = st[1].toLowerCase();
  const parts = markdown.split(/^##\s+(.+?)\s*#*\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const key = sectionKey(parts[i]);
    const body = (parts[i + 1] ?? '').trim();
    if (!key) continue;
    if (key === 'diagram') {
      const m = body.match(/```mermaid\s*\n([\s\S]*?)```/);
      out.diagram = m ? m[1].trim() : null;
      out.diagramNotes = (m ? body.replace(m[0], '') : body).trim();
    } else if (key === 'results') {
      const outcome = body.match(/^\s*\**outcome\**\s*:\s*\**\s*(in progress|in-progress|partial|done|blocked)\b/im)?.[1];
      const lines = body.split('\n');
      const pick = (re) => lines.map((l) => l.match(re)?.[1]?.trim()).filter(Boolean);
      out.results = {
        outcome: outcome ? outcome.toLowerCase().replace('-', ' ') : null,
        // Tolerates "Delivered:", "**Delivered:**" and "**Delivered**:".
        delivered: pick(/^\s*[-*]\s+\**\s*delivered\s*\**\s*:\s*\**\s*(.+)$/i),
        blockers: pick(/^\s*[-*]\s+\**\s*blocked by\s*\**\s*:\s*\**\s*(.+)$/i),
        filed: pick(/^\s*[-*]\s+\**\s*filed\s*\**\s*:\s*\**\s*(.+)$/i),
        notes: lines
          .filter((l) => !/^\s*\**\s*outcome\s*\**\s*:/i.test(l) && !/^\s*[-*]\s+\**\s*(delivered|blocked by|filed)\s*\**\s*:/i.test(l))
          .join('\n')
          .trim(),
      };
    } else if (key === 'references') {
      for (const line of body.split('\n')) {
        const ref = parseReference(line);
        if (ref) out.references.push(ref);
      }
    } else if (key === 'checks') {
      for (const line of body.split('\n')) {
        const m = line.match(/^\s*[-*]\s+\[([ xX!~])\]\s+(.+?)\s*$/);
        if (m) out.checks.push({ state: CHECK_STATES[m[1]], text: m[2] });
      }
    } else {
      out[key] = body;
    }
  }
  const count = (s) => out.checks.filter((c) => c.state === s).length;
  out.summary = {
    passed: count('passed'),
    failed: count('failed'),
    running: count('running'),
    pending: count('pending'),
    total: out.checks.length,
  };
  return out;
}

/** Re-read the brief if it changed since `prev` (by mtime). Returns the new brief, or null if unchanged. */
export function loadBrief(agentId, prev) {
  let st;
  try {
    st = fs.statSync(briefPath(agentId));
  } catch {
    return null;
  }
  if (prev && prev.mtimeMs === st.mtimeMs) return null;
  const markdown = fs.readFileSync(briefPath(agentId), 'utf8');
  return { ...parseBrief(markdown), mtimeMs: st.mtimeMs, updatedAt: st.mtime.toISOString() };
}

/**
 * Ask the agent to learn and follow the project's and user's own rules before working.
 * Claude Code gets the full list of its own files; other engines get their rules files
 * (`rulesFiles` on the adapter) and a plain warning against turning this into research,
 * which a smaller model otherwise did (it searched the whole disk for Claude's settings).
 */
export const conventionsPrompt = ({ withBrief, rulesFiles = null }) =>
  (rulesFiles
    ? 'Before you change anything, take a quick look at the rules this project has set up, and follow them throughout:\n' +
      `- Read ${rulesFiles.join(', ')} and any CONTRIBUTING guide in the repository root and the folders you work in, if they exist.\n` +
      '- If the repository has SKILL.md files under .claude/skills/, read the ones relevant to this task.\n' +
      "This is a quick check, not an investigation: don't search outside the repository, and if there's nothing, go straight to the task." +
      (withBrief ? '\nRecord what applies as the first item under Checks in the brief, for example: "- [x] Reviewed conventions: AGENTS.md".' : '')
    : conventionsClaude({ withBrief }));

const conventionsClaude = ({ withBrief }) =>
  'Before you change anything, learn the rules this project and user have set up, and follow them throughout:\n' +
  '- Read the CLAUDE.md and AGENTS.md files (repository root, the folders you work in, and ~/.claude/CLAUDE.md) ' +
  'and any CONTRIBUTING guide.\n' +
  '- Review the available skills: the ones listed to you, plus SKILL.md files under .claude/skills/ in the ' +
  'repository and ~/.claude/skills/. Read the ones relevant to this task and use them rather than improvising.\n' +
  '- Review hooks and permissions in .claude/settings.json, .claude/settings.local.json and ~/.claude/settings.json, ' +
  'so you know what runs automatically (formatters, linters, checks) and work with it, not around it.\n' +
  '- Check .claude/commands/ and .claude/agents/ for project workflows.\n' +
  'If the repository is not available yet, review the user-level ones now and the repository ones as soon as it is.' +
  (withBrief
    ? '\nRecord what applies as the first item under Checks in the brief, for example: ' +
      '"- [x] Reviewed conventions: skills go-testing, release-notes; hooks: gofmt on edit".'
    : '');

/**
 * Prompt for a one-off, tool-less "explain what this agent is doing" call, built
 * from the agent's live context: its conversation and actions, repository
 * changes, status and brief.
 */
export function explainPrompt({ intent, status, digest, repo, briefMarkdown }) {
  return [
    "You are briefing a busy engineer on an AI coding agent's work so far. Use the context below (the agent's",
    'actual conversation, actions and repository changes) and explain in plain language what it is doing.',
    '',
    'Write Markdown with exactly these sections:',
    '### The ask',
    'What the user asked for, in one or two sentences, including any later change of direction.',
    '### Where it stands',
    'One or two lines: the phase (planning, investigating, implementing, testing, done, blocked), what it is',
    'doing right now, and whether it is waiting for the user and on what.',
    '### Planned work',
    'The plan as a short checklist, each step marked ✅ done, 🔄 in progress or ⏳ next, based on what the agent',
    'said it would do and what it actually did.',
    '### Solution',
    'The approach and why, and the concrete changes so far: files or components touched, commits, PRs.',
    '### Conclusions so far',
    'Findings, decisions, answers and results (including test results). Write "None yet." if nothing is settled.',
    '### Needs from you',
    'Questions or decisions the agent is waiting on, plus risks and blockers. Write "Nothing right now." if none.',
    '',
    'Rules: rely only on the context. Clearly separate what was done from what was only planned. If the',
    'context is thin or unclear, say so instead of guessing. No preamble. Keep it under about 400 words.',
    '',
    '<agent_status>',
    status,
    '</agent_status>',
    '<intent>',
    intent || '(none)',
    '</intent>',
    '<conversation>',
    digest || '(no conversation recorded yet)',
    '</conversation>',
    '<repository>',
    repo || '(no repository changes recorded)',
    '</repository>',
    '<brief>',
    briefMarkdown || '(the agent has not written a brief yet)',
    '</brief>',
  ].join('\n');
}

/** Prompt for "Insights": Why / What / How / Now, three tidy points each. */
export function insightsPrompt({ intent, status, digest, repo, briefMarkdown }) {
  return [
    "Give a human the four insights that matter about an AI coding agent's work, from its ask and live",
    'context below. Write Markdown with exactly these four sections, in this order:',
    '### Why',
    'Why this work matters: the motivation, the user or business need, or the root cause of the problem.',
    '### What',
    'What is being done or delivered: the scope and the outcome.',
    '### How',
    'How it is being done: the approach, the key mechanism or the main changes.',
    '### Now',
    'Where it stands now and the next step, including anything waiting on the user.',
    '',
    'Style rules, strictly:',
    '- Each section has 1 to 3 bullets, never more. Fewer is better when it is enough.',
    '- Each bullet is one short, concrete line of at most 12 words: easy to remember and repeat.',
    '- Lead with the key word; no filler, no hedging, no nested bullets, no preamble or closing text.',
    '- Use only the context. If something is not known yet, write "Unclear yet" as the bullet.',
    '',
    '<agent_status>',
    status,
    '</agent_status>',
    '<intent>',
    intent || '(none)',
    '</intent>',
    '<conversation>',
    digest || '(no conversation recorded yet)',
    '</conversation>',
    '<repository>',
    repo || '(no repository changes recorded)',
    '</repository>',
    '<brief>',
    briefMarkdown || '(the agent has not written a brief yet)',
    '</brief>',
  ].join('\n');
}

/** Stakeholder documents built from an agent's live context. */
export const DOC_KINDS = {
  analysis: {
    title: 'Analysis',
    sections: [
      ['Summary', 'Two or three sentences a stakeholder can read on their own.'],
      ['Context', 'The background and why this came up (link the ticket or idea if there is one).'],
      ['Findings', 'What was learned from the code, docs and discussion, as specific facts.'],
      ['Root cause / core problem', 'The real problem or constraint behind the request.'],
      ['Constraints and assumptions', 'Limits, dependencies and assumptions that shape any solution.'],
      ['Options considered', 'The options, each with pros and cons, and which one is favoured and why.'],
      ['Open questions', 'What still needs an answer, and from whom.'],
    ],
    diagram: 'Include a diagram only if it clarifies the problem.',
  },
  design: {
    title: 'Design',
    sections: [
      ['Summary', 'What is being built and the key design decision, in two or three sentences.'],
      ['Goals and non-goals', 'Bullets.'],
      ['Architecture', 'Components and how they interact, with one ```mermaid flowchart or graph of the architecture.'],
      ['Components and changes', 'Each component or module touched: its responsibility and the change.'],
      ['Interfaces and data', 'APIs, configuration, schemas or data flows that change.'],
      ['Trade-offs and alternatives', 'What was chosen over what, and why.'],
      ['Risks and mitigations', 'Bullets.'],
      ['Testing and rollout', 'How it is verified and released (flags, phases, rollback).'],
    ],
    diagram: 'Include exactly one architecture diagram.',
  },
  flow: {
    title: 'Flow',
    sections: [
      ['Summary', 'What the flow covers, in one or two sentences.'],
      ['End-to-end flow', 'A ```mermaid flowchart of the main path, then a numbered step-by-step walk-through.'],
      ['Key interactions', 'A ```mermaid sequenceDiagram of the most important interaction between components or services.'],
      ['Failure and edge cases', 'What happens when steps fail or inputs are unusual.'],
    ],
    diagram: 'Use two diagrams: a flowchart and a sequenceDiagram.',
  },
  proposal: {
    title: 'Proposal',
    sections: [
      ['Summary', 'The recommendation in two or three sentences, written for a decision-maker.'],
      ['Problem', 'What is wrong or needed and why it matters now.'],
      ['Recommendation', 'The proposed approach and why it is the best option.'],
      ['Scope', 'In scope and out of scope.'],
      ['Plan', 'Phases or milestones with what each delivers.'],
      ['Effort and dependencies', 'Rough size, teams or systems involved, prerequisites.'],
      ['Risks', 'Main risks with mitigations.'],
      ['Decisions needed', 'The specific decisions or approvals requested from reviewers, as a list.'],
    ],
    diagram: 'Include one small diagram if it helps the decision.',
  },
  estimate: {
    title: 'Human time estimate',
    sections: [
      ['Summary', 'The total in hours and working days (6 focused hours a day) for one experienced developer who knows the codebase, the likely figure with its range, and how confident the estimate is.'],
      [
        'Breakdown',
        'A Markdown table with columns: #, Task, What it covers, Optimistic (h), Likely (h), Pessimistic (h), Expected (h). Split the work into tasks of at most about 8 likely hours each: understanding the ticket and code, design, each part of the implementation (one row per component or module), tests (unit, integration, end-to-end), documentation, code review and fixes, QA and verification, release or rollout. Expected = (optimistic + 4 × likely + pessimistic) / 6, rounded to the nearest half hour. End with a bold Total row.',
      ],
      ['Suggested split', 'If the total is more than about 3 days, how to split it into tickets or sub-tasks that can be delivered and reviewed on their own: each with a one-line scope, its estimate and what it depends on. Otherwise say that one ticket is enough.'],
      ['Roles and skills', 'Who is needed (for example backend, frontend, QA, DevOps, a reviewer who knows a component) and the hours for each.'],
      ['Assumptions', 'What the estimate takes as given.'],
      ['Risks and unknowns', 'What could move the estimate, by how much, and how to reduce the uncertainty early.'],
    ],
    diagram: 'No diagram unless a ```mermaid gantt chart of the tasks helps the plan.',
    rules: [
      'This is for planning: estimate the time a person would take to do this work by hand, without an AI agent. Never give the agent\'s own time.',
      'Size it from the evidence: the ticket and intent, the files and lines changed so far (diffstat) and the brief. Where the work is not done yet, estimate what is left as well as what is done, and say which.',
      'Use hours. Keep the numbers consistent: the Total row is the sum of the rows above it.',
    ],
    words: '300-900',
  },
  documentation: {
    title: 'Documentation',
    diff: true,
    sections: [
      ['Summary', 'What changed and who it is for, in two or three sentences.'],
      ['What is new or changed', 'The changes as users see them, as bullets.'],
      ['How to use it', 'Steps, commands, UI paths or code examples for the main uses.'],
      ['Configuration', 'Settings, environment variables, flags and their defaults that were added or changed, as a table; or "No configuration changes."'],
      ['Upgrade and operations notes', 'Migrations, compatibility, permissions, rollout and rollback, monitoring; or "None."'],
      ['Docs to add or update', 'Each documentation file or page in the repository (README, docs/, changelog, help text) that should be added or changed, with what goes in it.'],
      [
        'API changes',
        'If the work adds, changes or removes HTTP API endpoints, parameters, request or response fields or status codes, a summary table of the endpoints (method, path, change), then one ```yaml block with an OpenAPI 3.0.3 document covering only those endpoints: paths, parameters, request bodies, responses and component schemas, with descriptions and examples. Mark removed or deprecated endpoints with deprecated: true. If there are no API changes, write "No API changes."',
      ],
    ],
    diagram: 'No diagram unless one makes the usage clearer.',
    rules: [
      'Write it from the actual changes in <diff> and the brief: only document behaviour the code has. Read routes, handlers, schemas and validation in the diff to get the API right (paths, methods, field names and types).',
      'The OpenAPI block must be valid YAML that an OpenAPI 3.0 tool can load on its own: openapi, info (title and version), paths and, when used, components.',
    ],
    words: '400-1500',
  },
};

export function docPrompt(kind, { intent, status, digest, repo, briefMarkdown, agentName, diff }) {
  const d = DOC_KINDS[kind];
  return [
    `Write a ${d.title} document about an AI coding agent's work, for stakeholders who will review it.`,
    'Base it only on the context below: the original ask, the agent conversation and actions, repository changes',
    'and its brief. Write for reviewers, not for the agent: no mention of the agent, its tools or this prompt.',
    '',
    `Start with a level-1 title: "# ${d.title}: <short name of the work>". Then these sections, as level-2 headings, in order:`,
    ...d.sections.map(([h, what]) => `## ${h}\n${what}`),
    '',
    'Rules:',
    `- ${d.diagram} Diagrams go in \`\`\`mermaid code blocks with valid Mermaid syntax; keep node labels short and quote labels that contain punctuation.`,
    '- Be specific: name the real files, components, tickets and documents from the context.',
    '- Separate facts from proposals. Where the context does not say, write "To be confirmed" rather than guessing.',
    ...(d.rules ?? []).map((r) => `- ${r}`),
    `- Clear, neutral, professional prose; bullets where they help. Roughly ${d.words ?? '400-900'} words${d.rules ? ' (not counting tables and code)' : ''}.`,
    '- Output only the Markdown document.',
    '',
    '<agent_status>',
    status,
    '</agent_status>',
    '<intent>',
    intent || '(none)',
    '</intent>',
    '<conversation>',
    digest || '(no conversation recorded yet)',
    '</conversation>',
    '<repository>',
    repo || '(no repository changes recorded)',
    '</repository>',
    '<brief>',
    briefMarkdown || '(no brief yet)',
    '</brief>',
    ...(diff == null ? [] : ['<diff>', diff || '(no changes yet)', '</diff>']),
  ].join('\n');
}

// ------------------------------------------------------------------ Diagrams

const DIAGRAM_SET = [
  ['The problem', 'a flowchart of the situation today and where it goes wrong (the root cause, from the analysis)'],
  ['Architecture', 'a flowchart of the components and how they connect, grouped with subgraphs; mark the components this work adds or changes with class "changed"'],
  ['Design', 'a classDiagram (or erDiagram for data) of the key modules, types or records and their relationships'],
  ['Data flow', 'a flowchart LR of how data moves through the system, with the main path animated'],
  ['Key interaction', 'a sequenceDiagram (with autonumber) of the most important exchange between components, services or the user'],
  ['Plan', 'a flowchart of the delivery steps or a stateDiagram-v2 of the main lifecycle, whichever the work is about'],
];

/**
 * Diagrams only: the problem and its solution drawn for a quick grasp, from the documents
 * already written for this work (analysis, design, flow, plan) and the agent's live context.
 */
export function diagramsPrompt({ intent, status, digest, repo, briefMarkdown, documents, repoMap }) {
  return [
    "Draw diagrams that let a person grasp an AI coding agent's work at a glance: the problem and how it is being solved.",
    'Diagrams only. No paragraphs, bullets, captions, notes or explanations outside the diagrams.',
    '',
    'Output Markdown in exactly this shape: a level-1 title "# Diagrams: <short name of the work>", then for each diagram a',
    'level-2 heading with its name followed by one ```mermaid code block. Nothing else.',
    '',
    'The diagrams, in this order (leave one out only when the context has nothing for it):',
    ...DIAGRAM_SET.map(([name, what], i) => `${i + 1}. "${name}": ${what}.`),
    '',
    'Rules:',
    '- Valid Mermaid syntax. At most about 15 nodes per diagram; labels of five words or fewer; quote labels with punctuation, e.g. A["Parse (JSON)"]. No HTML in labels.',
    '- Animate the main path in every flowchart: give its edges ids and animate them, e.g.',
    '    A e1@--> B',
    '    B e2@-->|"saves"| C',
    '    e1@{ animate: true }',
    '    e2@{ animate: true }',
    '- In the architecture diagram, style what this work adds or changes: `classDef changed stroke-width:3px,stroke:#22c55e` then `class X,Y changed`.',
    '- Use the real names of files, modules, services and data from the context. Prefer what the documents below say; do not invent components.',
    '- Output only the Markdown.',
    '',
    contextBlock({ intent, status, digest, repo, briefMarkdown }).join('\n'),
    '<documents_already_written>',
    documents || '(none yet: draw from the context above)',
    '</documents_already_written>',
    '<repository_layout>',
    repoMap || '(no repository)',
    '</repository_layout>',
  ].join('\n');
}

/** Keep only the title, the diagram headings and the Mermaid blocks of a reply. */
export function diagramsOnly(markdown) {
  const out = [];
  let block = null;
  for (const line of String(markdown ?? '').split('\n')) {
    if (block) {
      if (/^\s*```\s*$/.test(line)) {
        if (block.length) out.push('```mermaid', ...block, '```', '');
        block = null;
      } else block.push(line);
    } else if (/^\s*```\s*mermaid\s*$/i.test(line)) block = [];
    else if (/^#{1,2} \S/.test(line)) out.push(line, '');
  }
  if (!out.some((l) => l === '```mermaid')) throw new Error('The reply had no diagrams');
  // A heading left with no diagram under it says nothing.
  return out
    .filter((l, i) => !/^## /.test(l) || out.slice(i + 1).find((x) => x !== '') === '```mermaid')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ------------------------------------------------------------------ Change walkthrough

/**
 * The agent's changes explained one by one, for review: each hunk of its diff gets a title, what
 * changed, why, a risk and what to check, in the order a reviewer should read them.
 * `hunks`: [{ id, file, head, text }].
 */
export function walkthroughPrompt({ intent, status, digest, briefMarkdown, hunks }) {
  return [
    "You help a person review an AI coding agent's changes, one change at a time.",
    'Below are its changes as numbered hunks (H1, H2, ...), with the request and its conversation for the reasons behind them.',
    '',
    'Reply with one JSON object only, no prose around it:',
    '{"summary": "<two sentences: what the changes do overall>", "changes": [{"id": "H3", "title": "<under 10 words>", "what": "<what this hunk changes, concretely>", "why": "<why, from the request or conversation; \"Not stated\" if unknown>", "risk": "low|medium|high", "check": "<what the reviewer should verify here>"}]}',
    '',
    'Rules:',
    '- One entry per hunk, every hunk exactly once. Order them the way a reviewer should read them: the core change first, then what depends on it, then tests, docs and small edits.',
    '- Be specific: name the functions, values and behavior. Base it only on the hunks and the context; do not invent intent.',
    '- risk is high for security, data loss, concurrency, money or public API changes; medium for behavior changes; low for refactors, tests, docs and formatting.',
    '- Keep what, why and check to one or two sentences each.',
    '',
    ...contextBlock({ intent, status, digest, repo: '', briefMarkdown }),
    '<hunks>',
    ...hunks.map((h) => `<hunk id="${h.id}" file="${h.file}">\n${h.head}\n${h.text}\n</hunk>`),
    '</hunks>',
  ].join('\n');
}

/** The hunks a walkthrough explains, from a parsed diff: ids, and the text sent (capped). */
export function walkthroughHunks(files, { maxLines = 80, maxChars = 60_000 } = {}) {
  const out = [];
  let used = 0;
  for (const f of files) {
    if (f.binary) continue;
    for (const h of f.hunks) {
      const lines = h.lines.map((l) => `${l.t === 'add' ? '+' : l.t === 'del' ? '-' : ' '}${l.text}`);
      const text = lines.length > maxLines ? [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines)`].join('\n') : lines.join('\n');
      if (used + text.length > maxChars) return { hunks: out, cut: true };
      used += text.length;
      out.push({ id: `H${out.length + 1}`, file: f.path, head: h.head, text });
    }
  }
  return { hunks: out, cut: false };
}

/** The model's reply mapped back to hunks (file + header), in its reading order; unknown ids dropped. */
export function walkthroughFrom(reply, hunks) {
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const seen = new Set();
  const risk = (r) => (['low', 'medium', 'high'].includes(r) ? r : 'medium');
  const changes = [];
  for (const c of Array.isArray(reply?.changes) ? reply.changes : []) {
    const h = byId.get(String(c?.id ?? '').trim());
    if (!h || seen.has(h.id)) continue;
    seen.add(h.id);
    changes.push({ file: h.file, head: h.head, title: String(c.title ?? '').slice(0, 120), what: String(c.what ?? '').slice(0, 800), why: String(c.why ?? '').slice(0, 800), risk: risk(c.risk), check: String(c.check ?? '').slice(0, 600) });
  }
  // Hunks the model skipped still get a place (unexplained), so stepping through covers everything.
  for (const h of hunks) if (!seen.has(h.id)) changes.push({ file: h.file, head: h.head, title: '', what: '', why: '', risk: 'low', check: '', unexplained: true });
  return { summary: String(reply?.summary ?? '').slice(0, 600), changes };
}

/** Markdown version, for Copy / Download and the CLI. */
export function walkthroughMarkdown({ summary, changes }, title = '') {
  const out = [`# Changes explained${title ? `: ${title}` : ''}`, '', summary, ''];
  changes.forEach((c, i) => {
    out.push(`## ${i + 1}. ${c.title || '(not explained)'}`, '', `\`${c.file}\` · \`${c.head.replace(/^(@@[^@]*@@).*/, '$1')}\` · risk: ${c.risk}`, '');
    if (c.what) out.push(`- **What:** ${c.what}`);
    if (c.why) out.push(`- **Why:** ${c.why}`);
    if (c.check) out.push(`- **Check:** ${c.check}`);
    out.push('');
  });
  return out.join('\n').trim() + '\n';
}

// ------------------------------------------------------------------ Human vs AI

export const contextBlock = ({ intent, status, digest, repo, briefMarkdown }) => [
  '<agent_status>',
  status,
  '</agent_status>',
  '<intent>',
  intent || '(none)',
  '</intent>',
  '<conversation>',
  digest || '(no conversation recorded yet)',
  '</conversation>',
  '<repository>',
  repo || '(no repository changes recorded)',
  '</repository>',
  '<brief>',
  briefMarkdown || '(no brief yet)',
  '</brief>',
];

/**
 * Human vs AI: split the open questions about an agent's work into the few that need a
 * person's judgment and the ones a model can answer by reasoning over the evidence, and
 * answer those. JSON, so the page can lay it out and collect the person's answers.
 */
export function humanAiPrompt(ctx) {
  return [
    "You help a person supervise an AI coding agent. From the context below, work out the open questions about this work and split them by who should answer them.",
    '',
    '1. "human": the 5 most important questions only a person should answer, most important first. They need judgment the',
    '   context cannot supply: intent and priorities, product or user knowledge, risk appetite, trade-offs between goods,',
    '   ethics, policy or accountability. For each give:',
    '   - "question": one sentence.',
    '   - "why_human": why a model should not decide this, in one short sentence.',
    '   - "stakes": what goes wrong if it is answered badly or not at all, in one short sentence.',
    '   - "options": 2 or 3 short, concrete options.',
    '   - "lean": what the context already suggests, in one short sentence, or null. Never decide for them.',
    '2. "ai": up to 5 questions a model can answer by reasoning over the context and evaluating the work: correctness,',
    '   edge cases, consistency with the ask, test coverage, risks in the changes, what is left to do. Answer each:',
    '   - "question": one sentence.',
    '   - "answer": 1 to 3 sentences.',
    '   - "confidence": "high", "medium" or "low".',
    '   - "evidence": the files, commits, commands, test results or quotes from the context it rests on.',
    '   - "check": how a person could verify it in a minute or two.',
    '',
    'Rules:',
    '- Specific to this work: name the real files, tickets and decisions. No generic questions that fit any project.',
    '- Use only the context. Where it does not say, answer that and use low confidence; do not guess.',
    '- Do not put a question in "ai" if answering it means choosing what the person wants.',
    '- Output only one JSON object, no code fence and no other text:',
    '  {"title": "<short name of the work>", "human": [...], "ai": [...]}',
    '',
    ...contextBlock(ctx),
  ].join('\n');
}

/** A second model double-checks the split and every AI answer, against the same context. */
export function critiquePrompt(ctx, draft) {
  return [
    'You are an independent reviewer double-checking another model. It looked at an AI coding agent\'s work (context below)',
    'and split the open questions into ones only a person should answer ("human") and ones it answered itself ("ai").',
    'Check its work against the context, sceptically. Do not trust its evidence without finding it in the context.',
    '',
    'Return:',
    '- "ai": one entry per AI answer, in the same order: {"verdict": "agree" | "partly" | "disagree", "note": "..."}.',
    '  The note says why in one or two sentences; when you disagree or partly agree, give the corrected answer.',
    '- "human": one entry per human question, in the same order: {"verdict": "keep" | "ai" | "reword", "note": "..."}.',
    '  "ai" means a model could answer it from the context (say what the answer is); "reword" means it is unclear,',
    '  leading or not the real decision (give a better wording).',
    '- "missing": up to 3 important questions both lists missed: {"question": "...", "for": "human" | "ai", "why": "..."}.',
    '- "summary": one or two sentences on how far the person can rely on the AI answers.',
    '',
    'Output only one JSON object with those four keys, no code fence and no other text.',
    '',
    '<review>',
    JSON.stringify(draft, null, 2),
    '</review>',
    ...contextBlock(ctx),
  ].join('\n');
}

/** The first JSON object in a model's reply (tolerates a code fence or a sentence around it). */
export function parseJsonReply(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The reply had no JSON in it');
  return JSON.parse(s.slice(start, end + 1));
}

/** Markdown version, for Copy / Download / Print and the CLI. */
export function humanAiMarkdown({ data, critique, answers = {} }) {
  const out = [`# Human vs AI: ${data.title ?? 'review'}`, ''];
  const c = critique?.data;
  out.push('## For you to decide', '');
  (data.human ?? []).forEach((q, i) => {
    out.push(`### ${i + 1}. ${q.question}`, '');
    if (q.why_human) out.push(`- **Why you:** ${q.why_human}`);
    if (q.stakes) out.push(`- **Stakes:** ${q.stakes}`);
    if (q.options?.length) out.push(`- **Options:** ${q.options.join(' · ')}`);
    if (q.lean) out.push(`- **The work so far suggests:** ${q.lean}`);
    if (c?.human?.[i]) out.push(`- **Second opinion (${critique.label}):** ${c.human[i].verdict} — ${c.human[i].note}`);
    out.push(`- **Your answer:** ${answers[i]?.trim() || '_not answered yet_'}`, '');
  });
  out.push('## Answered by AI', '');
  (data.ai ?? []).forEach((q, i) => {
    out.push(`### ${i + 1}. ${q.question}`, '', q.answer, '');
    out.push(`- **Confidence:** ${q.confidence}`);
    if (q.evidence) out.push(`- **Evidence:** ${Array.isArray(q.evidence) ? q.evidence.join('; ') : q.evidence}`);
    if (q.check) out.push(`- **How to check:** ${q.check}`);
    if (c?.ai?.[i]) out.push(`- **Second opinion (${critique.label}):** ${c.ai[i].verdict} — ${c.ai[i].note}`);
    out.push('');
  });
  if (c) {
    out.push(`## Second opinion: ${critique.label}`, '', c.summary ?? '', '');
    for (const m of c.missing ?? []) out.push(`- **Missed (${m.for}):** ${m.question} — ${m.why}`);
  } else if (critique?.error) {
    out.push('## Second opinion', '', `Not available: ${critique.error}`);
  }
  return out.join('\n').trim();
}

/** What "Send my answers" tells the agent. */
export function humanAiMessage({ data, critique, answers = {} }) {
  const lines = ['Answers to the open questions from my Human vs AI review:'];
  (data.human ?? []).forEach((q, i) => {
    const a = answers[i]?.trim();
    if (a) lines.push(`${i + 1}. ${q.question}`, `   My answer: ${a}`);
  });
  const doubts = (data.ai ?? []).map((q, i) => [q, critique?.data?.ai?.[i]]).filter(([, v]) => v && v.verdict !== 'agree');
  if (doubts.length) {
    lines.push('', 'A second model doubted these conclusions about the work. Check them before relying on them:');
    for (const [q, v] of doubts) lines.push(`- ${q.question} (${v.verdict}: ${v.note})`);
  }
  lines.push('', 'Take these into account and continue. If an answer changes the plan, say how before going further.');
  return lines.join('\n');
}

// ------------------------------------------------------------------ plan review

export const PLAN_FILE = 'PLAN.md';
export const planPath = (agentId) => path.join(briefDir(agentId), PLAN_FILE);

/** For agents whose plan the user reviews first: plan, write it down, then wait. */
export const planReviewPrompt = (file) =>
  'The user reviews your implementation plan before you implement anything. First investigate as much as you need ' +
  `(reading code, docs and running read-only commands is fine), then write the plan to ${file} (Markdown) with these sections:\n` +
  '# Plan: <short name>\n## Goal\n## Approach\n## Steps\nNumbered, each small enough to check.\n## Files to change\n' +
  '## Tests and verification\n## Risks and open questions\n' +
  'Then stop and wait. Until a message starting with "Plan approved" arrives, do not edit, create or delete files in ' +
  'the repository, commit, or run commands that change anything. If a message starting with "Plan changes requested" ' +
  `arrives, revise ${file} the same way and wait again. Once approved, implement the plan; if you have to depart from ` +
  `it, update ${file} and say why.`;

export const planApprovedPrompt = (file) =>
  `Your implementation plan in ${file} has been approved by the user. Implement it; if you have to depart from it, update the file and say why.`;

/** PLAN.md if it changed since `prev` (same shape as the brief: markdown + times). */
export function loadPlanFile(agentId, prev) {
  let st;
  try {
    st = fs.statSync(planPath(agentId));
  } catch {
    return null;
  }
  if (prev && prev.mtimeMs === st.mtimeMs) return null;
  return { markdown: fs.readFileSync(planPath(agentId), 'utf8').slice(0, 200_000), mtimeMs: st.mtimeMs, updatedAt: st.mtime.toISOString() };
}

// ------------------------------------------------------------------ intent, spec and plan

// Three files per agent, next to the brief, for reviewers (people, other agents, AI review):
//   INTENT.md - what was asked, written by AI Agent Manager when the agent is created
//   SPEC.md   - what done means (requirements, acceptance criteria), written by the agent first
//   PLAN.md   - how it gets there, step by step, kept by the agent (the plan review uses it too)
// Push & open PR puts them in the pull request's description.
export const INTENT_FILE = 'INTENT.md';
export const SPEC_FILE = 'SPEC.md';
export const intentPath = (agentId) => path.join(briefDir(agentId), INTENT_FILE);
export const specPath = (agentId) => path.join(briefDir(agentId), SPEC_FILE);
export const DESIGN_FILE = 'DESIGN.md';
export const designPath = (agentId) => path.join(briefDir(agentId), DESIGN_FILE);
export const DEMO_FILE = 'DEMO.html';
export const demoPath = (agentId) => path.join(briefDir(agentId), DEMO_FILE);
export const BENCH_FILE = 'BENCHMARK.md';
export const benchPath = (agentId) => path.join(briefDir(agentId), BENCH_FILE);
export const DEBUG_FILE = 'DEBUG.md';
export const debugPath = (agentId) => path.join(briefDir(agentId), DEBUG_FILE);
export const REVERSE_FILE = 'REVERSE.md';
export const reversePath = (agentId) => path.join(briefDir(agentId), REVERSE_FILE);
export const SPEC_DOCS = { intent: intentPath, spec: specPath, plan: planPath, designdoc: designPath, benchmark: benchPath, demo: demoPath, debug: debugPath, reverse: reversePath };

// ------------------------------------------------------------------ debug

// Debug: you say what to debug (a failure, instability at scale, slowness under load); the agent
// investigates in its own session and keeps a report at DEBUG.md with animated diagrams of the code
// path and the data flow, what it found with evidence, the likely causes and the fixes it
// recommends. It changes no code until you ask for a fix. The Debug tab shows the report as it grows.

const DEBUG_SHAPE = [
  '# Debug: <short name of the problem>',
  '## Summary',
  'Two or three sentences: what goes wrong, the most likely cause, and how sure you are.',
  '## Symptoms',
  'What is seen and when (scale, load, timing, environment), and how to reproduce it. Only numbers that were measured or given.',
  '## Code path',
  'One ```mermaid flowchart of the path the failing request, job or test takes through the real files and functions, where it breaks marked.',
  '## Data flow',
  'One ```mermaid flowchart LR or sequenceDiagram of the data on that path (payloads, queues, caches, connections, stores): where it grows, waits, is dropped or goes wrong.',
  '## Findings',
  'Numbered. Each with its evidence (file:line, a log line, a metric, or a command and its output) and "confirmed" (reproduced or measured) or "suspected".',
  '## Root cause',
  'The causes, most likely first, each with a confidence (high, medium, low) and what would confirm or rule it out.',
  '## Recommended fixes',
  'Numbered. Each: the change, where (file and function), effort (S, M, L), the risk, and how to verify it worked.',
  '## Next checks',
  'What to measure or try next, and what you need from the user (logs, numbers, access).',
].join('\n');

const DEBUG_DIAGRAMS =
  'Diagrams: valid Mermaid, at most about 15 nodes each, labels of five words or fewer (quote labels with punctuation, e.g. A["Parse (JSON)"]), no HTML in labels, real names from the code. ' +
  'Animate the path in every flowchart: give its edges ids and animate them, e.g.\n' +
  '    A e1@--> B\n    B e2@-->|"rows"| C\n    e1@{ animate: true }\n    e2@{ animate: true }\n' +
  'Mark where it breaks and what is only suspected: `classDef fault stroke:#ef4444,stroke-width:3px` and `classDef suspect stroke:#f59e0b,stroke-width:3px,stroke-dasharray:4`, then `class X fault` and `class Y suspect`. ' +
  'When timing, concurrency or load is the issue, add a "## Interleaving" section after Data flow with a sequenceDiagram of the order of events that breaks.';

/** The message that starts (or continues) a debug investigation in the agent's session. */
export function debugPrompt(file, question, { again = false } = {}) {
  const q = String(question ?? '').trim();
  if (again) {
    return (
      `Debug, continued: ${q}\n` +
      `Carry on the investigation and bring the report at ${file} up to date: same sections, diagrams redrawn where the picture changed, findings re-marked confirmed or suspected. ` +
      'Still no changes to the repository code unless I ask for a fix. Answer me here in a few lines, and say what changed in the report.'
    );
  }
  return (
    `Debug this: ${q}\n` +
    'Investigate before proposing anything: read the code on the path, the logs and the tests; reproduce it if you can (run the failing test, a small load or a script), and measure instead of guessing. ' +
    'Do not change the repository code yet: instrumentation or reproduction scripts go outside the repository or are reverted when you are done. ' +
    'If you need facts only I have (the environment, the scale it fails at, logs), ask me here in a line or two, but first write what you can.\n' +
    `Keep a report at ${file} (Markdown; the file is outside the repository: never copy it in or commit it). Write a first version as soon as you have the code path, and update it as you learn. Short and specific, in these sections:\n` +
    `${DEBUG_SHAPE}\n${DEBUG_DIAGRAMS}\n` +
    'When the report is written, tell me in a few lines what you found and which fix you recommend first.'
  );
}

/** The message that asks for the report's fixes to be made. */
export function debugFixPrompt(file, which) {
  const w = String(which ?? '').trim();
  return (
    `Apply the fixes from your debug report at ${file}: ${w || 'the ones you recommend, the safest first'}.\n` +
    'Make each change, then verify it the way the report says (run the test, the reproduction or the load again) and compare with what you measured before. ' +
    'Then update the report: add a "## Fixes applied" section (what changed, where, and the result before and after), and re-mark the findings. If a fix does not hold up, revert it and say why.'
  );
}

// ------------------------------------------------------------------ reverse engineering

// Reverse engineer: you name a target (an app's folder, a binary, a website) and what you want to
// understand about it; the agent investigates in its own session with REA's tools (the "Reverse
// Engineer Anything" MCP server, github.com/morluto/rea) and keeps a report at REVERSE.md: how the
// feature works with animated diagrams, the evidence behind each claim, what could not be
// determined, and a plan for building your own version. It changes nothing until you ask it to build.

const REVERSE_SHAPE = [
  '# Reverse engineering: <the feature> in <the target>',
  '## Summary',
  'Two or three sentences: how it works, and how sure you are.',
  '## Target',
  'What it is (name, version, platform), what kind (Electron or JavaScript app, native binary, .NET assembly, website), and which tools and providers you used on it.',
  '## How it works',
  'One ```mermaid flowchart of the path the feature takes through the real modules, functions or components you found, from what the user does to the result.',
  '## Data and interfaces',
  'One ```mermaid flowchart LR or sequenceDiagram of the data on that path: what is stored and where, formats, the calls between processes, and the network requests. Then a short list of the formats and endpoints by name.',
  '## Findings',
  'Numbered. Each with its evidence (a module or file path, a function or symbol, an address, a string, a request) and "confirmed" (seen directly) or "inferred" (reasoned from what was seen).',
  '## What could not be determined',
  'What is obfuscated, missing, server-side or out of reach of the tools you had, and what would be needed to find out.',
  '## Build it',
  'A plan for our own version in this project, from the behaviour described above: the pieces, where they go in this codebase, the order, effort (S, M, L) for each, and what to do differently or better. No code, text or assets taken from the target.',
  '## Next checks',
  'What to look at next, and what you need from the user (another build of the app, a sample file, an account).',
].join('\n');

const REVERSE_DIAGRAMS =
  'Diagrams: valid Mermaid, at most about 15 nodes each, labels of five words or fewer (quote labels with punctuation, e.g. A["Parse (JSON)"]), no HTML in labels, real names from the target. ' +
  'Animate the path in every flowchart: give its edges ids and animate them, e.g.\n' +
  '    A e1@--> B\n    B e2@-->|"rows"| C\n    e1@{ animate: true }\n    e2@{ animate: true }\n' +
  'Mark what is only inferred: `classDef inferred stroke:#f59e0b,stroke-width:3px,stroke-dasharray:4`, then `class Y inferred`; and what could not be seen: `classDef unknown stroke:#9ca3af,stroke-dasharray:2`, then `class Z unknown`.';

const REVERSE_RULES =
  'Rules: this is for understanding how something works so we can build our own. Analyse only: do not modify, patch or redistribute the target, and do not change this repository yet. ' +
  'Do not work on getting around licence checks, copy protection, sign-in or other access controls, and do not collect credentials, keys or personal data you come across: if that is what is asked, or the only way forward, stop and tell me. ' +
  'Say what you saw, not what you assume: every claim in the report names its evidence.';

/** The message that starts (or continues) a reverse-engineering investigation in the agent's session. */
export function reversePrompt(file, { target = '', question = '', again = false } = {}) {
  const q = String(question ?? '').trim();
  const t = String(target ?? '').trim();
  if (again) {
    return (
      `Reverse engineering, continued: ${q}${t ? `\nTarget: ${t}` : ''}\n` +
      `Carry on and bring the report at ${file} up to date: same sections, diagrams redrawn where the picture changed, findings re-marked confirmed or inferred. ` +
      'Still analysis only, and no changes to this repository unless I ask you to build. Answer me here in a few lines, and say what changed in the report.'
    );
  }
  return (
    `Reverse engineer this: ${q}\nTarget: ${t}\n` +
    "Use REA's tools (the \"Reverse Engineer Anything\" MCP server) to inspect the target: start with what kind of target it is, then follow the feature from what the user does down to the code and data behind it. " +
    "If REA's tools are not available in this session, say so in one line and stop: it is set up with `npx rea-agents setup` (which I run myself, then restart this session); do not install it or anything else yourself. " +
    'For a native binary REA needs a provider (Hopper, Ghidra, IDA or Kuna): if none is configured, say which is missing rather than guessing from strings alone.\n' +
    `${REVERSE_RULES}\n` +
    `Keep a report at ${file} (Markdown; the file is outside the repository: never copy it in or commit it). Write a first version as soon as you know the shape of the target, and update it as you learn. Short and specific, in these sections:\n` +
    `${REVERSE_SHAPE}\n${REVERSE_DIAGRAMS}\n` +
    'When the report is written, tell me in a few lines how it works and what you could not determine.'
  );
}

/** The message that asks for our own version to be built from the report. */
export function reverseBuildPrompt(file, what) {
  const w = String(what ?? '').trim();
  return (
    `Build our own version from your reverse-engineering report at ${file}: ${w || 'the plan under "Build it", the smallest useful piece first'}.\n` +
    'Write it from the behaviour the report describes, in this project\'s own style: copy no code, text, names of internal symbols or assets from the target, and add no dependency on it. ' +
    'Add tests for the behaviour, run them, and where the report says the target does something badly, do it better. ' +
    'Then update the report: add a "## Built" section (what was built, where, how it was verified, and what differs from the target on purpose).'
  );
}

/** INTENT.md: the request as given, and where it came from. */
export function intentMarkdown(agent) {
  const by = agent.startedBy ? 'the assistant' : agent.trigger ? (agent.trigger.source === 'github' ? 'a labeled GitHub issue' : 'a webhook') : agent.playbook ? `the playbook ${agent.playbook.name}` : agent.team ? `team ${agent.team.id} (${agent.team.role})` : agent.raceId ? `race ${agent.raceId}` : 'you';
  const out = [`# Intent: ${agent.name}`, ''];
  if (agent.synopsis?.text) out.push(`**${agent.synopsis.source === 'jira' ? `${agent.synopsis.key}: ` : ''}${agent.synopsis.text}**`, '');
  out.push('## Request', '', agent.intent || '(none)', '');
  const ctx = [
    `- Started by: ${by}${agent.trigger?.url ? ` (${agent.trigger.url})` : ''}`,
    agent.repo || agent.requestedDir ? `- Where: ${agent.repo || agent.requestedDir}${agent.base ? ` (from ${agent.base})` : ''}` : null,
    agent.engine ? `- Engine: ${agent.engine}${agent.model ? ` (${agent.model})` : ''}` : null,
    `- Created: ${agent.createdAt}`,
  ].filter(Boolean);
  out.push('## Context', '', ...ctx, '');
  return out.join('\n');
}

/** The agent's instructions for SPEC.md and PLAN.md (the plan only when the plan review isn't on). */
export const specPrompt = (specFile, planFile, { withPlan = true } = {}) =>
  `Before you change any code, write a short spec of the task to ${specFile} (Markdown), so reviewers (people and other agents) ` +
  'can check the work against it:\n# Spec: <short name>\n## Requirements\nWhat must be true when it is done, as a list.\n' +
  '## Acceptance criteria\nHow each requirement is checked: a command, a test or an observable behavior.\n## Out of scope\n## Open questions\n' +
  (withPlan
    ? `Then write your plan to ${planFile}: "# Plan: <short name>", then "## Steps" as a task list ("- [ ]" to do, "- [x]" done), ` +
      'small enough to check, and "## Files to change". Keep both current: tick steps as you finish them, and update the spec ' +
      'if the requirements change (say why). Do not stop to wait for approval; carry on with the work. '
    : 'Keep it current if the requirements change (say why). ') +
  'Both files are outside the repository: never copy them into the repo or commit them.';

/**
 * The agent's instructions for DESIGN.md: a short design doc once the plan is settled, published as a
 * claude.ai Artifact with the agent's own tool, and brought up to date when it's done. (Google Drive
 * is the person's choice: Publish to Google Drive takes all the agent's documents there.)
 */
export const designDocPrompt = (file, { afterApproval = false } = {}) =>
  `Once your plan is settled${afterApproval ? ' and approved' : ''}, before most of the code changes, write a design doc to ${file} (Markdown) and publish it. ` +
  'Keep it precise and simple, about 300-700 words: architecture, design and data flow only. Do not repeat the spec, plan or brief, ' +
  'and no filler, history or restated requirements. Use these sections:\n' +
  '# Design: <short name>\n## Summary\nTwo or three sentences: what is built and the key decision.\n' +
  '## Architecture\nOne ```mermaid flowchart of the components and how they connect, with what this work adds or changes marked; then a few bullets.\n' +
  '## Design\nThe components, interfaces and data that change, as short bullets. Add one classDiagram or erDiagram only if types or data change in a way bullets cannot show.\n' +
  '## Data flow\nOne ```mermaid flowchart LR or sequenceDiagram of the main path.\n' +
  '## Decisions and risks\nBullets: what was chosen over what and why; the main risks.\n' +
  'Diagrams: valid Mermaid, at most about 12 nodes each, short labels (quote labels with punctuation).\n' +
  'Always write and publish it, even for a small or one-line change (then keep it short); this is not optional and not your call to skip. ' +
  'Publish it without asking, and without waiting for the user, as a claude.ai Artifact with your Artifact tool: a page that renders ' +
  'the Markdown and draws the Mermaid diagrams. Then add its link to the References section of your brief (add the section if it is not there): ' +
  '"- **Design page**: [Artifact](<url>)". Do not publish it anywhere else; the user publishes to Google Drive from AI Agent Manager.\n' +
  `When the work is done, before you set the brief's status to done, bring ${file} up to date with what was actually built (same length limits) ` +
  'and republish the Artifact to the same URL. If the Artifact tool is missing or fails, say so in one line instead of the link ' +
  '("- **Design page**: not published: <why>"; only for a missing or failing tool, never because the change is small) and carry on; never hold up the task for it. ' +
  'The file is outside the repository: never copy it into the repo or commit it.';

export const demoPagePrompt = (file) =>
  `When the change works (tests pass), make a sample demo page of it at ${file}: one self-contained HTML file ` +
  '(CSS and JavaScript inline; no requests to other sites; under about 300 KB) that shows what this work does with realistic sample data. ' +
  'Open with one line on what changed, then show it: for a library, API or CLI, runnable examples with sample inputs and the output you actually got ' +
  'by running them (a small try-it form where the logic can run in the page); for a UI change, the changed screen rebuilt with sample data, ' +
  'or screenshots you took embedded as data: URLs; for a fix, before and after. Never invent output or numbers. No filler, no repeat of the spec. ' +
  'Publish it without asking, as a claude.ai Artifact with your Artifact tool, and add its link to the References section of your brief: ' +
  '"- **Demo page**: [Artifact](<url>)". If you change the work later, update the file and republish to the same URL. ' +
  'If the Artifact tool is missing or fails, write "- **Demo page**: not published: <why>" instead and carry on; never hold up the task for it. ' +
  'The file is outside the repository: never copy it into the repo or commit it.';

export const benchmarksPrompt = (file, dir) =>
  'Measure the speed of the code this task changes with micro benchmarks, once the change works (tests pass). ' +
  'If the repository already has a benchmark setup (a bench or benchmarks folder, go test -bench, pytest-benchmark, JMH, criterion, ' +
  `vitest bench, Benchmark.js, hyperfine and the like), add yours there in its style; otherwise put the scripts in ${dir}, outside the repository, never committed. ` +
  'Benchmark the changed functions directly with realistic sample inputs at two or three sizes; warm up, run enough iterations for stable numbers, ' +
  'and take the median and the spread (p95 or ±%). Run the same benchmark on the base commit (check it out in a temporary git worktree) ' +
  `and on your change, back to back on this machine. Write the results to ${file} (Markdown), short:\n` +
  '# Benchmark: <short name>\n## What was measured\nThe functions, inputs and sizes, and the command to run it again.\n' +
  '## Results\nA table: case | before | after | change.\n## Environment\nCPU, OS, runtime and version.\n' +
  '## Notes\nAnything noisy or surprising. A slowdown over 5% gets a line on why, or a fix.\n' +
  'Run them again if you change the code afterwards. Only real measurements: never estimate a number. ' +
  'The file is outside the repository: never copy it into the repo or commit it.';

/** One of the agent's files (intent, spec, plan, design doc): its Markdown and when it changed, or null. */
export function readSpecDoc(agentId, name) {
  const file = SPEC_DOCS[name]?.(agentId);
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    return { name, path: file, markdown: fs.readFileSync(file, 'utf8').slice(0, 200_000), updatedAt: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** Which of the three exist, and when they changed (for the page's buttons). */
export function specDocsInfo(agentId) {
  const out = {};
  for (const [name, fn] of Object.entries(SPEC_DOCS)) {
    try {
      out[name] = fs.statSync(fn(agentId)).mtime.toISOString();
    } catch {}
  }
  return out;
}

/** The pull request description's sections: the intent in full, the spec, plan and design doc folded. */
export function prSections(agentId, read = (n) => readSpecDoc(agentId, n)?.markdown) {
  const doc = (n) => read(n)?.trim();
  // Demote the files' own headings under the description's.
  const demote = (md) => md.replace(/^(#{1,4}) /gm, '#$1 ').replace(/^## (Intent|Spec|Plan|Design|Benchmark): .*\n+/m, '');
  const parts = [];
  const intent = doc('intent');
  if (intent) parts.push('## Intent', '', demote(intent), '');
  for (const [name, label] of [['spec', 'Spec'], ['plan', 'Plan'], ['designdoc', 'Design'], ['benchmark', 'Benchmark']]) {
    const md = doc(name);
    if (md) parts.push(`<details><summary><b>${label}</b></summary>`, '', demote(md), '', '</details>', '');
  }
  return parts.length ? [...parts, `<sub>Intent, spec${doc('designdoc') ? ', plan and design doc' : ' and plan'} kept by AI Agent Manager.</sub>`].join('\n') : '';
}
