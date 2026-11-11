// The top bar's view buttons fit the window: the ones that don't fit move, in order, into a
// "More" menu at the end of the row (as VS Code does with tabs). The buttons themselves move, so
// their handlers, counts and shortcuts keep working; a count on a moved one shows as a dot on More.

export function initTopNav({ $ }) {
  const nav = $('#top-nav');
  const wrap = $('#top-more');
  const btn = $('#top-more-btn');
  const menu = $('#top-more-menu');
  const order = [...nav.querySelectorAll(':scope > button')];
  let fitting = false;

  const counted = (b) => [...b.querySelectorAll('.badge')].some((x) => x.textContent.trim()) || Boolean(b.querySelector('.assistant-dot:not([hidden])'));

  function fit() {
    if (fitting) return;
    fitting = true;
    observer.disconnect();
    // Everything back in the row, in order; then move the last ones out until the row fits.
    for (const b of order) nav.insertBefore(b, wrap);
    wrap.hidden = false;
    const moved = [];
    while (nav.scrollWidth > nav.clientWidth + 1) {
      const last = order.filter((b) => b.parentElement === nav && !b.hidden).pop();
      if (!last) break;
      moved.unshift(last);
      menu.prepend(last);
    }
    wrap.hidden = moved.length === 0;
    if (!moved.length) close();
    btn.classList.toggle('has-news', moved.some(counted));
    btn.title = moved.length ? `More: ${moved.map((b) => b.firstChild?.textContent?.trim()).filter(Boolean).join(', ')}` : '';
    observe();
    fitting = false;
  }

  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fit();
    });
  };
  // Counts change the buttons' widths; the window and the rest of the bar change the room.
  const observer = new MutationObserver(later);
  const observe = () => {
    for (const b of order) observer.observe(b, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  };
  new ResizeObserver(later).observe(nav.parentElement);
  addEventListener('resize', later);

  function close() {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  // A button in the menu does its own thing (its handler is unchanged); then the menu closes.
  menu.addEventListener('click', () => setTimeout(close));
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !wrap.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) close();
  });

  fit();
  document.fonts?.ready.then(later);
  return { fit };
}
