// The text size of the terminals (an agent's session, split-screen groups, Open Terminal): 13 px
// unless you chose another in the menu, kept per browser.

const KEY = 'agentmgr.termFont';
export const TERM_FONT = { min: 10, max: 22, base: 13 };

export function termFont() {
  try {
    const n = Number(localStorage.getItem(KEY));
    return n >= TERM_FONT.min && n <= TERM_FONT.max ? n : TERM_FONT.base;
  } catch {
    return TERM_FONT.base;
  }
}

/** Saves it and tells the open terminals (`agentmgr-termfont` on window). */
export function setTermFont(n) {
  const size = Math.max(TERM_FONT.min, Math.min(TERM_FONT.max, Math.round(n)));
  try {
    if (size === TERM_FONT.base) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(size));
  } catch {}
  window.dispatchEvent(new CustomEvent('agentmgr-termfont', { detail: size }));
  return size;
}
