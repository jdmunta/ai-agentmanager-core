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
  if (next.site && !/^https:\/\/[\w.-]+(:\d+)?(\/[\w.~-]+)*$/.test(next.site)) throw Object.assign(new Error('The Jira site is an https address, like https://yourcompany.atlassian.net (or https://jira.yourcompany.com:8443/jira)'), { status: 400 });
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

// Why the last call to your Jira site failed ({ at, reason }), or null when it worked: shown in
// the Jira list and Today, since an empty list alone doesn't say whether Jira was reached.
let problem = null;

/** Why your Jira site couldn't be used last time, or null. */
export const jiraProblem = () => problem;

/** Basic with the email and API token (Jira Cloud); a bearer token without an email (Server, Data Center). */
const authOf = (jira) => (jira.email ? `Basic ${Buffer.from(`${jira.email}:${jira.token}`).toString('base64')}` : `Bearer ${jira.token}`);

/** The reason in words for an answer that isn't ok, or a fetch that threw. */
function reasonOf(site, res, e) {
  if (res) {
    if (res.status >= 300 && res.status < 400) return `${site} sent the request on to ${res.movedTo ?? 'another address'} (a sign-in page?): put your Atlassian address (https://yourcompany.atlassian.net) in Settings → Jira`;
    const why = {
      401: 'the email or API token is not accepted (Settings → Jira)',
      403: 'no permission; if you mistyped the token a few times, Jira may want you to sign in once in the browser',
      404: 'no Jira API at that address (is the site right?)',
      issue404: 'no such issue, or the account in Settings can\'t see it (is the email the one you sign in to Jira with?)',
      429: 'too many requests; trying again later',
    }[res.forIssue && res.status === 404 ? 'issue404' : res.status];
    return `${site} answered ${res.status}${res.forIssue ? ` for ${res.forIssue}` : ''}${why ? `: ${why}` : ''}`;
  }
  const m = String(e?.cause?.message ?? e?.message ?? e ?? '');
  if (e?.name === 'TimeoutError' || /abort|timeout/i.test(m)) return `${site} did not answer in time (VPN off?)`;
  if (/redirect/i.test(m)) return `${site} sent a sign-in page instead of an answer (the site address may be wrong, or it needs single sign-on)`;
  return `couldn't reach ${site}: ${m || 'network error'}`;
}

/**
 * Jira Cloud's API (v3), then the older one (v2) that Jira Server and Data Center have when v3
 * isn't there. Returns the response, or throws.
 */
async function jiraGet(fetchImpl, site, v3, v2, init) {
  const res = await follow(fetchImpl, `${site}${v3.path}`, { ...init, ...v3.init });
  if (res.status !== 404 || !v2) return res;
  return follow(fetchImpl, `${site}${v2.path}`, { ...init, ...v2.init });
}

/**
 * A site on its own domain (jira.company.com) may send API calls on to its Atlassian Cloud
 * address: followed once, to the same host or an *.atlassian.net one only, so the token never goes
 * anywhere else. Any other redirect (a sign-in page) comes back as it is.
 */
async function follow(fetchImpl, url, init) {
  const res = await fetchImpl(url, { ...init, redirect: 'manual' });
  if (!(res.status >= 300 && res.status < 400)) return res;
  const where = res.headers?.get?.('location');
  const to = (() => {
    try {
      return where ? new URL(where, url) : null;
    } catch {
      return null;
    }
  })();
  if (!to || to.protocol !== 'https:' || !(to.host === new URL(url).host || /\.atlassian\.net$/.test(to.host))) return Object.assign(res, { movedTo: to?.host ?? null });
  return fetchImpl(to.href, { ...init, redirect: 'manual' });
}

/**
 * Open issues assigned to you on your Jira site (epics too): [{ key, url, summary, status,
 * category, type, synopsis, updated }]. Needs the site and API token from Settings → Jira (and the
 * email, for Jira Cloud); null without them or when Jira can't be reached (jiraProblem() says why).
 * Closed and integrated ones are left out.
 */
export async function assignedIssues({ jira = loadJira(), fetchImpl = fetch, timeoutMs = 10_000, max = 100 } = {}) {
  if (!jira.site || !jira.token) return null;
  const headers = { accept: 'application/json', 'content-type': 'application/json', authorization: authOf(jira) };
  const jql = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
  const fields = ['summary', 'status', 'issuetype', 'description', 'updated'];
  const q = new URLSearchParams({ jql, fields: fields.join(','), maxResults: String(max) });
  try {
    const res = await jiraGet(
      fetchImpl,
      jira.site,
      { path: '/rest/api/3/search/jql', init: { method: 'POST', body: JSON.stringify({ jql, fields, maxResults: max }) } },
      { path: `/rest/api/2/search?${q}`, init: { method: 'GET' } },
      { headers, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) {
      problem = { at: new Date().toISOString(), reason: reasonOf(jira.site, res) };
      return null;
    }
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
    problem = null;
    return out;
  } catch (e) {
    problem = { at: new Date().toISOString(), reason: reasonOf(jira.site, null, e) };
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
 * The issue's summary and workflow status ({ summary, status, category, components, labels }:
 * category is Jira's "new", "indeterminate" or "done"), or null when it can't be had.
 */
export async function issueFields({ key, site }, { jira = loadJira(), fetchImpl = fetch, timeoutMs = 6000, allow = null } = {}) {
  const host = (() => {
    try {
      return new URL(site).host;
    } catch {
      return '';
    }
  })();
  // With your site saved, the issue is asked of it, whatever address the link has: links often use
  // the site's own domain (jira.company.com) while the API is on its Atlassian address, or the
  // other way round. Without one, only public Atlassian Cloud issues are asked for, signed out.
  const configured = Boolean(jira.site && jira.token);
  const allowed = configured || /\.atlassian\.net$/.test(host) || allow?.(site);
  if (!allowed) return null;
  const headers = { accept: 'application/json' };
  if (configured) headers.authorization = authOf(jira);
  const q = `${encodeURIComponent(key)}?fields=summary,status,description,components,labels`;
  try {
    // Your site as saved: it may have a path (https://host/jira) that the link's origin leaves out.
    const res = await jiraGet(fetchImpl, configured ? jira.site : site, { path: `/rest/api/3/issue/${q}` }, configured ? { path: `/rest/api/2/issue/${q}` } : null, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      if (configured) problem = { at: new Date().toISOString(), reason: reasonOf(jira.site, Object.assign(res, { forIssue: key })) };
      return null;
    }
    const f = (await res.json())?.fields ?? {};
    const summary = typeof f.summary === 'string' && f.summary.trim() ? f.summary.trim().slice(0, 300) : null;
    const status = typeof f.status?.name === 'string' ? f.status.name.slice(0, 60) : null;
    if (!summary && !status) return null;
    const synopsis = synopsisOf(f.description);
    // What part of the product it's in: the issue's components and labels.
    const components = (Array.isArray(f.components) ? f.components : []).map((c) => c?.name).filter((n) => typeof n === 'string').map((n) => n.slice(0, 80));
    const labels = (Array.isArray(f.labels) ? f.labels : []).filter((n) => typeof n === 'string').map((n) => n.slice(0, 80));
    return { summary, status, category: typeof f.status?.statusCategory?.key === 'string' ? f.status.statusCategory.key : null, ...(synopsis ? { synopsis } : {}), ...(components.length ? { components } : {}), ...(labels.length ? { labels } : {}) };
  } catch (e) {
    if (configured) problem = { at: new Date().toISOString(), reason: reasonOf(jira.site, null, e) };
    return null;
  }
}
