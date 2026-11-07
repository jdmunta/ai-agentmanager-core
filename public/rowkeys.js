// Keys inside a list dialog (Jira, Actions): j / k move between rows, [ and ] between filters,
// and the dialog's own keys act on the selected row. Not while typing in a field. Clicking a row
// selects it, and a key pressed in a row's own control (its action dropdown) acts on that row.

const typing = (el) => Boolean(el?.closest?.('input:not([type="checkbox"]), textarea, [contenteditable=""], [contenteditable="true"]'));

/**
 * `rows()` gives the row elements in order; `keys` maps a key to (row) => void; `filters()` gives
 * the filter buttons. The selected row is marked with the class "kb-on" and kept by `idOf(row)`.
 */
export function rowKeys(dialog, { rows, keys = {}, filters = () => [], idOf = (r) => r.dataset.rowId }) {
  let selected = null;
  // Where the selected row was: when it leaves the list (skipped, removed), the one now in its
  // place is selected, never silently the first.
  let at = 0;
  const mark = () => {
    const list = rows();
    let row = list.find((r) => idOf(r) === selected);
    if (!row && selected !== null && list.length) {
      row = list[Math.min(at, list.length - 1)];
      selected = idOf(row);
    }
    for (const r of list) r.classList.toggle('kb-on', r === row);
    if (row) at = list.indexOf(row);
    return row ?? null;
  };
  const choose = (row) => {
    selected = idOf(row);
    return mark();
  };
  const move = (step) => {
    const list = rows();
    if (!list.length) return;
    const i = list.findIndex((r) => idOf(r) === selected);
    const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + step))];
    choose(next);
    next.scrollIntoView({ block: 'nearest' });
  };
  const rowOf = (el) => {
    const tr = el?.closest?.('tr');
    return tr && rows().includes(tr) ? tr : null;
  };
  dialog.addEventListener('pointerdown', (e) => {
    const row = rowOf(e.target);
    if (row) choose(row);
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault();
      return move(e.key === 'j' ? 1 : -1);
    }
    if (e.key === '[' || e.key === ']') {
      const fs = filters();
      const i = fs.findIndex((f) => f.classList.contains('active'));
      const next = fs[(i + (e.key === ']' ? 1 : -1) + fs.length) % fs.length];
      if (next) {
        e.preventDefault();
        next.click();
      }
      return;
    }
    const fn = keys[e.key];
    if (!fn) return;
    // A key pressed in a row's own control is about that row.
    const own = rowOf(e.target);
    const row = own ? choose(own) : mark();
    if (!row && fn.needsRow !== false) return;
    e.preventDefault();
    fn(row);
  });
  /** After the list is drawn again: keep the selection on the same row. */
  return { redraw: mark, clear: () => (selected = null) };
}

/**
 * Wraps a list's render so it waits while you have one of its dropdowns open: drawing the list
 * again (agents change every few seconds) would throw the open dropdown away before you choose.
 * It draws once the dropdown loses focus.
 */
export function holdWhilePicking(body, render) {
  let waiting = false;
  const picking = () => {
    const f = document.activeElement;
    return f?.tagName === 'SELECT' && body.contains(f);
  };
  body.addEventListener('focusout', () => {
    if (!waiting) return;
    // After focus has moved on.
    setTimeout(() => {
      if (waiting && !picking()) {
        waiting = false;
        render();
      }
    });
  });
  return () => {
    if (picking()) {
      waiting = true;
      return;
    }
    waiting = false;
    render();
  };
}
