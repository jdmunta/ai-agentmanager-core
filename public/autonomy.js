// Autonomy on the page: how far an agent goes without you, and what was done for you meanwhile
// (questions answered from what is already decided, nudges sent, a merge made or held). An answer
// given for you shows in the inbox until you say OK or give your own.

export const LEVELS = ['ask', 'run', 'pr', 'merge'];
export const LEVEL_LABEL = { ask: 'Ask me', run: 'Agree, then run', pr: 'Run to pull request', merge: 'Run to merge' };
export const LEVEL_HINT = {
  ask: 'Questions, stuck findings and follow-ups wait for you in the inbox.',
  run: 'You agree on what done means. After that, its questions and its plan are decided for you when the answer is sure and easy to undo, a nudge the judge is sure of is sent, and a quiet agent is told to carry on.',
  pr: 'The same, and its pull request is opened when the review approves the work.',
  merge: 'The same, and the pull request is merged when its checks pass, the scorecard says ready and no high-risk path is touched.',
};
const KIND = { answer: 'Answered', left: 'Left for you', nudge: 'Nudged', followup: 'Told to carry on', plan: 'Plan decided', merge: 'Merged' };

export const levelOf = (a) => (LEVELS.includes(a.autonomy?.level) ? a.autonomy.level : 'ask');

/** "2 answered, 1 nudge, 1 left for you". */
export function logLine(log = []) {
  const n = (k) => log.filter((e) => e.kind === k).length;
  return [n('answer') ? `${n('answer')} answered` : '', n('nudge') ? `${n('nudge')} nudge${n('nudge') === 1 ? '' : 's'}` : '', n('followup') ? `${n('followup')} follow-up${n('followup') === 1 ? '' : 's'}` : '', n('merge') ? 'merged' : '', n('left') ? `${n('left')} left for you` : '']
    .filter(Boolean)
    .join(', ');
}

/** What was decided for you on an agent and you have not seen: inbox items. */
export function autonomyNeeds(a) {
  const st = a.autonomy;
  if (!st) return [];
  const items = (st.log ?? []).filter((e) => e.kind === 'answer' && !e.ack).map((e) => ({ a, kind: 'auto', key: `auto:${a.id}:${e.id}`, e }));
  if (st.hold && !st.hold.ack && st.level === 'merge') items.push({ a, kind: 'auto', key: `auto:${a.id}:hold`, e: { id: 'hold', kind: 'hold', ...st.hold } });
  return items;
}

/** The inbox card of one such item. */
export function autoNeedHtml(it, { esc, ago }) {
  const e = it.e;
  if (e.kind === 'hold') {
    return `<p class="need-title">Not merged: ${esc(e.note)}</p>
      <p class="hint">Held ${ago(e.at)}. Its pull request stays open; merging it is yours.</p>
      <div class="need-actions"><button class="small primary" data-ib="ap-review">Review changes</button><button class="small" data-ib="auto-ok" data-entry="hold">OK</button></div>`;
  }
  return `<p class="need-title">${esc(e.question)}</p>
    <p class="auto-answer"><b>Answered for you:</b> ${esc(e.answer)}</p>
    <p class="hint">${e.basis ? `From: ${esc(e.basis)} · ` : ''}${esc(e.model ?? (e.via === 'decide' ? 'Decide' : 'a model'))}, ${Math.round((e.confidence ?? 0) * 100)}% sure · ${ago(e.at)}.</p>
    <div class="need-actions"><button class="small primary" data-ib="auto-ok" data-entry="${esc(e.id)}">OK</button><button class="small" data-ib="auto-change" data-entry="${esc(e.id)}" title="Give your own answer; the agent is told to apply it and undo what differs">Change answer…</button></div>`;
}

/** The row in the brief card: the level, what was done, and the way in. */
export function autonomyRow(a, esc) {
  const st = a.autonomy;
  if (a.team || a.reviewing || a.hunting || a.fixing || a.builds || a.raceId) return '';
  if (!st || levelOf(a) === 'ask') {
    return `<div class="plan-row"><button class="small ghost" data-act="auto-open" title="Let it go on without you: routine questions answered from what is already decided, nudges sent, and if you choose, its pull request opened or merged">${st?.log?.length ? 'Without you: off' : 'Run without me…'}</button></div>`;
  }
  const line = logLine(st.log);
  const held = st.hold && !st.hold.ack && st.level === 'merge';
  return `<div class="plan-row auto-row"><b>Without you</b> <span class="tag auto-on">${esc(LEVEL_LABEL[st.level])}</span>${line ? ` <span class="hint">${esc(line)}</span>` : ''}${held ? ' <span class="tag acc-bad">merge held</span>' : ''}
    <button class="small" data-act="auto-open">Open</button></div>`;
}

export function initAutonomy({ dialog, api, esc, toast, ago, agentOf, upsert }) {
  let id = null;

  function render() {
    const a = id && agentOf(id);
    if (!a) return;
    const st = a.autonomy ?? { level: 'ask', log: [] };
    const level = levelOf(a);
    dialog.querySelector('#auto-title').textContent = `Without you: ${a.name}`;
    const log = (st.log ?? []).slice().reverse();
    const entry = (e) => {
      const head = `<b>${KIND[e.kind] ?? esc(e.kind)}</b> <span class="hint">${ago(e.at)}</span>`;
      if (e.kind === 'answer') {
        return `<li>${head}<div>${esc(e.question)}</div>
          <div class="auto-answer">→ ${e.corrected ? `<s>${esc(e.answer)}</s> yours: ${esc(e.corrected)}` : esc(e.answer)}</div>
          <div class="hint">${e.basis ? `From: ${esc(e.basis)} · ` : ''}${esc(e.model ?? (e.via === 'decide' ? 'Decide' : 'a model'))}, ${Math.round((e.confidence ?? 0) * 100)}% sure</div>
          ${e.corrected ? '' : `<div class="need-actions">${e.ack ? '' : `<button type="button" class="small" data-auto="ok" data-entry="${esc(e.id)}">OK</button>`}<button type="button" class="small ghost" data-auto="change" data-entry="${esc(e.id)}">Change answer…</button></div>`}</li>`;
      }
      if (e.kind === 'left') return `<li>${head}<div>${esc(e.question)}</div>${e.why ? `<div class="hint">${esc(e.why)}</div>` : ''}</li>`;
      return `<li>${head}<div>${esc(e.title ?? '')}</div>${e.text ? `<div class="hint">${esc(e.text)}</div>` : ''}</li>`;
    };
    dialog.querySelector('#auto-body').innerHTML = `
      <label>How far it goes
        <select data-auto="level">${LEVELS.map((l) => `<option value="${l}" ${l === level ? 'selected' : ''}>${LEVEL_LABEL[l]}</option>`).join('')}</select>
      </label>
      <p class="hint">${LEVEL_HINT[level]}</p>
      <p class="hint">Never done for you: answering a permission prompt, or a question about deleting, publishing, money, credentials or the scope of the task.</p>
      ${st.hold && !st.hold.ack && level === 'merge' ? `<p class="auto-hold"><b>Not merged:</b> ${esc(st.hold.note)} <button type="button" class="small" data-auto="ok" data-entry="hold">OK</button></p>` : ''}
      ${log.length ? `<h4>Done for you</h4><ul class="auto-log">${log.map(entry).join('')}</ul>` : level === 'ask' ? '' : '<p class="hint">Nothing was done for you yet.</p>'}`;
  }

  const run = async (fn, ok) => {
    try {
      const a = await fn();
      if (a?.id) upsert(a);
      if (ok) toast(ok);
    } catch (e) {
      toast(`Error: ${e.message}`, 5000);
    }
    render();
  };

  /** Your own answer to a question that was answered for you. */
  function change(agentId, entryId) {
    const e = agentOf(agentId)?.autonomy?.log?.find((x) => x.id === entryId);
    if (!e) return;
    const text = prompt(`${e.question}\n\nAnswered for you: ${e.answer}\n\nYour answer:`, '');
    if (!text?.trim()) return;
    return run(() => api('POST', `/agents/${agentId}/autonomy/correct`, { entry: entryId, text: text.trim() }), 'Your answer was sent; the agent applies it');
  }
  const ok = (agentId, entryId) => run(() => api('POST', `/agents/${agentId}/autonomy/ack`, { entry: entryId }));

  dialog.addEventListener('change', (e) => {
    if (e.target.dataset.auto !== 'level' || !id) return;
    const level = e.target.value;
    run(() => api('POST', `/agents/${id}/autonomy`, { level }), level === 'ask' ? 'It asks you again' : `${LEVEL_LABEL[level]}: it goes on without you`);
  });
  dialog.addEventListener('click', (e) => {
    const el = e.target.closest('[data-auto]');
    if (!el || !id) return;
    if (el.dataset.auto === 'close') return dialog.close();
    if (el.dataset.auto === 'ok') return ok(id, el.dataset.entry);
    if (el.dataset.auto === 'change') return change(id, el.dataset.entry);
  });
  dialog.addEventListener('close', () => (id = null));

  return {
    open(agentId) {
      id = agentId;
      render();
      if (!dialog.open) dialog.showModal();
    },
    ok,
    change,
    /** The agent changed (a new answer, a new level): show it, unless the level menu is open. */
    agentChanged(a) {
      if (id === a.id && document.activeElement?.dataset?.auto !== 'level') render();
    },
  };
}
