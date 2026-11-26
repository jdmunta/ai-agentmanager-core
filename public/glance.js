// At a glance (top bar): every agent on one line, in groups by what it needs from you: act now,
// fix, review, answer, working, follow up, tidy up, and idle. Each line says why, from what the app
// already knows (prompts, questions, stuck findings, pull requests, the Read first ranking,
// follow-up reminders), so nothing here is a model's guess. The daemon uses the same functions
// for `agentmgr glance` and /glance.

export const GROUPS = {
  act: { label: 'Needs you now', act: 'Answer it' },
  fix: { label: 'To fix', act: 'Look at it' },
  review: { label: 'To review', act: 'Review it' },
  answer: { label: 'To answer', act: 'Answer' },
  working: { label: 'Working', act: null },
  follow: { label: 'Follow up', act: 'Follow up' },
  tidy: { label: 'Tidy up', act: 'Close its session' },
  quiet: { label: 'Idle', act: null },
};
const ORDER = Object.keys(GROUPS);
const LEVEL = { close: 'Read closely', look: 'Look', skim: 'Skim' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s, n = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const prNo = (p) => (p.number ? `#${p.number}` : `#${String(p.url ?? '').split('/').pop()}`);

/** Why an open pull request needs fixing, in words. */
function fixWhy(p) {
  const why = [];
  if (p.checks?.state === 'failed') why.push('checks failing');
  if (p.review === 'CHANGES_REQUESTED') why.push('changes requested');
  if (p.mergeable === 'CONFLICTING' || p.mergeState === 'DIRTY') why.push('merge conflict');
  return why.join(', ') || 'needs fixes';
}

/**
 * One agent's line: { group, why: [reasons, the first is the headline], since }. `a` is the
 * agent's view (manager.view): runtime, prs, readFirst, followUp, stuck, questions and so on.
 */
export function glanceOf(a) {
  const rt = a.runtime ?? {};
  const prs = (Array.isArray(a.prs) ? a.prs : Object.values(a.prs ?? {})).filter((p) => p.source !== 'mentioned');
  const open = prs.filter((p) => p.state === 'OPEN');
  const outcome = a.results?.outcome ?? a.brief?.results?.outcome ?? null;
  const out = { act: [], fix: [], review: [], answer: [], working: [], follow: [], tidy: [] };

  // Needs you now: it is waiting on you.
  if (rt.attention) out.act.push(`Stopped at a ${String(rt.attention).toLowerCase()}`);
  if (rt.waiting) out.act.push(rt.waiting.state === 'error' ? `Shows an error: ${clip(rt.waiting.summary)}` : `Asks: ${clip(rt.waiting.question || rt.waiting.summary)}`);
  if (a.signIn) out.act.push('Waiting for you to sign in');
  if (a.status === 'error') out.act.push(`Stopped with an error${a.error ? `: ${clip(a.error)}` : ''}`);
  for (const s of a.stuck ?? []) out.act.push(`Looks stuck: ${clip(s.title, 100)}`);

  // To fix: its work is held up.
  for (const p of open.filter((p) => p.land === 'fix' || fixWhy(p) !== 'needs fixes')) out.fix.push(`Pull request ${prNo(p)}: ${fixWhy(p)}`);
  if (outcome === 'blocked') out.fix.push(`Blocked${a.results?.blockers?.[0]?.text ? `: ${clip(a.results.blockers[0].text)}` : ''}`);
  for (const c of a.conflicts ?? []) out.fix.push(`Changes the same files as ${c.agent?.name ?? 'another agent'}`);
  // Merged, and its recorded checks no longer pass on the latest main (nightwatch.js).
  if (a.nightWatch?.status === 'broken') out.fix.push(`No longer holds on main: ${clip(a.nightWatch.broken.join('; '), 100)}${a.nightWatch.suspects?.[0] ? ` (since ${clip(`${a.nightWatch.suspects[0].sha} ${a.nightWatch.suspects[0].subject}`, 80)})` : ''}`);
  // Repeats a mistake a lesson of the repository was learned from (echo.js).
  for (const e of Object.values(a.echoes ?? {}).filter((e) => e.repeats && e.state === 'open')) out.fix.push(`Repeats a past mistake: ${clip(e.lesson, 100)}${e.where ? ` (at ${e.where})` : ''}`);
  // Changing code outside what it was asked and planned (fence.js).
  for (const d of a.fence?.drift ?? []) out.fix.push(`Drifting: changes ${d.area} (${plural(d.files.length, 'file')}, ${plural(d.lines, 'line')}), not in its task`);

  // To review: finished, or a pull request ready to merge.
  if (a.readFirst) out.review.push(`${LEVEL[a.readFirst.level]}${a.readFirst.reasons?.[0] ? `: ${clip(a.readFirst.reasons[0].text, 120)}` : ''}`);
  for (const p of open.filter((p) => p.land === 'ready')) out.review.push(`Pull request ${prNo(p)} is ready to merge`);
  // Its self-review says a principle holds and the app's facts say otherwise (checklist.js): read those first, once the work waits for review. A drift is said under To fix.
  const contra = (a.checklist?.items ?? []).filter((i) => i.state === 'yes' && i.app?.verdict === 'contradicts' && !(i.key === 'scope' && a.fence?.drift?.length));
  if (contra.length && a.readFirst) out.review.push(`Its self-review is contradicted: ${clip(contra.map((i) => `${i.label} (${i.app.why})`).join('; '), 140)}`);

  // To answer: questions it asked without stopping (the Inbox), still unanswered.
  const asked = (a.questions ?? []).filter((q) => !q.answer);
  if (asked.length) out.answer.push(`${plural(asked.length, 'question')} it asked without stopping: ${clip(asked[0].question, 100)}`);

  // Working.
  if (rt.planning) out.working.push('Planning');
  else if (rt.busy) out.working.push('Working');
  if (rt.limited) out.working.push(`Paused at a usage limit${rt.limited.resetAt ? ' until it resets' : ''}`);
  if (a.status === 'preparing') out.working.push('Getting ready');

  // Follow up, or tidy up (reminders.js).
  if (a.followUp?.kind === 'followup') out.follow.push(a.followUp.title + (a.followUp.detail ? ` (${clip(a.followUp.detail, 100)})` : ''));
  if (a.followUp?.kind === 'close') out.tidy.push(a.followUp.title);

  const group = ORDER.find((g) => out[g]?.length) ?? 'quiet';
  const why = group === 'quiet' ? [quietWhy(a, prs, outcome)] : [...out[group], ...ORDER.filter((g) => g !== group && g !== 'working').flatMap((g) => out[g] ?? [])];
  return { group, why: [...new Set(why)], since: a.activeAt ?? a.createdAt ?? null };
}

function quietWhy(a, prs, outcome) {
  const merged = prs.filter((p) => p.state === 'MERGED');
  if (merged.length) return `Pull request ${prNo(merged[0])} merged`;
  if (outcome === 'done') return 'Done';
  if (outcome === 'partial') return 'Partly done';
  if (a.runtime?.running) return 'Open, nothing happening';
  return a.status === 'exited' ? 'Its session ended' : 'Stopped';
}

/**
 * Every agent's line, grouped and in order: what needs you first, then by priority and the most
 * recently active. Returns { items, counts, total }.
 */
export function glance(agents) {
  const items = [...agents]
    .filter((a) => a && a.kind !== 'general')
    .map((a) => ({ id: a.id, name: a.name, kind: a.kind, project: a.projectInfo?.name ?? null, title: clip(String(a.intent ?? '').split('\n')[0], 120), priority: a.priority ?? 2, running: Boolean(a.runtime?.running), ...glanceOf(a) }))
    .sort((x, y) => ORDER.indexOf(x.group) - ORDER.indexOf(y.group) || x.priority - y.priority || String(y.since).localeCompare(String(x.since)));
  const counts = Object.fromEntries(ORDER.map((g) => [g, items.filter((i) => i.group === g).length]));
  return { items, counts, total: items.length };
}

/** One sentence for the whole fleet: "14 agents: 2 need you now, 1 to fix, …". */
export function glanceLine({ counts, total }) {
  if (!total) return 'No agents yet.';
  const parts = [
    counts.act && `${counts.act} ${counts.act === 1 ? 'needs' : 'need'} you now`,
    counts.fix && `${counts.fix} to fix`,
    counts.review && `${counts.review} to review`,
    counts.answer && `${counts.answer} with questions to answer`,
    counts.working && `${counts.working} working`,
    counts.follow && `${counts.follow} to follow up`,
    counts.tidy && `${counts.tidy} to tidy up`,
    counts.quiet && `${counts.quiet} idle`,
  ].filter(Boolean);
  return `${plural(total, 'agent')}: ${parts.join(', ')}.`;
}

export function glanceMarkdown(g, { all = false } = {}) {
  const out = ['# At a glance', '', glanceLine(g), ''];
  for (const key of ORDER) {
    const list = g.items.filter((i) => i.group === key);
    if (!list.length || (key === 'quiet' && !all)) continue;
    out.push(`## ${GROUPS[key].label} (${list.length})`, '');
    for (const i of list) out.push(`- **${i.name}**${i.project ? ` · ${i.project}` : ''}: ${i.why.join('; ')}`);
    out.push('');
  }
  if (!all && g.counts.quiet) out.push(`${plural(g.counts.quiet, 'idle agent')} not listed.`);
  return out.join('\n').trimEnd();
}

/** Your calibration (calibration.js), in the Glance dialog. */
export function calibrationHtml(c, esc) {
  const word = { skim: 'skim', look: 'look', close: 'read closely', yes: 'yes', no: 'no' };
  const cell = (g, a, unit = '') => (g == null ? '–' : `${esc(word[g] ?? `${g}${unit}`)} → ${a == null ? '?' : esc(word[a] ?? `${a}${unit}`)}`);
  return `<p><button class="link" data-gl-back>‹ Back to the glance</button></p>
    <h3>Your calibration</h3>
    <ul class="cal-lines">${c.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    ${c.rows.length ? `<table class="cal-table"><tr><th>Agent</th><th>Finishes</th><th>Hours</th><th>Reading</th></tr>${c.rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${cell(r.guess.finish, r.actual.finish)}</td><td>${cell(r.guess.hours, r.actual.hours, 'h')}</td><td>${cell(r.guess.review, r.actual.review)}</td></tr>`).join('')}</table>` : ''}
    <p class="hint">Your guesses stay on this computer. Guess when you start an agent: New agent, Your guess.</p>`;
}

/** Night watch (nightwatch.js), in the Glance dialog: on or off, its hour, Run now, and what it found. */
export function nightHtml(v, esc, ago) {
  const st = { broken: 'No longer holds', holds: 'Holds', skipped: 'Not checked' };
  const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === v.settings.hour ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
  return `<p><button class="link" data-gl-back>‹ Back to the glance</button></p>
    <h3>Night watch</h3>
    <p class="hint">Merged work of the last ${v.settings.days} days: the agent's recorded checks run again against the latest main, in a checkout of their own. Commands that change things are never run.</p>
    <div class="row nw-controls">
      <label class="check"><input type="checkbox" data-nw="enabled"${v.settings.enabled ? ' checked' : ''} /> Every night at</label>
      <select data-nw="hour" aria-label="The hour it runs at">${hours}</select>
      <button class="small" data-nw="run"${v.running ? ' disabled' : ''}>${v.running ? 'Running…' : 'Run now'}</button>
    </div>
    <p class="hint">${v.lastRunAt ? `Last run ${esc(ago(v.lastRunAt))}: ${v.broken} of ${v.runs.length} no longer hold on main.` : 'Not run yet.'}</p>
    ${v.runs.length ? `<ul class="gl-list">${v.runs.map((r) => `<li class="gl-item ${r.status === 'broken' ? 'gl-fix' : r.status === 'holds' ? 'gl-working' : ''}"${r.agentId ? ` data-gl-agent="${esc(r.agentId)}" tabindex="0"` : ''}>
        <div class="gl-head"><b>${st[r.status] ?? esc(r.status)}</b> <span class="hint">${r.number ? `#${r.number} ` : ''}${esc(r.title ?? r.url)}</span></div>
        ${r.why ? `<div class="gl-why hint">${esc(r.why)}</div>` : ''}
        ${(r.results ?? []).filter((x) => x.status === 'differs').map((x) => `<div class="gl-why">${esc(x.title)} <code>${esc(x.command)}</code> exit ${x.code}</div>`).join('')}
        ${r.suspects?.length ? `<div class="gl-more hint">Changed the same files since: ${r.suspects.slice(0, 3).map((x) => esc(`${x.sha} ${x.subject}`)).join(' · ')}</div>` : ''}
      </li>`).join('')}</ul>` : ''}`;
}

export function initGlance({ $, esc, ago, agents, openAgent, readFirst, api }) {
  const dlg = $('#glance-dialog');
  let showIdle = false;
  let aside = null; // 'calibration' or 'night' showing instead of the glance: live updates leave it be

  function render() {
    const g = glance(agents.values());
    const n = g.counts.act + g.counts.fix;
    const badge = $('#glance-count');
    badge.textContent = n || '';
    badge.title = n ? `${g.counts.act} need you now, ${g.counts.fix} to fix` : '';
    if (!dlg.open || aside) return;
    const row = (i) => `<li class="gl-item gl-${i.group}" data-gl-agent="${esc(i.id)}" tabindex="0">
        <div class="gl-head"><b>${esc(i.name)}</b> <span class="hint">${esc(i.project ?? '')}${i.since ? ` · ${ago(i.since)}` : ''}${i.running ? ' · open' : ''}</span></div>
        <div class="gl-why">${esc(i.why[0])}</div>
        ${i.why.length > 1 ? `<div class="gl-more hint">${esc(i.why.slice(1, 3).join(' · '))}${i.why.length > 3 ? ` · and ${i.why.length - 3} more` : ''}</div>` : ''}
        ${i.title && i.title !== i.name ? `<div class="gl-title hint">${esc(i.title)}</div>` : ''}
      </li>`;
    const section = (key) => {
      const list = g.items.filter((i) => i.group === key);
      if (!list.length) return '';
      if (key === 'quiet' && !showIdle) return `<p class="hint">${plural(list.length, 'idle agent')}. <button class="link" data-gl-idle>Show them</button></p>`;
      return `<section class="gl-group"><h3>${GROUPS[key].label} <span class="badge">${list.length}</span>${key === 'review' ? ' <button class="link" data-gl-readfirst>Read first</button>' : ''}</h3><ul class="gl-list">${list.map(row).join('')}</ul></section>`;
    };
    $('#glance-body').innerHTML = `<p class="gl-line">${esc(glanceLine(g))}</p>${g.total ? ORDER.map(section).join('') : ''}${g.counts.act + g.counts.fix + g.counts.review + g.counts.answer + g.counts.follow + g.counts.tidy === 0 && g.total ? '<p class="hint">Nothing to act on.</p>' : ''}`;
  }

  function open() {
    aside = null;
    if (!dlg.open) dlg.showModal();
    render();
  }
  $('#glance-btn').onclick = () => open();
  dlg.addEventListener('click', async (e) => {
    if (e.target.closest('[data-gl="close"]')) return dlg.close();
    if (e.target.closest('[data-gl="calibration"]')) return show('calibration');
    if (e.target.closest('[data-gl="night"]')) return show('night');
    if (e.target.closest('[data-nw="run"]')) {
      e.target.disabled = true;
      e.target.textContent = 'Running…';
      return show('night', () => api('POST', '/night-watch/run', {}));
    }
    if (e.target.closest('[data-gl-back]')) return ((aside = null), render());
    if (e.target.closest('[data-gl-idle]')) return ((showIdle = true), render());
    if (e.target.closest('[data-gl-readfirst]')) return (dlg.close(), readFirst());
    const it = e.target.closest('[data-gl-agent]');
    if (it) return (dlg.close(), openAgent(it.dataset.glAgent));
  });
  // Night watch settings: saved as they change.
  dlg.addEventListener('change', (e) => {
    const k = e.target.dataset?.nw;
    if (k === 'enabled' || k === 'hour') show('night', () => api('PUT', '/night-watch', k === 'enabled' ? { enabled: e.target.checked } : { hour: Number(e.target.value) }));
  });

  /** Calibration or night watch in place of the glance; `first`: a change to make before showing it. */
  async function show(what, first = null) {
    aside = what;
    if (!first) $('#glance-body').innerHTML = `<p class="hint">${what === 'night' ? 'Reading the night watch…' : 'Reading your guesses…'}</p>`;
    try {
      const v = (await first?.()) ?? (await api('GET', what === 'night' ? '/night-watch' : '/calibration'));
      if (aside === what) $('#glance-body').innerHTML = what === 'night' ? nightHtml(v, esc, ago) : calibrationHtml(v, esc);
    } catch (err) {
      if (aside === what) $('#glance-body').innerHTML = `<p><button class="link" data-gl-back>‹ Back to the glance</button></p><p class="error">${esc(err.message)}</p>`;
    }
  }

  dlg.addEventListener('keydown', (e) => {
    const it = e.target.closest?.('[data-gl-agent]');
    if (it && e.key === 'Enter') (dlg.close(), openAgent(it.dataset.glAgent));
  });
  return { open, render, isOpen: () => dlg.open };
}
