// Live views are re-rendered as HTML strings many times a second (every agent update). Swapping
// innerHTML each time rebuilds every element, which the browser must restyle, lay out and paint,
// and it drops focus, selection and a click in progress. morph() changes only what differs: the
// same element stays in place when its tag (and data-id / id, when present) still match.

const FIELDS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-id') ?? n.id ?? '' : '');

function sameKind(a, b) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);
}

function syncAttrs(from, to) {
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of to.attributes) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
}

// What a fresh element would show; the field being typed in keeps what's typed.
function syncField(from, to) {
  if (from.type === 'checkbox' || from.type === 'radio') from.checked = to.checked;
  else if (from !== document.activeElement && from.value !== to.value) from.value = to.value;
}

function morphNode(from, to) {
  // Native and fast: most of a list is unchanged. Its fields may still show something else.
  if (from.isEqualNode(to)) {
    if (from.nodeType !== 1) return;
    if (FIELDS.has(from.nodeName)) return syncField(from, to);
    const mine = from.querySelectorAll('input, select, textarea');
    if (mine.length) {
      const theirs = to.querySelectorAll('input, select, textarea');
      mine.forEach((f, i) => syncField(f, theirs[i]));
    }
    return;
  }
  if (from.nodeType !== 1) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  // A diagram drawn into its slot (renderDiagrams) stays while its source is the same.
  if (from.dataset.filled && from.dataset.mermaid === to.dataset.mermaid) return;
  syncAttrs(from, to);
  if (from.nodeName === 'TEXTAREA') {
    if (from.defaultValue !== to.defaultValue) from.defaultValue = to.defaultValue;
    syncField(from, to);
    return;
  }
  morphChildren(from, to);
  if (from.nodeName === 'INPUT' || from.nodeName === 'SELECT') syncField(from, to);
}

function morphChildren(from, to) {
  let a = from.firstChild;
  let b = to.firstChild;
  while (b) {
    const next = b.nextSibling;
    if (a && sameKind(a, b)) {
      morphNode(a, b);
      a = a.nextSibling;
    } else {
      // A keyed element further on (a card that moved up): bring it here instead of rebuilding it.
      const key = keyOf(b);
      let found = null;
      if (key) for (let c = a?.nextSibling; c; c = c.nextSibling) if (sameKind(c, b)) { found = c; break; }
      if (found) {
        from.insertBefore(found, a);
        morphNode(found, b);
      } else from.insertBefore(b, a); // moves b out of the template
    }
    b = next;
  }
  while (a) {
    const next = a.nextSibling;
    a.remove();
    a = next;
  }
}

const tpl = document.createElement('template');

/** Make el's contents match html, touching only what changed. False when nothing did. */
export function morph(el, html) {
  if (el.__html === html && el.firstChild) return false;
  el.__html = html;
  tpl.innerHTML = html;
  morphChildren(el, tpl.content);
  tpl.innerHTML = '';
  return true;
}
