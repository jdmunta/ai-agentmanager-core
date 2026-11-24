// Acceptance on the page: what "done" means for an agent, as points. The agent drafts them; here
// you reword, remove or add points and agree; after that each point shows what the review
// scorecard found (met, not met, not verified) with its evidence.

const LABEL = { met: 'Met', not_met: 'Not met', unverified: 'Not verified', unchecked: 'Not checked yet' };
const ROW_LABEL = { writing: 'being written', review: 'waiting for you', agreed: 'agreed' };
const MAX_POINTS = 12;

/** Whether the agent is stopped until its points are agreed. */
export const acceptanceWaits = (a) => Boolean(a.acceptance?.wait) && a.acceptance.status === 'review';

/** "3 of 5 met, 1 not met", from the scorecard the agent has (null when it was scored against other points). */
export function acceptanceSummary(a) {
  const acc = a.acceptance;
  if (acc?.status !== 'agreed') return null;
  const sc = a.docs?.scorecard;
  if (!sc?.data || sc.acceptanceAt !== acc.agreedAt) return { text: `${acc.points.length} point${acc.points.length === 1 ? '' : 's'}, not checked yet`, notMet: 0, checked: false };
  const st = (s) => sc.data.criteria.filter((c) => c.status === s).length;
  const notMet = st('not_met');
  const unverified = st('unverified');
  return { text: [`${st('met')} of ${acc.points.length} met`, notMet ? `${notMet} not met` : '', unverified ? `${unverified} not verified` : ''].filter(Boolean).join(', '), notMet, checked: true };
}

/** The row in the brief card: where the points stand, and the way in. */
export function acceptanceRow(a, esc) {
  const acc = a.acceptance;
  if (!acc) {
    // Not asked for: offered once the agent has a spec to take the points from.
    return a.specDocs?.spec ? `<div class="plan-row"><button class="small ghost" data-act="accept-open" title="The points the agent wrote for what done means: change them and agree, and its work is checked against them">What done means</button></div>` : '';
  }
  const sum = acceptanceSummary(a);
  const waiting = acc.wait && acc.status !== 'agreed';
  return `<div class="plan-row acc-row ${acc.status}"><b>Done means</b> <span class="tag acc-${acc.status}${sum?.notMet ? ' acc-bad' : ''}">${esc(sum?.text ?? ROW_LABEL[acc.status])}</span>
    <button class="small ${acc.status === 'review' ? 'primary' : ''}" data-act="accept-open" ${acc.status === 'writing' ? 'disabled' : ''}>${acc.status === 'review' ? 'Review points' : 'Open'}</button>
    ${waiting ? '<button class="small ghost" data-act="accept-skip" title="Stop waiting; the agent goes ahead with the criteria in its own spec">Skip</button>' : ''}</div>`;
}

export function initAcceptance({ dialog, api, esc, toast, ago, agentOf, upsert }) {
  // view: what the server says; edit: the texts being edited (null when only showing results).
  let st = null;

  const editing = () => Boolean(st?.edit);

  function render() {
    if (!st) return;
    const { view: v } = st;
    const a = agentOf(st.id);
    dialog.querySelector('#acc-title').textContent = `What done means: ${a?.name ?? v?.name ?? ''}`;
    const body = dialog.querySelector('#acc-body');
    const actions = dialog.querySelector('#acc-actions');
    if (!v) {
      body.innerHTML = `<p class="hint">${st.error ? esc(st.error) : 'Loading…'}</p>`;
      actions.innerHTML = '<button type="button" class="small" data-acc="close">Close</button>';
      return;
    }
    if (st.edit) {
      const lead =
        v.status === 'agreed'
          ? 'Change the points. The agent is told, and its work is checked against the new ones.'
          : v.wait
            ? 'The agent wrote these and changes nothing until you agree. Reword, remove or add points: they should be things you would check.'
            : st.edit.length
              ? 'The agent wrote these in its spec. Reword, remove or add points and agree: from then on they are yours, and its work is checked against them.'
              : 'The agent has written no points. Add your own: each one a thing you would check when the work is done.';
      body.innerHTML = `<p class="hint">${lead}</p>
        <ol class="acc-edit">${st.edit
          .map((t, i) => `<li><textarea data-acc-point="${i}" rows="2" maxlength="300" aria-label="Point ${i + 1}">${esc(t)}</textarea><button type="button" class="link" data-acc-remove="${i}" title="Take this point out" aria-label="Remove point ${i + 1}">×</button></li>`)
          .join('')}</ol>
        <button type="button" class="small" data-acc="add" ${st.edit.length >= MAX_POINTS ? 'disabled' : ''}>+ Add a point</button>`;
      actions.innerHTML = `${v.wait ? '<button type="button" class="small ghost" data-acc="skip" title="Stop waiting; the agent goes ahead with the criteria in its own spec">Skip</button>' : ''}
        <button type="button" class="small" data-acc="${v.status === 'agreed' ? 'cancel' : 'close'}">${v.status === 'agreed' ? 'Cancel' : 'Close'}</button>
        <button type="button" class="small primary" data-acc="agree" ${st.busy ? 'disabled' : ''}>${v.status === 'agreed' ? 'Agree on these' : v.wait ? 'Agree and start' : 'Agree'}</button>`;
      return;
    }
    if (v.status === 'writing') {
      body.innerHTML = '<p class="hint">The agent is reading the code and writing its points. It changes nothing until you agree on them; they appear here and in the inbox.</p>';
      actions.innerHTML = '<button type="button" class="small ghost" data-acc="skip">Skip</button><button type="button" class="small" data-acc="close">Close</button>';
      return;
    }
    // Agreed: each point with what was found.
    const c = v.counts;
    const head = c.unchecked === c.total ? (v.scoring ? 'Being checked now…' : 'Not checked yet: the work is scored against these when the agent says it is done.') : `Checked ${ago(v.checkedAt)}${v.stale ? ' · the work or the points changed since' : ''}`;
    body.innerHTML = `<p class="hint">Agreed ${ago(v.agreedAt)}. ${esc(head)}</p>
      <ol class="acc-list">${v.results
        .map((r) => `<li><span class="cl-chip acc-chip acc-${r.status}">${LABEL[r.status]}</span> ${esc(r.text)}${r.from === 'you' ? ' <span class="hint">(yours)</span>' : ''}${r.evidence ? `<div class="hint acc-evidence">${esc(r.evidence)}</div>` : ''}</li>`)
        .join('')}</ol>
      <p class="hint">Met, not met and not verified are another model's reading of the changes, with the evidence it gave. A point that is not met holds the work back from “Ready to approve”.</p>`;
    actions.innerHTML = `<button type="button" class="small ghost" data-acc="edit">Change points</button>
      <button type="button" class="small" data-acc="check" ${st.busy || v.scoring ? 'disabled' : ''} title="Score the work against these points now (a separate model call)">${st.busy || v.scoring ? 'Checking…' : c.unchecked === c.total || v.stale ? 'Check now' : 'Check again'}</button>
      <button type="button" class="small primary" data-acc="close">Close</button>`;
  }

  /** Keep what is typed: the list is drawn again on add and remove. */
  function readEdits() {
    if (!st?.edit) return;
    for (const el of dialog.querySelectorAll('[data-acc-point]')) st.edit[Number(el.dataset.accPoint)] = el.value;
  }

  async function load() {
    const id = st.id;
    try {
      const view = await api('GET', `/agents/${id}/acceptance`);
      if (st?.id !== id) return;
      // What was typed while it loaded is read back before the list is drawn again.
      readEdits();
      st.view = view;
      st.error = null;
      // Not agreed yet: straight to the points, to edit. (Typing in progress is kept.)
      if (view.status !== 'agreed' && view.status !== 'writing' && !st.edit) st.edit = view.draft.slice();
      if (view.status === 'none' && !st.edit) st.edit = [];
      if (view.status === 'writing') st.edit = null;
    } catch (e) {
      if (st?.id !== id) return;
      st.error = e.message;
    }
    render();
  }

  async function run(fn, ok) {
    st.busy = true;
    render();
    try {
      const a = await fn();
      if (a?.id) upsert(a);
      if (ok) toast(ok);
      return true;
    } catch (e) {
      toast(`Error: ${e.message}`, 5000);
      return false;
    } finally {
      if (st) st.busy = false;
    }
  }

  dialog.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-acc-remove]');
    if (rm) {
      readEdits();
      st.edit.splice(Number(rm.dataset.accRemove), 1);
      return render();
    }
    const act = e.target.closest('[data-acc]')?.dataset.acc;
    if (!act || !st) return;
    const id = st.id;
    if (act === 'close') return dialog.close();
    if (act === 'add') {
      readEdits();
      st.edit.push('');
      render();
      return dialog.querySelector(`[data-acc-point="${st.edit.length - 1}"]`)?.focus();
    }
    if (act === 'edit') {
      st.edit = st.view.points.map((p) => p.text);
      return render();
    }
    if (act === 'cancel') {
      st.edit = null;
      return render();
    }
    if (act === 'agree') {
      readEdits();
      const points = st.edit.map((t) => t.trim()).filter(Boolean);
      if (!points.length) return toast('Add at least one point', 4000);
      const waited = st.view.wait;
      if (await run(() => api('POST', `/agents/${id}/acceptance/agree`, { points }), waited ? 'Agreed; the agent goes ahead' : 'Agreed; the work is checked against these')) {
        if (st?.id !== id) return;
        st.edit = null;
        await load();
      } else render();
      return;
    }
    if (act === 'skip') {
      if (await run(() => api('POST', `/agents/${id}/acceptance/skip`), 'Not waiting; the agent goes ahead with its own criteria')) dialog.close();
      else render();
      return;
    }
    if (act === 'check') {
      await run(() => api('POST', `/agents/${id}/docs/scorecard`));
      if (st?.id === id) await load();
    }
  });
  dialog.addEventListener('close', () => (st = null));

  return {
    open(id) {
      st = { id, view: null, edit: null, busy: false, error: null };
      render();
      if (!dialog.open) dialog.showModal();
      return load();
    },
    /** The agent changed (new points from it, a new score): show it, unless the person is typing. */
    agentChanged(a) {
      if (st?.id === a.id && !editing() && !st.busy) load();
    },
  };
}
