// When an engine stops for a limit: a usage limit or exhausted quota ("Claude usage limit
// reached… resets 3pm", Codex's "You've hit your usage limit… try again at 3:05 PM"), or a busy or
// failing service (429, 529 overloaded, 5xx). Read from the end of the agent's screen once a turn
// ends. The manager shows it, types "continue" when the limit resets (a few minutes later for a
// busy service), and offers to carry the work on with another engine.

// Engines' own words, not an agent talking about rate limits in its code: a limit names your
// usage, quota or credits; a 429 or an overload has to read as an error.
const LIMIT = [
  /usage limit (?:reached|hit)|(?:hit|reached) (?:your|the) (?:usage |session |weekly |5-hour |daily )?limit\b/i,
  /\b(?:5-hour|weekly|daily|session|opus|sonnet) limit reached/i,
  /quota (?:exceeded|exhausted)|exceeded your (?:current )?quota|RESOURCE_EXHAUSTED/i,
  /out of (?:credits|extra usage)|credit balance is too low/i,
];
const BUSY = [/(?:api error|error|■)[^\n]{0,80}(?:\b429\b|rate limit|\b529\b|overloaded|\b50[0234]\b)/i, /overloaded_error/i];
// A busy service says nothing about when: try again after this long.
export const BUSY_RETRY_MS = 5 * 60_000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Minutes a time zone is ahead of UTC at `t`, or null for a zone this Node doesn't know. */
function zoneOffset(zone, t) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(t).map((p) => [p.type, p.value]));
    return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Math.floor(t / 60_000) * 60_000) / 60_000;
  } catch {
    return null;
  }
}

/** Wall-clock fields in a zone (or this machine's, without one) as epoch ms. */
function wallTime(y, mo, d, h, min, zone, near) {
  if (!zone) return new Date(y, mo, d, h, min).getTime();
  const guess = Date.UTC(y, mo, d, h, min);
  const off = zoneOffset(zone, near);
  return off === null ? new Date(y, mo, d, h, min).getTime() : guess - off * 60_000;
}

/** Today's date in a zone (or here), as [year, month, day]. */
function today(zone, now) {
  const off = zone ? zoneOffset(zone, now) : null;
  const d = off === null ? new Date(now) : new Date(now + off * 60_000);
  return off === null ? [d.getFullYear(), d.getMonth(), d.getDate()] : [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

/** "3pm", "3:05 PM", "15:00", with an optional "Nov 12" before it and "(Area/City)" after: the next such time. */
function clockTime(s, now) {
  const m = /(?:\b([a-z]{3})[a-z]*\.? (\d{1,2}),? (?:at )?)?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(s);
  if (!m) return null;
  let h = Number(m[3]);
  const min = Number(m[4] ?? 0);
  const ampm = m[5]?.toLowerCase();
  if (!ampm && m[4] === undefined) return null; // a bare number isn't a time
  if (h > 23 || min > 59 || (ampm && (h < 1 || h > 12))) return null;
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  const zone = /\(([A-Za-z_]+\/[A-Za-z_/+-]+|UTC)\)/.exec(s)?.[1] ?? null;
  const [y, mo, d] = today(zone, now);
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (month >= 0) {
    let t = wallTime(y, month, Number(m[2]), h, min, zone, now);
    if (t < now - 86_400_000) t = wallTime(y + 1, month, Number(m[2]), h, min, zone, now);
    return t;
  }
  const t = wallTime(y, mo, d, h, min, zone, now);
  return t > now ? t : wallTime(y, mo, d + 1, h, min, zone, now);
}

/** "in 2h 15m", "in 45 minutes", "in 3 hours": from `now`. */
function inTime(s, now) {
  const m = /\bin (?:(\d+)\s*(?:h|hr|hrs|hours?))?\s*(?:(\d+)\s*(?:m|min|mins|minutes?))?\b/i.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  return now + (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
}

/** When a limit message says it resets, as epoch ms, or null. */
export function resetTime(text, now = Date.now()) {
  const m = /(?:resets?|reset at|resets at|try again|available again|retry)\b([^\n]{0,60})/i.exec(text);
  if (!m) return null;
  return inTime(m[1], now) ?? clockTime(m[1], now);
}

/**
 * A limit at the end of a screen: { kind: 'limit' | 'busy', text, resetAt } (resetAt an ISO time,
 * or null when a usage limit doesn't say), or null. Only the last lines count.
 */
export function findLimit(screen, now = Date.now()) {
  const lines = String(screen ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-8);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const kind = LIMIT.some((re) => re.test(line)) ? 'limit' : BUSY.some((re) => re.test(line)) ? 'busy' : null;
    if (!kind) continue;
    // The reset time is often on the same line, sometimes on the next.
    const at = kind === 'limit' ? resetTime(lines.slice(i, i + 2).join(' '), now) : now + BUSY_RETRY_MS;
    return { kind, text: line.slice(0, 200), resetAt: at ? new Date(at).toISOString() : null };
  }
  return null;
}

/** The first message for an agent that carries on another's work with a different engine. */
export function continuePrompt({ from, engineLabel, limit, intent, branch, brief, digest }) {
  return [
    `Continue this work. ${from} (${engineLabel}) was doing it in this folder${branch ? `, on branch ${branch}` : ''}, and stopped${limit ? ` at a limit ("${limit}")` : ''}.`,
    `The original request:\n${intent}`,
    brief ? `Its brief (what it planned and where it got to):\n${brief.slice(-6000)}` : null,
    digest ? `The end of its conversation:\n${digest.slice(-4000)}` : null,
    "Check `git status` and `git log` to see what is already done, then carry on from there. Don't redo finished work.",
  ]
    .filter(Boolean)
    .join('\n\n');
}
