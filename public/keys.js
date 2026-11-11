// Keyboard shortcuts: one key for the common actions, never while you type (a field or a
// terminal has the keys then), plus Ctrl+Shift ones that work from inside a terminal. ? lists them.

export const SHORTCUTS = [
  ['Agents', [
    [['j'], 'Next agent', 'next'],
    [['k'], 'Previous agent', 'prev'],
    [['Enter', 't'], 'Open its terminal', 'terminal'],
    [['r'], 'Review its changes', 'changes'],
    [['s'], 'Resume it in the background', 'start'],
    [['Shift+X'], 'Close its session (it can be resumed)', 'stop'],
    [['e'], 'Edit it', 'edit'],
  ]],
  ['Anywhere', [
    [['y'], 'Today: what needs you, most pressing first', 'today'],
    [['b'], 'Bugs: what bug hunts found, and the hunts', 'bugs'],
    [['n'], 'New agents', 'new'],
    [['a'], 'Ask Agent (a general session)', 'ask'],
    [['/'], 'Filter agents', 'filter'],
    [['w'], 'Watch: agents side by side', 'watch'],
    [['p'], 'Play the standup', 'standup'],
    [['m'], 'Map: where agents are in the code', 'map'],
    [['i'], 'Jira: issues waiting for your review', 'issues'],
    [['o'], "Actions: what's asked of you in Slack and meetings", 'actions'],
    [['h'], 'Assistant', 'assistant'],
    [[','], 'Settings', 'settings'],
    [['d'], 'Designs: agents\' design docs', 'designs'],
    [['g'], 'Reviews: pull requests you review', 'reviews'],
    [['v'], 'Value: what the work is worth', 'value'],
    [['1'], 'Agents tab', 'tab:agents'],
    [['2'], 'Inbox: what needs you', 'tab:inbox'],
    [['3'], 'Backlog', 'tab:backlog'],
    [['4'], 'Land: pull requests', 'tab:land'],
    [['5'], 'Built agents', 'tab:built'],
    [['?'], 'These shortcuts', 'help'],
  ]],
  ['In the Today, Jira and Actions lists', [
    [['j', 'k'], 'Next / previous row', null],
    [['[', ']'], 'Previous / next filter', null],
    [['a'], 'Assign (starts an agent)', null],
    [['s'], 'Skip', null],
    [['d'], 'Done', null],
    [['x'], 'Remove', null],
    [['z'], 'Snooze until tomorrow 9am', null],
    [['1–6'], "Pick one of an agent's answers (Today)", null],
    [['o'], 'Undecided again (Actions) or clear (Jira)', null],
    [['c'], 'Discuss it with Claude (Actions)', null],
    [['Enter'], 'Open the issue or where it was asked', null],
    [['u'], 'Undo the last change (Today); or Undo on the message', null],
    [['r'], 'Look again', null],
  ]],
  ['In the standup', [
    [['Space'], 'Play or pause', null],
    [['←', '→'], 'Previous / next agent', null],
  ]],
  ['In a terminal', [
    [['Ctrl+Shift+↓'], "Next agent's terminal", 'next-term'],
    [['Ctrl+Shift+↑'], "Previous agent's terminal", 'prev-term'],
    [['Ctrl+Shift+L'], 'Leave the terminal (then the keys above work)', 'leave'],
    [['Ctrl+Shift+E'], 'Expand or shrink the terminal', null],
  ]],
  ['Split screen (also from a terminal)', [
    [['Cmd+\\', 'Ctrl+Shift+\\'], 'Split the active group to the right', null],
    [['Cmd+Shift+\\', 'Ctrl+Alt+Shift+\\'], 'Split it down', null],
    [['Ctrl+Shift+1…6'], 'Go to group 1 to 6 (left to right, top to bottom)', null],
    [['Ctrl+Shift+X'], 'Close the active group (its agent keeps running)', null],
  ]],
];

// A single key, as an event names it, to its action.
export const SINGLE = {
  j: 'next', k: 'prev', Enter: 'terminal', t: 'terminal',
  r: 'changes', s: 'start', X: 'stop', e: 'edit', n: 'new', a: 'ask', '/': 'filter', w: 'watch', p: 'standup', m: 'map', i: 'issues', o: 'actions', h: 'assistant', ',': 'settings', d: 'designs', g: 'reviews', v: 'value', y: 'today', b: 'bugs', '?': 'help',
  1: 'tab:agents', 2: 'tab:inbox', 3: 'tab:backlog', 4: 'tab:land', 5: 'tab:built',
};
// While Watch is open: only what makes sense there.
const ON_WATCH = new Set(['today', 'new', 'ask', 'watch', 'standup', 'map', 'issues', 'actions', 'assistant', 'settings', 'designs', 'reviews', 'value', 'bugs', 'help']);

/** Typing somewhere: a field, an editor or a terminal (xterm types through a textarea). */
const typing = (el) => Boolean(el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm, .cm-editor'));

export function initKeys({ $, esc, run }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'keys-dialog';
  dialog.className = 'keys-dialog';
  const kbd = (k) => k.split('+').map((p) => `<kbd>${esc(p)}</kbd>`).join('+');
  dialog.innerHTML = `<form method="dialog">
      <h3>Keyboard shortcuts</h3>
      ${SHORTCUTS.map(([group, rows]) => `<h4>${esc(group)}</h4><table>${rows.map(([keys, what]) => `<tr><td class="keys">${keys.map(kbd).join(' <span class="hint">or</span> ')}</td><td>${esc(what)}</td></tr>`).join('')}</table>`).join('')}
      <p class="hint">Single keys work when you're not typing in a field or a terminal.</p>
      <div class="actions"><button class="primary" value="close">Close</button></div>
    </form>`;
  document.body.appendChild(dialog);
  const help = () => (dialog.open ? dialog.close() : dialog.showModal());

  // Ctrl+Shift ones, first, so a focused terminal doesn't take them.
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    const act = e.code === 'ArrowDown' ? 'next-term' : e.code === 'ArrowUp' ? 'prev-term' : e.code === 'KeyL' ? 'leave' : null;
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    run(act);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && document.activeElement === $('#filter')) {
      $('#filter').blur();
      return;
    }
    if (typing(e.target) || typing(document.activeElement)) return;
    // An open dialog has the keyboard; ? still closes the shortcuts one.
    if (document.querySelector('dialog[open]') && !(dialog.open && e.key === '?')) return;
    const act = SINGLE[e.key];
    if (!act || (document.body.classList.contains('watching') || document.body.classList.contains('mapping')) && !ON_WATCH.has(act)) return;
    if (act === 'help') {
      e.preventDefault();
      return help();
    }
    // Enter on a focused button or link is that button's.
    if (e.key === 'Enter' && e.target.closest?.('button, a, summary')) return;
    if (run(act) !== false) e.preventDefault();
  });

  return { help };
}
