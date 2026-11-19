// Go to: one box that finds a view, an agent or a setting by name, instead of looking for its
// button (on a phone most of them are in the More menu) or remembering its key. Ctrl+K or ⌘K.

/**
 * The items that match what was typed, best first: every word must be in the name or its
 * description; a name that starts with it comes before one that contains it, and that before a
 * match in the description only. With nothing typed, all of them in their own order.
 */
export function findMatches(items, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const q = words.join(' ');
  return items
    .map((item, at) => {
      const label = item.label.toLowerCase();
      const all = `${label} ${(item.hint ?? '').toLowerCase()}`;
      if (!words.every((w) => all.includes(w))) return null;
      const rank = label.startsWith(q) ? 0 : label.split(/[\s/:-]+/).some((part) => part.startsWith(words[0])) ? 1 : words.every((w) => label.includes(w)) ? 2 : 3;
      return { item, rank, at };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((m) => m.item);
}

const MAX = 60;

export function initPalette({ $, esc, agents, select }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'go-dialog';
  dialog.className = 'go-dialog';
  dialog.innerHTML = `<input id="go-input" type="search" placeholder="Go to a view, an agent or a setting…" aria-label="Go to" aria-controls="go-list" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" />
    <ul id="go-list" class="go-list" role="listbox"></ul>
    <p id="go-none" class="hint" hidden>Nothing by that name.</p>`;
  document.body.appendChild(dialog);
  const input = dialog.querySelector('#go-input');
  const list = dialog.querySelector('#go-list');
  let shown = [];
  let at = 0;

  /** A button as an item: its own words as the name, its tooltip as the description. */
  function ofButton(b, kind) {
    if (b.hidden || getComputedStyle(b).display === 'none') return null;
    const label = [...b.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(' ').replace(/[…▾]/g, '').replace(/^\+\s*/, '').trim();
    if (!label) return null;
    const count = b.querySelector('.badge')?.textContent.trim();
    return { label, hint: b.title || '', kind, count, run: () => b.click() };
  }

  function collect() {
    const views = [...document.querySelectorAll('#top-nav button:not(#top-more-btn), #new-btn')].map((b) => ofButton(b, 'View'));
    const tabs = [...document.querySelectorAll('.side-tab')].map((b) => ofButton(b, 'List'));
    const menu = [...document.querySelectorAll('#menu [role="menuitem"]')].map((b) => ofButton(b, 'Menu'));
    const mine = agents().map((a) => ({ label: a.label, hint: a.hint, kind: 'Agent', run: () => select(a.id) }));
    return [...views, ...tabs, ...menu, ...mine].filter(Boolean);
  }

  let items = [];
  function render() {
    shown = findMatches(items, input.value).slice(0, MAX);
    at = Math.max(0, Math.min(at, shown.length - 1));
    list.innerHTML = shown
      .map((it, i) => `<li role="option" data-go="${i}" aria-selected="${i === at}"${i === at ? ' class="sel"' : ''}><span class="go-name">${esc(it.label)}${it.count ? ` <span class="badge">${esc(it.count)}</span>` : ''}</span><span class="go-hint">${esc(it.hint)}</span><span class="go-kind">${it.kind}</span></li>`)
      .join('');
    dialog.querySelector('#go-none').hidden = shown.length > 0;
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    if (dialog.open) return dialog.close();
    // Under another dialog it could not be used; that dialog has the page.
    if (document.querySelector('dialog[open]')) return false;
    items = collect();
    input.value = '';
    at = 0;
    render();
    dialog.showModal();
    input.focus();
  }

  function go(i) {
    const it = shown[i];
    if (!it) return;
    dialog.close();
    // After the dialog is gone: what it opens may be a dialog of its own.
    setTimeout(it.run);
  }

  input.addEventListener('input', () => {
    at = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) {
      e.preventDefault();
      at = (at + step + shown.length) % Math.max(1, shown.length);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(at);
    }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-go]');
    if (li) go(Number(li.dataset.go));
  });
  // A click beside the box closes it.
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());

  // ⌘K anywhere; Ctrl+K too, except in a terminal, where it is the shell's (cut to the end of the line).
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
    if (!e.metaKey && e.target.closest?.('.xterm')) return;
    e.preventDefault();
    e.stopPropagation();
    open();
  }, true);
  $('#go-btn').onclick = () => open();

  return { open };
}
