// Today: what needs you, in one list, most pressing first. It gathers what the other lists already
// know (agents' questions and prompts from the inbox, issues waiting for your review or not started
// in Jira, what's asked of you in Slack and meeting notes, pull requests to review) and says, for
// each, why it's here: "blocks OPS-7", "due today", "assigned to you".

const DAY = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * When a due date said in words falls ("today", "EOD", "tomorrow", "Friday", "2026-11-09",
 * "Nov 9"): the end of that day, or null when it can't be told. `now` is a Date.
 */
export function dueAt(due, now = new Date()) {
  const s = String(due ?? '').trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  if (!s) return null;
  const endOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
  if (/\b(today|tonight|eod|end of (the )?day|asap|now|urgent)\b/.test(s)) return endOf(now);
  if (/\btomorrow\b/.test(s)) return endOf(new Date(now.getTime() + DAY));
  if (/\b(eow|end of (the )?week|this week)\b/.test(s)) return endOf(new Date(now.getTime() + ((5 - now.getDay() + 7) % 7) * DAY));
  if (/\bnext week\b/.test(s)) return endOf(new Date(now.getTime() + ((8 - now.getDay()) % 7 || 7) * DAY + 4 * DAY));
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w.slice(0, 3)}(${w.slice(3)})?\\b`).test(s));
  if (wd >= 0) return endOf(new Date(now.getTime() + ((wd - now.getDay() + 7) % 7) * DAY));
  // A date: ISO, or a month and day (this year; next year when that's long past).
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return endOf(new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  if (!/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(s)) return null;
  const t = Date.parse(`${s.replace(/\b(by|on|before|due)\b/g, '').trim()} ${now.getFullYear()}`);
  if (Number.isFinite(t)) {
    const d = new Date(t);
    return endOf(d.getTime() < now.getTime() - 180 * DAY ? new Date(d.getFullYear() + 1, d.getMonth(), d.getDate()) : d);
  }
  return null;
}

/** "overdue 2 days", "due today", "due tomorrow", "due Friday", or null. */
export function dueWords(at, now = new Date()) {
  if (!at) return null;
  const day = (d) => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY);
  const n = day(at) - day(now);
  if (n < 0) return `overdue ${-n === 1 ? 'a day' : `${-n} days`}`;
  if (n === 0) return 'due today';
  if (n === 1) return 'due tomorrow';
  if (n < 7) return `due ${WEEKDAYS[at.getDay()].replace(/^./, (c) => c.toUpperCase())}`;
  return `due ${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

const INBOX = {
  prompt: { score: 0, label: 'Prompt', why: (i) => `${i.agentName} is stopped until you answer` },
  waiting: { score: 10, label: 'Question', why: (i) => `${i.agentName} waits for your answer` },
  question: { score: 10, label: 'Question', why: (i) => `${i.agentName} asked` },
  review: { score: 35, label: 'AI review', why: (i) => `The AI review of ${i.agentName}'s work is in` },
  stuck: { score: 55, label: 'Stuck', why: (i) => `${i.agentName} looks stuck` },
  conflict: { score: 60, label: 'Overlap', why: (i) => `${i.agentName} and another agent change the same code` },
  rule: { score: 65, label: 'Rule', why: () => 'You keep allowing this' },
  reminder: { score: 70, label: 'Follow-up', why: (i) => `${i.agentName} finished and wasn't looked at` },
};

/**
 * The list: [{ id, kind, label, title, why, score, at, agentId?, url?, actionId?, issueKey?, reviewUrl? }],
 * most pressing first. Each source may be missing (turned off, or it couldn't be had).
 */
export function todayItems({ inbox = [], issues = [], actions = [], reviews = [], now = new Date() } = {}) {
  const items = [];
  // The issue each agent works on: named on its questions, and not listed twice.
  const issueOfAgent = new Map(issues.filter((r) => r.agent?.id).map((r) => [r.agent.id, r]));
  const asking = new Set();
  for (const i of inbox) {
    const k = INBOX[i.kind];
    if (!k) continue;
    const r = i.agentId ? issueOfAgent.get(i.agentId) : null;
    if (r && ['prompt', 'waiting', 'question'].includes(i.kind)) asking.add(r.key);
    const about = !r?.title ? '' : i.agentName === r.key ? ` · ${r.title}` : ` · ${r.key}: ${r.title}`;
    items.push({ id: i.key, kind: i.kind, label: k.label, title: String(i.title ?? '').slice(0, 300), why: k.why(i) + about, score: k.score + (i.priority ?? 2) / 10, at: i.at ?? null, agentId: i.agentId ?? null, ...(r ? { url: r.url ?? null, issueKey: r.key } : {}) });
  }
  for (const r of issues) {
    if (asking.has(r.key)) continue;
    const title = r.title ? `${r.key}: ${r.title}` : r.key;
    if (r.group === 'you') {
      items.push({ id: `issue:${r.key}`, kind: 'issue-review', label: 'Jira', title, why: r.note, score: 25, at: r.updatedAt ?? null, agentId: r.agent?.id ?? null, url: r.url ?? null, issueKey: r.key });
    } else if (r.group === 'new') {
      items.push({ id: `issue:${r.key}`, kind: 'issue-new', label: r.type && !/^(story|task|bug|sub-?task)$/i.test(r.type) ? r.type : 'Jira', title, why: r.stage === 'assigned' ? 'Assigned to you in Jira, not started' : 'Proposed for an agent, not started', score: 50, at: r.updatedAt ?? null, url: r.url ?? null, issueKey: r.key });
    }
  }
  for (const a of actions) {
    if (a.group !== 'open') continue;
    const at = dueAt(a.due, now);
    const words = dueWords(at, now);
    const late = at && at.getTime() < now.getTime();
    const soon = at && !late && at.getTime() - now.getTime() < DAY;
    const score = late ? 15 : soon ? 20 : at ? 40 + Math.min(9, (at.getTime() - now.getTime()) / DAY) : 45;
    const why = [words ?? (a.due ? `due ${a.due}` : null), a.from && `asked by ${a.from}`, a.sourceLabel && `in ${a.sourceLabel}`].filter(Boolean).join(' · ');
    items.push({ id: `action:${a.id}`, kind: 'action', label: 'Action', title: a.text, why: why || 'Asked of you', score, at: a.when ?? null, url: a.link ?? null, actionId: a.id, due: at?.toISOString() ?? null });
  }
  for (const r of reviews) {
    const title = `${r.pr.repo ?? ''}#${r.pr.number ?? '?'} ${r.pr.title ?? ''}`.trim();
    if (r.status === 'requested') {
      items.push({ id: `pr:${r.pr.url}`, kind: 'pr-requested', label: 'Review', title, why: `Your review was requested${r.pr.author ? ` by ${r.pr.author}` : ''}`, score: 30, at: r.updatedAt ?? null, url: r.pr.url, reviewUrl: r.pr.url });
    } else if (r.agent && r.review && !r.posted && r.pr.state !== 'MERGED' && r.pr.state !== 'CLOSED') {
      const verdict = { blocked: 'blocks approval', approve_with_nits: 'approve with nits', approve: 'approve' }[r.status] ?? r.status;
      items.push({ id: `pr:${r.pr.url}`, kind: 'pr-ready', label: 'Review', title, why: `${r.agent.name}'s review is ready to post: ${verdict}${r.stale ? ' (the author pushed since)' : ''}`, score: 32, at: r.updatedAt ?? null, agentId: r.agent.id, url: r.pr.url, reviewUrl: r.pr.url });
    }
  }
  return items.sort((x, y) => x.score - y.score || String(y.at ?? '').localeCompare(String(x.at ?? '')));
}

/** What the list says aloud: a count, then the first `max` items one by one. */
export function todaySpeech(items, max = 8) {
  if (!items.length) return ['Nothing needs you right now.'];
  const parts = [`${items.length} thing${items.length === 1 ? '' : 's'} for you today.${items.length > max ? ` The first ${max}:` : ''}`];
  // Read as sentences: a link is "a link", "·" a comma, and no doubled stops ("?.").
  const say = (t) => String(t ?? '').replace(/https?:\/\/\S+/g, 'a link').replace(/\s+·\s+/g, ', ').trim().replace(/[.?!:;,]*$/, (m) => m || '.');
  items.slice(0, max).forEach((it, i) => parts.push(`${i + 1}. ${it.label}. ${say(it.title)} ${say(it.why)}`));
  return parts;
}

const ASIDE = { skip: 'Skipped', done: 'Done', remove: 'Removed' };

/**
 * What you set aside from Today's lists (skipped, done, removed), newest first, so any of it can be
 * brought back: [{ id, kind: 'issue' | 'action', state, label, title, at, issueKey?, actionId? }].
 */
export function todayAside({ issues = [], actions = [], max = 50 } = {}) {
  const out = [];
  for (const r of issues) {
    if (!ASIDE[r.action]) continue;
    out.push({ id: `issue:${r.key}`, kind: 'issue', state: r.action, label: ASIDE[r.action], title: r.title ? `${r.key}: ${r.title}` : r.key, at: r.actionAt ?? r.updatedAt ?? null, issueKey: r.key });
  }
  for (const a of actions) {
    if (!ASIDE[a.status]) continue;
    out.push({ id: `action:${a.id}`, kind: 'action', state: a.status, label: ASIDE[a.status], title: a.text, at: a.updatedAt ?? null, actionId: a.id });
  }
  return out.sort((x, y) => String(y.at ?? '').localeCompare(String(x.at ?? ''))).slice(0, max);
}
