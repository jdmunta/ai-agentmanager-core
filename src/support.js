// Support tickets: a problem or an idea, in your words, with a screenshot when one helps. Each is
// kept on this computer (support/<id>/ in the home folder: ticket.md, ticket.json, screenshot) and
// comes with a link to a new GitHub issue filled in with it. Nothing is sent from here: you look
// it over on GitHub, paste the screenshot (it's put on your clipboard) and submit it yourself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from './config.js';

export const KINDS = { bug: 'Something is wrong', idea: 'An improvement' };
const LABELS = { bug: 'bug', idea: 'enhancement' };
const IMAGE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_KEPT = 100;
// GitHub refuses very long new-issue links; the body is cut to fit.
const MAX_URL = 7500;
const err = (status, message) => Object.assign(new Error(message), { status });

const dir = () => path.join(paths.home, 'support');
const ticketDir = (id) => {
  if (!/^[\w-]{1,80}$/.test(String(id))) throw err(400, 'No such ticket');
  return path.join(dir(), id);
};

/** What's useful to know about this setup, without names, folders, hosts or tokens. */
export function aboutThis({ version, browser = null, features = {}, agents = null } = {}) {
  return {
    version: version ?? null,
    os: `${os.type()} ${os.release()} (${process.arch})`,
    node: process.version,
    ...(browser ? { browser: String(browser).slice(0, 200) } : {}),
    on: Object.entries(features)
      .filter(([, v]) => v)
      .map(([k]) => k),
    ...(agents === null ? {} : { agents }),
  };
}

/** The issue's text, in Markdown. */
export function ticketMarkdown(t) {
  const info = t.info ?? {};
  const lines = [
    t.details.trim(),
    '',
    ...(t.screenshot ? ['**Screenshot:** _(pasted below)_', '', ''] : []),
    '<details><summary>About this setup</summary>',
    '',
    `- AI Agent Manager ${info.version ?? '?'}`,
    `- ${info.os ?? '?'}, Node ${info.node ?? '?'}`,
    ...(info.browser ? [`- Browser: ${info.browser}`] : []),
    ...(info.on?.length ? [`- Turned on: ${info.on.join(', ')}`] : []),
    ...(info.agents !== undefined ? [`- Agents: ${info.agents}`] : []),
    '',
    '</details>',
  ];
  return lines.join('\n');
}

/** A link to a new issue on `issuesUrl` (…/issues) with the title, text and label filled in. */
export function issueLink(issuesUrl, t) {
  const base = `${String(issuesUrl).replace(/\/+$/, '')}/new`;
  const q = (body) => `${base}?${new URLSearchParams({ title: t.title, labels: LABELS[t.kind] ?? '', body })}`;
  let link = q(ticketMarkdown(t));
  // Cut the details, not the setup: the whole text stays in the ticket on this computer.
  for (let room = t.details.length; link.length > MAX_URL && room > 0; ) {
    room = Math.floor(room * Math.min(0.9, MAX_URL / link.length));
    link = q(ticketMarkdown({ ...t, details: `${t.details.slice(0, room).trim()}\n\n_(cut short to fit the link; paste the rest)_` }));
  }
  return link;
}

export class Support {
  constructor({ issuesUrl, about = () => ({}) }) {
    this.issuesUrl = issuesUrl;
    this.about = about;
  }

  /** Keep a ticket: { kind, title, details, browser } → the ticket with its id and issue link. */
  create({ kind = 'bug', title, details, browser = null } = {}) {
    if (!KINDS[kind]) throw err(400, `The kind is ${Object.keys(KINDS).join(' or ')}`);
    title = String(title ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    details = String(details ?? '').trim().slice(0, 20_000);
    if (!title) throw err(400, 'Give it a short title');
    if (!details) throw err(400, 'Say what happened, or what would help');
    const at = new Date();
    const id = `${at.toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${Math.random().toString(36).slice(2, 6)}`;
    const t = { id, kind, title, details, at: at.toISOString(), screenshot: null, info: aboutThis({ ...this.about(), browser }) };
    fs.mkdirSync(ticketDir(id), { recursive: true });
    this.write(t);
    this.prune();
    return this.view(t);
  }

  /** The screenshot for a ticket (PNG, JPEG or WebP, as sent). */
  addScreenshot(id, buf, type) {
    const t = this.read(id);
    const ext = IMAGE[String(type ?? '').split(';')[0]];
    if (!ext) throw err(415, 'The screenshot is a PNG, JPEG or WebP image');
    if (!buf?.length) throw err(400, 'The screenshot is empty');
    const name = `screenshot.${ext}`;
    fs.writeFileSync(path.join(ticketDir(id), name), buf);
    t.screenshot = name;
    this.write(t);
    return this.view(t);
  }

  /** The screenshot's file: { file, type }. */
  screenshot(id) {
    const t = this.read(id);
    if (!t.screenshot) throw err(404, 'No screenshot');
    const ext = t.screenshot.split('.').pop();
    return { file: path.join(ticketDir(id), t.screenshot), type: Object.keys(IMAGE).find((k) => IMAGE[k] === ext) };
  }

  /** Your tickets, newest first. */
  list(max = 20) {
    let ids = [];
    try {
      ids = fs.readdirSync(dir()).sort().reverse();
    } catch {}
    const out = [];
    for (const id of ids) {
      if (out.length >= max) break;
      try {
        out.push(this.view(this.read(id)));
      } catch {}
    }
    return out;
  }

  view(t) {
    return { ...t, folder: ticketDir(t.id), issueUrl: issueLink(this.issuesUrl, t) };
  }

  read(id) {
    const file = path.join(ticketDir(id), 'ticket.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw err(404, 'No such ticket');
    }
  }

  write(t) {
    fs.writeFileSync(path.join(ticketDir(t.id), 'ticket.json'), JSON.stringify(t, null, 2) + '\n');
    fs.writeFileSync(path.join(ticketDir(t.id), 'ticket.md'), `# ${t.title}\n\n_${KINDS[t.kind]} · ${t.at}_\n\n${ticketMarkdown(t)}\n${t.screenshot ? `\n![Screenshot](${t.screenshot})\n` : ''}`);
  }

  /** The oldest go when there are many. */
  prune() {
    let ids = [];
    try {
      ids = fs.readdirSync(dir()).sort();
    } catch {}
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_KEPT))) fs.rmSync(ticketDir(id), { recursive: true, force: true });
  }
}
