// Usage: each engine's plan limits, how much is used and left, and when they reset. A chip by the
// connection light always shows the engine new agents start on; the window has every engine, the
// alert and hold levels, and which engine new agents start on.

const LEVEL = { ok: 'Fine', warn: 'Getting close', high: 'Nearly used up', held: 'Held for new work', limited: 'Stopped at a limit', unknown: 'No reading yet' };
const SHORT = { five_hour: '5h', seven_day: 'wk', primary: '5h', secondary: 'wk' };

export function initUsage({ api, $, esc, ago, toast }) {
  const dialog = $('#usage-dialog');
  const body = $('#usage-body');
  const chip = $('#usage-chip');
  let data = null;
  let again = null;

  async function load({ quiet = false } = {}) {
    try {
      data = await api('GET', '/usage');
    } catch (e) {
      if (!quiet) toast?.(e.message, 5000);
    }
    drawChip();
    if (dialog.open) draw();
  }

  /** The engine new agents start on, or the one in the worst state when that is worse than fine. */
  function drawChip() {
    if (!chip || !data) return;
    const mine = data.engines.find((e) => e.id === data.default);
    const bad = data.worst && ['warn', 'high', 'held', 'limited'].includes(data.worst.level) ? data.worst : null;
    const e = bad ?? mine;
    const read = e?.windows.filter((w) => w.used !== null) ?? [];
    chip.hidden = !e || (!read.length && !e.limited);
    if (chip.hidden) return;
    chip.className = `usage-chip ${e.level}`;
    chip.textContent = e.limited ? `${e.label}: at its limit` : `${e.label} ${read.map((w) => `${SHORT[w.id] ?? w.label} ${Math.round(w.used)}%`).join(' · ')}`;
    chip.title = `${e.label}: ${e.limited ? `stopped at a limit${e.limited.resetsIn ? `, resets ${e.limited.resetsIn}` : ''}` : read.map((w) => `${w.label}: ${Math.round(w.used)}% used, ${Math.round(w.left)}% left${w.resetsIn ? `, resets ${w.resetsIn}` : ''}`).join('; ')}. Click for every engine.`;
  }

  const tone = (used) => (used >= 95 ? 'heavy' : used >= (data.settings.warnAt ?? 101) ? 'busy' : 'light');
  const when = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  function engineHtml(e) {
    const others = data.engines.filter((x) => x.installed && x.id !== e.id && !['held', 'limited', 'high'].includes(x.level));
    const rows = e.windows
      .map((w) => (w.used === null
        ? `<div class="usage-window"><div class="usage-window-head"><b>${esc(w.label)}</b><span class="hint">It has reset since the last reading; the next reply brings a new one.</span></div></div>`
        : `<div class="usage-window" data-usage-window="${esc(w.id)}">
            <div class="usage-window-head"><b>${esc(w.label)}</b><span class="usage-num">${Math.round(w.used)}% used</span><span class="usage-left ${tone(w.used)}">${Math.round(w.left)}% left</span><span class="spacer"></span><span class="hint">${w.resetsAt ? `resets ${esc(w.resetsIn)} (${esc(when(w.resetsAt))})` : ''}${w.stale ? ' · an old reading' : ''}</span></div>
            <div class="os-meter ${tone(w.used)}" role="img" aria-label="${Math.round(w.used)}% used"><span style="width:${w.used}%"></span></div>
          </div>`))
      .join('');
    return `<div class="plan-project usage-engine" data-usage-engine="${esc(e.id)}">
      <div class="plan-project-head"><h3>${esc(e.label)}</h3><span class="tag usage-level ${esc(e.level)}">${esc(LEVEL[e.level] ?? e.level)}</span>${e.id === data.default ? '<span class="tag">new agents start here</span>' : ''}${e.installed ? '' : '<span class="tag">not installed</span>'}
        <span class="spacer"></span>${e.at ? `<span class="hint">read ${esc(ago(e.at))}${e.source ? ` from ${esc(e.source)}` : ''}</span>` : ''}
        ${e.installed && e.id !== data.default ? `<button class="small" data-usage-default="${esc(e.id)}" title="New agents start on ${esc(e.label)} unless you pick another engine for them. Agents already running stay where they are">Start new agents here</button>` : ''}</div>
      ${e.limited ? `<p class="issues-problem">An agent stopped at a limit${e.limited.resetsIn ? `; it resets ${esc(e.limited.resetsIn)}` : ''}: ${esc(e.limited.text)}</p>` : ''}
      ${rows}
      ${e.note ? `<p class="hint">${esc(e.note)}</p>` : ''}
      ${['held', 'limited', 'high'].includes(e.level) && e.id === data.default && others.length ? `<p class="hint">New agents start here by default. ${others.map((o) => `<button class="link" data-usage-default="${esc(o.id)}">Switch new agents to ${esc(o.label)}</button>`).join(' · ')}</p>` : ''}
    </div>`;
  }

  function draw() {
    if (!data) return (body.innerHTML = '<div class="issues-head"><h2>Usage</h2><span class="spacer"></span><button class="small" data-usage="close">Close</button></div><p class="hint">Loading…</p>');
    const s = data.settings;
    const level = (name, v, off) => `<select data-usage-set="${name}" aria-label="${name}"><option value="off" ${v ? '' : 'selected'}>${off}</option>${[50, 60, 70, 75, 80, 85, 90, 95, 100].map((n) => `<option value="${n}" ${v === n ? 'selected' : ''}>${n}% used</option>`).join('')}${v && ![50, 60, 70, 75, 80, 85, 90, 95, 100].includes(v) ? `<option value="${v}" selected>${v}% used</option>` : ''}</select>`;
    body.innerHTML = `
      <div class="issues-head"><h2>Usage</h2><span class="hint">What is used and left of each engine's plan limits</span><span class="spacer"></span><button class="small" data-usage="refresh" title="Read again">↻</button><button class="small" data-usage="close" title="Close (Esc)">Close</button></div>
      <div class="issues-scroll usage-scroll">
        ${data.engines.map(engineHtml).join('') || '<p class="hint issues-empty">No engine is installed.</p>'}
        <div class="usage-settings">
          <label>Alert me at ${level('warnAt', s.warnAt, 'never')}</label>
          <label title="No new agent starts on an engine at or past this much of a limit (the backlog waits, and New agents says why). Agents already running carry on.">Hold new work at ${level('holdAt', s.holdAt, 'never')}</label>
        </div>
        <p class="hint">These are numbers the engines hand out on this computer: Claude Code gives them to the status line of the sessions started here, Codex writes them in its session logs. No service is asked and no model is called. A limit an agent actually hits is shown for any engine until it resets, and the agent carries on by itself when it does.</p>
      </div>`;
  }

  const save = async (patch, done) => {
    try {
      data = await api('PUT', '/usage', patch);
      if (done) toast?.(done, 3000);
    } catch (e) {
      toast?.(e.message, 6000);
    }
    drawChip();
    draw();
  };

  body.addEventListener('click', (e) => {
    const d = e.target.closest('[data-usage-default]');
    if (d) return save({ engine: d.dataset.usageDefault }, 'New agents start there from now on');
    const b = e.target.closest('[data-usage]')?.dataset.usage;
    if (b === 'close') dialog.close();
    else if (b === 'refresh') load();
  });
  body.addEventListener('change', (e) => {
    const s = e.target.closest('[data-usage-set]');
    if (s) save({ [s.dataset.usageSet]: s.value }, 'Saved');
  });
  if (chip) chip.onclick = () => open();

  function open() {
    if (dialog.open) return dialog.close();
    dialog.showModal();
    draw();
    load();
  }
  /** The daemon has a new reading. */
  function changed() {
    clearTimeout(again);
    again = setTimeout(() => load({ quiet: true }), 400);
  }
  // "resets in 2h 10m" counts down, and a window that reset says so.
  setInterval(() => (dialog.open || !chip?.hidden) && load({ quiet: true }), 60_000);
  load({ quiet: true });
  return { open, changed, isOpen: () => dialog.open };
}
