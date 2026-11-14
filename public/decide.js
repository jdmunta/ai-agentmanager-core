// Decide: help with the decisions, not only the tasks. What waits for you comes with its options
// and a recommendation; calls you keep making become standing decisions that are handled for you;
// the backlog is ranked by impact; a date at risk is laid out as choices; and past decisions are
// looked back on. The reasoning is the AI judge's, on your own plan.

import { expandButton, expandable } from './expand.js';

const TABS = [['waiting', 'Waiting'], ['handled', 'Handled for you'], ['standing', 'Standing decisions'], ['priority', 'Priority'], ['tradeoffs', 'Dates at risk'], ['lookback', 'Looking back']];
const SAVED = 'agentmgr.decideTab';
const ACTION = { approve: 'approve', changes: 'send back', answer: 'answer' };
const OUTCOME = { revisit: 'Worth another look', held: 'Held up', early: 'Too early to tell' };

/** "92% sure", with what it means. */
export const sure = (c) => (c == null ? '' : `<span class="tag decide-sure ${c >= 0.85 ? 'high' : c >= 0.7 ? 'mid' : 'low'}" title="How sure the recommendation is that you would agree">${Math.round(c * 100)}% sure</span>`);

/** The recommendation as it is shown on an inbox card or in the Decide window. */
/** An option's own words, when they say more than its name. */
const said = (o, esc) => (o.action !== 'approve' && o.text && o.text.trim().toLowerCase() !== o.label.trim().toLowerCase() ? `: ${esc(o.text)}` : '');

export function adviceHtml(b, esc, { full = false } = {}) {
  if (!b) return '';
  if (!b.options.length) return full ? `<p class="hint decide-none">${esc(b.none ?? 'No recommendation.')} <button class="link" data-decide-refresh="${esc(b.key)}">Try again</button></p>` : '';
  const rec = b.options[b.recommend];
  const others = b.options.map((o, i) => ({ o, i })).filter(({ i }) => i !== b.recommend);
  return `<div class="decide-advice" data-decide-brief="${esc(b.key)}">
    <p class="decide-rec"><span class="tag decide-tag">Recommended</span> <b>${esc(rec.label)}</b>${said(rec, esc)} ${sure(b.confidence)}${b.undo === 'hard' ? ' <span class="tag decide-hard" title="Costly to reverse once acted on: it is never decided without you unless one of your standing decisions covers it">hard to undo</span>' : ''}${b.standing ? ' <span class="tag" title="One of your standing decisions applies">standing decision</span>' : ''}</p>
    <p class="decide-why">${esc(b.why)}</p>
    ${full && b.evidence.length ? `<ul class="decide-evidence">${b.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
    ${b.risk ? `<p class="hint"><b>Risk:</b> ${esc(b.risk)}</p>` : ''}
    ${full ? `<ul class="decide-options">${b.options.map((o, i) => `<li class="${i === b.recommend ? 'rec' : ''}"><b>${esc(o.label)}</b>${said(o, esc)}${o.consequence ? ` <span class="hint">→ ${esc(o.consequence)}</span>` : ''}</li>`).join('')}</ul>` : ''}
    <div class="need-actions">
      <button class="small primary" data-decide-apply="${b.recommend}" title="${esc(rec.consequence || 'Do what is recommended')}">${esc(rec.action === 'approve' ? 'Approve' : rec.action === 'changes' ? 'Send back as recommended' : `Answer: ${rec.label}`)}</button>
      ${others.map(({ o, i }) => `<button class="small" data-decide-apply="${i}" title="${esc(o.consequence || o.text || '')}">${esc(o.action === 'approve' ? 'Approve' : o.action === 'changes' ? 'Send back' : o.label)}</button>`).join('')}
      ${b.canRace ? '<button class="small" data-decide-race title="Evidence first: each option is tried by its own agent, and you compare the results side by side (a race)">Try both</button>' : ''}
    </div>
  </div>`;
}

export function initDecide({ api, $, esc, ago, toast, openAgent, openRace, openPlan, onData }) {
  const dialog = $('#decide-dialog');
  const body = $('#decide-body');
  let data = null;
  let tab = 'waiting';
  let again = null;
  let adding = false;
  try {
    tab = localStorage.getItem(SAVED) || 'waiting';
  } catch {}
  if (!TABS.some(([k]) => k === tab)) tab = 'waiting';

  async function load({ quiet = false } = {}) {
    try {
      // Open, the missing rankings and trade-off advice are asked for; a glance for the badge asks nothing.
      data = await api('GET', `/advisor${dialog.open ? '?think=1' : ''}`);
    } catch (e) {
      if (!quiet) toast?.(e.message, 5000);
    }
    badge();
    onData?.(data);
    render();
    // A ranking being written arrives by itself.
    if (dialog.open && (data?.writing || data?.impact.some((p) => p.thinking))) changed(4000);
  }

  function badge() {
    const el = $('#decide-count');
    if (!el || !data) return;
    const n = data.briefs.filter((b) => b.options.length).length + data.offers.length + data.tradeoffs.length;
    el.textContent = n ? String(n) : data.newHandled ? `✓${data.newHandled}` : '';
    el.classList.toggle('ready', !n && Boolean(data.newHandled));
    el.title = n ? `${n} waiting with a recommendation` : data.newHandled ? `${data.newHandled} decided for you since you last looked` : '';
  }

  const typing = () => body.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  const agentLink = (id, name, gone) => (gone || !id ? esc(name ?? '') : `<button class="link" data-decide-agent="${esc(id)}">${esc(name)}</button>`);

  function waitingHtml() {
    const d = data;
    const list = d.briefs
      .map((b) => `<li class="decide-card" data-decide-brief="${esc(b.key)}">
        <div class="decide-card-head"><span class="tag">${b.kind === 'plan' ? 'Plan' : 'Question'}</span> <b>${esc(b.title)}</b><span class="spacer"></span><span class="hint">${esc(b.project)} · ${agentLink(b.agentId, b.agentName)} · ${esc(ago(b.at))}</span></div>
        ${adviceHtml(b, esc, { full: true })}
        ${b.kind === 'plan' ? `<p class="hint"><button class="link" data-decide-plan="${esc(b.agentId)}">Read the plan</button></p>` : ''}
      </li>`)
      .join('');
    return `<p class="hint">Plans waiting for review and agents' questions, each with its options, the one recommended, why, and the risk. ${d.agreement ? `You went with the recommendation ${d.agreement.followed} of ${d.agreement.decided} times.` : ''} ${d.judge.enabled ? `Written by the AI judge (${d.judge.calls} of ${d.judge.cap} calls today, on your own plan).` : '<b>The AI judge is off</b>, so nothing is recommended: turn it on in Settings.'}</p>
      ${list ? `<ul class="decide-list">${list}</ul>` : `<p class="hint issues-empty">${d.writing ? 'Writing a recommendation…' : 'Nothing is waiting for a decision.'}</p>`}`;
  }

  function handledHtml() {
    const list = data.handled
      .map((h) => `<li class="decide-card ${h.isNew ? 'new' : ''}">
        <div class="decide-card-head"><span class="tag">${h.kind === 'plan' ? 'Plan' : 'Question'}</span> <b>${esc(h.title)}</b>${h.isNew ? ' <span class="tag news-new">new</span>' : ''}<span class="spacer"></span><span class="hint">${esc(h.project)} · ${agentLink(h.agentId, h.agentName, h.agentGone)} · ${esc(ago(h.at))}</span></div>
        <p class="decide-rec">${esc(h.did)} ${sure(h.confidence)}</p>
        <p class="decide-why">${esc(h.why)}</p>
        ${h.standingWhen ? `<p class="hint">By your standing decision: when ${esc(h.standingWhen)}.</p>` : '<p class="hint">Within the autonomy you set for this project.</p>'}
      </li>`)
      .join('');
    return `<p class="hint">What was decided without you, newest first, with the reasoning. Each one is also in the decision log (Plan → Decisions). How much may be decided without you is set per project under Standing decisions.</p>
      ${list ? `<ul class="decide-list">${list}</ul>` : '<p class="hint issues-empty">Nothing has been decided for you yet.</p>'}`;
  }

  const ruleWords = (r) => `When ${esc(r.when)} → <b>${esc(ACTION[r.action])}</b>${r.text ? `: ${esc(r.text)}` : ''}`;

  function standingHtml() {
    const d = data;
    const offers = d.offers
      .map((o) => `<li class="decide-card offer"><div class="decide-card-head"><span class="tag decide-tag">A call you keep making</span><span class="hint">${o.kind === 'plan' ? 'Plans' : 'Questions'} · ${esc(o.projectName ?? 'every project')} · seen ${o.count} times</span></div>
        <p class="decide-rec">${ruleWords(o)}</p>
        <div class="need-actions"><button class="small primary" data-decide-offer="accept" data-id="${esc(o.id)}">Make it standing</button><button class="small" data-decide-offer="dismiss" data-id="${esc(o.id)}">No</button></div></li>`)
      .join('');
    const rules = d.standing
      .map((r) => `<li class="decide-card ${r.on === false ? 'off' : ''}"><div class="decide-card-head"><span class="tag">${r.kind === 'plan' ? 'Plans' : 'Questions'}</span><span class="hint">${esc(r.projectName ?? 'every project')} · used ${r.uses ?? 0} time${r.uses === 1 ? '' : 's'}${r.lastUsedAt ? `, last ${esc(ago(r.lastUsedAt))}` : ''}${r.source === 'offered' ? ' · learned from your decisions' : ''}</span><span class="spacer"></span>
          <label class="check decide-on"><input type="checkbox" data-decide-rule-on="${esc(r.id)}" ${r.on === false ? '' : 'checked'} /> on</label><button class="link" data-decide-rule-del="${esc(r.id)}" title="Remove">✕</button></div>
        <p class="decide-rec">${ruleWords(r)}</p></li>`)
      .join('');
    const form = adding
      ? `<form class="plan-form decide-form" data-decide-form="standing">
          <select name="kind" aria-label="For"><option value="plan">For plans</option><option value="question">For questions</option></select>
          <select name="project" aria-label="Project"><option value="">Every project</option>${d.autonomy.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('')}</select>
          <input name="when" placeholder="When… (the plan only updates dependencies and the tests pass)" required minlength="8" />
          <select name="action" aria-label="Do"><option value="approve">approve</option><option value="changes">send back</option><option value="answer">answer</option></select>
          <input name="text" placeholder="What to send back or answer (not needed to approve)" />
          <button class="small primary">Add</button><button type="button" class="small" data-decide="add-cancel">Cancel</button>
        </form>`
      : '<p><button class="small" data-decide="add">+ Add a standing decision</button> <button class="small" data-decide="learn" title="Look through your recent decisions for calls you keep making (one AI judge call)">Look for patterns now</button></p>';
    const autonomy = d.autonomy.length
      ? `<table class="issues decide-autonomy"><tbody>${d.autonomy.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td><select data-decide-level="${esc(p.key)}" aria-label="Autonomy for ${esc(p.name)}">${d.levels.map((l) => `<option value="${l.id}" ${l.id === p.level ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table>`
      : '<p class="hint">No projects yet.</p>';
    return `<p class="hint">A standing decision is a call you made once for all the times it comes up: when it applies, it is carried out for you and reported under Handled for you. Offered when three of your decisions agree; you can also write your own.</p>
      ${offers ? `<ul class="decide-list">${offers}</ul>` : ''}
      ${rules ? `<ul class="decide-list">${rules}</ul>` : '<p class="hint">No standing decisions yet.</p>'}
      ${form}
      <h3 class="decide-h">How much may be decided without you</h3>
      <p class="hint">Per project. <b>Sure</b> means 85% or more; anything hard to undo always waits for you unless a standing decision of yours covers it.</p>
      ${autonomy}`;
  }

  function priorityHtml() {
    const cards = data.impact
      .map((p) => `<div class="plan-project"><div class="plan-project-head"><h3>${esc(p.project.name)}</h3><span class="hint">${p.by === 'judge' ? `Ranked by the AI judge ${sure(p.confidence)}` : p.thinking ? 'Ranked by plain rules; the AI judge is thinking…' : 'Ranked by plain rules (priority, the nearest date, fixes, age)'}</span><span class="spacer"></span>
          <button class="small ${p.inOrder ? '' : 'primary'}" data-decide-impact="${esc(p.project.key)}" ${p.inOrder ? 'disabled' : ''} title="Put the queue in this order${p.items.some((i) => i.suggest != null) ? ' and set the suggested priorities' : ''}; free agents pick from the top">${p.inOrder ? 'The queue is in this order' : 'Use this order'}</button></div>
        <table class="issues decide-impact"><tbody>${p.items.map((i) => `<tr><td class="num hint">${i.rank}</td><td><span class="tag decide-level ${esc(i.level)}">${esc(i.level)}</span></td><td><b>${esc(i.title)}</b><div class="hint">${esc(i.why)}${i.heldUntil ? ` · held until ${esc(i.heldUntil)}` : ''}</div></td><td class="hint nowrap">P${i.priority}${i.suggest != null ? ` → <b>P${i.suggest}</b>` : ''} · ${esc(i.status)}</td></tr>`).join('')}</tbody></table></div>`)
      .join('');
    return `<p class="hint">Each project's open backlog, most valuable first: what is nearest a date, what unblocks other work, what removes risk. The reason is beside each item.</p>
      ${cards || '<p class="hint issues-empty">No open backlog items.</p>'}`;
  }

  function tradeoffsHtml() {
    const cards = data.tradeoffs
      .map((t) => `<div class="plan-project"><div class="plan-project-head"><h3>${esc(t.project.name)}: ${esc(t.stage.label)}</h3><span class="tag plan-${esc(t.stage.status)}">${t.stage.status === 'late' ? 'late' : 'at risk'}</span><span class="hint">${esc(t.stage.date)} · ${esc(t.stage.words)} · ${t.open} open${t.need != null ? `, about ${t.need} days at the pace of ${t.perDay} a day` : ', nothing finished in the last two weeks to judge the pace by'}</span><span class="spacer"></span><button class="link" data-decide="dates">Checklist</button></div>
        <ul class="decide-choices">${t.options.map((o) => `<li class="${o.id === t.recommend ? 'rec' : ''}">
          <div class="decide-choice-head"><b>${esc(o.label)}</b>${o.id === t.recommend ? ` <span class="tag decide-tag">Recommended</span> ${t.by === 'judge' ? sure(t.confidence) : '<span class="hint">(plain rules)</span>'}` : ''}</div>
          <p>${esc(o.what)}</p><p class="hint">${esc(o.consequence)}</p>
          ${o.items ? `<ul class="hint decide-cut">${o.items.map((i) => `<li>${esc(i.title)}</li>`).join('')}</ul>` : ''}
          ${o.id === t.recommend ? `<p class="decide-why">${esc(t.why)}</p>` : ''}
          <button class="small ${o.id === t.recommend ? 'primary' : ''}" data-decide-tradeoff="${esc(t.key)}" data-option="${esc(o.id)}">Do this</button></li>`).join('')}</ul></div>`)
      .join('');
    return `<p class="hint">A date that is at risk or late, as choices. Picking one carries it out (items held, the date moved, or more agents started) and records it in the decision log.</p>
      ${cards || '<p class="hint issues-empty">No date is at risk. Dates are set in Plan → Dates.</p>'}`;
  }

  function lookbackHtml() {
    const l = data.lookback;
    const rows = l.items
      .map((r) => `<li class="decide-card ${esc(r.outcome)}"><div class="decide-card-head"><span class="tag decide-outcome ${esc(r.outcome)}">${OUTCOME[r.outcome]}</span> <b>${esc(r.title)}</b><span class="spacer"></span><span class="hint">${esc(r.project.name)}${r.agentName ? ` · ${agentLink(r.agentId, r.agentName, !r.agentId)}` : ''} · decided ${esc(ago(r.decidedAt))}</span></div>
        <p class="decide-rec">${esc(r.decision)}</p>
        ${r.signs.length ? `<p class="hint">What followed: ${r.signs.map(esc).join('; ')}.</p>` : ''}
        ${r.lesson ? `<p class="decide-why"><b>Next time:</b> ${esc(r.lesson)}</p>` : ''}</li>`)
      .join('');
    return `<div class="plan-bar"><span class="hint">What followed each past decision (plans, answers, designs): ${l.revisit} worth another look, ${l.held} held up. The lessons are given to the next recommendation.${l.lookedAt ? ` Looked ${esc(ago(l.lookedAt))}; again every hour.` : ''}</span><span class="spacer"></span><button class="small" data-decide="lookback">Look now</button></div>
      ${l.lessons.length ? `<div class="decide-lessons"><b>What they taught</b><ul>${l.lessons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${rows ? `<ul class="decide-list">${rows}</ul>` : '<p class="hint issues-empty">Nothing to look back on yet: decisions are looked at two days after they are made.</p>'}`;
  }

  function draw() {
    const d = data;
    const count = d ? { waiting: d.briefs.length, handled: d.newHandled, standing: d.offers.length, tradeoffs: d.tradeoffs.length, lookback: d.lookback.revisit } : {};
    body.innerHTML = `
      <div class="issues-head">
        <h2>Decide</h2>
        <div class="chips" role="tablist">${TABS.map(([k, label]) => `<button class="chip ${k === tab ? 'active' : ''}" role="tab" aria-selected="${k === tab}" data-decide-tab="${k}">${label}${count[k] ? ` <span class="count">${count[k]}</span>` : ''}</button>`).join('')}</div>
        <span class="spacer"></span>
        ${expandButton(dialog)}
        <button class="small" data-decide="close" title="Close (Esc)">Close</button>
      </div>
      ${!d ? '<p class="hint">Loading…</p>' : d.enabled === false ? '<p class="hint issues-empty">Decide is off. Turn it on with <code>"decide": { "enabled": true }</code> in config.json.</p>' : `<div class="issues-scroll decide-scroll">${{ waiting: waitingHtml, handled: handledHtml, standing: standingHtml, priority: priorityHtml, tradeoffs: tradeoffsHtml, lookback: lookbackHtml }[tab]()}</div>`}`;
  }

  // A change from the daemon doesn't take what you are typing.
  function render() {
    if (!dialog.open || typing()) return;
    const top = body.querySelector('.decide-scroll')?.scrollTop ?? 0;
    draw();
    const sc = body.querySelector('.decide-scroll');
    if (sc) sc.scrollTop = top;
  }

  const run = async (fn, done) => {
    try {
      await fn();
      if (done) toast?.(done, 3000);
    } catch (e) {
      toast?.(e.message, 6000);
    }
    document.activeElement?.blur?.();
    await load({ quiet: true });
  };

  /** Carry out an option of a brief, from here or from an inbox card. */
  const apply = (key, option) => run(() => api('POST', '/advisor/briefs/apply', { key, option: Number(option) }), 'Done; it is in the decision log');
  const race = (key) =>
    run(async () => {
      const r = await api('POST', '/advisor/briefs/race', { key });
      if (dialog.open) dialog.close();
      openRace?.(r.race);
    }, 'Each option is being tried by its own agent');
  const refresh = (key) => run(() => api('POST', '/advisor/briefs/refresh', { key }), 'Asking again');

  /** Clicks on a recommendation, wherever it is drawn. True when it was one. */
  function handle(e) {
    const card = e.target.closest('[data-decide-brief]');
    const r = e.target.closest('[data-decide-refresh]');
    if (r) return refresh(r.dataset.decideRefresh), true;
    if (!card) return false;
    const a = e.target.closest('[data-decide-apply]');
    if (a) return apply(card.dataset.decideBrief, a.dataset.decideApply), true;
    if (e.target.closest('[data-decide-race]')) return race(card.dataset.decideBrief), true;
    return false;
  }

  body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-decide-tab]');
    if (t) {
      tab = t.dataset.decideTab;
      try {
        localStorage.setItem(SAVED, tab);
      } catch {}
      if (tab === 'handled' && data?.newHandled) api('POST', '/advisor/seen', {}).catch(() => {});
      return draw();
    }
    if (handle(e)) return;
    const ag = e.target.closest('[data-decide-agent]');
    if (ag) return dialog.close(), openAgent?.(ag.dataset.decideAgent);
    const pl = e.target.closest('[data-decide-plan]');
    if (pl) return dialog.close(), openAgent?.(pl.dataset.decidePlan, { plan: true });
    const of = e.target.closest('[data-decide-offer]');
    if (of) return run(() => api('POST', `/advisor/offers/${of.dataset.id}/${of.dataset.decideOffer}`, {}), of.dataset.decideOffer === 'accept' ? 'It is a standing decision now' : null);
    const del = e.target.closest('[data-decide-rule-del]');
    if (del) return run(() => api('DELETE', `/advisor/standing/${del.dataset.decideRuleDel}`));
    const im = e.target.closest('[data-decide-impact]');
    if (im) return run(() => api('POST', '/advisor/impact/apply', { project: im.dataset.decideImpact }), 'The queue is in this order');
    const tr = e.target.closest('[data-decide-tradeoff]');
    if (tr) return run(() => api('POST', '/advisor/tradeoffs/apply', { key: tr.dataset.decideTradeoff, option: tr.dataset.option }), 'Done, and recorded in the decision log');
    const b = e.target.closest('[data-decide]')?.dataset.decide;
    if (b === 'close') return dialog.close();
    if (b === 'add' || b === 'add-cancel') return (adding = b === 'add'), draw();
    if (b === 'dates') return dialog.close(), openPlan?.('dates');
    if (b === 'lookback') return run(() => api('POST', '/advisor/lookback', {}), 'Looked');
    if (b === 'learn') return run(async () => toast?.((await api('POST', '/advisor/learn', {})).offers.length ? 'Found a call you keep making' : 'No clear pattern in your recent decisions', 4000));
  });

  body.addEventListener('change', (e) => {
    const lv = e.target.closest('[data-decide-level]');
    if (lv) return run(() => api('PUT', '/advisor/autonomy', { project: lv.dataset.decideLevel, level: lv.value }), 'Saved');
    const on = e.target.closest('[data-decide-rule-on]');
    if (on) return run(() => api('POST', `/advisor/standing/${on.dataset.decideRuleOn}`, { on: on.checked }));
  });

  body.addEventListener('submit', (e) => {
    if (e.target.dataset.decideForm !== 'standing') return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    run(async () => {
      await api('POST', '/advisor/standing', { ...f, project: f.project || null });
      adding = false;
    }, 'Added');
  });

  dialog.addEventListener('close', () => {
    if (data?.newHandled && tab === 'handled') load({ quiet: true });
  });

  function open(which) {
    if (dialog.open && !which) return dialog.close();
    if (which && TABS.some(([k]) => k === which)) tab = which;
    if (!dialog.open) dialog.showModal();
    draw();
    load();
  }

  /** The daemon says something changed: the badge and the inbox cards now, the window while open. */
  function changed(ms) {
    clearTimeout(again);
    again = setTimeout(() => load({ quiet: true }), ms ?? (dialog.open ? 300 : 1200));
  }

  expandable(dialog, draw);
  load({ quiet: true });
  return { open, changed, handle, isOpen: () => dialog.open, brief: (key) => data?.briefs.find((b) => b.key === key) ?? null };
}
