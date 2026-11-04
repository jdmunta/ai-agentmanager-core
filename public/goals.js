// Goals (top of the Backlog tab): outcomes for today or this week across projects, planned into
// backlog tasks and seen through by agents, with completed / pending / follow-ups kept current.

const STATUS = { planning: 'planning…', review: 'plan ready', running: 'in progress', checking: 'checking the outcome…', done: 'done', stopped: 'stopped', error: "couldn't plan" };
const PERIOD = { day: 'Today', week: 'This week', none: 'No deadline' };

export function initGoals({ api, esc, toast, $, ago, getProjects, rerender }) {
  let goals = [];
  const openGoals = new Set(); // cards expanded in this browser session

  const due = (g) => {
    if (!g.due) return '';
    const d = new Date(g.due);
    const label = g.period === 'day' ? 'today' : `by ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
    return `<span class="${g.overdue ? 'fail' : 'hint'}">${g.overdue ? `overdue (was due ${esc(d.toLocaleDateString())})` : esc(label)}</span>`;
  };
  const prLinks = (r) => r.prs.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener">#${esc(p.url.split('/').pop())}${p.state && p.state !== 'OPEN' ? ` ${esc(p.state.toLowerCase())}` : ''}</a>`).join(' ');
  const row = (r, extra = '') => `<li><span class="goal-task">${esc(r.title.split('\n')[0])}</span> <span class="hint">${esc(r.project ?? '')}${r.agentId ? ` · <a href="#${esc(r.agentId)}">${esc(r.agentName ?? r.agentId)}</a>` : ''}</span> ${prLinks(r)}${extra}</li>`;

  function card(g) {
    const c = g.counts;
    const open = openGoals.has(g.id) || g.status === 'review' || g.status === 'error';
    const pct = c.total ? Math.round((c.completed / c.total) * 100) : 0;
    const s = g.summary;
    const body = [];
    if (g.status === 'error') body.push(`<p class="error">${esc(g.error ?? '')}</p><div class="need-actions"><button class="small primary" data-goal-act="replan">Plan again</button><button class="small ghost" data-goal-act="remove">Remove</button></div>`);
    if (g.status === 'review') {
      body.push(`<p class="hint">The plan: one agent per task. Untick what you don't want, then start.${g.note ? ` ${esc(g.note)}` : ''}</p>
        <ul class="goal-plan">${g.plan.map((t, i) => `<li><label><input type="checkbox" data-goal-task="${i}" checked> <span class="tag">${esc(t.project)}</span> ${esc(t.title)}</label></li>`).join('')}</ul>
        <div class="need-actions"><button class="small primary" data-goal-act="approve">Start ${g.plan.length} agent${g.plan.length === 1 ? '' : 's'}</button><button class="small ghost" data-goal-act="replan">Plan again</button><button class="small ghost" data-goal-act="remove">Remove</button></div>`);
    }
    if (c.total) {
      if (s.followUps.length) body.push(`<p class="goal-h fail">Follow-ups (${s.followUps.length})</p><ul class="goal-list">${s.followUps.map((r) => row(r, `<div class="hint">${esc(r.why)}</div>`)).join('')}</ul>`);
      if (s.pending.length) body.push(`<p class="goal-h">Pending (${s.pending.length})</p><ul class="goal-list">${s.pending.map((r) => row(r, ` <span class="tag">${esc(r.state)}</span>`)).join('')}</ul>`);
      if (s.completed.length) body.push(`<p class="goal-h">Completed (${s.completed.length})</p><ul class="goal-list">${s.completed.map((r) => row(r)).join('')}</ul>`);
    }
    const last = g.checks?.at(-1);
    if (last) body.push(`<p class="hint">Outcome check ${last.met === false ? `found more to do (${last.tasks} task${last.tasks === 1 ? '' : 's'} added)` : last.met ? 'says it is met' : ''}${last.reason ? `: ${esc(last.reason)}` : ''}</p>`);
    const actions = [
      c.total ? '<button class="small ghost" data-goal-act="copy" title="Completed, pending and follow-ups as Markdown">Copy summary</button>' : '',
      g.period !== 'none' && g.overdue ? `<button class="small ghost" data-goal-act="extend">Carry over to ${g.period === 'day' ? 'tomorrow' : 'next week'}</button>` : '',
      ['running', 'checking', 'planning'].includes(g.status) ? '<button class="small ghost" data-goal-act="stop" title="Cancel its queued tasks; work in progress goes on">Stop</button>' : '',
      ['done', 'stopped'].includes(g.status) ? '<button class="small ghost" data-goal-act="remove">Remove</button>' : '',
    ].join('');
    return `<li class="goal ${esc(g.status)} ${g.overdue ? 'overdue' : ''}" data-goal="${esc(g.id)}">
      <button class="goal-head" data-goal-act="toggle" aria-expanded="${open}">
        <span class="caret">${open ? '▾' : '▸'}</span><span class="goal-title">🎯 ${esc(g.title)}</span>
        <span class="pill ${g.status === 'done' ? 'done' : g.status === 'error' ? 'error' : c.followUps ? 'attention' : 'working'}">${STATUS[g.status] ?? esc(g.status)}</span>
      </button>
      <div class="goal-meta">${due(g)} <span class="hint">${esc(g.projects.join(', '))}</span>
        ${c.total ? `<span class="goal-bar" title="${pct}% completed"><span style="width:${pct}%"></span></span><span>${c.completed} completed · ${c.pending} pending · <span class="${c.followUps ? 'fail' : ''}">${c.followUps} follow-up${c.followUps === 1 ? '' : 's'}</span></span>` : ''}</div>
      ${open ? `<div class="goal-body">${body.join('')}${actions ? `<div class="need-actions">${actions}</div>` : ''}</div>` : ''}
    </li>`;
  }

  function html() {
    const shown = goals.filter((g) => g.status !== 'done' || Date.now() - Date.parse(g.doneAt ?? 0) < 3 * 86_400_000);
    return `<div class="goals">
      <div class="goals-head"><b>Goals</b><span class="hint">outcomes agents work toward until they're done</span><span class="spacer"></span><button class="link" data-goal-act="new">+ Goal</button></div>
      ${shown.length ? `<ul class="goal-cards">${shown.map(card).join('')}</ul>` : ''}
    </div>`;
  }

  // New goal dialog.
  const dlg = $('#goal-dialog');
  const f = $('#goal-form');
  function openNew() {
    const projects = getProjects();
    $('#goal-projects').innerHTML = projects.length
      ? projects.map((p) => `<label class="goal-proj"><input type="checkbox" name="project" value="${esc(p.shortcut)}"> <span class="shortcut">${esc(p.shortcut)}</span> ${esc(p.name)}</label>`).join('')
      : '<p class="hint">No projects yet: start an agent in a repo or folder first, or add one with <code>agentmgr project add</code>.</p>';
    if (projects.length === 1) $('#goal-projects input').checked = true;
    $('#goal-error').hidden = true;
    dlg.showModal();
    f.text.focus();
  }
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const projects = [...f.querySelectorAll('input[name="project"]:checked')].map((x) => x.value);
    try {
      const g = await api('POST', '/goals', { text: f.text.value, period: f.period.value, projects, review: f.review.checked, priority: Number(f.priority.value) });
      goals = [g, ...goals.filter((x) => x.id !== g.id)];
      openGoals.add(g.id);
      dlg.close();
      f.text.value = '';
      toast(f.review.checked ? 'Planning it; the plan shows here for you to start' : 'Planning it; agents start as tasks are queued');
      rerender();
    } catch (err) {
      $('#goal-error').hidden = false;
      $('#goal-error').textContent = err.message;
    }
  });
  $('#goal-cancel').onclick = () => dlg.close();

  async function onClick(e) {
    const el = e.target.closest('[data-goal-act]');
    if (!el) return false;
    e.preventDefault();
    const act = el.dataset.goalAct;
    if (act === 'new') return openNew(), true;
    const id = el.closest('[data-goal]')?.dataset.goal;
    const g = goals.find((x) => x.id === id);
    if (!g) return true;
    const run = async (fn, msg) => {
      try {
        const v = await fn();
        if (v?.id) goals = goals.map((x) => (x.id === v.id ? v : x));
        if (msg) toast(msg);
      } catch (err) {
        toast(`Error: ${err.message}`, 5000);
      }
      rerender();
    };
    switch (act) {
      case 'toggle':
        openGoals.has(id) ? openGoals.delete(id) : openGoals.add(id);
        return rerender(), true;
      case 'approve': {
        const keep = [...el.closest('[data-goal]').querySelectorAll('[data-goal-task]')].filter((x) => x.checked).map((x) => g.plan[Number(x.dataset.goalTask)]);
        return run(() => api('POST', `/goals/${id}/approve`, { tasks: keep }), `Started ${keep.length} agent${keep.length === 1 ? '' : 's'}`), true;
      }
      case 'replan':
        return run(() => api('POST', `/goals/${id}/replan`), 'Planning it again'), true;
      case 'extend':
        return run(() => api('POST', `/goals/${id}/extend`), 'Carried over'), true;
      case 'stop':
        if (!confirm('Stop this goal? Its queued tasks are cancelled; agents already working go on.')) return true;
        return run(() => api('POST', `/goals/${id}/stop`), 'Goal stopped'), true;
      case 'remove':
        await run(() => api('DELETE', `/goals/${id}`));
        goals = goals.filter((x) => x.id !== id);
        return rerender(), true;
      case 'copy':
        try {
          await navigator.clipboard.writeText((await api('GET', `/goals/${id}/summary`)).markdown);
          toast('Summary copied (Markdown)');
        } catch (err) {
          toast(`Couldn't copy: ${err.message}`, 4000);
        }
        return true;
    }
    return true;
  }

  return {
    set(list) {
      goals = list ?? [];
    },
    html,
    onClick,
    count: () => goals.filter((g) => g.counts?.followUps || g.status === 'review').length,
  };
}
