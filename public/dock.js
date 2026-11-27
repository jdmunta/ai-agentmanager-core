// In the three-column layout a view opens in the pane at the right, beside the agent list, as a page
// does in Claude's app, instead of over the page. Its dialog opens non-modal and docked there; the
// view's own code is unchanged. On a narrower window, a phone, or with the views in the top bar,
// they open over the page as before. Its expand button (f) also covers the agent list.

// The views' dialogs; each one's button in the nav is `<name>-btn`.
const VIEWS = new Set(['today', 'glance', 'readfirst', 'assistant', 'board', 'reviews', 'designs', 'issues', 'bugs', 'actions', 'decide', 'plan', 'standup', 'spend', 'value', 'quality', 'news', 'mcp', 'os', 'machine', 'screen'].map((v) => `${v}-dialog`));

export function initDock({ $, onDock }) {
  const wide = matchMedia('(min-width: 1100px)');
  const columns = () => wide.matches && !document.body.classList.contains('nav-top');
  const docked = () => [...document.querySelectorAll('dialog.docked[open]')];
  const buttonOf = (dialog) => $(`#${dialog.id.replace(/-dialog$/, '')}-btn`);

  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () {
    if (!VIEWS.has(this.id) || !columns()) return showModal.call(this);
    for (const d of docked()) if (d !== this) d.close();
    this.classList.add('docked');
    onDock?.();
    this.show();
    buttonOf(this)?.classList.add('active');
    this.focus({ preventScroll: true });
  };
  for (const id of VIEWS) {
    const d = document.getElementById(id);
    d?.addEventListener('close', () => {
      d.classList.remove('docked');
      buttonOf(d)?.classList.remove('active');
    });
  }

  const closeAll = () => docked().forEach((d) => d.close());
  // Another view in the nav takes the pane (Watch and Map too); the view's own button still toggles it.
  $('#top-nav').addEventListener(
    'click',
    (e) => {
      const b = e.target.closest('button');
      if (b) for (const d of docked()) if (buttonOf(d) !== b) d.close();
    },
    true,
  );
  // Escape closes it, as it does a view over the page, unless a dialog over it is open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !docked().length) return;
    if ([...document.querySelectorAll('dialog[open]')].some((d) => d.matches(':modal'))) return;
    closeAll();
  });
  return { closeAll, columns };
}
