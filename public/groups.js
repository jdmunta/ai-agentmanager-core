// Split screen, like editor groups in VS Code: the area beside the agents list splits right or
// down into groups, each showing one agent's session (its Claude session or a shell). The main
// group is the usual panel (the agent's details and terminal); the others are terminals.
// Load a session into a group by dragging an agent onto it (onto its right or bottom edge to split
// there), with the group's picker, or by clicking an agent in the list while that group is active.
// The layout and what each group shows are kept per browser.

const SAVED = 'agentmgr.groups';
const MAX_GROUPS = 6;
// What a terminal answers to the program's queries (cursor position, colors, focus): never typing.
const REPLY = /^(\x1b\[[\d;?>]*[IOcRnt]|\x1b\][\d;]*[^\x07\x1b]*(\x07|\x1b\\))+$/;
const EDGE = 0.25; // a drop this close to a group's right or bottom edge splits it
const isShell = (k) => /^shell(:\d+)?$/.test(k ?? '');

export function initGroups({ $, esc, agents, Terminal, FitAddon, openStream, api, upsert, toast, statusOf, pillText, engineLabel, dragged, openInMain, refitMain }) {
  const root = $('#groups');
  const detail = $('#detail');
  // A layout is a tree: { leaf: id } or { dir: 'row' | 'col', a, b, size } (the first part's share, %).
  let tree = { leaf: 'main' };
  let active = 'main';
  const panes = new Map(); // group id -> { el, xterm, fit, conn, agentId, kind, replaying, exited }
  let seq = 1;

  const save = () => {
    try {
      const shows = Object.fromEntries([...panes].map(([id, p]) => [id, { agentId: p.agentId, kind: p.kind }]));
      localStorage.setItem(SAVED, JSON.stringify({ tree, active, shows }));
    } catch {}
  };
  const leaves = (n = tree) => (n.leaf ? [n.leaf] : [...leaves(n.a), ...leaves(n.b)]);
  const narrow = () => matchMedia('(max-width: 760px)').matches;

  // ------------------------------------------------------------------ panes

  function makePane(id, show = {}) {
    const el = document.createElement('section');
    el.className = 'gpane';
    el.dataset.group = id;
    el.innerHTML = `
      <div class="gbar">
        <span class="pill gpill" hidden></span>
        <button class="link gname" data-g="main" title="Open in the main panel, with its details"></button>
        <select class="gkind" aria-label="Session" hidden></select>
        <span class="spacer"></span>
        <select class="gpick" aria-label="Open a session in this group" title="Open a session in this group"></select>
        <button class="ghost small" data-g="right" title="Split right (Ctrl+\\)">◫</button>
        <button class="ghost small" data-g="down" title="Split down">⬓</button>
        <button class="ghost small" data-g="close" title="Close this group (the agent keeps running)">✕</button>
      </div>
      <div class="gbody">
        <div class="gterm"></div>
        <div class="gempty"><p>Drag an agent here from the list, pick one above, or click one in the list while this group is active.</p><p class="hint">Drop on a group's right or bottom edge to split it there.</p></div>
        <div class="goverlay" hidden><span class="gover-msg"></span> <button class="small primary" data-g="resume"></button></div>
      </div>`;
    const xterm = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      scrollback: 10000,
      theme: { background: '#0f1117' },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    const p = { el, xterm, fit, conn: null, agentId: null, kind: 'claude', replaying: false, exited: false, opened: false };
    xterm.onData((d) => {
      if (p.replaying || REPLY.test(d)) return;
      p.conn?.send({ t: 'i', d });
    });
    xterm.onResize(({ cols, rows }) => p.conn?.send({ t: 'r', cols, rows }));
    new ResizeObserver(() => refit(p)).observe(el.querySelector('.gterm'));
    panes.set(id, p);
    if (show.agentId) load(id, show.agentId, show.kind);
    return p;
  }

  function refit(p) {
    if (!p.opened || !p.agentId || !p.el.isConnected) return;
    try {
      p.fit.fit();
    } catch {}
  }

  /** Show an agent's session (or one of its shells) in a group. */
  function load(id, agentId, kind = 'claude') {
    if (id === 'main') return openInMain(agentId, kind);
    const p = panes.get(id);
    if (!p) return;
    if (p.agentId === agentId && p.kind === kind && p.conn) return p.xterm.focus();
    disconnect(p);
    p.agentId = agentId;
    p.kind = kind;
    p.exited = false;
    p.failed = false;
    if (agents.get(agentId)) connect(p);
    renderPane(id);
    save();
  }

  function connect(p) {
    if (!p.el.isConnected) return;
    if (!p.opened) {
      p.xterm.open(p.el.querySelector('.gterm'));
      p.opened = true;
    }
    p.failed = false;
    p.xterm.reset();
    const conn = openStream(
      { agentId: p.agentId, kind: p.kind },
      {
        onOpen: () => {
          refit(p);
          p.conn?.send({ t: 'r', cols: p.xterm.cols, rows: p.xterm.rows });
        },
        onMessage: (msg) => {
          if (p.conn !== conn) return;
          if (msg.t === 'o') return p.xterm.write(msg.d);
          if (msg.t === 'hello') {
            p.xterm.reset();
            p.replaying = true;
            p.xterm.write(msg.backlog ?? '', () => (p.replaying = false));
          } else if (msg.t === 'error') toast(`Terminal unavailable: ${msg.error}`, 5000);
          else if (msg.t === 'exit') {
            if (isShell(p.kind)) p.exited = true;
            else p.xterm.write(`\r\n\x1b[2m[session exited with code ${msg.code}; session kept]\x1b[0m\r\n`);
            renderPane(groupOf(p));
          }
        },
        onClose: (ev) => {
          if (p.conn !== conn) return;
          p.conn = null;
          p.failed = true;
          if (ev.code === 1008) toast(`Terminal unavailable: ${ev.reason}`, 5000);
        },
      },
    );
    p.conn = conn;
  }

  function disconnect(p) {
    const c = p.conn;
    p.conn = null;
    c?.close();
  }

  const groupOf = (p) => [...panes].find(([, x]) => x === p)?.[0];

  /** Open sessions first (needing you, working, waiting), then the rest, most recent first. */
  function pickList() {
    const rank = (a) => (a.runtime?.attention ? 0 : a.runtime?.running && a.runtime?.busy ? 1 : a.runtime?.running ? 2 : 3);
    return [...agents.values()]
      .filter((a) => a.kind !== 'assistant' && a.workdir)
      .sort((x, y) => rank(x) - rank(y) || String(y.activeAt ?? y.createdAt ?? '').localeCompare(String(x.activeAt ?? x.createdAt ?? '')));
  }

  function renderPane(id) {
    const p = panes.get(id);
    if (!p) return;
    const el = p.el;
    const a = p.agentId && agents.get(p.agentId);
    el.classList.toggle('active', id === active);
    el.classList.toggle('empty', !a);
    const st = a ? statusOf(a) : null;
    el.classList.toggle('attention', st === 'attention');
    const pill = el.querySelector('.gpill');
    pill.hidden = !a;
    if (a) {
      pill.className = `pill gpill ${st}`;
      pill.textContent = pillText(st);
    }
    const name = el.querySelector('.gname');
    const label = a ? `${a.name}${isShell(p.kind) ? ` · shell ${p.kind.split(':')[1] ?? 1}` : ''}` : 'Empty group';
    if (name.textContent !== label) name.textContent = label;
    name.disabled = !a;
    el.querySelector('.gempty').hidden = Boolean(a);
    el.querySelector('.gterm').hidden = !a;

    // The session: the agent's own (named after its engine) or one of its shells.
    const kindSel = el.querySelector('.gkind');
    kindSel.hidden = !a;
    if (a && document.activeElement !== kindSel) {
      const shells = new Set(a.runtime?.shells ?? []);
      if (isShell(p.kind)) shells.add(Number(p.kind.split(':')[1] ?? 1));
      const opts = [['claude', engineLabel(a.engine)], ...[...shells].sort((x, y) => x - y).map((n) => [`shell:${n}`, `Shell ${n}`]), ['shell:new', '+ New shell']];
      const html = opts.map(([k, l]) => `<option value="${k}" ${k === p.kind ? 'selected' : ''}>${esc(l)}</option>`).join('');
      if (kindSel.dataset.html !== html) {
        kindSel.innerHTML = html;
        kindSel.dataset.html = html;
      }
      kindSel.value = p.kind;
    }

    const pick = el.querySelector('.gpick');
    if (document.activeElement !== pick) {
      const html = `<option value="">${a ? 'Open another…' : 'Open a session…'}</option>${pickList()
        .map((x) => `<option value="${x.id}">${esc(x.runtime?.running ? '● ' : '')}${esc(x.name)}${x.runtime?.attention ? ' (needs input)' : ''}</option>`)
        .join('')}`;
      if (pick.dataset.html !== html) {
        pick.innerHTML = html;
        pick.dataset.html = html;
      }
      pick.value = '';
    }

    // A closed session or an exited shell: start it again from here.
    const shell = isShell(p.kind);
    const closed = a && (shell ? p.exited : !a.runtime?.running && a.status !== 'preparing');
    el.querySelector('.goverlay').hidden = !closed;
    if (closed) {
      el.querySelector('.gover-msg').textContent = shell ? 'The shell has exited.' : "This agent's session is closed.";
      el.querySelector('[data-g="resume"]').textContent = shell ? 'Start a new shell' : 'Resume session';
    }
    // The agent's state arrived after the group was restored: connect now.
    if (a && !p.conn && !p.failed && !closed) connect(p);
  }

  // ------------------------------------------------------------------ layout

  function nodeEl(n) {
    if (n.leaf) {
      if (n.leaf === 'main') {
        detail.classList.toggle('gactive', active === 'main');
        return detail;
      }
      const p = panes.get(n.leaf) ?? makePane(n.leaf);
      return p.el;
    }
    const box = document.createElement('div');
    box.className = `gsplit g${n.dir}`;
    const a = nodeEl(n.a);
    const b = nodeEl(n.b);
    a.style.flex = `0 0 calc(${n.size}% - 3px)`;
    b.style.flex = '1 1 0';
    const bar = document.createElement('div');
    bar.className = `gsplitter g${n.dir}`;
    bar.setAttribute('role', 'separator');
    bar.title = 'Drag to resize; double-click to even out';
    bar.addEventListener('pointerdown', (e) => resizeFrom(e, bar, box, n, a));
    bar.addEventListener('dblclick', () => {
      n.size = 50;
      a.style.flex = `0 0 calc(50% - 3px)`;
      save();
      refitAll();
    });
    box.append(a, bar, b);
    return box;
  }

  function resizeFrom(e, bar, box, n, first) {
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing', n.dir === 'row' ? 'cols' : 'rows');
    const move = (ev) => {
      const r = box.getBoundingClientRect();
      const at = n.dir === 'row' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      n.size = Math.round(Math.min(85, Math.max(15, at * 100)));
      first.style.flex = `0 0 calc(${n.size}% - 3px)`;
    };
    const up = () => {
      document.body.classList.remove('resizing', 'cols', 'rows');
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      save();
      refitAll();
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  }

  function refitAll() {
    requestAnimationFrame(() => {
      refitMain();
      for (const p of panes.values()) refit(p);
    });
  }

  /** Rebuild the layout (only when its shape changes; groups and their terminals are moved, not redrawn). */
  function layout() {
    const one = narrow() || !tree.dir;
    const top = one ? detail : nodeEl(tree);
    if (one) detail.classList.remove('gactive');
    root.classList.toggle('split', !one);
    if (root.firstElementChild !== top || root.children.length !== 1) root.replaceChildren(top);
    if (one) detail.style.removeProperty('flex');
    for (const id of panes.keys()) renderPane(id);
    refitAll();
  }

  function replace(n, id, next) {
    if (n.leaf) return n.leaf === id ? next : n;
    return { ...n, a: replace(n.a, id, next), b: replace(n.b, id, next) };
  }

  /** Split a group: a new group to its right ('row') or below it ('col'), active, showing `show` if given. */
  function split(id = active, dir = 'row', show) {
    if (leaves().length >= MAX_GROUPS) return toast(`At most ${MAX_GROUPS} groups`, 3000);
    if (narrow()) return toast('Widen the window to split the screen', 3000);
    const gid = `g${seq++}`;
    while (panes.has(`g${seq}`)) seq++;
    tree = replace(tree, id, { dir, a: { leaf: id }, b: { leaf: gid }, size: 50 });
    makePane(gid);
    active = gid;
    layout();
    if (show) load(gid, show.agentId, show.kind);
    else panes.get(gid).el.querySelector('.gpick').focus();
    save();
    return gid;
  }

  function close(id) {
    if (id === 'main') return;
    const p = panes.get(id);
    if (!p) return;
    const drop = (n) => {
      if (n.leaf) return n;
      if (n.a.leaf === id) return n.b;
      if (n.b.leaf === id) return n.a;
      return { ...n, a: drop(n.a), b: drop(n.b) };
    };
    tree = drop(tree);
    disconnect(p);
    p.xterm.dispose();
    p.el.remove();
    panes.delete(id);
    if (active === id) active = 'main';
    layout();
    save();
  }

  function activate(id) {
    if (active === id) return;
    active = id;
    detail.classList.toggle('gactive', id === 'main' && Boolean(tree.dir) && !narrow());
    for (const gid of panes.keys()) panes.get(gid).el.classList.toggle('active', gid === id);
    save();
  }

  // ------------------------------------------------------------------ events

  root.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.gpane');
    activate(g ? g.dataset.group : e.target.closest('#detail') ? 'main' : active);
  }, true);
  root.addEventListener('focusin', (e) => {
    const g = e.target.closest('.gpane');
    if (g) activate(g.dataset.group);
    else if (e.target.closest('#detail')) activate('main');
  });

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-g]');
    const g = b?.closest('.gpane');
    if (!g) return;
    const id = g.dataset.group;
    const p = panes.get(id);
    switch (b.dataset.g) {
      case 'right':
        return split(id, 'row');
      case 'down':
        return split(id, 'col');
      case 'close':
        return close(id);
      case 'main': {
        if (!p.agentId) return;
        const { agentId, kind } = p;
        close(id);
        return openInMain(agentId, kind);
      }
      case 'resume':
        if (isShell(p.kind)) {
          p.exited = false;
          disconnect(p);
          connect(p);
          return renderPane(id);
        }
        try {
          upsert(await api('POST', `/agents/${p.agentId}/start`, {}));
          if (!p.conn) connect(p);
          p.xterm.focus();
        } catch (err) {
          toast(`Error: ${err.message}`, 5000);
        }
    }
  });

  root.addEventListener('change', async (e) => {
    const g = e.target.closest('.gpane');
    if (!g) return;
    const id = g.dataset.group;
    const p = panes.get(id);
    if (e.target.classList.contains('gpick') && e.target.value) {
      const agentId = e.target.value;
      e.target.blur();
      return load(id, agentId, 'claude');
    }
    if (e.target.classList.contains('gkind')) {
      let kind = e.target.value;
      e.target.blur();
      if (kind === 'shell:new') {
        try {
          kind = `shell:${(await api('POST', `/agents/${p.agentId}/shell/new`)).n}`;
        } catch (err) {
          renderPane(id);
          return toast(`Error: ${err.message}`, 5000);
        }
      }
      load(id, p.agentId, kind);
    }
  });

  // Dragging an agent from the list: onto a group to show it there, onto its right or bottom edge to split.
  const zoneOf = (e) => {
    const target = e.target.closest?.('.gpane, #detail');
    if (!target || !root.contains(target)) return null;
    const r = target.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const id = target.classList.contains('gpane') ? target.dataset.group : 'main';
    const zone = narrow() ? 'here' : x > 1 - EDGE && x - (1 - EDGE) >= y - (1 - EDGE) ? 'right' : y > 1 - EDGE ? 'down' : 'here';
    return { id, zone, target };
  };
  const clearDrop = () => root.querySelectorAll('[data-gdrop]').forEach((el) => el.removeAttribute('data-gdrop'));
  root.addEventListener('dragover', (e) => {
    const agentId = dragged();
    const z = agentId && zoneOf(e);
    if (!z) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (z.target.dataset.gdrop !== z.zone) {
      clearDrop();
      z.target.dataset.gdrop = z.zone;
    }
  });
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget)) clearDrop();
  });
  root.addEventListener('drop', (e) => {
    const agentId = dragged();
    const z = agentId && zoneOf(e);
    clearDrop();
    if (!z) return;
    e.preventDefault();
    if (z.zone === 'here') {
      activate(z.id);
      return load(z.id, agentId, 'claude');
    }
    split(z.id, z.zone === 'right' ? 'row' : 'col', { agentId, kind: 'claude' });
  });
  document.addEventListener('dragend', clearDrop);

  // Ctrl+\ (Cmd+\ on a Mac), as in VS Code: split the active group to the right.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'Backslash') {
      e.preventDefault();
      split(active, e.shiftKey ? 'col' : 'row');
    }
  });
  matchMedia('(max-width: 760px)').addEventListener('change', () => layout());

  // Restore the last layout.
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED) ?? 'null');
    if (saved?.tree) {
      const ids = leaves(saved.tree);
      if (ids.includes('main') && ids.length <= MAX_GROUPS) {
        tree = saved.tree;
        for (const id of ids) if (id !== 'main') makePane(id, saved.shows?.[id]);
        active = ids.includes(saved.active) ? saved.active : 'main';
        seq = Math.max(1, ...ids.map((x) => Number(x.slice(1)) || 0)) + 1;
      }
    }
  } catch {}
  layout();

  return {
    /** Agents changed: names, states and pickers in each group. */
    render() {
      for (const id of panes.keys()) renderPane(id);
    },
    /** The group a click in the list opens into, when it isn't the main one. */
    count: () => panes.size,
    activeSplit: () => (active !== 'main' && panes.has(active) && tree.dir && !narrow() ? active : null),
    load,
    split: (dir) => split(active, dir),
    removed(agentId) {
      for (const [id, p] of panes) if (p.agentId === agentId) close(id);
    },
  };
}
