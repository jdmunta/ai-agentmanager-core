// Reminders about recent agents that went quiet: work that needs a follow-up, or a finished
// agent whose session is still open. They show in the inbox once an agent used in the last few
// days has been quiet for a couple of hours (and isn't already waiting on you for something else):
//   follow-up - open, not finished: nudge it, open it, or close it
//             - closed before it finished, by itself or by the session cap / clean up: resume it
//   close     - finished (brief done, or its pull requests merged) with its session still open
// Agents you closed yourself are left alone. "Later" hides a reminder for a few hours; "Not
// needed" hides it until the agent is used again.
export const REMINDER_DEFAULTS = { enabled: true, quietHours: 2, recentDays: 3, laterHours: 4 };
const HOUR = 3_600_000;

/** Settings from config.json's "reminders", with defaults. */
export function reminderSettings(config = {}) {
  const r = { ...REMINDER_DEFAULTS, ...config.reminders };
  const n = (v, d) => (Number(v) > 0 ? Number(v) : d);
  return { enabled: r.enabled !== false, quietHours: n(r.quietHours, 2), recentDays: n(r.recentDays, 3), laterHours: n(r.laterHours, 4) };
}

const hours = (ms) => {
  const h = Math.floor(ms / HOUR);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} minutes`;
  return h >= 48 ? `${Math.floor(h / 24)} days` : `${h} hour${h === 1 ? '' : 's'}`;
};

/**
 * The reminder for an agent's view now, or null: { kind: 'followup' | 'close', title, detail, since }.
 * `v` is the agent's view (runtime, results, prs, activeAt).
 */
export function reminderFor(v, settings, t = Date.now()) {
  if (!settings.enabled || v.kind === 'assistant' || v.status === 'preparing' || v.builds) return null;
  const rt = v.runtime ?? {};
  if (rt.busy || rt.attention || rt.waiting || rt.planning) return null;
  const active = Date.parse(v.activeAt ?? v.createdAt ?? '') || 0;
  const quiet = t - active;
  if (quiet < settings.quietHours * HOUR || quiet > settings.recentDays * 24 * HOUR) return null;
  const r = v.reminder ?? {};
  if (r.dismissedAt && Date.parse(r.dismissedAt) >= active) return null;
  if (r.laterUntil && Date.parse(r.laterUntil) > t) return null;
  const outcome = v.results?.outcome ?? null;
  const prs = v.prs ?? [];
  const merged = prs.length > 0 && prs.every((p) => p.state === 'MERGED' || p.state === 'CLOSED') && prs.some((p) => p.state === 'MERGED');
  const done = outcome === 'done' || merged;
  const since = new Date(active).toISOString();
  if (rt.running) {
    if (done) return { kind: 'close', title: `${merged ? 'Its pull request merged' : 'Done'} and quiet for ${hours(quiet)}, but its session is still open`, detail: null, since };
    const open = prs.find((p) => p.state === 'OPEN');
    const detail =
      (outcome === 'blocked' && v.results?.blockers?.[0]?.text ? `Blocked: ${v.results.blockers[0].text}` : null) ??
      (open ? `Pull request #${String(open.url ?? '').split('/').pop()} is open${open.land === 'fix' ? ' and needs fixes' : ''}` : null) ??
      (v.git?.dirtyFiles ? `${v.git.dirtyFiles} file${v.git.dirtyFiles === 1 ? '' : 's'} changed, not committed` : null);
    return { kind: 'followup', title: `Quiet for ${hours(quiet)} and not finished`, detail, since };
  }
  // Closed: only when it closed by itself or was closed for you (session cap, clean up).
  const byItself = v.status === 'exited' || v.closedBy === 'cap' || v.closedBy === 'idle' || v.closedBy === 'cleanup';
  if (done || !byItself || !v.sessionId) return null;
  const how = v.closedBy === 'cap' ? 'closed by the session cap' : v.closedBy === 'idle' ? 'closed after being idle' : v.closedBy === 'cleanup' ? 'closed by clean up' : 'its session ended';
  return { kind: 'followup', title: `Not finished, and ${how}`, detail: outcome === 'blocked' && v.results?.blockers?.[0]?.text ? `Blocked: ${v.results.blockers[0].text}` : null, since, closed: true };
}
