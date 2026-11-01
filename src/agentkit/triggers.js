// What starts a run by itself: an interval, a cron schedule, a folder watch. (Webhooks arrive over
// HTTP, see http.js.) Each fires agent.run with a short description of why.
import fs from 'node:fs';

/** One cron field ("*", "5", "1-5", "*\/15", "1,15") against a value. */
function fieldMatches(field, value, min, max) {
  return field.split(',').some((part) => {
    const [range, stepRaw] = part.split('/');
    const step = Number(stepRaw ?? 1) || 1;
    let [lo, hi] = range === '*' ? [min, max] : range.split('-').map(Number);
    if (hi == null) hi = stepRaw ? max : lo;
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/** Whether a five-field cron expression (minute hour day month weekday) matches a time. */
export function cronMatches(expr, d = new Date()) {
  const [mi, h, dom, mon, dow] = String(expr).trim().split(/\s+/);
  return fieldMatches(mi, d.getMinutes(), 0, 59) && fieldMatches(h, d.getHours(), 0, 23) && fieldMatches(dom, d.getDate(), 1, 31) && fieldMatches(mon, d.getMonth() + 1, 1, 12) && fieldMatches(dow, d.getDay(), 0, 6);
}

/** Start the agent's triggers; returns a function that stops them. */
export function startTriggers(agent, { log = () => {} } = {}) {
  const stops = [];
  for (const t of agent.spec.triggers) {
    if (t.kind === 'every') {
      const timer = setInterval(() => agent.run('', { source: t.label }).catch(() => {}), t.ms);
      stops.push(() => clearInterval(timer));
    } else if (t.kind === 'cron') {
      let last = '';
      const timer = setInterval(() => {
        const d = new Date();
        const minute = d.toISOString().slice(0, 16);
        if (minute !== last && cronMatches(t.cron, d)) {
          last = minute;
          agent.run('', { source: t.label }).catch(() => {});
        }
      }, 15_000);
      stops.push(() => clearInterval(timer));
    } else if (t.kind === 'watch') {
      fs.mkdirSync(t.dir, { recursive: true });
      // A burst of changes (an editor saving, a copy) is one run.
      let pending = new Set();
      let timer = null;
      const w = fs.watch(t.dir, (event, file) => {
        if (!file || file.startsWith('.')) return;
        pending.add(file);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const files = [...pending];
          pending = new Set();
          agent.run(`Files changed in ${t.dir}: ${files.join(', ')}`, { source: t.label }).catch(() => {});
        }, 1500);
      });
      stops.push(() => (clearTimeout(timer), w.close()));
    }
    if (t.kind !== 'webhook') log(`trigger: ${t.label}`);
  }
  return () => stops.forEach((s) => s());
}
