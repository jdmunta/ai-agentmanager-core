// The summary of the Jira issue a request starts with, so an agent created from a link shows what
// the issue is about instead of the link. Fetched from Jira Cloud's REST API in the background;
// when it can't be fetched, the words after the link stand in for it.
//
// Only Atlassian Cloud sites (*.atlassian.net) and the site set here are contacted, and the email
// and API token go only to that site: requests can come from outside (GitHub issues, the
// assistant), and a link in one must not receive your token or reach internal addresses.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { leadingJiraKey } from './tracker.js';

const file = () => path.join(paths.home, 'jira.json');

/** Saved settings ({ site, email, token }), with JIRA_SITE / JIRA_EMAIL / JIRA_API_TOKEN as fallbacks. */
export function loadJira(env = process.env) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {}
  return {
    site: normSite(saved.site || env.JIRA_SITE || ''),
    email: saved.email || env.JIRA_EMAIL || '',
    token: saved.token || env.JIRA_API_TOKEN || '',
  };
}

/** What the page shows: never the token itself. */
export const jiraView = (j = loadJira()) => ({ site: j.site, email: j.email, hasToken: Boolean(j.token) });

/** Save settings; an empty token keeps the saved one unless `clearToken`. */
export function saveJira({ site, email, token, clearToken = false } = {}) {
  const cur = (() => {
    try {
      return JSON.parse(fs.readFileSync(file(), 'utf8'));
    } catch {
      return {};
    }
  })();
  const next = {
    site: site === undefined ? cur.site ?? '' : normSite(site),
    email: email === undefined ? cur.email ?? '' : String(email).trim(),
    token: clearToken ? '' : token ? String(token).trim() : cur.token ?? '',
  };
  if (next.site && !/^https:\/\/[\w.-]+$/.test(next.site)) throw Object.assign(new Error('The Jira site is an https address, like https://yourcompany.atlassian.net'), { status: 400 });
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return jiraView(loadJira());
}

function normSite(s) {
  const v = String(s ?? '').trim().replace(/\/+$/, '');
  if (!v) return '';
  return /^https?:\/\//.test(v) ? v : `https://${v}`;
}

/** The issue a request starts with: { key, site } from its leading link, or null. */
export function leadingIssue(text) {
  const key = leadingJiraKey(text);
  if (!key) return null;
  const url = String(text).trimStart().match(/^<?(https?:\/\/\S+)/)[1];
  try {
    return { key, site: new URL(url).origin };
  } catch {
    return null;
  }
}

/** The person's own words after the leading link ("…/browse/ABC-1 fix the timeout" → "fix the timeout"). */
export function wordsAfterLink(text) {
  const rest = String(text ?? '').trimStart().replace(/^<?https?:\/\/\S+>?/, '').trim();
  return rest.replace(/^[-:–—,\s]+/, '').split('\n')[0].trim().slice(0, 200) || null;
}

// Statuses that mean the work is over, whatever category a workflow puts them in.
const FINISHED = /^(closed|done|resolved|integrated|cancell?ed|won'?t (do|fix)|duplicate|rejected)$/i;

/**
 * Open issues assigned to you on your Jira site (epics too): [{ key, url, summary, status,
 * category, type, synopsis, updated }]. Needs the site, email and API token from Settings → Jira;
 * null without them or when Jira can't be reached. Closed and integrated ones are left out.
 */
export async function assignedIssues({ jira = loadJira(), fetchImpl = fetch, timeoutMs = 10_000, max = 100 } = {}) {
  if (!jira.site || !jira.email || !jira.token) return null;
  const headers = { accept: 'application/json', 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${jira.email}:${jira.token}`).toString('base64')}` };
  const body = JSON.stringify({ jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC', fields: ['summary', 'status', 'issuetype', 'description', 'updated'], maxResults: max });
  try {
    const res = await fetchImpl(`${jira.site}/rest/api/3/search/jql`, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const out = [];
    for (const i of (await res.json())?.issues ?? []) {
      const f = i?.fields ?? {};
      const status = typeof f.status?.name === 'string' ? f.status.name.slice(0, 60) : null;
      if (typeof i.key !== 'string' || !/^[A-Z][A-Z0-9_]+-\d+$/.test(i.key) || (status && FINISHED.test(status))) continue;
      const synopsis = synopsisOf(f.description);
      out.push({
        key: i.key,
        url: `${jira.site}/browse/${i.key}`,
        summary: typeof f.summary === 'string' ? f.summary.trim().slice(0, 300) : null,
        status,
        category: typeof f.status?.statusCategory?.key === 'string' ? f.status.statusCategory.key : null,
        type: typeof f.issuetype?.name === 'string' ? f.issuetype.name.slice(0, 40) : null,
        ...(synopsis ? { synopsis } : {}),
        updated: typeof f.updated === 'string' ? f.updated : null,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** The text of a Jira description: Atlassian document format (API v3), or plain text. */
export function descriptionText(d) {
  if (typeof d === 'string') return d;
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
    else if (n.type === 'hardBreak') out.push(' ');
    // Code is how, not what: left out of the synopsis.
    if (n.type === 'codeBlock') return;
    for (const c of Array.isArray(n.content) ? n.content : []) walk(c);
    if (/^(paragraph|heading|listItem|blockquote|tableCell)$/.test(n.type)) out.push('\n');
  };
  walk(d);
  return out.join('');
}

/** What an issue is about in a sentence or two, from its description; null when it has none. */
export function synopsisOf(description, max = 280) {
  const text = descriptionText(description)
    .split('\n')
    .map((l) => l.trim())
    // Jira's wiki markup and template headings carry no meaning on their own.
    .filter((l) => l && !/^(h\d\.|\{code|\*?(description|summary|acceptance criteria|steps to reproduce)\*?:?$)/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > max / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max).trim()}…`;
}

/**
 * The issue's summary, or null when it can't be had (not a site we contact, no access, offline).
 * `fetchImpl` and `allow` are for tests.
 */
export async function issueSummary(issue, opts = {}) {
  return (await issueFields(issue, opts))?.summary ?? null;
}

/**
 * The issue's summary and workflow status ({ summary, status, category }: category is Jira's
 * "new", "indeterminate" or "done"), or null when it can't be had.
 */
export async function issueFields({ key, site }, { jira = loadJira(), fetchImpl = fetch, timeoutMs = 6000, allow = null } = {}) {
  const host = (() => {
    try {
      return new URL(site).host;
    } catch {
      return '';
    }
  })();
  const configured = jira.site && new URL(jira.site).host === host;
  const allowed = configured || /\.atlassian\.net$/.test(host) || allow?.(site);
  if (!allowed) return null;
  const headers = { accept: 'application/json' };
  if (configured && jira.email && jira.token) headers.authorization = `Basic ${Buffer.from(`${jira.email}:${jira.token}`).toString('base64')}`;
  try {
    const res = await fetchImpl(`${site}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,description`, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const f = (await res.json())?.fields ?? {};
    const summary = typeof f.summary === 'string' && f.summary.trim() ? f.summary.trim().slice(0, 300) : null;
    const status = typeof f.status?.name === 'string' ? f.status.name.slice(0, 60) : null;
    if (!summary && !status) return null;
    const synopsis = synopsisOf(f.description);
    return { summary, status, category: typeof f.status?.statusCategory?.key === 'string' ? f.status.statusCategory.key : null, ...(synopsis ? { synopsis } : {}) };
  } catch {
    return null;
  }
}
