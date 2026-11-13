// Calendar-aware day: your meetings today, the free time between them, and what needs you fitted
// into that time, most pressing first; and for each meeting, the agents, pull requests and issues
// it is about. The calendar is read from its private iCal address (Google, Outlook and Apple
// calendars all have one), which only gives read access. Nothing is written to it, and nothing
// about it leaves this computer.

import fs from 'node:fs';

const MIN = 60_000;
const DAY = 86_400_000;
const CACHE_MS = 10 * MIN;
export const CALENDAR_DEFAULTS = { ics: [], workStart: '09:00', workEnd: '18:00' };
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
/** Minutes a thing that needs you usually takes, by its kind in Today. */
const MINUTES = { prompt: 3, waiting: 5, question: 5, ask: 10, rule: 2, reminder: 10, stuck: 10, conflict: 10, review: 15, issue: 10, 'issue-review': 20, 'issue-new': 10, action: 20, 'pr-review': 25, 'pr-requested': 25, 'pr-ready': 5, bug: 15, 'bug-pr': 15, eval: 10, bench: 10, milestone: 10 };
const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const dayNum = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / DAY);
const fromDayNum = (n) => {
  const d = new Date(n * DAY);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};

/** How far a time zone is ahead of UTC at an instant, in ms. */
function tzOffset(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** A wall-clock time ({ y, m, d, h, mi, s }) in a zone ("utc", an IANA name, or null for this computer's) as ms. */
export function wallToMs(w, tz) {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h ?? 0, w.mi ?? 0, w.s ?? 0);
  if (tz === 'utc') return guess;
  if (tz) {
    try {
      const t = guess - tzOffset(guess, tz);
      return guess - tzOffset(t, tz);
    } catch {
      // A zone name this runtime doesn't know (some calendars use their own): this computer's time.
    }
  }
  return new Date(w.y, w.m - 1, w.d, w.h ?? 0, w.mi ?? 0, w.s ?? 0).getTime();
}

/** "20261113T170000Z", "20261113T090000" or "20261113": { w, tz, allDay }. */
function parseTime(value, params = {}) {
  const m = String(value).trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const allDay = !m[4];
  return { w: { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), h: Number(m[4] ?? 0), mi: Number(m[5] ?? 0), s: Number(m[6] ?? 0) }, tz: m[7] ? 'utc' : params.TZID ?? null, allDay };
}
const wallKey = (w, allDay) => `${w.y}${String(w.m).padStart(2, '0')}${String(w.d).padStart(2, '0')}${allDay ? '' : `T${String(w.h).padStart(2, '0')}${String(w.mi).padStart(2, '0')}`}`;

/** "PT1H30M", "P1D": ms. */
function durationMs(v) {
  const m = String(v).match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * ((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * DAY + Number(m[4] ?? 0) * 60 * MIN + Number(m[5] ?? 0) * MIN + Number(m[6] ?? 0) * 1000);
}
const unescapeText = (s) => String(s ?? '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

/** The events of an iCalendar file, as written (recurring ones not yet spread over their dates). */
export function parseIcs(text) {
  // A line that starts with a space or tab continues the one before.
  const lines = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  let depth = 0; // inside VALARM and the like: not the event's own lines
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = { exdates: [] };
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('BEGIN:')) {
      depth++;
      continue;
    }
    if (line.startsWith('END:') && line !== 'END:VEVENT') {
      depth--;
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur.start) events.push(cur);
      cur = null;
      continue;
    }
    if (depth) continue;
    const at = line.indexOf(':');
    if (at < 0) continue;
    const [name, ...ps] = line.slice(0, at).split(';');
    const params = Object.fromEntries(ps.map((p) => [p.split('=')[0].toUpperCase(), p.split('=').slice(1).join('=').replace(/^"|"$/g, '')]));
    const value = line.slice(at + 1);
    switch (name.toUpperCase()) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.summary = unescapeText(value); break;
      case 'DESCRIPTION': cur.description = unescapeText(value); break;
      case 'LOCATION': cur.location = unescapeText(value); break;
      case 'URL': cur.url = value; break;
      case 'STATUS': cur.status = value.toUpperCase(); break;
      case 'TRANSP': cur.transparent = value.toUpperCase() === 'TRANSPARENT'; break;
      case 'DTSTART': cur.start = parseTime(value, params); break;
      case 'DTEND': cur.end = parseTime(value, params); break;
      case 'DURATION': cur.duration = durationMs(value); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseTime(value, params); break;
      case 'EXDATE': for (const v of value.split(',')) { const t = parseTime(v, params); if (t) cur.exdates.push(t); } break;
      case 'RRULE': cur.rrule = Object.fromEntries(value.split(';').map((p) => [p.split('=')[0].toUpperCase(), p.split('=')[1] ?? ''])); break;
      default:
    }
  }
  return events;
}

/** Whether a recurring event falls on a day (day number `n`), by its rule. */
function onDay(ev, n, s0) {
  const r = ev.rrule;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const c = fromDayNum(n);
  const wd = WEEKDAYS[new Date(n * DAY).getUTCDay()];
  const byday = (r.BYDAY ?? '').split(',').filter(Boolean);
  const s = ev.start.w;
  switch (r.FREQ) {
    case 'DAILY':
      return (n - s0) % interval === 0 && (!byday.length || byday.includes(wd));
    case 'WEEKLY': {
      const wkst = WEEKDAYS.indexOf(r.WKST ?? 'MO');
      const week = (x) => Math.floor((x - ((new Date(x * DAY).getUTCDay() - wkst + 7) % 7)) / 7);
      return (week(n) - week(s0)) % interval === 0 && (byday.length ? byday.includes(wd) : wd === WEEKDAYS[new Date(s0 * DAY).getUTCDay()]);
    }
    case 'MONTHLY': {
      if (((c.y - s.y) * 12 + (c.m - s.m)) % interval !== 0) return false;
      if (byday.length) {
        const nth = Math.ceil(c.d / 7);
        const last = new Date(Date.UTC(c.y, c.m, 0)).getUTCDate();
        const fromEnd = -Math.ceil((last - c.d + 1) / 7);
        return byday.some((b) => {
          const m = b.match(/^([+-]?\d+)?([A-Z]{2})$/);
          return m && m[2] === wd && (!m[1] || Number(m[1]) === nth || Number(m[1]) === fromEnd);
        });
      }
      if (r.BYMONTHDAY) {
        const last = new Date(Date.UTC(c.y, c.m, 0)).getUTCDate();
        return r.BYMONTHDAY.split(',').map(Number).some((d) => d === c.d || (d < 0 && last + d + 1 === c.d));
      }
      return c.d === s.d;
    }
    case 'YEARLY':
      return (c.y - s.y) % interval === 0 && c.m === s.m && c.d === s.d;
    default:
      return false;
  }
}

/**
 * The events between two instants, recurring ones spread over their dates:
 * [{ uid, title, description, location, url, start, end (ms), allDay, free }], by start.
 */
export function eventsBetween(events, from, to) {
  const out = [];
  // An occurrence changed on its own (moved, renamed) replaces the one its series would give.
  const moved = new Map();
  for (const e of events) if (e.recurrenceId && e.uid) moved.set(`${e.uid}|${wallKey(e.recurrenceId.w, e.recurrenceId.allDay)}`, true);
  const lengthOf = (e) => {
    if (e.end) return wallToMs(e.end.w, e.end.tz) - wallToMs(e.start.w, e.start.tz);
    if (e.duration) return e.duration;
    return e.start.allDay ? DAY : 0;
  };
  const push = (e, w) => {
    const start = wallToMs(w, e.start.allDay ? null : e.start.tz);
    const end = start + Math.max(0, lengthOf(e));
    if (end <= from || start >= to) return;
    out.push({ uid: e.uid ?? null, title: clip(e.summary || '(no title)', 200), description: clip(e.description, 2000), location: clip(e.location, 200) || null, url: e.url ?? null, start, end, allDay: e.start.allDay, free: Boolean(e.transparent) });
  };
  for (const e of events) {
    if (e.status === 'CANCELLED') continue;
    if (!e.rrule || e.recurrenceId) {
      push(e, e.start.w);
      continue;
    }
    const s0 = dayNum(e.start.w.y, e.start.w.m, e.start.w.d);
    const until = e.rrule.UNTIL ? parseTime(e.rrule.UNTIL) : null;
    const untilMs = until ? wallToMs(until.allDay ? { ...until.w, h: 23, mi: 59, s: 59 } : until.w, until.tz ?? e.start.tz) : Infinity;
    const count = Number(e.rrule.COUNT) || Infinity;
    const skip = new Set(e.exdates.map((x) => wallKey(x.w, x.allDay || e.start.allDay)));
    const lastDay = Math.floor(to / DAY) + 2;
    // Without a count, nothing before the window matters: start near it (a week early, for long events).
    let n = count === Infinity ? Math.max(s0, Math.floor(from / DAY) - 7) : s0;
    let made = 0;
    for (let guard = 0; n <= lastDay && made < count && guard < 20_000; n++, guard++) {
      if (!onDay(e, n, s0)) continue;
      const w = { ...fromDayNum(n), h: e.start.w.h, mi: e.start.w.mi, s: e.start.w.s };
      if (wallToMs(w, e.start.allDay ? null : e.start.tz) > untilMs) break;
      made++;
      const key = wallKey(w, e.start.allDay);
      if (skip.has(key) || moved.has(`${e.uid}|${key}`)) continue;
      push(e, w);
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** What a meeting is about, from its title and description: the agents and Today items it names. */
export function relatedTo(meeting, { agents = [], items = [] } = {}) {
  const text = `${meeting.title} ${meeting.description ?? ''}`;
  const lower = text.toLowerCase().replace(/[-_]+/g, ' ');
  const keys = new Set([...text.matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g)].map((m) => m[0]));
  const prs = new Set([...text.matchAll(/#(\d{1,6})\b/g)].map((m) => m[1]));
  const out = [];
  const seen = new Set();
  const add = (x) => {
    if (seen.has(x.key) || out.length >= 6) return;
    seen.add(x.key);
    out.push(x);
  };
  for (const a of agents) {
    const name = String(a.name ?? '').toLowerCase().replace(/[-_]+/g, ' ').trim();
    const issue = a.issue && keys.has(a.issue);
    const pr = (a.prs ?? []).find((p) => prs.has(String(p.number)));
    const named = name.length >= 5 && lower.includes(name);
    const project = a.project && a.project.length >= 4 && new RegExp(`\\b${a.project.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/ /g, '[ -]')}\\b`).test(lower);
    if (issue || pr || named) add({ key: `agent:${a.id}`, kind: 'agent', agentId: a.id, title: a.name, why: issue ? `works on ${a.issue}` : pr ? `opened #${pr.number}` : 'named in the invite', status: a.status ?? null });
    else if (project) add({ key: `agent:${a.id}`, kind: 'agent', agentId: a.id, title: a.name, why: `in ${a.project}`, status: a.status ?? null });
  }
  for (const i of items) {
    const t = `${i.title} ${i.issueKey ?? ''}`;
    if ([...keys].some((k) => t.includes(k)) || [...prs].some((n) => new RegExp(`#${n}\\b`).test(t))) add({ key: `item:${i.id}`, kind: 'item', id: i.id, title: clip(i.title, 120), why: i.label, url: i.url ?? null, agentId: i.agentId ?? null });
  }
  return out;
}

const atTime = (now, hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h || 0, m || 0).getTime();
};

/**
 * The day: meetings, free blocks from now to the end of the working day, and Today's items placed
 * in them in order (most pressing first), each with the minutes it usually takes.
 */
export function dayPlan({ events = [], items = [], agents = [], now = new Date(), workStart = '09:00', workEnd = '18:00' } = {}) {
  const t = now.getTime();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const today = events.filter((e) => e.end > dayStart && e.start < dayStart + DAY);
  const meetings = today.filter((e) => !e.allDay).map((e) => ({ title: e.title, start: e.start, end: e.end, location: e.location, url: e.url, free: e.free, now: e.start <= t && e.end > t, past: e.end <= t, related: e.end > t ? relatedTo(e, { agents, items }) : [] }));
  const busy = meetings.filter((m) => !m.free);
  const from = Math.max(t, atTime(now, workStart));
  const to = atTime(now, workEnd);
  // Free time: the working day from now on, less the meetings.
  const gaps = [];
  let at = from;
  for (const m of busy.filter((x) => x.end > from && x.start < to).sort((a, b) => a.start - b.start)) {
    if (m.start - at >= 15 * MIN) gaps.push([at, m.start]);
    at = Math.max(at, m.end);
  }
  if (to - at >= 15 * MIN) gaps.push([at, to]);
  // A date coming up is something to know, not something to sit down and do.
  const todo = items.filter((i) => i.kind !== 'milestone');
  const left = todo.map((i) => ({ id: i.id, kind: i.kind, label: i.label, title: clip(i.title, 140), minutes: MINUTES[i.kind] ?? 10, agentId: i.agentId ?? null, url: i.url ?? null }));
  const blocks = gaps.map(([start, end]) => {
    let room = Math.floor((end - start) / MIN);
    const placed = [];
    for (let k = 0; k < left.length; ) {
      if (left[k].minutes <= room) {
        room -= left[k].minutes;
        placed.push(...left.splice(k, 1));
      } else k++;
    }
    return { start, end, minutes: Math.floor((end - start) / MIN), items: placed, spare: room };
  });
  const next = busy.find((m) => m.start > t) ?? null;
  return {
    date: new Date(dayStart).toISOString(),
    allDay: today.filter((e) => e.allDay).map((e) => e.title),
    meetings,
    blocks,
    current: busy.find((m) => m.now)?.title ?? null,
    next: next ? { title: next.title, start: next.start, inMinutes: Math.round((next.start - t) / MIN), related: next.related } : null,
    meetingMinutes: Math.round(busy.reduce((s, m) => s + (m.end - m.start), 0) / MIN),
    freeMinutes: blocks.reduce((s, b) => s + b.minutes, 0),
    needMinutes: todo.reduce((s, i) => s + (MINUTES[i.kind] ?? 10), 0),
    unplaced: left.length,
    workStart,
    workEnd,
  };
}

/** Settings from config.json's "calendar". */
export function calendarSettings(config = {}) {
  const s = { ...CALENDAR_DEFAULTS, ...config.calendar };
  const time = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d);
  const ics = (Array.isArray(s.ics) ? s.ics : s.ics ? [s.ics] : []).map((u) => String(u).trim().replace(/^webcal:\/\//i, 'https://')).filter((u) => /^https?:\/\//i.test(u) || u.startsWith('/'));
  const workStart = time(s.workStart, CALENDAR_DEFAULTS.workStart);
  const workEnd = time(s.workEnd, CALENDAR_DEFAULTS.workEnd);
  return { ics: [...new Set(ics)].slice(0, 8), workStart, workEnd: workEnd > workStart ? workEnd : CALENDAR_DEFAULTS.workEnd };
}

async function defaultFetch(source) {
  if (source.startsWith('/')) return fs.readFileSync(source, 'utf8');
  const res = await fetch(source, { headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}
/** Where a calendar comes from, without its secret address: the host, or the file's name. */
const sourceName = (u) => {
  if (u.startsWith('/')) return u.split('/').pop();
  try {
    return new URL(u).host;
  } catch {
    return 'calendar';
  }
};

export class Calendar {
  constructor({ config = {}, fetchText = defaultFetch, now = () => new Date(), log = (m) => console.log(`[agentmgr] ${m}`) }) {
    Object.assign(this, { config, fetchText, now, log });
    this.cache = new Map(); // address -> { at, events, error }
  }

  get settings() {
    return calendarSettings(this.config);
  }

  /** Check the addresses can be read as calendars, then keep them; `save(patch)` writes config.json. */
  async set({ ics, add, workStart, workEnd } = {}, save) {
    // `add`: one more address next to the ones already kept (they are never sent to the page).
    if (add !== undefined && String(add).trim()) ics = [...this.settings.ics, String(add).trim()];
    const next = calendarSettings({ calendar: { ...this.config.calendar, ...(ics !== undefined ? { ics } : {}), ...(workStart ? { workStart } : {}), ...(workEnd ? { workEnd } : {}) } });
    if (ics !== undefined) {
      const asked = (Array.isArray(ics) ? ics : [ics]).filter((u) => String(u ?? '').trim());
      if (asked.length !== next.ics.length) throw err(400, "A calendar address starts with https:// (or webcal://): the calendar's private iCal address");
      for (const u of next.ics) {
        if (this.config.calendar?.ics?.includes(u)) continue;
        let text;
        try {
          text = await this.fetchText(u);
        } catch (e) {
          throw err(400, `Couldn't read the calendar at ${sourceName(u)}: ${e.message}`);
        }
        if (!/BEGIN:VCALENDAR/.test(text)) throw err(400, `${sourceName(u)} didn't return a calendar: use the calendar's private iCal address (it ends in .ics)`);
      }
    }
    this.config.calendar = next;
    this.cache.clear();
    save?.({ calendar: next });
    return this.status();
  }

  async load(source) {
    const hit = this.cache.get(source);
    if (hit && this.now().getTime() - hit.at < CACHE_MS) return hit;
    let rec;
    try {
      rec = { at: this.now().getTime(), events: parseIcs(await this.fetchText(source)), error: null };
    } catch (e) {
      // A calendar that can't be read right now: what was read last, with why.
      rec = { at: this.now().getTime(), events: hit?.events ?? [], error: String(e.message).slice(0, 200) };
      this.log(`calendar: ${sourceName(source)}: ${e.message}`);
    }
    this.cache.set(source, rec);
    return rec;
  }

  status() {
    const s = this.settings;
    return { connected: s.ics.length > 0, sources: s.ics.map((u) => ({ name: sourceName(u), error: this.cache.get(u)?.error ?? null, events: this.cache.get(u)?.events.length ?? null })), workStart: s.workStart, workEnd: s.workEnd };
  }

  /** Today planned around the meetings; { connected: false } when no calendar is set. */
  async day({ items = [], agents = [] } = {}) {
    const s = this.settings;
    if (!s.ics.length) return { connected: false, workStart: s.workStart, workEnd: s.workEnd };
    const now = this.now();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const loaded = await Promise.all(s.ics.map((u) => this.load(u)));
    const events = eventsBetween(loaded.flatMap((l) => l.events), dayStart, dayStart + DAY);
    // The same meeting on two calendars is one meeting.
    const seen = new Set();
    const unique = events.filter((e) => !seen.has(`${e.title}|${e.start}|${e.end}`) && seen.add(`${e.title}|${e.start}|${e.end}`));
    return { ...this.status(), ...dayPlan({ events: unique, items, agents, now, workStart: s.workStart, workEnd: s.workEnd }) };
  }
}
