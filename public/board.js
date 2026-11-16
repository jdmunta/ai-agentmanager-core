// Board: every agent as a card in the column for where its work stands: starting, working, needs
// you, waiting for its next instruction, in review (an open pull request), done, closed. An agent
// moves between columns by itself as its work moves. Dragging a card does the two things a drag
// can honestly do: onto Closed closes its session, and from Closed onto Waiting resumes it.

import { expandButton, expandable } from './expand.js';
import { morph } from './morph.js';
import { BOARD_COLUMNS, columnOf, dropAction, needOf, openPrs } from './boardcols.js';

const LAND = { ready: 'ready to merge', fix: 'needs fixes', behind: 'behind', waiting: 'checks running', draft: 'draft', merged: 'merged', closed: 'closed' };
const MANY = 30; // closed and done cards shown before "and N more"

export function initBoard({ api, $, esc, ago, toast, agents, openAgent, upsert }) {
  const dialog = $('#board-dialog');
  const body = $('#board-body');
  let project = '';
  let all = false; // every closed and done card, not the latest ones
  let dragging = null;
  let stale = false;
  try {
    project = localStorage.getItem('agentmgr.board.project') ?? '';
  } catch {}

  const shown = () => [...agents().values()].filter((a) => a.kind !== 'assistant');
  const projects = () => {
    const seen = new Map();
    for (const a of shown()) if (a.projectInfo?.key && !['other', 'general', 'assistant'].includes(a.projectInfo.key)) seen.set(a.projectInfo.key, a.projectInfo.name);
    return [...seen].sort((x, y) => x[1].localeCompare(y[1]));
  };

  function card(a, col) {
    const need = col === 'needs' ? needOf(a) : null;
    const pr = col === 'review' ? openPrs(a)[0] : col === 'done' ? (a.prs ?? []).find((p) => p.land === 'merged') : null;
    const rt = a.runtime ?? {};
    const move = col === 'closed' && a.workdir ? `<button class="small" data-board-act="start" data-id="${esc(a.id)}" title="Resume its session in the background">Resume</button>` : col === 'idle' ? `<button class="small ghost" data-board-act="stop" data-id="${esc(a.id)}" title="Close its session; it can be resumed">Close</button>` : '';
    return `<li class="board-card pr${a.priority ?? 2}" draggable="true" data-board-card="${esc(a.id)}" tabindex="0" title="${esc(a.synopsis?.text || a.intent || '')}">
      <div class="board-card-head">${(a.priority ?? 2) === 2 ? '' : `<span class="prio p${a.priority}">P${a.priority}</span>`}<b>${esc(a.name)}</b></div>
      ${need ? `<div class="board-need">${esc(need)}</div>` : ''}
      ${pr ? `<div class="board-pr ${esc(pr.land)}">#${esc(String(pr.number ?? ''))} ${esc(LAND[pr.land] ?? pr.land)}</div>` : ''}
      ${col === 'starting' && a.progress?.phase ? `<div class="hint">${esc(a.progress.phase)}</div>` : ''}
      <div class="board-meta">${a.projectInfo?.name && !project && !['other', 'general', 'assistant'].includes(a.projectInfo.key) ? `<span class="branch">${esc(a.projectInfo.name)}</span>` : ''}${a.kind === 'general' ? '<span class="tag">general</span>' : ''}${a.activeAt ? `<span class="hint">${esc(ago(a.activeAt))}</span>` : ''}${a.brief?.summary?.total ? `<span class="hint${a.brief.summary.failed ? ' fail' : ''}">✓${a.brief.summary.passed}/${a.brief.summary.total}</span>` : ''}${rt.running && col !== 'working' && col !== 'idle' ? '<span class="hint" title="Its session is open">◉</span>' : ''}<span class="spacer"></span>${move}</div>
    </li>`;
  }

  function draw() {
    const list = shown().filter((a) => !project || a.projectInfo?.key === project);
    const by = new Map(BOARD_COLUMNS.map((c) => [c.id, []]));
    for (const a of list) by.get(columnOf(a)).push(a);
    for (const cards of by.values()) cards.sort((x, y) => (x.priority ?? 2) - (y.priority ?? 2) || String(y.activeAt ?? y.createdAt ?? '').localeCompare(String(x.activeAt ?? x.createdAt ?? '')));
    const ps = projects();
    return `
      <div class="issues-head">
        <h2>Board</h2><span class="hint">${list.length} agent${list.length === 1 ? '' : 's'}</span>
        <span class="spacer"></span>
        ${ps.length > 1 ? `<select data-board-project aria-label="Project"><option value="">Every project</option>${ps.map(([k, n]) => `<option value="${esc(k)}" ${k === project ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>` : ''}
        ${expandButton(dialog)}
        <button class="small" data-board="close">Close</button>
      </div>
      <div class="board-cols">
        ${BOARD_COLUMNS.map((c) => {
          const cards = by.get(c.id);
          const cut = !all && (c.id === 'closed' || c.id === 'done') && cards.length > MANY ? cards.length - MANY : 0;
          return `<section class="board-col col-${c.id}" data-board-col="${c.id}" aria-label="${esc(c.label)}">
            <h3 title="${esc(c.hint)}">${esc(c.label)} <span class="hint">${cards.length}</span></h3>
            <ul>${(cut ? cards.slice(0, MANY) : cards).map((a) => card(a, c.id)).join('')}</ul>
            ${cut ? `<button class="link" data-board="all">and ${cut} more</button>` : ''}
          </section>`;
        }).join('')}
      </div>
      <p class="hint">A card moves by itself as its agent's work moves. Drag one onto Closed to close its session, or from Closed onto Waiting to resume it. Click a card to open its agent.</p>`;
  }

  const render = () => {
    // A redraw mid-drag would drop the card being dragged: draw when it lands.
    if (dragging) return (stale = true);
    morph(body, draw());
  };

  async function run(id, what) {
    try {
      upsert(await api('POST', `/agents/${id}/${what}`, {}));
      toast?.(what === 'stop' ? 'Session closed. Resume brings it back' : 'Resumed in the background', 3000);
    } catch (e) {
      toast?.(e.message, 5000);
    }
    render();
  }

  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-board="close"]')) return dialog.close();
    if (e.target.closest('[data-board="all"]')) {
      all = true;
      return render();
    }
    const b = e.target.closest('[data-board-act]');
    if (b) return run(b.dataset.id, b.dataset.boardAct);
    const c = e.target.closest('[data-board-card]');
    if (c) {
      dialog.close();
      openAgent?.(c.dataset.boardCard);
    }
  });
  body.addEventListener('keydown', (e) => {
    const c = e.target.matches?.('[data-board-card]') ? e.target : null;
    if (!c || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    dialog.close();
    openAgent?.(c.dataset.boardCard);
  });
  body.addEventListener('change', (e) => {
    if (!e.target.matches('[data-board-project]')) return;
    project = e.target.value;
    try {
      localStorage.setItem('agentmgr.board.project', project);
    } catch {}
    render();
  });

  const colAt = (e) => e.target.closest?.('[data-board-col]');
  const clear = () => body.querySelectorAll('.board-col.drop').forEach((x) => x.classList.remove('drop'));
  body.addEventListener('dragstart', (e) => {
    const c = e.target.closest?.('[data-board-card]');
    if (!c) return;
    dragging = c.dataset.boardCard;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging);
    c.classList.add('dragging');
  });
  body.addEventListener('dragover', (e) => {
    const col = colAt(e);
    if (!dragging || !col) return;
    e.preventDefault();
    if (!col.classList.contains('drop')) {
      clear();
      col.classList.add('drop');
    }
  });
  body.addEventListener('drop', (e) => {
    const col = colAt(e);
    const a = agents().get(dragging);
    if (!col || !a) return;
    e.preventDefault();
    const r = dropAction(a, col.dataset.boardCol);
    if (r.act) run(a.id, r.act);
    else if (r.why) toast?.(r.why, 6000);
  });
  body.addEventListener('dragend', () => {
    dragging = null;
    clear();
    body.querySelector('.board-card.dragging')?.classList.remove('dragging');
    if (stale) {
      stale = false;
      render();
    }
  });

  let queued = false;
  /** Agents changed: draw again, once a frame at most, while the board is open. */
  function refresh() {
    if (!dialog.open || queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      if (dialog.open) render();
    }, 200);
  }

  function open() {
    if (dialog.open) return dialog.close();
    all = false;
    dialog.showModal();
    render();
  }

  expandable(dialog, render);
  return { open, refresh, isOpen: () => dialog.open };
}
