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

  // To review: finished, or a pull request ready to merge.
  if (a.readFirst) out.review.push(`${LEVEL[a.readFirst.level]}${a.readFirst.reasons?.[0] ? `: ${clip(a.readFirst.reasons[0].text, 120)}` : ''}`);
  for (const p of open.filter((p) => p.land === 'ready')) out.review.push(`Pull request ${prNo(p)} is ready to merge`);

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

export function initGlance({ $, esc, ago, agents, openAgent, readFirst }) {
  const dlg = $('#glance-dialog');
  let showIdle = false;

  function render() {
    const g = glance(agents.values());
    const n = g.counts.act + g.counts.fix;
    const badge = $('#glance-count');
    badge.textContent = n || '';
    badge.title = n ? `${g.counts.act} need you now, ${g.counts.fix} to fix` : '';
    if (!dlg.open) return;
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
    if (!dlg.open) dlg.showModal();
    render();
  }
  $('#glance-btn').onclick = () => open();
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-gl="close"]')) return dlg.close();
    if (e.target.closest('[data-gl-idle]')) return ((showIdle = true), render());
    if (e.target.closest('[data-gl-readfirst]')) return (dlg.close(), readFirst());
    const it = e.target.closest('[data-gl-agent]');
    if (it) return (dlg.close(), openAgent(it.dataset.glAgent));
  });
  dlg.addEventListener('keydown', (e) => {
    const it = e.target.closest?.('[data-gl-agent]');
    if (it && e.key === 'Enter') (dlg.close(), openAgent(it.dataset.glAgent));
  });
  return { open, render, isOpen: () => dlg.open };
}
