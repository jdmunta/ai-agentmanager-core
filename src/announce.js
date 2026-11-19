// Announce: what to tell the people who asked for the work, once an agent has something to show
// (a pull request opened) or is finished. One tool-less model call writes three things from the
// agent's live context: a short Slack message, a short email, and the details as a document both
// point to. They are drafts: you read them, change them and send them. Nothing here writes to a
// person by itself.

/** The parts of the document, in order, as the model is told to write them and as they are read back. */
const PARTS = ['Slack', 'Email', 'Details'];

export const announceSettings = (config = {}) => ({ auto: config.announce?.auto !== false });

/**
 * What stage the work is at, for the wording: finished, something to show, or under way. From
 * what is tracked, not from what the agent says about itself in passing.
 */
/** Finished: its brief says so, in its status or in its results. */
const done = (v) => v.brief?.status === 'done' || v.results?.outcome === 'done';

export function stageOf(v) {
  const prs = (v.prs ?? []).filter((p) => p.source !== 'mentioned');
  if (done(v) || (prs.length && prs.every((p) => p.state === 'MERGED'))) return 'finished';
  if (prs.some((p) => p.state === 'OPEN' || p.state === 'MERGED')) return 'ready for review';
  return 'in progress';
}

/** The moments an update is prepared for by itself: finished, and each pull request it opens. */
export function milestonesOf(v) {
  const out = [];
  for (const p of v.prs ?? []) if (p.source !== 'mentioned' && p.url && ['OPEN', 'MERGED'].includes(p.state)) out.push(`pr:${p.url}`);
  if (done(v)) out.push('done');
  return out;
}

export function updatePrompt({ intent, status, digest, repo, briefMarkdown, stage = 'in progress' }) {
  return [
    'Write an update for the people who asked for a piece of software work: the requester and other stakeholders. They did not follow the work and may not read code.',
    `The work is ${stage}. Base everything only on the context below: the original ask, the conversation and actions, the repository changes and the brief.`,
    'Write as the person responsible for the work, in the first person plural or neutral ("This is done", "We changed…"). No mention of an AI agent, its tools or this prompt.',
    '',
    'Output Markdown with exactly these three level-2 sections, in this order, and nothing before the first:',
    '',
    '## Slack',
    'A message to paste into Slack: at most 5 lines of under 100 characters each, plain text. First line: what this is about and where it stands (finished, ready for review, in progress), in a few words. Then what was done, what is left or needed from the reader (a review, a decision, nothing), each in one line. No headings, no tables, no greeting, no sign-off, no links.',
    '',
    '## Email',
    'First line exactly "To: <the name of whoever asked, if the context says; otherwise leave empty>". Second line "Subject: <under 70 characters, saying what and where it stands>". Then an empty line and the body in plain text: a one-line greeting ("Hi <first name>," or "Hi,"), then 3 to 6 short sentences or bullets ("- ") covering what was asked, what was done, the status, and what is needed from the reader with any date the context gives. No signature, no links.',
    '',
    '## Details',
    'The full write-up the two messages point to, in Markdown, with these level-3 headings: "### What was asked", "### What was done" (specific: components, behaviour, pull requests by number and tickets by key), "### Status" (what is finished, tested, merged or released, and what is not), "### What is left" (or "Nothing."), "### Decisions and risks" (what needs a decision or could go wrong; or "None."), "### Links" (the pull requests, tickets and documents in the context, as a list).',
    '',
    'Rules:',
    '- Say only what the context supports. Where it does not say, write "To be confirmed" in Details and leave it out of the two messages.',
    '- Plain words for a reader outside the team: what changes for users or the business before how it was built. No file paths in the two messages.',
    '- Do not claim more than was checked: "tests pass" only if the context shows them passing, "released" only if it was.',
    '- The two messages stand on their own and do not repeat each other word for word; Details is 150 to 500 words.',
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
  ].join('\n');
}

/**
 * The written update taken apart: { slack, to, subject, email, details }. A part the model left
 * out is an empty string; a reply with none of them is all Details, so nothing written is lost.
 */
export function parseUpdate(markdown) {
  const text = String(markdown ?? '').replace(/\r\n/g, '\n');
  const parts = {};
  const heads = [...text.matchAll(/^##[ \t]+(Slack|Email|Details)\b[^\n]*\n/gim)];
  heads.forEach((m, i) => {
    const name = PARTS.find((p) => p.toLowerCase() === m[1].toLowerCase());
    parts[name] ??= text.slice(m.index + m[0].length, heads[i + 1]?.index ?? text.length).trim();
  });
  if (!heads.length) return { slack: '', to: '', subject: '', email: '', details: text.trim() };
  let email = parts.Email ?? '';
  const line = (label) => {
    const m = new RegExp(`^\\**${label}:\\**[ \\t]*(.*)$`, 'im').exec(email);
    if (!m) return '';
    email = (email.slice(0, m.index) + email.slice(m.index + m[0].length)).trim();
    return m[1].replace(/^[<(\[]|[>)\]]$/g, '').trim();
  };
  const to = line('To');
  const subject = line('Subject');
  // A fenced block around a message is the model being careful, not part of the message.
  const bare = (s) => s.replace(/^```\w*\n([\s\S]*?)\n```$/m, '$1').trim();
  return { slack: bare(parts.Slack ?? ''), to: /^(to be confirmed|unknown|none|n\/a|-)?$/i.test(to) ? '' : to, subject, email: bare(email), details: parts.Details ?? '' };
}

/** A message with the link to the details under it, when there is one. */
export const withLink = (text, link) => (link ? `${text.trim()}\n\nDetails: ${link}` : text.trim());

/**
 * Prepares an update by itself when an agent reaches a moment worth telling: it finished, or it
 * opened a pull request. Only moments seen to happen while this runs count: what was already so
 * when the daemon started (or when updates were turned on) is not announced after the fact.
 */
export class Announcer {
  /** `prepare(agentId, milestone)` writes the update and resolves when it is there. */
  constructor({ manager, config = {}, prepare, log = () => {} }) {
    Object.assign(this, { manager, config, prepare, log });
    this.seen = new Map(); // agent id -> the milestones it had already reached
    manager.on('change', (a) => this.observe(a));
  }

  get settings() {
    return announceSettings(this.config);
  }

  change(b = {}) {
    if (typeof b.auto !== 'boolean') throw Object.assign(new Error('auto is true or false'), { status: 400 });
    this.config.announce = { ...this.config.announce, auto: b.auto };
    return this.config.announce;
  }

  observe(a) {
    if (!a?.id || ['general', 'assistant'].includes(a.kind) || a.hunting || a.reviewing) return;
    const now = milestonesOf(a);
    const before = this.seen.get(a.id);
    this.seen.set(a.id, new Set([...(before ?? []), ...now]));
    if (!before || !this.settings.auto) return;
    const fresh = now.filter((m) => !before.has(m));
    if (!fresh.length) return;
    // Finished says more than the pull request that came with it: one update for both.
    const milestone = fresh.includes('done') ? 'done' : fresh.at(-1);
    this.prepare(a.id, milestone).catch((e) => this.log(`update for ${a.name}: ${e.message.slice(0, 160)}`));
  }
}
