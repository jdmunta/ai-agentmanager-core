// Making a list dialog (Jira, Actions, Designs, Reviews, Value) bigger: a button in its header, or f, fills the window,
// remembered per list. The dialog's corner can also be dragged to any size.

const saved = (id) => `agentmgr.expanded.${id}`;

/** The header button; `dialog` tells which way it points. */
export function expandButton(dialog) {
  const on = dialog.classList.contains('expanded');
  return `<button class="small" data-expand title="${on ? 'Back to normal size' : 'Fill the window'} (f)" aria-pressed="${on}">${on ? '⤡' : '⤢'}</button>`;
}

/** Wire the button and the f key; `redraw()` draws the header again with the button turned. */
export function expandable(dialog, redraw) {
  try {
    dialog.classList.toggle('expanded', localStorage.getItem(saved(dialog.id)) === '1');
  } catch {}
  const toggle = () => {
    const on = dialog.classList.toggle('expanded');
    // A size dragged by hand gives way to the button.
    dialog.style.width = '';
    dialog.style.height = '';
    try {
      localStorage.setItem(saved(dialog.id), on ? '1' : '0');
    } catch {}
    redraw();
  };
  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-expand]')) toggle();
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'f' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input:not([type="checkbox"]), textarea, [contenteditable=""], [contenteditable="true"]')) return;
    e.preventDefault();
    toggle();
  });
}
