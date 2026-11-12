// Updating from the app: a button in the top bar when a newer release is out, and "Update and
// restart" in About. The daemon installs it (git checkout of the release tag, or npm install -g)
// and restarts onto it; this page shows each step, waits for it to come back and reloads. It works the same
// from a phone over remote access: the install runs on the computer.

export function initUpdate({ api, esc, toast, $ }) {
  let state = null;

  function show(s) {
    state = s;
    const btn = $('#update-btn');
    const ready = s?.newer && !s.blocker && !s.updating;
    btn.hidden = !ready;
    if (ready) {
      btn.textContent = `Update to ${s.latest}`;
      btn.title = `Version ${s.latest} is out (you have ${s.current}). Installs it and restarts; running agents resume.`;
    }
    $('#about-auto').checked = s?.check !== false;
    $('#about-install').hidden = !ready;
    // An update started from another page or device: follow it here too.
    if (s?.updating && s.progress?.step === 'install' && !run) {
      run = { phase: 'install', to: s.progress.to, from: s.progress.from, startedAt: Date.parse(s.progress.startedAt), progress: s.progress };
      api('GET', '/about').then((a) => {
        run.pid = a.daemon.pid;
        draw();
        if (!dialog.open) dialog.showModal();
        follow();
      }, () => (run = null));
    }
  }

  async function load() {
    try {
      show(await api('GET', '/update'));
    } catch {
      // An older daemon has no /update.
    }
  }

  // The update window: asks first, then follows the install on the daemon step by step (what npm
  // is doing, how long it has taken), the restart, and the page's reload; an error stays on screen
  // with the command to run by hand.
  const dialog = $('#update-dialog');
  let run = null; // { to, from, pid, phase: 'ask' | 'install' | 'restart' | 'failed' | 'late', progress, startedAt, error, manual }
  let ticking = null;

  const took = (since) => {
    const s = Math.max(0, Math.round((Date.now() - since) / 1000));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  };

  function draw() {
    if (!run) return;
    const { phase, progress: p } = run;
    $('#update-title').textContent = phase === 'ask' ? `Update to ${run.to}?` : phase === 'failed' ? `Update to ${run.to} failed` : `Updating to ${run.to}`;
    const body = $('#update-body');
    const actions = $('#update-actions');
    if (phase === 'ask') {
      body.innerHTML = `<p>Version ${esc(run.to)} is out (you have ${esc(run.from)}).</p>
        <p class="hint">Running agents are closed and resume on the new version. It usually takes a minute or two, and longer when the update spans several releases or many agents are open. You'll see each step here.</p>`;
      actions.innerHTML = '<button type="button" class="ghost" data-up="cancel">Cancel</button><button type="button" class="primary" data-up="go">Update and restart</button>';
      return;
    }
    if (phase === 'failed') {
      body.innerHTML = `<p class="error">${esc(run.error)}</p>
        ${run.manual ? `<p class="hint">Nothing was changed. You can also install it in a terminal:</p><p><code>${esc(run.manual)}</code></p>` : '<p class="hint">Nothing was restarted.</p>'}`;
      actions.innerHTML = '<button type="button" class="ghost" data-up="cancel">Close</button><button type="button" class="primary" data-up="go">Try again</button>';
      return;
    }
    const installing = phase === 'install';
    const fetched = p?.fetched ? `${p.fetched} package${p.fetched === 1 ? '' : 's'} fetched` : '';
    const detail = [fetched, p?.detail].filter(Boolean).join(' · ');
    const step = (state, label, hint = '') => `<li class="${state}"><span>${state === 'done' ? '✓' : state === 'now' ? '●' : '○'}</span><span>${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</li>`;
    body.innerHTML = `<div class="update-bar"><span></span></div>
      <ul class="update-steps">
        ${step(installing ? 'now' : 'done', `Install ${esc(run.to)}${p?.kind === 'git' ? ' (git checkout)' : ' (npm)'}`, installing ? `${took(run.startedAt)}${detail ? ` · ${esc(detail)}` : ''}` : '')}
        ${step(installing ? '' : 'now', 'Restart the daemon', installing ? 'Agents close and resume on the new version' : `${took(run.restartAt)} · closing agents, starting ${esc(run.to)}, resuming them`)}
        ${step('', 'Reload this page')}
      </ul>
      ${phase === 'late' ? '<p class="error">The daemon has not come back yet. Check <code>~/.agentmanager/daemon.log</code>, or run <code>agentmgr restart</code> in a terminal.</p>' : '<p class="hint">Keep this page open; it reloads by itself. Closing it does not stop the update.</p>'}`;
    actions.innerHTML = '<button type="button" class="ghost" data-up="cancel">Hide</button>';
  }

  /** Follow an update that is running on the daemon until this page reloads on the new version. */
  function follow() {
    clearInterval(ticking);
    let busy = false;
    ticking = setInterval(async () => {
      if (!run || busy) return;
      busy = true;
      try {
        if (run.phase === 'install') {
          const s = await api('GET', '/update');
          const p = s.progress;
          if (p) run.progress = p;
          if (p?.step === 'failed') Object.assign(run, { phase: 'failed', error: p.error, manual: p.manual });
          else if (p?.step === 'restart' || (!s.updating && !p)) Object.assign(run, { phase: 'restart', restartAt: Date.now() });
        } else if (run.phase === 'restart' || run.phase === 'late') {
          const a = await api('GET', '/about');
          if (a.daemon.pid !== run.pid) return location.reload();
          if (Date.now() - run.restartAt > 10 * 60_000) run.phase = 'late';
        }
      } catch {
        // No answer: it is restarting.
        if (run.phase === 'install') Object.assign(run, { phase: 'restart', restartAt: Date.now() });
      } finally {
        busy = false;
      }
      if (run.phase === 'failed') {
        clearInterval(ticking);
        $('#update-btn').disabled = $('#about-install').disabled = false;
      }
      draw();
    }, 1000);
  }

  async function start() {
    Object.assign(run, { phase: 'install', startedAt: Date.now(), progress: null, error: null });
    $('#update-btn').disabled = $('#about-install').disabled = true;
    draw();
    try {
      run.pid = (await api('GET', '/about')).daemon.pid;
      const r = await api('POST', '/update');
      if (r.upToDate) {
        dialog.close();
        $('#update-btn').disabled = $('#about-install').disabled = false;
        toast(`${r.current} is the newest release`);
        return load();
      }
      run.to = r.to;
      follow();
    } catch (err) {
      Object.assign(run, { phase: 'failed', error: err.message, manual: null });
      $('#update-btn').disabled = $('#about-install').disabled = false;
      draw();
    }
  }

  function install() {
    if (!state?.newer) return;
    if (!run || run.phase === 'ask' || run.phase === 'failed') run = { phase: 'ask', to: state.latest, from: state.current };
    draw();
    if (!dialog.open) dialog.showModal();
  }

  dialog.addEventListener('click', (e) => {
    const act = e.target.closest('[data-up]')?.dataset.up;
    if (act === 'cancel') dialog.close();
    else if (act === 'go') start();
  });

  /** "Check for updates" in About: the daemon's check, and whether it can update itself. */
  async function check() {
    const s = await api('POST', '/update/check');
    show(s);
    if (!s.newer) return `You have the newest release (${esc(s.current)}).`;
    if (s.blocker) return `Version ${esc(s.latest)} is out. ${esc(s.blocker)}.`;
    return `Version ${esc(s.latest)} is out (you have ${esc(s.current)}). <b>Update and restart</b> installs it; running agents resume.`;
  }

  $('#update-btn').onclick = install;
  $('#about-install').onclick = install;
  $('#about-auto').onchange = async (e) => {
    try {
      show(await api('PUT', '/update', { check: e.target.checked }));
    } catch (err) {
      toast(`Error: ${err.message}`, 5000);
    }
  };
  load();
  // The daemon checks twice a day; look at what it found now and then.
  setInterval(load, 30 * 60_000);
  return { load, check };
}
