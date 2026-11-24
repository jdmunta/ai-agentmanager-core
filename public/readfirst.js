// Read first (top bar): finished work waiting for your review, the pieces that need reading most
// first. Each has a level (read closely, look, skim), the reasons as facts the app measured, what
// speaks for it, and where to start. Drawn from the agents as they are, so it stays current.

export const LEVEL = { close: 'Read closely', look: 'Look', skim: 'Skim' };

/** The queue from the page's agents: the ones with a ranking, heaviest first. */
export function queueOf(agents) {
  return [...agents.values()]
    .filter((a) => a.readFirst)
    .sort((x, y) => y.readFirst.score - x.readFirst.score || String(x.brief?.updatedAt).localeCompare(String(y.brief?.updatedAt)));
}

/** In an agent's Results: its level, and the first reasons. */
export function readFirstRow(a, esc) {
  const r = a.readFirst;
  if (!r) return '';
  return `<p class="read-first-row"><b>Review</b> <span class="tag rf-${r.level}" title="How much this needs reading, from what was measured (${r.score} points)">${LEVEL[r.level]}</span> <span class="hint">${esc(r.reasons.slice(0, 2).map((x) => x.text).join(' · ') || r.calm[0] || 'Nothing measured speaks against it')}</span> <button class="small" data-act="readfirst-open">Why</button></p>`;
}

export function initReadFirst({ $, esc, ago, agents, openAgent, openChanges, projectOf, api, toast, understand }) {
  const dlg = $('#readfirst-dialog');
  let only = null; // an agent id: opened from that agent's Results

  function render() {
    const all = queueOf(agents);
    const n = (l) => all.filter((a) => a.readFirst.level === l).length;
    const badge = $('#readfirst-count');
    badge.textContent = n('close') || '';
    badge.title = n('close') ? `${n('close')} to read closely` : '';
    if (!dlg.open) return;
    const items = only ? all.filter((a) => a.id === only) : all;
    const old = all.filter((a) => Date.parse(a.brief?.updatedAt) < Date.now() - 14 * 86_400_000);
    const card = (a) => {
      const r = a.readFirst;
      const pr = Object.values(a.prs ?? {}).find((p) => p.state === 'OPEN');
      return `<li class="rf-item rf-${r.level}">
        <div class="rf-head"><span class="tag rf-${r.level}">${LEVEL[r.level]}</span> <b>${esc(a.name)}</b> <span class="hint">${esc(projectOf(a) ?? '')}${a.brief?.updatedAt ? ` · finished ${ago(a.brief.updatedAt)}` : ''} · ${r.score} points</span></div>
        <div class="rf-title">${esc(String(a.intent ?? '').split('\n')[0].slice(0, 160))}</div>
        ${r.reasons.length ? `<ul class="rf-reasons">${r.reasons.slice(0, only ? 20 : 5).map((x) => `<li>${esc(x.text)} <span class="hint">+${x.points}</span></li>`).join('')}${!only && r.reasons.length > 5 ? `<li class="hint">and ${r.reasons.length - 5} more</li>` : ''}</ul>` : '<p class="hint">Nothing measured speaks against it.</p>'}
        ${r.calm.length ? `<ul class="rf-calm">${r.calm.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
        ${r.start.length ? `<p class="rf-start"><b>Start with</b> ${r.start.map((s) => `<code>${esc(s)}</code>`).join(' ')}</p>` : ''}
        <div class="need-actions"><button class="small primary" data-rf-changes="${a.id}">Review changes</button><button class="small" data-rf-understand="${a.id}" title="Two or three questions about what it does, before you approve it">Check my understanding</button><button class="small" data-rf-agent="${a.id}">Open agent</button><button class="small" data-rf-reviewed="${a.id}" title="You have read it: it leaves the queue until the agent changes its work again">Mark as reviewed</button>${pr ? `<a class="small-link" href="${esc(pr.url)}" target="_blank" rel="noopener">Pull request</a>` : ''}</div>
      </li>`;
    };
    $('#readfirst-body').innerHTML = `
      <p class="hint">${only ? 'Why this piece is ranked as it is.' : `Finished work waiting for your review: ${n('close')} to read closely, ${n('look')} to look at, ${n('skim')} to skim.`} The ranking adds up facts the app measured (high-risk files, the scorecard, checks, whether the tests notice a mistake, what was left out, risks not checked, its own confidence, size). No model decides it. "Skim" means nothing measured speaks against it, not that it is correct.</p>
      ${items.length ? `<ul class="rf-list">${items.map(card).join('')}</ul>` : '<p class="hint issues-empty">No finished work is waiting for review.</p>'}
      ${only && all.length > 1 ? '<p><button class="link" data-rf-all>Show the whole queue</button></p>' : ''}
      ${!only && old.length ? `<p class="hint">${old.length} of these finished more than 14 days ago. <button class="link" data-rf-old title="They leave the queue; each comes back if its agent changes its work again">Mark those as reviewed</button></p>` : ''}`;
  }

  function open(agentId = null) {
    only = agentId;
    if (!dlg.open) dlg.showModal();
    render();
  }
  $('#readfirst-btn').onclick = () => open();
  dlg.addEventListener('click', async (e) => {
    if (e.target.closest('[data-rf="close"]')) return dlg.close();
    const rev = e.target.closest('[data-rf-reviewed]');
    if (rev || e.target.closest('[data-rf-old]')) {
      try {
        const r = await api('POST', '/read-first/reviewed', rev ? { agent: rev.dataset.rfReviewed } : { olderThanDays: 14 });
        toast(`${r.marked} marked as reviewed`);
        // (Each agent's update arrives by itself and redraws the queue.)
        if (only) only = null;
      } catch (err) {
        toast(`Error: ${err.message}`, 6000);
      }
      return render();
    }
    if (e.target.closest('[data-rf-all]')) return open();
    const us = e.target.closest('[data-rf-understand]');
    if (us) return understand(us.dataset.rfUnderstand);
    const ch = e.target.closest('[data-rf-changes]');
    const ag = e.target.closest('[data-rf-agent]');
    if (ch || ag) {
      dlg.close();
      return ch ? openChanges(ch.dataset.rfChanges) : openAgent(ag.dataset.rfAgent);
    }
  });
  return { open, render, isOpen: () => dlg.open };
}
