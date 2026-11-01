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

/**
 * The issue's summary, or null when it can't be had (not a site we contact, no access, offline).
 * `fetchImpl` and `allow` are for tests.
 */
export async function issueSummary({ key, site }, { jira = loadJira(), fetchImpl = fetch, timeoutMs = 6000, allow = null } = {}) {
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
    const res = await fetchImpl(`${site}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const summary = (await res.json())?.fields?.summary;
    return typeof summary === 'string' && summary.trim() ? summary.trim().slice(0, 300) : null;
  } catch {
    return null;
  }
}
