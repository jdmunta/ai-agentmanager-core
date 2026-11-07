// Keys inside a list dialog (Jira, Actions): j / k move between rows, [ and ] between filters,
// and the dialog's own keys act on the selected row. Not while typing in a field.

const typing = (el) => Boolean(el?.closest?.('input:not([type="checkbox"]), textarea, [contenteditable=""], [contenteditable="true"]'));

/**
 * `rows()` gives the row elements in order; `keys` maps a key to (row) => void; `filters()` gives
 * the filter buttons. The selected row is marked with the class "kb-on" and kept by `idOf(row)`.
 */
export function rowKeys(dialog, { rows, keys = {}, filters = () => [], idOf = (r) => r.dataset.rowId }) {
  let selected = null;
  const mark = () => {
    const list = rows();
    let row = list.find((r) => idOf(r) === selected);
    if (!row && selected !== null) row = list[0];
    for (const r of list) r.classList.toggle('kb-on', r === row);
    return row ?? null;
  };
  const move = (step) => {
    const list = rows();
    if (!list.length) return;
    const i = list.findIndex((r) => idOf(r) === selected);
    const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + step))];
    selected = idOf(next);
    mark();
    next.scrollIntoView({ block: 'nearest' });
  };
  dialog.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    // A focused select or checkbox keeps its own arrow keys; ours are letters.
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
    const row = mark();
    if (!row && fn.needsRow !== false) return;
    e.preventDefault();
    fn(row);
  });
  /** After the list is drawn again: keep the selection on the same row. */
  return { redraw: mark, clear: () => (selected = null) };
}
