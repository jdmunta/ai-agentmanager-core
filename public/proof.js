// Proof on the page: what the agent recorded of its checks (the command, its exit code, the last
// lines of output), what it says it did not do, and the commands run again here when you ask.

/** "3 recorded runs, 1 by reading" for the results card. */
export function proofLine(doc) {
  if (!doc?.entries) return '';
  return `${doc.commands} recorded run${doc.commands === 1 ? '' : 's'}${doc.entries > doc.commands ? `, ${doc.entries - doc.commands} by reading` : ''}`;
}

/** The last run by the app, when it still speaks for the proof as it is now. */
export function rerunOf(a) {
  const r = a.proof;
  if (!r?.results?.length || r.proofAt !== (a.proofDoc?.updatedAt ?? null)) return null;
  const n = (s) => r.results.filter((x) => x.status === s).length;
  return { at: r.at, same: n('same'), differs: n('differs'), skipped: n('skipped') };
}

/** The rows in the results card: what was left out, and the proof with the way in. */
export function proofRows(a, esc) {
  const r = a.results;
  if (!r?.fromAgent) return '';
  const finished = ['done', 'partial'].includes(r.outcome);
  const passed = (a.brief?.checks ?? []).filter((c) => c.state === 'passed').length;
  const doc = a.proofDoc;
  const rr = rerunOf(a);
  const notDone = r.notDone?.length
    ? `<div class="not-done"><b>Not done, as the agent says</b><ul>${r.notDone.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`
    : finished && !r.notDoneSaid
      ? '<p class="hint not-done-none">The agent has not said what it left out.</p>'
      : '';
  const proof = doc?.entries
    ? `<p class="proof-row"><b>Proof</b> <span class="hint">${esc(proofLine(doc))}</span>${rr ? ` <span class="tag ${rr.differs ? 'proof-bad' : 'proof-ok'}" title="The recorded commands, run again on this computer">${rr.differs ? `${rr.differs} different when run again` : `${rr.same} same when run again`}</span>` : ''} <button class="small" data-act="proof-open">Open</button></p>`
    : finished && passed
      ? `<p class="hint proof-row">No proof recorded for its ${passed} passed check${passed === 1 ? '' : 's'}: they are its word.</p>`
      : '';
  return notDone + proof;
}

export function initProof({ dialog, api, esc, toast, ago, agentOf }) {
  let id = null;
  let view = null;
  let stamp = '';
  const stampOf = (a) => `${a.proofDoc?.updatedAt ?? ''}|${a.proof?.at ?? ''}`;

  function render() {
    const a = id && agentOf(id);
    if (!a || !view) return;
    dialog.querySelector('#proof-title').textContent = `Proof: ${a.name}`;
    const mark = { same: ['proof-ok', 'Same result'], differs: ['proof-bad', 'Different result'], skipped: ['', 'Not run again'] };
    const entry = (e) => `<li>
      <div class="proof-title">${esc(e.title)}${e.rerun ? ` <span class="tag ${mark[e.rerun.status][0]}">${mark[e.rerun.status][1]}</span>` : ''}</div>
      ${e.command ? `<code class="proof-cmd">${esc(e.command)}</code>${e.exit === null ? '' : ` <span class="hint">exit ${e.exit}</span>`}` : `<span class="hint">Verified by reading${e.note ? `: ${esc(e.note)}` : ''}</span>`}
      ${e.output ? `<pre class="proof-out">${esc(e.output)}</pre>` : ''}
      ${e.rerun?.status === 'differs' ? `<p class="hint">Run again: exit ${e.rerun.code ?? 'none (stopped)'}${e.rerun.output === 'differs' ? ', and its last recorded line was not printed' : ''}</p><pre class="proof-out bad">${esc(e.rerun.tail ?? '')}</pre>` : ''}
      ${e.rerun?.status === 'same' && e.rerun.output === 'differs' ? '<p class="hint">The same exit code; its last recorded line was not printed this time (durations and dates differ between runs).</p>' : ''}
      ${e.command && !e.runnable ? `<p class="hint">Not run again by the app: ${esc(e.why)}.</p>` : ''}
    </li>`;
    const n = view.entries.filter((e) => e.runnable).length;
    dialog.querySelector('#proof-body').innerHTML = `
      <p class="hint">The agent's own record of what it ran. ${view.passed ? `Its brief ticks ${view.passed} check${view.passed === 1 ? '' : 's'} as passed; ` : ''}${view.counts.commands} ${view.counts.commands === 1 ? 'has' : 'have'} a command and output here.</p>
      ${view.notDone.length ? `<div class="not-done"><b>Not done, as the agent says</b><ul>${view.notDone.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
      ${view.entries.length ? `<ul class="proof-list">${view.entries.map(entry).join('')}</ul>` : '<p class="hint">Nothing recorded yet.</p>'}
      ${view.rerun ? `<p class="hint">${view.rerun.stale ? 'The last run here was before the agent changed its proof.' : `Run again here ${ago(view.rerun.at)}: ${view.rerun.same} same, ${view.rerun.differs} different${view.rerun.skipped ? `, ${view.rerun.skipped} not run` : ''}.`}</p>` : ''}
      ${!view.canRun && view.counts.commands ? `<p class="hint">${esc(view.whyNot)}</p>` : ''}`;
    const btn = dialog.querySelector('[data-proof="run"]');
    btn.hidden = !view.canRun || !n;
    btn.disabled = view.running;
    btn.textContent = view.running ? 'Running…' : `Run ${n === 1 ? 'it' : `these ${n}`} again here`;
    btn.title = 'Runs the commands above in the agent\'s folder on this computer, without its permission prompts. Read them first.';
  }

  async function load() {
    stamp = stampOf(agentOf(id) ?? {});
    try {
      view = await api('GET', `/agents/${id}/proof`);
    } catch (e) {
      toast(`Error: ${e.message}`, 5000);
    }
    render();
  }

  dialog.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-proof]')?.dataset.proof;
    if (act === 'close') return dialog.close();
    if (act !== 'run' || !id || !view) return;
    view.running = true;
    render();
    try {
      view = await api('POST', `/agents/${id}/proof/run`);
      toast(view.rerun.differs ? `${view.rerun.differs} gave a different result` : 'All gave the same result');
    } catch (err) {
      view.running = false;
      toast(`Error: ${err.message}`, 5000);
    }
    render();
  });
  dialog.addEventListener('close', () => ((id = null), (view = null)));

  return {
    open(agentId) {
      id = agentId;
      view = null;
      dialog.querySelector('#proof-title').textContent = 'Proof';
      dialog.querySelector('#proof-body').innerHTML = '<p class="hint">Loading…</p>';
      dialog.querySelector('[data-proof="run"]').hidden = true;
      if (!dialog.open) dialog.showModal();
      return load();
    },
    /** The agent changed its proof while the dialog is open. */
    agentChanged(a) {
      if (id === a.id && view && !view.running && stampOf(a) !== stamp) load();
    },
  };
}
