// The three columns on a wide window (views, the agent list, the page), each hidden or shown by its
// button by the logo; this device remembers. Hidden views go to the top bar (with More), so they are
// still there. The list and the page can't both be hidden: hiding one shows the other. Picking an
// agent or a view shows the page again.

const KEYS = { nav: 'agentmgr.nav', list: 'agentmgr.list', page: 'agentmgr.page' };
const NAMES = { nav: 'the views', list: 'the agent list', page: 'the page' };
const CLASS = { nav: 'nav-top', list: 'list-hidden', page: 'page-hidden' };

export function initColumns({ $, onChange }) {
  const read = (k) => {
    try {
      return localStorage.getItem(KEYS[k]);
    } catch {
      return null;
    }
  };
  const hidden = (k) => document.body.classList.contains(CLASS[k]);

  function set(k, hide, save = true) {
    document.body.classList.toggle(CLASS[k], hide);
    if (hide && k === 'list' && hidden('page')) set('page', false);
    if (hide && k === 'page' && hidden('list')) set('list', false);
    const b = $(`#${k}-toggle`);
    b.setAttribute('aria-pressed', String(!hide));
    b.title = `${hide ? 'Show' : 'Hide'} ${NAMES[k]}${k === 'nav' && hide ? ' as a column (now in the top bar)' : k === 'nav' ? ' column (into the top bar)' : ''}`;
    if (save) {
      try {
        localStorage.setItem(KEYS[k], k === 'nav' ? (hide ? 'top' : 'side') : hide ? 'hidden' : 'shown');
      } catch {}
    }
  }

  set('nav', read('nav') === 'top', false);
  set('list', read('list') === 'hidden', false);
  set('page', read('page') === 'hidden', false);
  for (const k of Object.keys(KEYS)) {
    $(`#${k}-toggle`).onclick = () => {
      set(k, !hidden(k));
      onChange?.(k);
    };
  }
  return { showPage: () => hidden('page') && set('page', false) };
}
