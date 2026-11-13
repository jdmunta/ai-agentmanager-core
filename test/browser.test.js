// The page itself, in headless Chrome, against a daemon of its own (test/fake-claude.js as the
// engine): the top bar fits the window, and the split screen splits, loads, types, resizes and
// remembers. Skipped when no Chrome-family browser is installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { findBrowser } from '../src/livebrowser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const chromeBin = findBrowser();
const skip = chromeBin ? false : 'no Chrome-family browser installed';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

let home, daemon, chrome, ws, base, notes;
// AI News reads its release notes from here, never the internet.
const today = new Date().toISOString().slice(0, 10);
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
// ...and Today's calendar: a meeting late today (this computer's time), and one that names an agent.
const calIcs = () => {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:1', 'SUMMARY:Design sync', 'DESCRIPTION:About task-2', `DTSTART:${ymd}T235000`, `DTEND:${ymd}T235500`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
};
let notesMd = `## ${longDate(today)}\n\n* We launched **Model One** ([docs](https://example.com/one)).\n* Faster batches. See [batches](https://example.com/batches).\n`;
let seq = 0;
const pending = new Map();
const errors = [];
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, replMode: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  in: ${expression.slice(0, 160)}`);
  return r.result.value;
};
// Waits for an expression to be true; one that throws (the page is between two loads) is tried again.
const until = async (expression, what, ms = 10_000) => {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    try {
      if (await js(expression)) return;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
};
// A reload: the checks that follow must see the new page, not the old one still on screen.
const reload = async () => {
  await js(`window.__old = true`);
  await send('Page.reload');
  await until(`!window.__old && document.readyState === 'complete'`, 'the page to reload', 20_000);
};
const width = (w, h = 900) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
// Keys as Chrome sends them: modifiers Alt 1, Ctrl 2, Meta 4, Shift 8.
const key = async (code, keyName, vk, modifiers) => {
  for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, code, key: keyName, windowsVirtualKeyCode: vk, modifiers });
};
const api = async (method, route, body) => (await fetch(`${base}/api${route}`, { method, headers: { 'content-type': 'application/json', 'x-agentmgr': '1' }, body: body && JSON.stringify(body) })).json();

before(async () => {
  if (skip) return;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmgr-browser-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const http = await import('node:http');
  notes = http.createServer((req, res) => res.end(req.url.endsWith('.ics') ? calIcs() : notesMd));
  await new Promise((r) => notes.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claudeBin: process.execPath, claudeArgs: [path.join(here, 'fake-claude.js')], updates: { check: false }, judge: { enabled: false }, shell: '/bin/sh', gitRefreshSec: 1, conflictRefreshSec: 0, news: { sources: [], custom: [{ id: 'local', lab: 'Anthropic', label: 'Local notes', url: `http://127.0.0.1:${notes.address().port}/notes.md` }] } }));
  daemon = spawn(process.execPath, [path.join(here, '..', 'bin', 'agentmgr.js'), 'serve'], {
    env: { ...process.env, AGENTMGR_HOME: home, AGENTMGR_PORT: String(port), AGENTMGR_REMOTE: '0', AGENTMGR_PLUGINS: '', AGENTMGR_NO_GH: '1', CLAUDE_CONFIG_DIR: path.join(home, 'claude'), AGENTMGR_CLAUDE_DESKTOP_DIR: path.join(home, 'claude-desktop'), FAKE_CLAUDE_LOG: path.join(home, 'fake.log') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/agents`)).ok) break;
    } catch {}
    await sleep(100);
  }
  for (const n of [1, 2, 3]) {
    fs.mkdirSync(path.join(home, `w${n}`));
    await api('POST', '/agents', { intent: `Task ${n}`, workdir: path.join(home, `w${n}`) });
  }

  const cdpPort = await freePort();
  chrome = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(home, 'chrome')}`, '--no-first-run', '--no-default-browser-check', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(150);
    try {
      target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === 'page');
    } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.once('open', r));
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  // BROWSER_TEST_CPU=6 runs the page 6x slower, to find waits that only hold on a fast machine.
  if (Number(process.env.BROWSER_TEST_CPU) > 1) await send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.BROWSER_TEST_CPU) });
  await width(1600);
  await send('Page.navigate', { url: `${base}/` });
  await until(`document.querySelectorAll('#agent-list li[data-id]').length === 3`, 'the agents listed', 20_000);
});

// Chrome and the daemon write to the home folder as they stop: let them exit before removing it.
const stopped = (child) => (child && child.exitCode === null && child.signalCode === null ? new Promise((r) => (child.once('exit', r), child.kill(), setTimeout(r, 5000))) : null);
after(async () => {
  ws?.close();
  await Promise.all([stopped(chrome), stopped(daemon)]);
  notes?.close();
  // Chrome's helper processes can still be writing its profile for a moment; a temp folder left behind isn't a failure.
  if (home) {
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {}
  }
});

test('the top bar fits the window: the view buttons that do not fit go into More', { skip }, async () => {
  for (const w of [1600, 1280, 1024, 800, 420]) {
    await width(w);
    await sleep(300);
    const r = await js(`({
      page: document.documentElement.scrollWidth,
      inRow: document.querySelectorAll('#top-nav > button').length,
      inMore: document.querySelector('#top-more').hidden ? 0 : document.querySelectorAll('#top-more-menu > button').length,
      newOk: document.querySelector('#new-btn').getBoundingClientRect().right <= innerWidth,
      menuOk: document.querySelector('#menu-btn').getBoundingClientRect().right <= innerWidth,
    })`);
    assert.ok(r.page <= w, `${w}px: the page is ${r.page}px wide`);
    assert.equal(r.inRow + r.inMore, 17, `${w}px: every view button is in the row or in More`);
    assert.ok(r.newOk && r.menuOk, `${w}px: New agents and the account menu are on screen`);
    if (w >= 1024) assert.ok(r.inRow >= 3, `${w}px: only ${r.inRow} buttons in the row`);
  }
  await width(1024);
  await sleep(300);
  await js(`document.querySelector('#top-more-btn').click()`);
  assert.equal(await js(`document.querySelector('#top-more-menu').hidden`), false);
  await js(`document.querySelector('#top-more-menu > button').click()`);
  await until(`document.querySelector('#top-more-menu').hidden`, 'More to close after picking an item');
  await width(1600);
  await reload();
  await until(`document.querySelectorAll('#agent-list li[data-id]').length === 3`, 'the agents listed again');
});

test('split screen: split, load, type, follow sizes, keys, reload, close', { skip }, async () => {
  const ids = await js(`[...document.querySelectorAll('#agent-list li[data-id]')].map((l) => l.dataset.id)`);
  const xtermRows = (sel) => `document.querySelector('${sel} .xterm-rows')?.textContent ?? ''`;

  // The main panel shows the first agent's session.
  await js(`document.querySelector('#agent-list li[data-id="${ids[0]}"]').click()`);
  await until(`[...document.querySelectorAll('#detail-body button')].some((b) => b.textContent.trim() === 'Open terminal')`, 'Open terminal');
  await js(`[...document.querySelectorAll('#detail-body button')].find((b) => b.textContent.trim() === 'Open terminal').click()`);
  await until(`${xtermRows('#terminal')}.includes('fake-claude ready')`, 'the main terminal');

  // Plain Ctrl+\ in a terminal is the terminal's; Ctrl+Shift+\ splits.
  await js(`document.querySelector('#terminal textarea').focus()`);
  await key('Backslash', '\\', 220, 2);
  await sleep(300);
  assert.equal(await js(`document.querySelectorAll('.gpane').length`), 0, 'plain Ctrl+\\ did not split');
  await key('Backslash', '|', 220, 2 | 8);
  await until(`document.querySelectorAll('.gpane.active.empty').length === 1`, 'an empty active group');

  // Clicking an agent in the list loads it into the active group; the main panel stays.
  await js(`document.querySelector('#agent-list li[data-id="${ids[1]}"]').click()`);
  await until(`${xtermRows('.gpane')}.includes('fake-claude ready')`, 'the session in the group');
  assert.ok(await js(`location.hash.includes('${ids[0]}')`), 'the main panel still shows the first agent');

  // Typing in the group reaches its session.
  await js(`document.querySelector('.gpane .gterm textarea').focus()`);
  await send('Input.insertText', { text: 'hello-split' });
  await key('Enter', 'Enter', 13, 0);
  await until(`${xtermRows('.gpane')}.includes('echo:hello-split')`, 'the echo in the group');

  // The same session in two views of different sizes: the one typed in sets the size, the other
  // shows it at that size with the font scaled to fit; going back to the other hands it back.
  await js(`(() => { const s = document.querySelector('.gpane .gpick'); s.value = '${ids[0]}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`${xtermRows('.gpane')}.includes('fake-claude ready')`, 'the first agent in the group too');
  await js(`document.querySelector('.gsplit').firstElementChild.style.flex = '0 0 calc(70% - 3px)'`);
  await sleep(400);
  const rows = (sel) => `document.querySelector('${sel} .xterm-rows').children.length`;
  const font = (sel) => `parseFloat(getComputedStyle(document.querySelector('${sel} .xterm-rows')).fontSize)`;
  await js(`document.querySelector('.gpane .gterm textarea').focus()`);
  await send('Input.insertText', { text: 'x' });
  await until(`${rows('#terminal')} === ${rows('.gpane')} && ${font('.gpane')} === 13`, 'the main terminal following the group');
  await key('Digit1', '!', 49, 2 | 8);
  await until(`document.querySelector('#detail').classList.contains('gactive')`, 'the main group active');
  await until(`${rows('#terminal')} === ${rows('.gpane')} && ${font('#terminal')} === 13`, 'the group following the main terminal');

  // Ctrl+Shift+2 goes to the split group (Ctrl+Shift+1 went to the main one above).
  await key('Digit2', '@', 50, 2 | 8);
  await until(`document.querySelector('.gpane').classList.contains('active')`, 'the split group active');

  // Dropping an agent on the group's bottom edge splits it down, showing that agent.
  await js(`(() => {
    const li = document.querySelector('#agent-list li[data-id="${ids[2]}"]');
    const dt = new DataTransfer();
    li.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const pane = document.querySelector('.gpane');
    const r = pane.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.bottom - 8 };
    pane.dispatchEvent(new DragEvent('dragover', at));
    pane.dispatchEvent(new DragEvent('drop', at));
    document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  })()`);
  await until(`document.querySelectorAll('.gpane').length === 2 && document.querySelector('.gsplit.gcol')`, 'a group below');
  await until(`${xtermRows('.gpane.active')}.includes('fake-claude ready')`, 'the dropped agent in the new group');

  // A reload brings the layout and the sessions back.
  await reload();
  await until(`document.querySelectorAll('.gpane').length === 2 && document.querySelectorAll('.gpane .xterm-rows').length === 2 && [...document.querySelectorAll('.gpane .xterm-rows')].every((r) => r.textContent.includes('fake-claude ready'))`, 'the groups after a reload', 15_000);

  // Ctrl+Shift+X closes the active group; the group's name moves the last one to the main panel.
  await js(`document.querySelectorAll('.gpane')[1].querySelector('.gterm textarea').focus()`);
  await until(`document.querySelectorAll('.gpane')[1].classList.contains('active') && document.activeElement?.closest('.gpane') === document.querySelectorAll('.gpane')[1]`, 'the lower group active');
  await sleep(500); // the main terminal reconnecting must not take the keyboard back
  assert.ok(await js(`document.querySelectorAll('.gpane')[1].classList.contains('active')`), 'the lower group stays active after the sessions reconnect');
  await key('KeyX', 'X', 88, 2 | 8);
  await until(`document.querySelectorAll('.gpane').length === 1`, 'one group left');
  await js(`document.querySelector('.gpane [data-g="main"]').click()`);
  await until(`document.querySelectorAll('.gpane').length === 0 && !document.querySelector('#groups').classList.contains('split')`, 'back to one panel');

  assert.deepEqual(errors, [], 'no errors on the page');
});

test("expanded, the terminal bar names the agent whose session it is; it follows the tab and a rename", { skip }, async () => {
  const listed = await api('GET', '/agents');
  const [a] = listed;
  const shown = `(() => { const e = document.querySelector('#term-agent'); return e.offsetParent ? e.textContent : null; })()`;
  await js(`document.querySelector('#agent-list li[data-id="${a.id}"]').click()`);
  await until(`[...document.querySelectorAll('#detail-body button')].some((x) => x.textContent.trim() === 'Open terminal')`, 'Open terminal');
  await js(`[...document.querySelectorAll('#detail-body button')].find((x) => x.textContent.trim() === 'Open terminal').click()`);
  await until(`!document.querySelector('#term-wrap').hidden`, 'the terminal');
  assert.equal(await js(shown), null, 'not shown while the detail above names the agent');

  await js(`document.querySelector('#term-max').click()`);
  await until(`${shown} === ${JSON.stringify(a.name)}`, 'the name when expanded');
  await js(`document.querySelector('.term-tab[data-kind="code"]').click()`);
  await until(`${shown} === ${JSON.stringify(a.name)} && document.querySelector('#term-wrap').classList.contains('coding')`, 'the name on the Code tab too');
  // Renamed while expanded: the new name.
  await fetch(`${base}/api/agents/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-agentmgr': '1' }, body: JSON.stringify({ name: 'Renamed agent' }) });
  await until(`${shown} === 'Renamed agent'`, 'the new name');

  await js(`document.querySelector('#term-max').click()`);
  await until(`${shown} === null`, 'hidden again when restored');
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Actions: the Due tab lists what is due and not done, soonest first, overdue in red', { skip }, async () => {
  const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString();
  const late = await api('POST', '/actions', { text: 'Send the numbers', due: 'today', when: days(-3) });
  await api('POST', '/actions', { text: 'Plan the rollout', due: 'next sprint' });
  await api('POST', '/actions', { text: 'Book the review', due: 'tomorrow' });
  await api('POST', '/actions', { text: 'No date on this one' });
  const done = await api('POST', '/actions', { text: 'Already handled', due: 'today' });
  await api('POST', '/actions/set', { ids: [done.id], state: 'done' });
  await api('POST', '/actions/set', { ids: [late.id], state: 'skip' });

  // The button shows only with Slack or meeting notes set up; the window itself works either way.
  await js(`document.querySelector('#actions-btn').click()`);
  await until(`document.querySelector('#actions-dialog').open && document.querySelector('[data-act-filter="due"]')`, 'the Actions window');
  await js(`document.querySelector('[data-act-filter="due"]').click()`);
  await until(`document.querySelectorAll('#actions-body tbody tr').length === 3`, 'three dues');
  const r = await js(`({
    texts: [...document.querySelectorAll('#actions-body .action-text')].map((e) => e.textContent),
    dues: [...document.querySelectorAll('#actions-body .action-due')].map((e) => [e.textContent, e.classList.contains('late')]),
    chip: document.querySelector('[data-act-filter="due"]').classList.contains('late'),
  })`);
  assert.deepEqual(r.texts, ['Send the numbers', 'Book the review', 'Plan the rollout'], 'overdue first (skipped is still yours), then by date; no date said last; done and dateless left out');
  assert.deepEqual(r.dues, [['overdue 3 days', true], ['due tomorrow', false], ['due next sprint', false]]);
  assert.ok(r.chip, 'the Due tab shows there is something overdue');
  await js(`document.querySelector('[data-act="close"]').click()`);
  assert.deepEqual(errors, [], 'no errors on the page');
});

test("overlaps: behind their own button in the agent's detail, not on the page", { skip }, async () => {
  // Two agents in one repo changing the same lines.
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
  const origin = path.join(home, 'ov.git');
  const seed = path.join(home, 'ov-seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, seed]);
  fs.writeFileSync(path.join(seed, 'app.js'), 'line1\nline2\nline3\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'app');
  git(seed, 'push', '-q', 'origin', 'main');
  const [x, y] = await api('POST', '/agents', { intents: ['Change line two', 'Also change line two'], repo: `file://${origin}` });
  const ready = async (id) => {
    for (let i = 0; i < 200; i++) {
      const a = (await api('GET', '/agents')).find((v) => v.id === id);
      if (a?.workdir && a.status === 'running') return a;
      await sleep(100);
    }
    throw new Error(`agent ${id} not ready`);
  };
  const [rx, ry] = [await ready(x.id), await ready(y.id)];
  fs.writeFileSync(path.join(rx.workdir, 'app.js'), 'line1\nLINE TWO\nline3\n');
  fs.writeFileSync(path.join(ry.workdir, 'app.js'), 'line1\nline 2!\nline3\nline4\n');

  let seen;
  for (let i = 0; i < 200 && !seen?.conflicts?.length; i++) {
    seen = (await api('GET', '/agents')).find((v) => v.id === x.id);
    await sleep(100);
  }
  assert.ok(seen?.conflicts?.length, 'the radar flags them');
  await js(`document.querySelector('#agent-list li[data-id="${x.id}"]').click()`);
  await until(`document.querySelector('#detail-body button[data-act="overlaps"] .count')?.textContent === '1'`, 'the Overlaps button with its count', 20_000);
  assert.equal(await js(`document.querySelectorAll('#detail-body .need').length`), 0, 'no overlap card on the page');
  await js(`document.querySelector('#detail-body button[data-act="overlaps"]').click()`);
  await until(`document.querySelector('#needs-dialog').open && document.querySelector('#needs-title').textContent === ${JSON.stringify(`Overlaps: ${rx.name}`)}`, 'the Overlaps panel');
  const card = await js(`document.querySelector('#needs-body .need')?.textContent ?? ''`);
  assert.match(card, new RegExp(ry.name), 'names the other agent');
  assert.match(card, /app\.js/, 'and the file');
  await js(`document.querySelector('#needs-close').click()`);
  for (const id of [x.id, y.id]) await fetch(`${base}/api/agents/${id}`, { method: 'DELETE', headers: { 'x-agentmgr': '1' } });
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('AI News: release notes summarized, the top labs from a web search, filters, and what is new', { skip }, async () => {
  await js(`document.querySelector('#news-btn').click()`);
  await until(`document.querySelector('#news-dialog').open && document.querySelector('[data-news="refresh"]')`, 'the AI News window');
  await until(`!document.querySelector('[data-news="refresh"]').disabled`, 'not refreshing', 20_000);
  await js(`document.querySelector('[data-news="refresh"]').click()`);
  const titles = `[...document.querySelectorAll('#news-body .news-title')].map((a) => a.textContent)`;
  await until(`${titles}.length === 3 && [...document.querySelectorAll('#news-body .news-summary')].every((p) => !p.classList.contains('hint'))`, 'three entries, each summarized', 30_000);
  const r = await js(`({
    titles: ${titles},
    summaries: [...document.querySelectorAll('#news-body .news-summary')].map((p) => p.textContent),
    day: document.querySelector('#news-body .news-day').textContent,
    chips: [...document.querySelectorAll('[data-news-lab]')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()),
    links: [...document.querySelectorAll('#news-body .news-links a')].map((a) => a.href),
  })`);
  assert.deepEqual([...r.titles].sort(), ['Faster batches.', 'Grok Fake 9', 'We launched Model One (docs).']);
  assert.ok(r.summaries.includes('Fake summary: Faster batches.') && r.summaries.includes('A fake frontier model from the web search.'), JSON.stringify(r.summaries));
  assert.equal(r.day, 'Today');
  assert.deepEqual(r.chips, ['All 3', 'Anthropic 2', 'xAI 1'], 'the web search adds a lab without release notes here; the old one is left out');
  assert.ok(r.links.includes('https://example.com/batches'), 'its links');

  // On a phone the list scrolls inside the window; it isn't cut off below it.
  await width(390, 320);
  const fit = await js(`(() => {
    const d = document.querySelector('#news-dialog').getBoundingClientRect();
    const l = document.querySelector('#news-body .news-list');
    return { inside: l.getBoundingClientRect().bottom <= d.bottom + 1, scrolls: l.scrollHeight > l.clientHeight && getComputedStyle(l).overflowY === 'auto' };
  })()`);
  assert.deepEqual(fit, { inside: true, scrolls: true }, 'the news list scrolls on a small screen');
  await width(1600);

  // Filters: a lab, then words.
  await js(`document.querySelector('[data-news-lab="xAI"]').click()`);
  await until(`JSON.stringify(${titles}) === '["Grok Fake 9"]'`, 'only xAI');
  await js(`document.querySelector('[data-news-lab="all"]').click()`);
  await js(`(() => { const f = document.querySelector('[data-news-find]'); f.focus(); f.value = 'batch'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(`JSON.stringify(${titles}) === '["Faster batches."]' && document.activeElement?.matches('[data-news-find]')`, 'found by words, still typing');
  await js(`(() => { const f = document.querySelector('[data-news-find]'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  // Closing is the first look; what comes after it is new, counted on the button.
  await js(`document.querySelector('[data-news="close"]').click()`);
  await until(`(await (await fetch('/api/news')).json()).seenAt`, 'seen');
  notesMd = notesMd.replace('\n\n', '\n\n* Brand new thing.\n');
  await api('POST', '/news/refresh');
  await until(`document.querySelector('#news-count').textContent === '1'`, 'one new on the button', 30_000);
  await js(`document.querySelector('#news-btn').click()`);
  await until(`[...document.querySelectorAll('#news-body .news-item.new .news-title')].map((a) => a.textContent).join() === 'Brand new thing.'`, 'marked new');
  await js(`document.querySelector('[data-news="close"]').click()`);
  await until(`document.querySelector('#news-count').textContent === ''`, 'the count cleared after looking');
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Debug: asked beside the session, the report drawn with its animated diagrams, follow-ups and fixes', { skip }, async () => {
  const a = (await api('GET', '/agents')).find((v) => v.intent === 'Task 2');
  await js(`document.querySelector('#agent-list li[data-id="${a.id}"]').click()`);
  await until(`document.querySelector('#detail-body button[data-act="debug"]')`, 'the Debug button');
  await js(`document.querySelector('#detail-body button[data-act="debug"]').click()`);
  await until(`!document.querySelector('#side-pane').hidden && document.querySelector('[data-side="debug"]').classList.contains('active') && document.querySelector('[data-debug-text]')`, 'the Debug tab beside the terminal');
  assert.equal(await js(`document.querySelector('[data-debug-form] button.primary').textContent`), 'Debug');
  assert.equal(await js(`Boolean(document.querySelector('[data-debug-fix]'))`), false, 'no fixes to apply before a report');

  // An idea fills the box; what you type instead is what's sent.
  await js(`document.querySelector('[data-debug-idea]').click()`);
  assert.equal(await js(`document.querySelector('[data-debug-text]').value`), 'E2E tests unstable at max scale');
  await js(`(() => { const t = document.querySelector('[data-debug-text]'); t.value = 'Imports stall at 500 tenants'; t.form.requestSubmit(); })()`);
  await until(`document.querySelector('.debug-asked summary')?.textContent === 'Asked (1)'`, 'the question listed');
  // The message is long: its end is what's still on screen (lines wrap, so spaces aside).
  await until(`document.querySelector('#terminal .xterm-rows').textContent.replace(/\\s/g, '').includes('whichfixyourecommendfirst.')`, "typed into the agent's session", 20_000);

  // The agent writes its report: it shows here, diagrams drawn and the path animated.
  const dir = path.join(home, 'briefs', a.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'DEBUG.md'), '# Debug: imports at scale\n## Summary\nThe pool runs dry.\n## Code path\n```mermaid\nflowchart LR\n  A["importer.run"] e1@--> B["pool.get"]\n  e1@{ animate: true }\n  classDef fault stroke:#ef4444,stroke-width:3px\n  class B fault\n```\n## Recommended fixes\n1. Raise the pool size.\n');
  await until(`document.querySelector('.debug-report h1')?.textContent === 'Debug: imports at scale'`, 'the report', 20_000);
  await until(`document.querySelector('.debug-report .diagram svg')`, 'its diagram drawn', 20_000);
  assert.ok(await js(`/animat|dash/i.test(document.querySelector('.debug-report .diagram svg').outerHTML)`), 'the path is animated');
  assert.equal(await js(`document.querySelector('[data-debug-form] button.primary').textContent`), 'Ask');
  await until(`/report/.test(document.querySelector('#detail-body button[data-act="debug"]').textContent)`, 'the Debug button says there is a report');

  // What's typed survives the pane redrawing; then the fixes are asked for by name.
  await js(`(() => { const t = document.querySelector('[data-debug-text]'); t.focus(); t.value = '1'; })()`);
  await js(`document.querySelector('[data-debug-fix]').click()`);
  await until(`document.querySelector('.debug-asked summary')?.textContent === 'Asked (2)' && document.querySelector('.debug-asked li:last-child').textContent.trim() === 'fix Apply fixes: 1'`, 'the fix asked for');
  await js(`document.querySelector('#side-close').click()`);
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Plan: project dates with checklists, the decision log, the tech debt radar; Today shows the date and the day around a meeting', { skip }, async () => {
  // A project with an agent at work in its folder, and one that is a git repository.
  for (const n of ['p1', 'p3']) fs.mkdirSync(path.join(home, n));
  const [worker] = await api('POST', '/agents', { intent: 'Plan task', dir: path.join(home, 'p1') });
  for (let i = 0; i < 100 && (await api('GET', '/agents')).find((a) => a.id === worker.id)?.status !== 'running'; i++) await sleep(100);
  const w3 = await api('POST', '/projects', { shortcut: 'pthree', dir: path.join(home, 'p3') });
  const w1 = (await api('GET', '/projects')).find((p) => p.dir === path.join(home, 'p1'));
  assert.ok(w1, 'the agent\'s folder is a project');
  const iso = (days) => {
    const d = new Date(Date.now() + days * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  // Dates: code complete in 3 days with an agent still working is at risk.
  await js(`document.querySelector('#plan-btn').click()`);
  await until(`document.querySelector('#plan-dialog').open && document.querySelector('[data-plan="add"]')`, 'the Plan window');
  await js(`document.querySelector('[data-plan-tab="dates"]').click()`);
  await until(`document.querySelector('[data-plan="add"]') && !document.querySelector('[data-plan="add"]').disabled`, 'projects to add dates for');
  await js(`document.querySelector('[data-plan="add"]').click()`);
  await js(`(() => { const f = document.querySelector('form[data-plan-dates=""]'); f.project.value = ${JSON.stringify(w1.shortcut)}; f.codeComplete.value = '${iso(3)}'; f.rc.value = '${iso(10)}'; f.ga.value = '${iso(30)}'; f.requestSubmit(); })()`);
  await until(`document.querySelectorAll('.plan-stage').length === 3`, 'the three dates');
  const stages = await js(`[...document.querySelectorAll('.plan-stage')].map((s) => [s.querySelector('b').textContent, s.querySelector('.tag').textContent, s.querySelector('.plan-left').textContent, s.querySelectorAll('.plan-reminder').length])`);
  assert.deepEqual(stages, [['Code complete', 'At risk', 'in 3 days', 5], ['Release candidate', 'On track', 'in 10 days', 5], ['GA', 'On track', 'in 30 days', 5]]);
  assert.match(await js(`document.querySelector('.plan-stage .plan-check.open').textContent`), /1\s*1 agent still working/);
  await until(`document.querySelector('#plan-count').textContent === '1'`, 'one date at risk on the button');
  // One of yours ticked; the dates out of order are refused.
  await js(`document.querySelector('.plan-stage input[type=checkbox]').click()`);
  await until(`document.querySelector('.plan-stage .plan-check.ok input[type=checkbox]')?.checked`, 'ticked');
  await js(`(() => { const f = document.querySelector('form[data-plan-dates]:not([data-plan-dates=""])'); f.rc.value = '${iso(1)}'; f.requestSubmit(); })()`);
  await until(`[...document.querySelectorAll('.toast, #toast')].some((t) => /in order/.test(t.textContent))`, 'refused: the dates go in order');

  // Decisions: one of yours, found by a word.
  await js(`document.querySelector('[data-plan-tab="decisions"]').click()`);
  await until(`document.querySelector('[data-plan-find]')`, 'the decision log');
  await js(`document.querySelector('[data-plan="add"]').click()`);
  await js(`(() => { const f = document.querySelector('[data-plan-decision]'); f.project.value = ${JSON.stringify(w1.shortcut)}; f.title.value = 'Cursor or offset paging'; f.decision.value = 'Offset'; f.why.value = 'Small tables'; f.requestSubmit(); })()`);
  await until(`document.querySelector('.plan-decision b')?.textContent === 'Cursor or offset paging'`, 'the decision listed');
  assert.match(await js(`document.querySelector('.plan-decision').textContent`), /Decided:\s*Offset[\s\S]*Why:\s*Small tables[\s\S]*Added by you/);
  await js(`(() => { const f = document.querySelector('[data-plan-find]'); f.focus(); f.value = 'nothing like it'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(`!document.querySelector('.plan-decision') && document.activeElement?.matches('[data-plan-find]')`, 'filtered while typing');
  await js(`document.activeElement.blur()`);

  // Debt: a real repository, one file changed often and tangled.
  const repo = w3.dir;
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo });
  git('init', '-q', '-b', 'main');
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(repo, 'importer.js'), `export function run(a) {\n${Array.from({ length: 70 + i }, (_, k) => `          if (a.x${k} && a.y${k}) { a.z += ${k}; } // TODO ${k}`).join('\n')}\n}\n`);
    git('add', 'importer.js');
    git('commit', '-q', '-m', i % 2 ? 'Fix the importer' : 'Importer: more');
  }
  await js(`document.querySelector('[data-plan-tab="debt"]').click()`);
  await until(`document.querySelector('[data-plan-scan="${w3.shortcut}"]') && !document.querySelector('[data-plan-scan="${w3.shortcut}"]').disabled`, 'the project to scan');
  await js(`document.querySelector('[data-plan-scan="${w3.shortcut}"]').click()`);
  await until(`document.querySelector('table.plan-debt code')?.textContent === 'importer.js'`, 'the hot spot', 20_000);
  assert.match(await js(`document.querySelector('table.plan-debt tr').textContent`), /changed 5 times in 90 days · 3 of them fixes/);
  await js(`document.querySelector('[data-plan-notdebt]').click()`);
  await until(`!document.querySelector('table.plan-debt code')`, 'set aside');
  await js(`document.querySelector('[data-plan="close"]').click()`);

  // Today: the date near the top, and the day planned around a meeting once the calendar is connected.
  await js(`document.querySelector('#today-btn').click()`);
  await until(`document.querySelector('#today-dialog').open && document.querySelector('tr.today-milestone')`, 'the date in Today', 20_000);
  assert.match(await js(`document.querySelector('tr.today-milestone').textContent`), /At risk[\s\S]*Code complete in 3 days[\s\S]*1 agent still working/);
  await js(`document.querySelector('[data-day="settings"]').click()`);
  await js(`(() => { const f = document.querySelector('[data-day-form]'); f.ics.value = 'http://127.0.0.1:${notes.address().port}/secret/cal.ics'; f.workStart.value = '00:00'; f.workEnd.value = '23:59'; f.requestSubmit(); })()`);
  await until(`document.querySelector('.day-meeting b')?.textContent === 'Design sync'`, 'the meeting', 20_000);
  const dayRows = await js(`({ free: document.querySelectorAll('.day-free').length, about: document.querySelector('.day-meeting [data-day-agent]')?.textContent, head: document.querySelector('.today-day-head').textContent, html: document.querySelector('#today-body').innerHTML.includes('secret') })`);
  assert.ok(dayRows.free >= 1, 'free time before it');
  assert.equal(dayRows.about, 'task-2', 'the agent the meeting names');
  assert.match(dayRows.head, /1 meeting today \(5m\)[\s\S]*Next: Design sync/);
  assert.equal(dayRows.html, false, "the calendar's address isn't shown");
  await js(`document.querySelector('[data-today="close"]').click()`);
  assert.deepEqual(errors, [], 'no errors on the page');
});
