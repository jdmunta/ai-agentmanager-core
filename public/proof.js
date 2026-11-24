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
  // Its tests tested (Test the tests): how many small breaks in the changed lines they noticed.
  const b = a.breaks;
  const n = (st) => (b?.breaks ?? []).filter((x) => x.status === st).length;
  const tested = b
    ? `<p class="proof-row"><b>Tests tested</b> <span class="tag ${!b.baseline?.ok || n('missed') ? 'proof-bad' : 'proof-ok'}" title="Lines of the change broken one at a time, and the tests run on each">${!b.baseline?.ok ? 'the tests fail as it is' : `${n('caught')} of ${n('caught') + n('missed')} breaks caught`}</span>${doc?.entries ? '' : ' <button class="small" data-act="proof-open">Open</button>'}</p>`
    : finished && !doc?.entries
      ? '<p class="hint proof-row">Do its tests notice a mistake? <button class="small" data-act="proof-open">Test its tests</button></p>'
      : '';
  return notDone + riskRows(a, esc, finished) + proof + tested;
}

/** The pre-mortem: the risks the agent named before starting, and how each ended. */
export function riskRows(a, esc, finished) {
  const risks = a.brief?.risks ?? [];
  if (!risks.length) return '';
  const n = (st) => risks.filter((r) => r.state === st).length;
  const mark = { avoided: ['proof-ok', 'Avoided'], happened: ['proof-bad', 'Happened'], open: ['', finished ? 'Not checked' : 'Open'] };
  const head = finished ? `${n('avoided')} avoided${n('happened') ? `, ${n('happened')} happened` : ''}${n('open') ? `, ${n('open')} not checked` : ''}` : `${risks.length} named`;
  return `<details class="risks"${n('happened') || (finished && n('open')) ? ' open' : ''}><summary><b>Risks it named before starting</b> <span class="hint">${head}</span></summary><ul>${risks.map((r) => `<li><span class="tag ${mark[r.state][0]}">${mark[r.state][1]}</span> ${esc(r.text)}</li>`).join('')}</ul></details>`;
}

export function initProof({ dialog, api, esc, toast, ago, agentOf }) {
  let id = null;
  let view = null;
  let stamp = '';
  let breaks = null; // Test the tests: the view of /breaks
  let trace = null; // Requirement trace: each point of what done means, followed to what shows it
  let command = ''; // the test command typed here, kept over redraws
  const stampOf = (a) => `${a.proofDoc?.updatedAt ?? ''}|${a.proof?.at ?? ''}|${a.breaks?.at ?? ''}|${a.breaks?.sentAt ?? ''}`;

  /** Requirement trace: each point of what done means, what the scorecard found, the checks recorded for it, and what is missing. */
  function traceHtml() {
    const t = trace;
    if (!t?.rows.length) return '';
    const word = { met: ['proof-ok', 'Met'], not_met: ['proof-bad', 'Not met'], unverified: ['', 'Not verified'], unscored: ['', 'Not scored yet'] };
    const again = { same: 'the same result when run again', differs: 'a different result when run again', skipped: 'not run again' };
    const row = (r) => `<li class="${r.gap ? 'trace-gap' : ''}">
      <div class="proof-title"><span class="tag">${esc(r.id)}</span> ${esc(r.text)}</div>
      <div><span class="tag ${word[r.status][0]}">${word[r.status][1]}</span> <span class="hint">by the scorecard${r.evidence ? `: ${esc(r.evidence)}` : ''}</span></div>
      ${r.proof.map((p) => `<div class="trace-check">${p.command ? `<code class="proof-cmd">${esc(p.command)}</code>${p.exit === null ? '' : ` <span class="hint">exit ${p.exit}</span>`}${p.rerun ? ` <span class="hint">· ${again[p.rerun]}</span>` : ''}` : `<span class="hint">By reading${p.note ? `: ${esc(p.note)}` : ''}</span>`}</div>`).join('')}
      ${r.gap ? `<p class="trace-missing"><b>Gap</b> ${esc(r.gap)}</p>` : '<p class="hint">Shown by a recorded run.</p>'}
    </li>`;
    return `<h3 class="breaks-head trace-head">What done means, traced</h3>
      <p class="hint">${t.source === 'agreed' ? 'Each point you agreed on' : "Each of the scorecard's criteria (no points were agreed)"}, followed to what shows it: the scorecard's finding and the checks recorded for it. <b>${t.counts.shown} of ${t.counts.points}</b> ${t.counts.points === 1 ? 'is' : 'are'} shown by a recorded run${t.counts.gaps ? `; <b>${t.counts.gaps}</b> ${t.counts.gaps === 1 ? 'has' : 'have'} a gap` : ''}.</p>
      <ul class="trace-list">${t.rows.map(row).join('')}</ul>`;
  }

  /** Test the tests: the last run, the command, and the buttons. */
  function breaksHtml() {
    const v = breaks;
    if (!v) return '';
    const m = v.last;
    const mark = { caught: ['proof-ok', 'Caught'], missed: ['proof-bad', 'Not noticed'], skipped: ['', 'Not tried'] };
    const row = (b) => `<li>
      <div class="proof-title"><span class="tag ${mark[b.status][0]}">${mark[b.status][1]}</span> ${esc(b.file)}:${b.line} <span class="hint"><code>${esc(b.from)}</code> became <code>${esc(b.to)}</code></span></div>
      <code class="proof-cmd">${esc(b.before.trim())}</code>
      ${b.status === 'missed' ? '<p class="hint">The tests still passed with this line wrong: nothing checks it.</p>' : ''}
      ${b.status === 'caught' && b.stopped ? '<p class="hint">The tests did not finish with this line wrong, which counts as caught.</p>' : ''}
      ${b.status === 'skipped' ? `<p class="hint">${esc(b.why)}</p>` : ''}
    </li>`;
    const last = !m
      ? ''
      : !m.baseline.ok
        ? `<p class="hint">Run ${ago(m.at)} with <code>${esc(m.commands.join(' && '))}</code>: the tests fail before anything is changed (exit ${m.baseline.code ?? 'none, stopped'}), so there is nothing to compare with.</p><pre class="proof-out bad">${esc(m.baseline.tail ?? '')}</pre>`
        : `<p class="hint">${m.stale ? 'Before the latest changes: ' : ''}Run ${ago(m.at)} with <code>${esc(m.commands.join(' && '))}</code>: <b>${esc(v.line)}</b>.${m.sentAt ? ` The ones not noticed were sent to the agent ${ago(m.sentAt)}.` : ''}</p>
           ${m.breaks.length ? `<ul class="breaks-list">${m.breaks.map(row).join('')}</ul>` : ''}
           ${m.restored === false ? '<p class="hint proof-warn">The folder is not as it was before the run: look at its changes.</p>' : ''}`;
    return `<h3 class="breaks-head">Test the tests</h3>
      <p class="hint">Do its tests notice a mistake? This breaks the lines the agent changed, one at a time (<code>===</code> becomes <code>!==</code>, <code>&amp;&amp;</code> becomes <code>||</code>, a number goes up by one), runs the tests on each, and puts the line back. A break the tests still pass on is a line nothing checks.</p>
      ${last}
      ${v.canRun ? `<label class="breaks-cmd">The command that runs the tests <input type="text" data-breaks="command" value="${esc(command)}" placeholder="${esc(v.commands.join(' && ') || 'npm test')}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <p class="hint">${v.commands.length ? 'Empty: the passing commands the agent recorded, shown in grey.' : 'The agent recorded no passing test command: type the one that runs the tests.'} It runs in the agent's folder on this computer, without its permission prompts, up to ${v.max + 1} times.</p>` : `<p class="hint">${esc(v.whyNot)}</p>`}
      <div class="breaks-actions">
        ${v.canRun ? `<button type="button" class="small" data-breaks="run" ${v.running ? 'disabled' : ''}>${v.running ? 'Breaking and testing…' : m ? 'Run it again' : 'Break the code and run the tests'}</button>` : ''}
        ${m && !m.stale && m.missed ? `<button type="button" class="small" data-breaks="send" ${v.running ? 'disabled' : ''} title="Sends the lines whose breaks were not noticed, asking for tests that fail when they are wrong">${m.sentAt ? 'Tell the agent again' : 'Tell the agent'}</button>` : ''}
      </div>`;
  }

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
    // Typing the test command goes on over a redraw.
    const typing = document.activeElement?.dataset?.breaks === 'command' ? document.activeElement.selectionStart : null;
    dialog.querySelector('#proof-body').innerHTML = `
      <p class="hint">The agent's own record of what it ran. ${view.passed ? `Its brief ticks ${view.passed} check${view.passed === 1 ? '' : 's'} as passed; ` : ''}${view.counts.commands} ${view.counts.commands === 1 ? 'has' : 'have'} a command and output here.</p>
      ${view.notDone.length ? `<div class="not-done"><b>Not done, as the agent says</b><ul>${view.notDone.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
      ${view.entries.length ? `<ul class="proof-list">${view.entries.map(entry).join('')}</ul>` : '<p class="hint">Nothing recorded yet.</p>'}
      ${view.rerun ? `<p class="hint">${view.rerun.stale ? 'The last run here was before the agent changed its proof.' : `Run again here ${ago(view.rerun.at)}: ${view.rerun.same} same, ${view.rerun.differs} different${view.rerun.skipped ? `, ${view.rerun.skipped} not run` : ''}.`}</p>` : ''}
      ${!view.canRun && view.counts.commands ? `<p class="hint">${esc(view.whyNot)}</p>` : ''}
      ${traceHtml()}
      ${breaksHtml()}`;
    if (typing !== null) {
      const input = dialog.querySelector('[data-breaks="command"]');
      input?.focus();
      input?.setSelectionRange(typing, typing);
    }
    const btn = dialog.querySelector('[data-proof="run"]');
    btn.hidden = !view.canRun || !n;
    btn.disabled = view.running;
    btn.textContent = view.running ? 'Running…' : `Run ${n === 1 ? 'it' : `these ${n}`} again here`;
    btn.title = 'Runs the commands above in the agent\'s folder on this computer, without its permission prompts. Read them first.';
  }

  async function load() {
    stamp = stampOf(agentOf(id) ?? {});
    try {
      [view, breaks, trace] = await Promise.all([api('GET', `/agents/${id}/proof`), api('GET', `/agents/${id}/breaks`), api('GET', `/agents/${id}/trace`)]);
    } catch (e) {
      toast(`Error: ${e.message}`, 5000);
    }
    render();
  }

  dialog.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-proof]')?.dataset.proof;
    if (act === 'close') return dialog.close();
    const b = e.target.closest('button[data-breaks]')?.dataset.breaks;
    if (b && id && breaks) {
      const send = b === 'send';
      breaks.running = true;
      render();
      try {
        breaks = await api('POST', `/agents/${id}/breaks/${send ? 'send' : 'run'}`, send ? undefined : { command: command.trim() || undefined });
        const m = breaks.last;
        toast(send ? 'Sent to the agent' : !m.baseline.ok ? 'The tests fail before anything is changed' : m.missed ? `${m.missed} of ${m.tried} breaks were not noticed` : m.tried ? `All ${m.tried} breaks were caught` : 'No line of the change could be broken in a small way', 5000);
      } catch (err) {
        if (breaks) breaks.running = false;
        toast(`Error: ${err.message}`, 6000);
      }
      stamp = stampOf(agentOf(id) ?? {});
      return render();
    }
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
  dialog.addEventListener('input', (e) => {
    if (e.target.dataset?.breaks === 'command') command = e.target.value;
  });
  dialog.addEventListener('close', () => ((id = null), (view = null), (breaks = null), (trace = null), (command = '')));

  return {
    open(agentId) {
      id = agentId;
      view = null;
      breaks = null;
      command = '';
      dialog.querySelector('#proof-title').textContent = 'Proof';
      dialog.querySelector('#proof-body').innerHTML = '<p class="hint">Loading…</p>';
      dialog.querySelector('[data-proof="run"]').hidden = true;
      if (!dialog.open) dialog.showModal();
      return load();
    },
    /** The agent changed its proof while the dialog is open. */
    agentChanged(a) {
      if (id === a.id && view && !view.running && !breaks?.running && stampOf(a) !== stamp) load();
    },
  };
}
