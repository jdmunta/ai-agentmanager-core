// AI News: what the frontier labs released lately, in one list. It reads their release notes
// (Claude Platform, Claude Code, OpenAI API, Gemini API, and any you add in config.json), keeps
// the last few weeks, and has each entry summarized in a sentence or two by one batched,
// tool-less model call per refresh (each entry once). Once a day a Claude Code call allowed only
// web search and web fetch looks for the latest releases of the top 10 AI labs, for those without
// release notes read here. Nothing is sent anywhere; it only reads public pages.

import crypto from 'node:crypto';
import { parseJsonReply } from './brief.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_ITEMS = 400;
const SUMMARY_BATCH = 25;
const FETCH_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 10 * 60_000;
export const NEWS_DEFAULTS = { enabled: true, sources: ['claude-platform', 'claude-code', 'openai', 'gemini'], custom: [], search: true, summaries: true, refreshHours: 6, searchHours: 24, days: 30 };

const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** "November 12, 2026" (or "Nov 12, 2026") as "2026-11-12", or null. */
export function dateOf(words) {
  const m = String(words ?? '').match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  const mi = m ? MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3))) : -1;
  return mi < 0 ? null : ymd(Number(m[3]), mi, Number(m[2]));
}

/** An address on the page, made absolute; null for anything but http(s). */
const absolute = (href, base) => {
  try {
    const u = new URL(href, base);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
};

/** Markdown to plain text, with its links kept apart: { text, links: [{ text, url }] }. */
export function plainText(md, base) {
  const links = [];
  const text = String(md ?? '')
    .replace(/^#{1,6}\s.*$/gm, '')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, t, href) => {
      const url = absolute(href, base);
      if (url && !links.some((l) => l.url === url)) links.push({ text: t.replace(/[*`_]/g, ''), url });
      return t;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, links };
}

/** A headline for an entry: its bold lead ("**Gemini 4 GA**: …") or its first sentence. */
function headline(md, text) {
  const bold = String(md).match(/^\s*\*\*([^*]{3,160})\*\*/);
  if (bold) return plainText(bold[1]).text.replace(/[:.]$/, '');
  return clip(text.split(/(?<=[.!?])\s/)[0], 140);
}

/**
 * Release notes in Markdown, one "## <date>" (or "###") heading per day and a bullet per change,
 * as the Claude Platform and the Gemini API publish them: [{ date, title, text, links }].
 */
export function parseDatedMarkdown(md, { base, since = null } = {}) {
  const out = [];
  let date = null;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const { text, links } = plainText(cur, base);
    if (text.length > 3) out.push({ date, title: headline(cur, text), text: clip(text, 2400), links });
    cur = null;
  };
  let gap = false; // a blank line since the bullet's last line
  for (const line of String(md ?? '').split('\n')) {
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) {
      flush();
      date = dateOf(h[1]);
      continue;
    }
    if (!date || (since && date < since)) continue;
    if (!line.trim()) {
      gap = true;
      continue;
    }
    // A bullet at the margin starts an entry; an indented one is a sub-point of the entry above.
    if (/^\s?[*-]\s+/.test(line)) {
      flush();
      cur = line.replace(/^\s*[*-]\s+/, '');
    } else if (cur !== null && (!gap || /^\s/.test(line)) && !/^\s*</.test(line)) cur += ` ${line.trim().replace(/^[*-]\s+/, '')}`;
    else flush();
    gap = false;
  }
  flush();
  return out;
}

const unescapeHtml = (s) => String(s).replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' })[e]);
const htmlText = (h) => unescapeHtml(String(h).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * OpenAI's changelog page: "<Month>, <Year>" headings, then entries with a date badge ("Nov 5"),
 * a type and tags (models, endpoints), and the text. Read from the page's HTML.
 */
export function parseOpenAiChangelog(html, { base, since = null } = {}) {
  const out = [];
  const sections = String(html ?? '').split(/<h3\b/).slice(1);
  for (const sec of sections) {
    const head = htmlText(sec.slice(sec.indexOf('>') + 1, sec.indexOf('</h3>')));
    const year = Number(head.match(/\b(\d{4})\b/)?.[1]);
    if (!year) continue;
    for (const chunk of sec.split(/grid-cols-\[3rem_1fr\]/).slice(1)) {
      const day = chunk.match(/data-variant="outline"[^>]*>\s*([A-Z][a-z]{2})\s+(\d{1,2})\s*</);
      const mi = day ? MONTHS.findIndex((x) => x.startsWith(day[1].toLowerCase())) : -1;
      if (mi < 0) continue;
      const date = ymd(year, mi, Number(day[2]));
      if (since && date < since) continue;
      const type = chunk.match(/<span class="capitalize">([^<]+)<\/span>/)?.[1] ?? null;
      const bodyAt = chunk.search(/MarkdownContent/);
      if (bodyAt < 0) continue;
      const body = chunk.slice(chunk.indexOf('>', bodyAt) + 1);
      const tags = [...chunk.slice(0, bodyAt).matchAll(/data-variant="soft"[^>]*>([^<]+)</g)].map((m) => htmlText(m[1])).filter(Boolean);
      const links = [];
      for (const m of body.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
        const url = absolute(unescapeHtml(m[1]), base);
        if (url && !links.some((l) => l.url === url)) links.push({ text: htmlText(m[2]), url });
      }
      const text = clip(htmlText(body), 2400);
      if (text.length < 4) continue;
      out.push({ date, title: tags.length ? `${type ? `${type}: ` : ''}${tags.slice(0, 3).join(', ')}` : headline('', text), text, links, tags });
    }
  }
  return out;
}

/** GitHub releases (Claude Code's): one entry per version, with its date and notes. */
export function parseGithubReleases(json, { label, since = null } = {}) {
  const list = typeof json === 'string' ? JSON.parse(json) : json;
  if (!Array.isArray(list)) throw new Error(list?.message ?? 'Not a list of releases');
  return list
    .filter((r) => !r.draft && !r.prerelease && r.published_at)
    .map((r) => {
      const { text, links } = plainText(r.body ?? '', r.html_url);
      return { date: r.published_at.slice(0, 10), title: `${label} ${String(r.tag_name).replace(/^v/, '')}`, text: clip(text || r.name || r.tag_name, 6000), links: links.slice(0, 6), url: r.html_url };
    })
    .filter((e) => !since || e.date >= since);
}

/** The release notes read here. `page` is where a person reads them. */
export const SOURCES = {
  'claude-platform': {
    lab: 'Anthropic',
    label: 'Claude Platform',
    url: 'https://platform.claude.com/docs/en/release-notes/overview.md',
    page: 'https://platform.claude.com/docs/en/release-notes/overview',
    parse: (body, o) => parseDatedMarkdown(body, { ...o, base: 'https://platform.claude.com/docs/en/release-notes/overview' }),
  },
  'claude-code': {
    lab: 'Anthropic',
    label: 'Claude Code',
    url: 'https://api.github.com/repos/anthropics/claude-code/releases?per_page=15',
    page: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md',
    parse: (body, o) => parseGithubReleases(body, { ...o, label: 'Claude Code' }),
  },
  openai: {
    lab: 'OpenAI',
    label: 'OpenAI API',
    url: 'https://developers.openai.com/changelog',
    page: 'https://developers.openai.com/changelog',
    parse: (body, o) => parseOpenAiChangelog(body, { ...o, base: 'https://developers.openai.com/changelog' }),
  },
  gemini: {
    lab: 'Google',
    label: 'Gemini API',
    url: 'https://ai.google.dev/gemini-api/docs/changelog.md.txt',
    page: 'https://ai.google.dev/gemini-api/docs/changelog',
    // Its Markdown links "/docs/…" for what the site serves at "/gemini-api/docs/…".
    parse: (body, o) =>
      parseDatedMarkdown(body, { ...o, base: 'https://ai.google.dev/gemini-api/docs/changelog' }).map((e) => ({
        ...e,
        links: e.links.map((l) => ({ ...l, url: l.url.replace(/^https:\/\/ai\.google\.dev\/docs\//, 'https://ai.google.dev/gemini-api/docs/') })),
      })),
  },
};

/** Settings from config.json's "news", with defaults; custom sources are dated Markdown. */
export function newsSettings(config = {}) {
  const s = { ...NEWS_DEFAULTS, ...config.news };
  const num = (v, d, min) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d);
  const custom = (Array.isArray(s.custom) ? s.custom : [])
    .filter((c) => c && /^[\w-]{1,40}$/.test(c.id ?? '') && /^https?:\/\//.test(c.url ?? '') && !SOURCES[c.id])
    .map((c) => ({ id: c.id, lab: clip(c.lab || c.label || c.id, 40), label: clip(c.label || c.id, 60), url: c.url, page: /^https?:\/\//.test(c.page ?? '') ? c.page : c.url }));
  return {
    enabled: s.enabled !== false,
    sources: (Array.isArray(s.sources) ? s.sources : NEWS_DEFAULTS.sources).filter((id) => SOURCES[id]),
    custom,
    search: s.search !== false,
    summaries: s.summaries !== false,
    refreshHours: num(s.refreshHours, NEWS_DEFAULTS.refreshHours, 0.25),
    searchHours: num(s.searchHours, NEWS_DEFAULTS.searchHours, 1),
    days: num(s.days, NEWS_DEFAULTS.days, 1),
  };
}

const idOf = (source, e) => crypto.createHash('sha1').update(`${source}\n${e.date}\n${e.url ?? ''}\n${e.title}\n${e.text.slice(0, 200)}`).digest('hex').slice(0, 12);

/** The prompt that summarizes entries; the reply is { summaries: { id: text } }. */
export function summaryPrompt(entries) {
  return [
    'Summarize these AI release notes for a developer who builds with AI models and coding agents, one entry at a time.',
    'For each entry write one or two plain sentences (at most 240 characters): what was released or changed, and why it matters or who it is for.',
    'Keep model names, IDs and API names exactly as written. No hype, no marketing words, no "This update…" opener. Do not invent anything not in the entry.',
    'Reply with JSON only: {"summaries": {"<id>": "<summary>", …}}, one for every id.',
    '',
    '<entries>',
    JSON.stringify(entries.map((e) => ({ id: e.id, source: e.label, date: e.date, title: e.title, text: clip(e.text, 3000) }))),
    '</entries>',
  ].join('\n');
}

/** The prompt for the web search over the top AI labs; the reply is { items: [...] }. */
export function searchPrompt({ today, days = 14, known = [] }) {
  return [
    `Find the latest frontier AI releases from the top 10 AI labs, from the last ${days} days (today is ${today}).`,
    'The labs: Anthropic, OpenAI, Google DeepMind, Meta, xAI, Mistral AI, DeepSeek, Alibaba (Qwen), Microsoft AI and Amazon, or whichever ten lead now.',
    'Look for new models, model updates, major API or developer platform features, and agent or coding tools. Use web search, and open the announcement to check the date and details. Leave out rumors, opinion pieces and anything older.',
    known.length ? `Already known (skip these): ${known.slice(0, 40).join('; ')}.` : '',
    'Reply with JSON only: {"items": [{"lab": "<lab>", "date": "YYYY-MM-DD", "title": "<the release, short>", "summary": "<one or two plain sentences: what it is and why it matters, at most 240 characters>", "url": "<the official announcement or docs>"}]}, newest first, at most 20.',
  ]
    .filter(Boolean)
    .join('\n');
}

export class News {
  /**
   * `fetchText(url)` reads a page; `oneShot(prompt, { web })` makes the model call (web: the
   * tools a search may use) and resolves to its text.
   */
  constructor({ store, config = {}, fetchText = defaultFetch, oneShot = null, onChange = () => {}, log = (m) => console.log(`[agentmgr] ${m}`), now = () => Date.now() }) {
    this.store = store;
    this.config = config;
    this.fetchText = fetchText;
    this.oneShot = oneShot;
    this.onChange = onChange;
    this.log = log;
    this.now = now;
    this.running = null;
    this.timer = null;
    if (this.settings.enabled) {
      // A first look shortly after start, then whenever a refresh is due.
      this.first = setTimeout(() => this.tick(), 20_000);
      this.timer = setInterval(() => this.tick(), 15 * 60_000);
      this.first.unref?.();
      this.timer.unref?.();
    }
  }

  get settings() {
    return newsSettings(this.config);
  }

  get state() {
    return (this.store.data.news ??= { items: {}, sources: {}, search: {}, seenAt: null });
  }

  close() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  /** The sources in use, built in and custom. */
  sources() {
    const s = this.settings;
    return [
      ...s.sources.map((id) => ({ id, ...SOURCES[id] })),
      ...s.custom.map((c) => ({ ...c, parse: (body, o) => parseDatedMarkdown(body, { ...o, base: c.page }) })),
    ];
  }

  tick() {
    const s = this.settings;
    if (!s.enabled || this.running) return;
    const last = Date.parse(this.state.refreshedAt ?? '') || 0;
    if (this.now() - last >= s.refreshHours * HOUR) this.refresh().catch((e) => this.log(`news: ${e.message}`));
  }

  /** Read every source, search when due (or `search`: now), then summarize what's new. One at a time. */
  refresh({ search = null } = {}) {
    if (!this.settings.enabled) return Promise.reject(err(409, 'AI News is off: "news": { "enabled": true } in config.json'));
    this.running ??= this.run({ search }).finally(() => {
      this.running = null;
      this.onChange();
    });
    this.onChange();
    return this.running;
  }

  async run({ search }) {
    const s = this.settings;
    const st = this.state;
    const since = new Date(this.now() - s.days * DAY).toISOString().slice(0, 10);
    await Promise.all(
      this.sources().map(async (src) => {
        const at = new Date(this.now()).toISOString();
        try {
          // Read whole, so a page with nothing recent isn't taken for one that can't be read.
          const all = src.parse(await this.fetchText(src.url), {});
          if (!all.length) throw new Error('No dated entries found on the page (its layout may have changed)');
          const entries = all.filter((e) => e.date >= since);
          let added = 0;
          for (const e of entries) added += this.add(src, e);
          st.sources[src.id] = { at, error: null, count: entries.length, added };
        } catch (e) {
          st.sources[src.id] = { ...st.sources[src.id], at, error: clip(e.message, 200) };
          this.log(`news: ${src.label}: ${e.message}`);
        }
      }),
    );
    const searchDue = search ?? (s.search && this.now() - (Date.parse(st.search.at ?? '') || 0) >= s.searchHours * HOUR);
    if (searchDue && s.search && this.oneShot) await this.search(since);
    st.refreshedAt = new Date(this.now()).toISOString();
    this.prune(since);
    this.store.save();
    this.onChange();
    if (s.summaries && this.oneShot) await this.summarize();
    this.store.save();
  }

  /** Keep one entry; 1 when it's new. */
  add(src, e) {
    const st = this.state;
    const id = idOf(src.id, e);
    if (st.items[id]) return 0;
    st.items[id] = {
      id,
      source: src.id,
      lab: src.lab,
      label: src.label,
      date: e.date,
      title: clip(String(e.title).replace(/`/g, ''), 200),
      text: e.text,
      links: (e.links ?? []).slice(0, 8),
      tags: e.tags ?? [],
      url: e.url ?? src.page,
      summary: e.summary ? clip(e.summary, 300) : null,
      summaryBy: e.summary ? 'search' : null,
      seenAt: new Date(this.now()).toISOString(),
    };
    return 1;
  }

  /** The top labs' latest releases, from the web: one Claude Code call with only web search and fetch. */
  async search(since) {
    const st = this.state;
    const at = new Date(this.now()).toISOString();
    const known = Object.values(st.items).filter((i) => i.date >= since).map((i) => `${i.lab}: ${i.title}`);
    try {
      const reply = parseJsonReply(await this.oneShot(searchPrompt({ today: at.slice(0, 10), days: 14, known }), { web: ['WebSearch', 'WebFetch'], timeoutMs: SEARCH_TIMEOUT_MS }));
      const items = (Array.isArray(reply?.items) ? reply.items : []).filter((x) => x && /^\d{4}-\d{2}-\d{2}$/.test(x.date ?? '') && x.date >= since && /^https?:\/\//.test(x.url ?? '') && x.title);
      // One the release notes already have (same address) isn't added twice.
      const urls = new Set(Object.values(st.items).flatMap((i) => [i.url, ...i.links.map((l) => l.url)]));
      let added = 0;
      for (const x of items) {
        if (urls.has(x.url)) continue;
        added += this.add({ id: 'search', lab: clip(x.lab || 'AI lab', 40), label: 'Web search', page: x.url }, { date: x.date, title: x.title, text: clip(x.summary ?? '', 600), links: [{ text: 'Announcement', url: x.url }], url: x.url, summary: x.summary });
      }
      st.search = { at, error: null, count: items.length, added };
    } catch (e) {
      st.search = { ...st.search, at, error: clip(e.message, 200) };
      this.log(`news: search: ${e.message}`);
    }
  }

  /** Summaries for the entries that have none, newest first, a batch per call; tried twice at most. */
  async summarize() {
    const todo = Object.values(this.state.items)
      .filter((i) => !i.summary && (i.summaryTries ?? 0) < 2)
      .sort((x, y) => y.date.localeCompare(x.date));
    for (let i = 0; i < todo.length; i += SUMMARY_BATCH) {
      const batch = todo.slice(i, i + SUMMARY_BATCH);
      try {
        const got = parseJsonReply(await this.oneShot(summaryPrompt(batch), {}))?.summaries ?? {};
        for (const it of batch) {
          if (typeof got[it.id] === 'string' && got[it.id].trim()) Object.assign(it, { summary: clip(got[it.id], 300), summaryBy: 'ai' });
          else it.summaryTries = (it.summaryTries ?? 0) + 1;
        }
      } catch (e) {
        for (const it of batch) it.summaryTries = (it.summaryTries ?? 0) + 1;
        this.log(`news: summaries: ${e.message}`);
      }
      this.store.save();
      this.onChange();
    }
  }

  /** Older than the window goes; past MAX_ITEMS, the oldest. */
  prune(since) {
    const st = this.state;
    const keep = Object.values(st.items)
      .filter((i) => i.date >= since)
      .sort((x, y) => y.date.localeCompare(x.date) || y.seenAt.localeCompare(x.seenAt))
      .slice(0, MAX_ITEMS);
    st.items = Object.fromEntries(keep.map((i) => [i.id, i]));
  }

  /** What the page shows: entries newest first, with which are new since you last looked. */
  view() {
    const s = this.settings;
    const st = this.state;
    const seen = st.seenAt ?? '';
    const items = Object.values(st.items)
      .sort((x, y) => y.date.localeCompare(x.date) || x.lab.localeCompare(y.lab) || y.seenAt.localeCompare(x.seenAt))
      .map((i) => ({ id: i.id, source: i.source, lab: i.lab, label: i.label, date: i.date, title: i.title, summary: i.summary, summaryBy: i.summaryBy, lead: i.summary ? null : clip(i.text, 280), links: i.links, tags: i.tags, url: i.url, isNew: Boolean(seen) && i.seenAt > seen }));
    return {
      enabled: s.enabled,
      settings: { search: s.search, summaries: s.summaries, refreshHours: s.refreshHours, searchHours: s.searchHours, days: s.days },
      sources: [
        ...this.sources().map((x) => ({ id: x.id, lab: x.lab, label: x.label, page: x.page, ...pick(st.sources[x.id]) })),
        ...(s.search ? [{ id: 'search', lab: 'Top 10 labs', label: 'Web search', page: null, ...pick(st.search) }] : []),
      ],
      items,
      newCount: seen ? items.filter((i) => i.isNew).length : 0,
      seenAt: st.seenAt ?? null,
      refreshing: Boolean(this.running),
      refreshedAt: st.refreshedAt ?? null,
    };
  }

  /** You've looked: the "new" marks clear. */
  seen() {
    this.state.seenAt = new Date(this.now()).toISOString();
    this.store.save();
    this.onChange();
    return { ok: true };
  }
}

const pick = (x = {}) => ({ at: x.at ?? null, error: x.error ?? null, count: x.count ?? 0 });

async function defaultFetch(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (AI Agent Manager news)', accept: 'text/markdown, text/html, application/json;q=0.9, */*;q=0.8' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return res.text();
}
