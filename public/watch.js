// Watch: several agents' live sessions side by side on one page, so they can be followed without
// clicking from one to the next. Each tile shows its session at the session's own size, with the
// font scaled to fit the tile; tiles never resize a session. Click a tile to type into it.

const SAVED = 'agentmgr.watch';
const MAX_TILES = 12;
// What a terminal answers to the program's queries (cursor position, colors, focus): never typing.
const REPLY = /^(\x1b\[[\d;?>]*[IOcRnt]|\x1b\][\d;]*[^\x07\x1b]*(\x07|\x1b\\))+$/;
const SHOW = [
  ['running', 'Running agents'],
  ['attention', 'Waiting on you'],
  ['working', 'Working now'],
];

export function initWatch({ agents, $, esc, Terminal, openStream, statusOf, pillText, projectKey, projectLabel, openAgent }) {
  const view = $('#watch-view');
  const grid = $('#watch-grid');
  const tiles = new Map(); // agent id -> { el, xterm, conn, cols, rows, replaying }
  let open = false;
  let prefs = { show: 'running', project: '', hidden: [], cols: 0 };
  try {
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem(SAVED) ?? '{}') };
  } catch {}
  const save = () => {
    try {
      localStorage.setItem(SAVED, JSON.stringify(prefs));
    } catch {}
  };

  /** The agents to show, in a fixed order (oldest first) so tiles don't jump about as they work. */
  function wanted() {
    const all = [...agents.values()].filter((a) => a.runtime?.running);
    const shown = all
      .filter((a) => !prefs.project || projectKey(a) === prefs.project)
      .filter((a) => (prefs.show === 'attention' ? a.runtime.attention : prefs.show === 'working' ? a.runtime.busy || a.runtime.attention : true))
      .filter((a) => !prefs.hidden.includes(a.id));
    shown.sort((x, y) => String(x.createdAt ?? '').localeCompare(String(y.createdAt ?? '')) || x.id.localeCompare(y.id));
    return { all, shown: shown.slice(0, MAX_TILES), more: Math.max(0, shown.length - MAX_TILES) };
  }

  // Line height in xterm is about 1.2 of the font size; monospace glyphs about 0.6 of it wide.
  const LINE = 1.2;
  const GLYPH = 0.6;
  const MIN_FONT = 7;
  const HEAD = 30;
  const GAP = 10;

  /**
   * Fit: as many columns as gives the biggest text with every tile on screen; each tile is then as
   * tall as a screen row. With a fixed number per row, tiles are as tall as their sessions.
   */
  function layout() {
    const fit = !Number(prefs.cols);
    grid.classList.toggle('fit', fit);
    if (!fit) {
      grid.style.gridTemplateColumns = `repeat(${Number(prefs.cols)}, minmax(0, 1fr))`;
      grid.style.removeProperty('--watch-term-h');
    } else {
      const n = Math.max(1, tiles.size);
      const W = grid.clientWidth;
      const H = view.clientHeight - (grid.getBoundingClientRect().top - view.getBoundingClientRect().top) - 16;
      const cols = Math.max(80, ...[...tiles.values()].map((t) => t.cols || 120));
      const rows = Math.max(20, ...[...tiles.values()].map((t) => t.rows || 34));
      let best = { c: 1, font: 0, h: 0 };
      for (let c = 1; c <= Math.min(4, n); c++) {
        const r = Math.ceil(n / c);
        const w = (W - GAP * (c - 1)) / c - 8;
        const h = Math.max(140, (H - GAP * (r - 1)) / r - HEAD);
        const font = Math.min(w / (cols * GLYPH), h / (rows * LINE));
        if (font > best.font) best = { c, font, h };
      }
      grid.style.gridTemplateColumns = `repeat(${best.c}, minmax(0, 1fr))`;
      grid.style.setProperty('--watch-term-h', `${Math.floor(best.h)}px`);
    }
    tiles.forEach(fitFont);
  }

  /** The font that fits the session in its tile; when it can't, the newest lines stay in view. */
  function fitFont(t) {
    const box = t.el.querySelector('.watch-term');
    const w = box.clientWidth - 8;
    if (!(w > 0) || !t.cols) return;
    let size = w / (t.cols * GLYPH);
    if (grid.classList.contains('fit')) size = Math.min(size, (box.clientHeight - 8) / (t.rows * LINE));
    size = Math.max(Number(prefs.cols) ? 5 : MIN_FONT, Math.min(13, Math.floor(size * 10) / 10));
    if (t.xterm.options.fontSize !== size) t.xterm.options.fontSize = size;
  }

  function addTile(a) {
    const el = document.createElement('div');
    el.className = 'watch-tile';
    el.dataset.agent = a.id;
    el.innerHTML = `<div class="watch-head">
        <button class="link watch-name" data-watch="open" title="Open this agent"></button>
        <span class="pill watch-pill"></span>
        <span class="hint watch-what"></span>
        <span class="spacer"></span>
        <button class="link watch-x" data-watch="hide" title="Stop watching this agent (Show all brings it back)">×</button>
      </div>
      <div class="watch-term" title="Click to type into this agent's session"></div>`;
    const xterm = new Terminal({
      cursorBlink: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 9,
      scrollback: 2000,
      theme: { background: '#0f1117' },
      allowProposedApi: true,
    });
    const t = { el, xterm, conn: null, cols: 0, rows: 0, replaying: false };
    xterm.open(el.querySelector('.watch-term'));
    // Only your typing goes to the agent: the session's own terminal already answers its queries.
    xterm.onData((d) => {
      if (t.replaying || REPLY.test(d) || !el.contains(document.activeElement)) return;
      t.conn?.send({ t: 'i', d });
    });
    const size = (cols, rows) => {
      if (!(cols > 0 && rows > 0)) return;
      t.cols = cols;
      t.rows = rows;
      if (xterm.cols !== cols || xterm.rows !== rows) xterm.resize(cols, rows);
      layout();
    };
    t.conn = openStream(
      { agentId: a.id, kind: 'claude' },
      {
        onMessage: (msg) => {
          if (msg.t === 'o') return xterm.write(msg.d);
          if (msg.t === 'hello') {
            xterm.reset();
            size(msg.cols, msg.rows);
            t.replaying = true;
            xterm.write(msg.backlog ?? '', () => (t.replaying = false));
          } else if (msg.t === 'size') size(msg.cols, msg.rows);
          else if (msg.t === 'exit') xterm.write(`\r\n\x1b[2m[session ended with code ${msg.code}]\x1b[0m\r\n`);
        },
        onClose: () => (t.conn = null),
      },
    );
    tiles.set(a.id, t);
    return t;
  }

  function dropTile(id) {
    const t = tiles.get(id);
    if (!t) return;
    t.conn?.close();
    t.xterm.dispose();
    t.el.remove();
    tiles.delete(id);
  }

  function renderBar(all, shown, more) {
    const projects = new Map();
    for (const a of all) projects.set(projectKey(a), projectLabel(a));
    if (prefs.project && !projects.has(prefs.project)) projects.set(prefs.project, prefs.project);
    const hidden = prefs.hidden.filter((id) => agents.get(id)?.runtime?.running).length;
    const waiting = shown.filter((a) => a.runtime.attention).length;
    $('#watch-bar').innerHTML = `
      <b>Watching ${shown.length} of ${all.length} running</b>
      ${waiting ? `<span class="pill attention">${waiting} waiting on you</span>` : ''}
      <select data-watch-set="show" aria-label="Which agents">${SHOW.map(([k, l]) => `<option value="${k}" ${k === prefs.show ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${projects.size > 1 || prefs.project ? `<select data-watch-set="project" aria-label="Project"><option value="">All projects</option>${[...projects].map(([k, l]) => `<option value="${esc(k)}" ${k === prefs.project ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}
      <select data-watch-set="cols" aria-label="Tiles per row" title="Tiles per row">${[[0, 'Fit'], [1, '1 per row'], [2, '2 per row'], [3, '3 per row'], [4, '4 per row']].map(([k, l]) => `<option value="${k}" ${k === Number(prefs.cols) ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${hidden ? `<button class="link" data-watch="unhide">Show all (${hidden} hidden)</button>` : ''}
      ${more ? `<span class="hint">${more} more not shown (at most ${MAX_TILES})</span>` : ''}
      <span class="spacer"></span>
      <button class="small" data-watch="close" title="Back to the agents (Esc)">Close</button>`;
  }

  function render() {
    if (!open) return;
    const { all, shown, more } = wanted();
    renderBar(all, shown, more);
    const ids = new Set(shown.map((a) => a.id));
    for (const id of [...tiles.keys()]) if (!ids.has(id)) dropTile(id);
    shown.forEach((a, i) => {
      const t = tiles.get(a.id) ?? addTile(a);
      // Keep the order without moving tiles that are already in place (a move would redraw them).
      if (grid.children[i] !== t.el) grid.insertBefore(t.el, grid.children[i] ?? null);
      const st = statusOf(a);
      t.el.classList.toggle('attention', st === 'attention');
      t.el.classList.toggle('working', st === 'working');
      const name = t.el.querySelector('.watch-name');
      if (name.textContent !== a.name) name.textContent = a.name;
      const pill = t.el.querySelector('.watch-pill');
      pill.className = `pill watch-pill ${st}`;
      pill.textContent = pillText(st);
      const what = a.runtime.attention || a.progress?.summary || a.synopsis?.text || '';
      const whatEl = t.el.querySelector('.watch-what');
      if (whatEl.textContent !== what) {
        whatEl.textContent = what;
        whatEl.title = what;
      }
    });
    layout();
    $('#watch-empty').hidden = shown.length > 0;
    $('#watch-empty').textContent = all.length
      ? 'No running agent matches. Pick another filter above.'
      : 'No agents are running. Their sessions show up here, side by side, as soon as they start.';
  }

  function show(on) {
    open = on;
    view.hidden = !on;
    document.body.classList.toggle('watching', on);
    $('#watch-btn')?.classList.toggle('active', on);
    if (on) {
      history.replaceState(null, '', '#watch');
      render();
    } else {
      for (const id of [...tiles.keys()]) dropTile(id);
      if (location.hash === '#watch') history.replaceState(null, '', '#');
    }
  }

  view.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-watch]');
    if (!btn) return;
    const id = btn.closest('.watch-tile')?.dataset.agent;
    const what = btn.dataset.watch;
    if (what === 'close') show(false);
    else if (what === 'open' && id) {
      show(false);
      openAgent(id);
    } else if (what === 'hide' && id) {
      prefs.hidden = [...new Set([...prefs.hidden, id])];
      save();
      render();
    } else if (what === 'unhide') {
      prefs.hidden = [];
      save();
      render();
    }
  });
  view.addEventListener('change', (e) => {
    const key = e.target.dataset.watchSet;
    if (!key) return;
    prefs[key] = key === 'cols' ? Number(e.target.value) : e.target.value;
    save();
    render();
    requestAnimationFrame(layout);
  });
  document.addEventListener('keydown', (e) => {
    // Esc closes the page, unless you're typing into a session (Esc belongs to it then).
    if (open && e.key === 'Escape' && !e.target.closest?.('.watch-term')) show(false);
  });
  let fitTimer = null;
  new ResizeObserver(() => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(layout, 60);
  }).observe(view);

  return { show, render, isOpen: () => open };
}
