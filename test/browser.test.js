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
const until = async (expression, what, ms = 10_000, info = null) => {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    try {
      if (await js(expression)) return;
    } catch (e) {
      last = e;
    }
  }
  // What the page showed when the wait gave up, when the caller said what to look at.
  let seen = '';
  if (info) {
    try {
      seen = `; saw ${JSON.stringify(await js(info))}`;
    } catch (e) {
      seen = `; could not read what it saw: ${e.message}`;
    }
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}${seen}`);
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
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claudeBin: process.execPath, claudeArgs: [path.join(here, 'fake-claude.js')], updates: { check: false }, announce: { auto: false }, judge: { enabled: false, idleSec: 2, warmupSec: 0 }, localModels: { enabled: false }, preReview: { enabled: false }, shell: '/bin/sh', gitRefreshSec: 1, conflictRefreshSec: 0, engines: { codex: { bin: path.join(here, 'fake-codex.js') } }, news: { sources: [], custom: [{ id: 'local', lab: 'Anthropic', label: 'Local notes', url: `http://127.0.0.1:${notes.address().port}/notes.md` }] } }));
  // Quality: merged pull requests already looked at (GitHub is not asked in these tests).
  const mergedPr = (n, title, extra = {}) => [`https://github.com/acme/shop/pull/${n}`, { url: `https://github.com/acme/shop/pull/${n}`, number: n, title, repo: 'acme/shop', agentId: 'gone', agentName: `agent-${n}`, project: 'Shop', openedAt: new Date(Date.now() - 3 * 3_600_000 - 2000).toISOString(), mergedAt: new Date(Date.now() - 2000).toISOString(), facts: { mergeCommit: `sha${n}`, base: 'main', files: ['src/cache.js'], lines: 40 + n, changesRequested: n === 71 ? 2 : 0, reviews: 1 }, after: { reverted: null, fixes: [], checks: { state: 'passed', failed: [] } }, checkedAt: new Date().toISOString(), ...extra }];
  const qualityItems = Object.fromEntries([
    mergedPr(71, 'Cache prices', { said: { confidence: 90, recommendation: 'ready', breaks: null, engine: 'claude', model: 'opus', level: 'pr' }, after: { reverted: null, fixes: [{ number: 75, title: 'Fix stale prices', url: 'https://github.com/acme/shop/pull/75', at: new Date().toISOString(), shared: ['src/cache.js'], named: false }], checks: { state: 'passed', failed: [] } } }),
    mergedPr(72, 'Export orders', { said: { confidence: 96, recommendation: 'look', breaks: { caught: 1, tried: 3 }, engine: 'claude', model: 'opus', level: 'pr' }, after: { reverted: { number: 76, title: 'Revert "Export orders"', url: 'https://github.com/acme/shop/pull/76', at: new Date().toISOString() }, fixes: [], checks: { state: 'passed', failed: [] } } }),
    mergedPr(73, 'Faster search'),
    mergedPr(74, 'New footer', { facts: null, after: null, checkedAt: null }),
  ]);
  // Standards: a repository with a lesson proposed from the pull request that was reverted.
  const shop = 'repo:github.com/acme/shop';
  const standards = {
    repos: { [shop]: { name: 'acme/shop', risk: [], bar: { tests: false, secrets: true, checks: [] }, lessons: [{ id: 'p72', text: '', state: 'proposed', source: { kind: 'reverted', detail: 'Reverted by #76 Revert "Export orders"', url: 'https://github.com/acme/shop/pull/72', number: 72, title: 'Export orders', agentId: 'gone' }, at: new Date().toISOString() }] } },
    seen: { 'https://github.com/acme/shop/pull/72': shop },
  };
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ version: 1, agents: {}, quality: { items: qualityItems }, standards }));
  daemon = spawn(process.execPath, [path.join(here, '..', 'bin', 'agentmgr.js'), 'serve'], {
    env: { ...process.env, AGENTMGR_HOME: home, AGENTMGR_PORT: String(port), AGENTMGR_REMOTE: '0', AGENTMGR_PLUGINS: '', AGENTMGR_NO_GH: '1', AGENTMGR_CLIPBOARD_FILE: path.join(home, 'clipboard.txt'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), AGENTMGR_CLAUDE_DESKTOP_DIR: path.join(home, 'claude-desktop'), FAKE_CLAUDE_LOG: path.join(home, 'fake.log') },
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
  // A loaded CI runner can take long to open Chrome's first page, or lose it: wait, then start it once more.
  let target;
  for (let attempt = 0; attempt < 2 && !target; attempt++) {
    chrome?.kill('SIGKILL');
    chrome = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(home, 'chrome')}`, '--no-first-run', '--no-default-browser-check', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 200 && !target; i++) {
      await sleep(150);
      try {
        target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === 'page');
      } catch {}
    }
  }
  assert.ok(target, 'Chrome opened a page to drive');
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
    assert.equal(r.inRow + r.inMore, 24, `${w}px: every view button is in the row or in More`);
    assert.ok(r.newOk && r.menuOk, `${w}px: New agents and the account menu are on screen`);
    if (w >= 1024) assert.ok(r.inRow >= 3, `${w}px: only ${r.inRow} buttons in the row`);
  }
  // On a phone the menu is longer than the screen: it ends at the bottom and scrolls to its last item.
  await width(420, 700);
  await sleep(300);
  await js(`document.querySelector('#top-more-btn').click()`);
  // A loaded runner lays the menu out a moment after the click.
  await until(`(() => { const m = document.querySelector('#top-more-menu'); return m.getBoundingClientRect().height > 0 && m.scrollHeight > m.clientHeight; })()`, 'the menu open, longer than the screen');
  const long = await js(`(() => { const m = document.querySelector('#top-more-menu'); const last = m.querySelector(':scope > button:last-of-type');
    const fits = m.getBoundingClientRect().bottom <= innerHeight; const scrolls = m.scrollHeight > m.clientHeight; last.scrollIntoView({ block: 'nearest' });
    return { fits, scrolls, lastSeen: last.getBoundingClientRect().bottom <= innerHeight }; })()`);
  assert.deepEqual(long, { fits: true, scrolls: true, lastSeen: true });
  await js(`document.querySelector('#top-more-btn').click()`);
  // Go to: on a phone too, a view is found by name instead of in that menu.
  assert.equal(await js(`(() => { const r = document.querySelector('#go-btn').getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth; })()`), true, 'the Go to button is on screen');
  await js(`document.querySelector('#go-btn').click()`);
  await until(`document.querySelector('#go-dialog').open && document.activeElement.id === 'go-input'`, 'the box, ready to type in');
  assert.ok((await js(`document.querySelectorAll('#go-list li').length`)) >= 30, 'every view, list and menu item');
  const find = (text) => js(`(() => { const i = document.querySelector('#go-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return [...document.querySelectorAll('#go-list .go-name')].map((n) => n.textContent.trim()); })()`);
  assert.equal((await find('scr'))[0], 'Screen', 'a name that starts with it comes first');
  assert.deepEqual(await find('no such thing anywhere'), []);
  assert.equal(await js(`document.querySelector('#go-none').hidden`), false);
  assert.ok((await find('shortcuts')).includes('Keyboard shortcuts'), 'the account menu too');
  assert.equal((await find('backlog'))[0], 'Backlog');
  await find('usage');
  await js(`document.querySelector('#go-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  await until(`!document.querySelector('#go-dialog').open && document.querySelector('dialog[open]')`, 'Usage open, the box gone');
  await js(`document.querySelector('dialog[open]').close()`);
  // Ctrl+K opens it, and closes it again.
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await until(`document.querySelector('#go-dialog').open`, 'Ctrl+K');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await until(`!document.querySelector('#go-dialog').open`, 'Ctrl+K again');
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
  // What the two views show, said when a wait below gives up: this test has failed on slow machines
  // and the sizes at that moment are what tells why.
  const sizes = `(() => { const v = (sel) => { const el = document.querySelector(sel); const r = el?.querySelector('.xterm-rows'); const sc = el?.querySelector('.xterm-screen'); return el ? { rows: r?.children.length, cols: Math.round((sc?.offsetWidth ?? 0) / ((r?.firstElementChild?.offsetWidth ?? 0) / Math.max(1, r?.firstElementChild?.textContent.length || 1) || 1)), font: r ? parseFloat(getComputedStyle(r).fontSize) : null, shrunk: el.classList.contains('shrunk') || Boolean(el.querySelector('.shrunk')), box: [el.clientWidth, el.clientHeight], screen: [sc?.offsetWidth, sc?.offsetHeight] } : null; }; return { main: v('#terminal'), pane: v('.gpane .gterm') ?? v('.gpane'), active: document.querySelector('#detail').classList.contains('gactive'), setting: localStorage.getItem('agentmgr.termFont') }; })()`;
  await js(`document.querySelector('.gpane .gterm textarea').focus()`);
  await send('Input.insertText', { text: 'x' });
  await until(`${rows('#terminal')} === ${rows('.gpane')} && ${font('.gpane')} === 13`, 'the main terminal following the group', 10_000, sizes);
  const saw = await js(sizes);
  assert.ok(saw.main.rows > 0 && saw.pane.rows > 0 && saw.pane.font === 13, `the sizes can be read: ${JSON.stringify(saw)}`);
  // Made much smaller for it, the view says why and how to end it.
  await until(`${font('#terminal')} < 10 && document.querySelector('#terminal').classList.contains('shrunk')`, 'the note on the shrunk view', 10_000, sizes);
  await key('Digit1', '!', 49, 2 | 8);
  await until(`document.querySelector('#detail').classList.contains('gactive')`, 'the main group active');
  await until(`${rows('#terminal')} === ${rows('.gpane')} && ${font('#terminal')} === 13`, 'the group following the main terminal', 10_000, sizes);
  await until(`!document.querySelector('#terminal').classList.contains('shrunk') && document.querySelector('.gpane .gterm').classList.contains('shrunk')`, 'the note moves to the view that follows now', 10_000, sizes);

  // Terminal text size, in the menu: every terminal takes it, and it is kept.
  await js(`document.querySelector('#menu-btn').click()`);
  await js(`document.querySelector('[data-term-font="1"]').click()`);
  await until(`${font('#terminal')} === 14 && ${font('.gpane')} < 10 && document.querySelector('#term-font-now').textContent === '14'`, 'the larger text; the following view still fits', 10_000, sizes);
  assert.equal(await js(`!document.querySelector('#menu').hidden && localStorage.getItem('agentmgr.termFont')`), '14', 'kept, and the menu stays open');
  await js(`document.querySelector('#term-font-now').click()`);
  await until(`${font('#terminal')} === 13 && localStorage.getItem('agentmgr.termFont') === null`, 'back to 13');
  await js(`document.querySelector('#menu-btn').click()`);

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

test('OS: this computer and its load, what an open session takes; the running count filters the list', { skip }, async () => {
  const [a] = await api('POST', '/agents', { intents: ['Watch the load'], workdir: home });
  for (let i = 0; i < 100 && (await api('GET', '/agents')).find((v) => v.id === a.id)?.status !== 'running'; i++) await sleep(100);
  await js(`document.querySelector('#os-btn').click()`);
  await until(`document.querySelector('#os-dialog').open && document.querySelector('[data-os-card="cpu"] .value-big')`, 'the OS window');
  await until(`document.querySelector('[data-os-agent="${a.id}"]')`, 'the open session in the list', 15_000);
  const r = await js(`({
    cards: [...document.querySelectorAll('[data-os-card]')].map((c) => c.dataset.osCard),
    big: [...document.querySelectorAll('[data-os-card] .value-big')].map((b) => b.textContent),
    level: document.querySelector('.os-level').textContent,
    facts: [...document.querySelectorAll('.os-facts th')].map((t) => t.textContent),
    procs: document.querySelectorAll('.os-table')[1].querySelectorAll('tbody tr').length,
  })`);
  assert.deepEqual(r.cards, ['cpu', 'memory', 'disk', 'agents']);
  assert.match(r.big[0], /^[\d.]+%$/);
  assert.match(r.big[1], /^[\d.]+%$/);
  assert.match(r.level, /^(Light load|Busy|Heavy load)$/);
  assert.ok(['Name', 'System', 'Processor', 'Memory', 'Up for'].every((f) => r.facts.includes(f)), JSON.stringify(r.facts));
  assert.ok(r.procs > 1, 'the busiest processes');
  // It reads again by itself while open.
  const at = await js(`(await (await fetch('/api/system')).json()).at`);
  await sleep(3500);
  assert.ok((await js(`(await (await fetch('/api/system')).json()).history.length`)) >= 1 && at, 'sampled');
  // The session's name goes to the agent.
  await js(`document.querySelector('[data-os-agent="${a.id}"]').click()`);
  await until(`!document.querySelector('#os-dialog').open && location.hash === '#${a.id}'`, 'the agent opened');

  // "N running" above the list: only the agents with an open session, and back.
  const [b] = await api('POST', '/agents', { intents: ['Stay closed'], workdir: home });
  for (let i = 0; i < 100 && (await api('GET', '/agents')).find((v) => v.id === b.id)?.status !== 'running'; i++) await sleep(100);
  await api('POST', `/agents/${b.id}/stop`);
  const ids = `[...document.querySelectorAll('#agent-list li[data-id]')].map((l) => l.dataset.id)`;
  await until(`${ids}.includes('${b.id}') && ${ids}.includes('${a.id}') && /running/.test(document.querySelector('#running-btn')?.textContent ?? '')`, 'both listed');
  await until(`!(await (await fetch('/api/agents')).json()).find((v) => v.id === '${b.id}').runtime.running`, 'one stopped');
  await js(`document.querySelector('#running-btn').click()`);
  await until(`${ids}.includes('${a.id}') && !${ids}.includes('${b.id}') && document.querySelector('#running-btn').getAttribute('aria-pressed') === 'true'`, 'only the running one');
  await js(`document.querySelector('#running-btn').click()`);
  await until(`${ids}.includes('${b.id}') && document.querySelector('#running-btn').getAttribute('aria-pressed') === 'false'`, 'all again');
  for (const id of [a.id, b.id]) await fetch(`${base}/api/agents/${id}`, { method: 'DELETE', headers: { 'x-agentmgr': '1' } });
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('review rounds and the AI judge: switches at the top of the inbox, and their numbers in Settings', { skip }, async () => {
  await js(`document.querySelector('[data-tab="inbox"]').click()`);
  const bar = `document.querySelector('#inbox-view .inbox-switches')?.textContent.replace(/\\s+/g, ' ')`;
  await until(`/Review rounds off/.test(${bar}) && /AI judge off/.test(${bar})`, 'the switches');
  assert.equal(await js(`document.querySelector('#inbox-view').firstElementChild.className`), 'inbox-switches hint', 'above the cards');
  await js(`document.querySelector('#inbox-view [data-rounds="on"]').click()`);
  await until(`/Review rounds on · 2 critics, up to 4 rounds/.test(${bar})`, 'rounds on');
  // Settings: the same switch, with the numbers.
  await js(`document.querySelector('#inbox-view [data-inbox-settings]').click()`);
  await until(`document.querySelector('#settings-dialog').open`, 'Settings');
  assert.equal(await js(`(() => { const f = document.querySelector('#settings-form'); return [f.roundsOn.checked, f.roundsMax.value, f.roundsCritics.value, f.roundsPr.checked, f.judgeOn.checked].join() })()`), 'true,4,2,true,false');
  await js(`(() => { const f = document.querySelector('#settings-form'); f.roundsMax.value = '3'; f.roundsCritics.value = '1'; f.roundsPr.checked = false; f.requestSubmit(); })()`);
  await until(`!document.querySelector('#settings-dialog').open && /Review rounds on · 1 critic, up to 3 rounds/.test(${bar})`, 'saved, and shown in the inbox');
  const saved = await api('GET', '/prereview');
  assert.deepEqual([saved.enabled, saved.rounds, saved.critics, saved.openPr], [true, 3, 1, false]);
  assert.equal((await api('GET', '/judge')).enabled, false, 'the judge was left alone');
  await api('PUT', '/prereview', { enabled: false, rounds: 4, critics: 2, openPr: true });
  await js(`document.querySelector('[data-tab="agents"]').click()`);
  assert.deepEqual(errors, [], 'no errors on the page');
});

test("Screen: off until turned on here, the screen sharing sign-in, the screen drawn, typing sent, and Turn off", { skip }, async (t) => {
  const net = await import('node:net');
  const socks = new Set();
  // A failed check must not leave the stand-in listening: the run would never end.
  t.after(() => {
    for (const s of socks) s.destroy();
    vnc.close();
  });
  // A stand-in screen sharing service (RFB 3.8, password sign-in): a 64x48 screen named Test Mac.
  const keys = [];
  const clicks = []; // [buttons, x, y] while a button is down
  let pointer = null; // [buttons, x, y] as last told
  let conns = 0;
  const vnc = net.createServer((sock) => {
    conns++;
    socks.add(sock);
    let buf = Buffer.alloc(0);
    let step = 'version';
    sock.on('error', () => {});
    sock.on('close', () => conns--);
    sock.write('RFB 003.008\n');
    const need = (n) => {
      if (buf.length < n) return null;
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (step === 'version') {
          if (!need(12)) return;
          sock.write(Buffer.from([1, 2])); // one way to sign in: a password
          step = 'security';
        } else if (step === 'security') {
          if (!need(1)) return;
          sock.write(Buffer.alloc(16, 7)); // the challenge
          step = 'response';
        } else if (step === 'response') {
          if (!need(16)) return;
          sock.write(Buffer.from([0, 0, 0, 0])); // accepted
          step = 'init';
        } else if (step === 'init') {
          if (!need(1)) return;
          const name = Buffer.from('Test Mac');
          const head = Buffer.alloc(24);
          head.writeUInt16BE(64, 0);
          head.writeUInt16BE(48, 2);
          Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(head, 4);
          head.writeUInt32BE(name.length, 20);
          sock.write(Buffer.concat([head, name]));
          step = 'run';
        } else {
          if (!buf.length) return;
          const t = buf[0];
          const size = t === 0 ? 20 : t === 2 ? (buf.length >= 4 ? 4 + 4 * buf.readUInt16BE(2) : Infinity) : t === 3 ? 10 : t === 4 ? 8 : t === 5 ? 6 : t === 6 ? (buf.length >= 8 ? 8 + buf.readUInt32BE(4) : Infinity) : 1;
          const m = need(size);
          if (!m) return;
          if (t === 4 && m[1] === 1) keys.push(m.readUInt32BE(4));
          if (t === 5 && m[1]) clicks.push([m[1], m.readUInt16BE(2), m.readUInt16BE(4)]);
          if (t === 5) pointer = [m[1], m.readUInt16BE(2), m.readUInt16BE(4)];
        }
      }
    });
  });
  await new Promise((r) => vnc.listen(0, '127.0.0.1', r));
  await api('PUT', '/screen/settings', { enabled: false, port: vnc.address().port });

  const body = `document.querySelector('#screen-body').textContent.replace(/\\s+/g, ' ')`;
  await js(`document.querySelector('#screen-btn').click()`);
  await until(`document.querySelector('#screen-dialog').open && /controls the whole computer/.test(${body})`, 'the dialog, off, saying what it gives');
  assert.equal(await js(`document.querySelector('#screen-off').hidden && document.querySelector('#screen-keys').hidden`), true);
  await js(`document.querySelector('[data-screen="on"]').click()`);
  await until(`/Ready/.test(${body}) && !document.querySelector('#screen-off').hidden`, 'on, and ready');
  assert.equal((await api('GET', '/screen')).enabled, true);

  await js(`document.querySelector('[data-screen="connect"]').click()`);
  await until(`document.querySelector('#screen-login input[name="password"]')`, 'the sign-in the service asks for');
  assert.equal(await js(`document.querySelector('#screen-login input[name="username"]')`), null, 'only what it asked for');
  // Typed blind on a phone a password goes wrong easily: it can be shown.
  await js(`document.querySelector('#screen-login [data-screen-show]').click()`);
  assert.equal(await js(`document.querySelector('#screen-login input[name="password"]').type`), 'text');
  await js(`document.querySelector('#screen-login [data-screen-show]').click()`);
  assert.equal(await js(`document.querySelector('#screen-login input[name="password"]').type`), 'password');
  await js(`(() => { const f = document.querySelector('#screen-login'); f.password.value = 'secret'; f.requestSubmit(); })()`);
  await until(`document.querySelector('#screen-state').textContent === 'Connected' && document.querySelector('#screen-view canvas') && !document.querySelector('#screen-view').hidden`, 'the screen');
  await until(`document.querySelector('#screen-name').textContent === 'Test Mac'`, "the computer's name");
  assert.equal(await js(`document.querySelector('#screen-view canvas').width + 'x' + document.querySelector('#screen-view canvas').height`), '64x48');
  assert.deepEqual((await api('GET', '/screen')).viewers.map((v) => v.who), ['this computer']);
  assert.equal(await js(`document.querySelector('#screen-dot').hidden`), true, 'no note for your own view');

  // Zoom draws the screen larger and scrolls it; Move is for getting around without clicking in it.
  const drawn = () => js(`Math.round(document.querySelector('#screen-view canvas').getBoundingClientRect().width)`);
  // The screen is scaled to the dialog a moment after it connects: wait for a size that holds.
  let fit = 0;
  for (let i = 0, last = -1; i < 50 && (fit === 0 || fit !== last); i++) {
    last = fit;
    await sleep(150);
    fit = await drawn();
  }
  assert.ok(fit > 0, 'the screen is drawn');
  assert.equal(await js(`document.querySelector('#screen-move').hidden`), true, 'nothing to move around at Fit');
  await js(`document.querySelector('[data-screen-zoom="1"]').click(); document.querySelector('[data-screen-zoom="1"]').click()`);
  await until(`document.querySelector('#screen-zoom-now').textContent === '200%'`, 'zoomed');
  for (let i = 0; i < 30 && Math.abs((await drawn()) - fit * 2) > 3; i++) await sleep(100);
  await sleep(300); // scrollbars that take room must not change the size afterwards
  assert.ok(Math.abs((await drawn()) - fit * 2) <= 3, `twice as large: ${await drawn()} for ${fit}`);
  assert.equal(await js(`(() => { const v = document.querySelector('#screen-view'); return v.scrollWidth > v.clientWidth && v.scrollLeft > 0; })()`), true, 'scrolls, around the middle');
  assert.equal(await js(`document.querySelector('.screen-pan').hidden`), true, 'a click still goes to the computer');
  await js(`document.querySelector('#screen-move').click()`);
  assert.equal(await js(`!document.querySelector('.screen-pan').hidden && document.querySelector('#screen-move').getAttribute('aria-pressed')`), 'true');
  await js(`document.querySelector('#screen-zoom-now').click()`);
  for (let i = 0; i < 30 && Math.abs((await drawn()) - fit) > 3; i++) await sleep(100);
  assert.equal(await js(`document.querySelector('#screen-zoom-now').textContent + document.querySelector('.screen-pan').hidden + document.querySelector('#screen-move').hidden`), 'Fittruetrue');
  assert.ok(Math.abs((await drawn()) - fit) <= 3, 'back to the whole screen');

  // A click, and a finger's tap, land where they point on the computer's screen.
  const at = await js(`(() => { const r = document.querySelector('#screen-view canvas').getBoundingClientRect(); return { x: r.left + r.width / 4, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  for (let i = 0; i < 30 && clicks.length < 1; i++) await sleep(100);
  assert.deepEqual(clicks.splice(0).map(([b, x, y]) => [b, Math.round(x / 4), Math.round(y / 4)])[0], [1, 4, 6], 'a click');
  // The sheet noVNC lays over the page while a button is down is gone when it is up: left there, it would take the next click after the dialog closes.
  await until(`getComputedStyle(document.getElementById('noVNC_mouse_capture_elem')).display === 'none'`, 'nothing left over the page');
  await js(`(() => { window.__rings = 0; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.className === 'screen-tap') window.__rings++; }).observe(document.querySelector('#screen-dialog'), { childList: true }); document.querySelector('#screen-type').focus(); })()`);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
  await sleep(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await js(`window.__rings`), 1, 'a ring where the tap landed');
  for (let i = 0; i < 30 && clicks.length < 1; i++) await sleep(100);
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  assert.deepEqual(clicks.splice(0).map(([b, x, y]) => [b, Math.round(x / 4), Math.round(y / 4)])[0], [1, 4, 6], 'a tap');
  assert.equal(await js(`document.activeElement.id`), 'screen-type', "the tap left the phone's keyboard open");

  // Pad: the screen as a trackpad, for targets a fingertip covers. It shows once the page was touched.
  const touch = (type, ...points) => send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const settle = async (ok, what) => {
    for (let i = 0; i < 40 && !ok(); i++) await sleep(50);
    assert.ok(ok(), `${what}: pointer ${JSON.stringify(pointer)}, clicks ${JSON.stringify(clicks)}`);
  };
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await settle(() => pointer?.[0] === 0, 'the tap above let go');
  assert.equal(await js(`document.querySelector('#screen-pad').hidden`), false, 'offered after a touch');
  assert.equal(await js(`document.querySelector('.screen-pad').hidden && document.querySelector('.screen-pointer').hidden`), true, 'off until asked for');
  await js(`document.querySelector('#screen-pad').click()`);
  assert.equal(await js(`!document.querySelector('.screen-pad').hidden && !document.querySelector('.screen-pointer').hidden && document.querySelector('#screen-pad').getAttribute('aria-pressed')`), 'true');
  await settle(() => pointer?.[0] === 0 && pointer[1] === 32 && pointer[2] === 24, 'the pointer starts in the middle');
  // A drag moves the pointer and clicks nothing.
  await touch('touchStart', [at.x, at.y]);
  for (let i = 1; i <= 6; i++) {
    await sleep(20);
    await touch('touchMove', [at.x + i * 50, at.y]);
  }
  await touch('touchEnd');
  await settle(() => pointer[1] >= 36 && pointer[2] === 24, 'moved right, not down');
  assert.deepEqual(clicks, [], 'a drag is not a click');
  const [, px, py] = pointer;
  assert.equal(await js(`(() => { const c = document.querySelector('#screen-view canvas').getBoundingClientRect(); const a = document.querySelector('.screen-pointer').getBoundingClientRect(); return Math.abs(a.left - (c.left + c.width * ${px} / 64)) < c.width / 32; })()`), true, 'the arrow is drawn where the pointer is');
  // A tap clicks where the pointer is, not under the finger.
  await touch('touchStart', [at.x, at.y]);
  await sleep(40);
  await touch('touchEnd');
  await settle(() => clicks.length === 1 && pointer[0] === 0, 'a tap: pressed and released');
  assert.deepEqual(clicks.splice(0), [[1, px, py]]);
  // Two fingers: a tap is the right button, a drag turns the wheel.
  await touch('touchStart', [at.x, at.y], [at.x + 60, at.y]);
  await sleep(40);
  await touch('touchEnd');
  await settle(() => clicks.length === 1 && pointer[0] === 0, 'a two-finger tap');
  assert.deepEqual(clicks.splice(0), [[4, px, py]]);
  await touch('touchStart', [at.x, at.y], [at.x + 60, at.y]);
  for (let i = 1; i <= 4; i++) {
    await sleep(20);
    await touch('touchMove', [at.x, at.y + i * 20], [at.x + 60, at.y + i * 20]);
  }
  await touch('touchEnd');
  await settle(() => clicks.length >= 2 && pointer[0] === 0, 'the wheel');
  assert.deepEqual([...new Set(clicks.splice(0).map(([b]) => b))], [8], 'fingers down: the page above comes into view');
  // A finger held still holds the button, to drag; lifting lets go.
  await touch('touchStart', [at.x, at.y]);
  await settle(() => pointer[0] === 1, 'held: the button is down');
  await touch('touchMove', [at.x - 200, at.y]);
  await settle(() => pointer[0] === 1 && pointer[1] < px, 'dragged left with it down');
  await touch('touchEnd');
  await settle(() => pointer[0] === 0, 'let go');
  clicks.splice(0);
  await js(`document.querySelector('#screen-pad').click()`);
  assert.equal(await js(`document.querySelector('.screen-pad').hidden && document.querySelector('.screen-pointer').hidden && document.querySelector('#screen-pad').getAttribute('aria-pressed')`), 'false');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });

  // The field for a phone's keyboard, and the keys it lacks.
  await js(`(() => { const t = document.querySelector('#screen-type'); t.value = 'hi'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await js(`document.querySelector('[data-screen-key="esc"]').click()`);
  for (let i = 0; i < 50 && keys.length < 3; i++) await sleep(100);
  assert.deepEqual(keys, [0x68, 0x69, 0xff1b]);
  // Shortcuts from the Keys list: the modifier held, the key, then released.
  assert.match(await js(`document.querySelector('#screen-combo').textContent`), /copy.*paste.*force quit|copy.*paste.*Alt\+F4/s);
  await js(`(() => { const c = document.querySelector('#screen-combo'); c.value = [...c.options].find((o) => o.textContent.includes('copy')).value; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  for (let i = 0; i < 50 && keys.length < 5; i++) await sleep(100);
  const [mod, c] = keys.splice(3);
  assert.ok([0xffeb, 0xffe3].includes(mod) && c === 0x63, `a modifier, then c: ${mod} ${c}`);
  assert.equal(await js(`document.querySelector('#screen-combo').value`), '', 'ready for the next one');
  // Return on a phone's keyboard, however it is reported: as a key, as a line break, or as both (sent once).
  const ret = (how) => js(`(() => { const t = document.querySelector('#screen-type');
    if (${JSON.stringify(how)}.includes('key')) t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    if (${JSON.stringify(how)}.includes('input')) t.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true })); })()`);
  await ret('key');
  await sleep(150);
  await ret('input');
  await sleep(150);
  await ret('key input');
  for (let i = 0; i < 50 && keys.length < 6; i++) await sleep(100);
  await sleep(300);
  assert.deepEqual(keys.splice(3), [0xff0d, 0xff0d, 0xff0d]);

  // Clip: text to the computer's clipboard and pasted there; what was copied there, fetched.
  const clipFile = path.join(home, 'clipboard.txt');
  assert.equal(await js(`document.querySelector('#screen-clip').hidden`), true);
  await js(`document.querySelector('#screen-clip-btn').click()`);
  assert.equal(await js(`!document.querySelector('#screen-clip').hidden && document.activeElement.id`), 'screen-clip-text');
  await js(`(() => { document.querySelector('#screen-clip-text').value = 'héllo ✓ wörld'; document.querySelector('[data-screen="clip-paste"]').click(); })()`);
  for (let i = 0; i < 50 && keys.length < 5; i++) await sleep(100);
  const [pasteMod, v] = keys.splice(3);
  assert.ok([0xffeb, 0xffe3].includes(pasteMod) && v === 0x76, `paste: a modifier, then v: ${pasteMod} ${v}`);
  assert.equal(fs.readFileSync(clipFile, 'utf8'), 'héllo ✓ wörld', "on the computer's clipboard before the paste");
  assert.equal(await js(`document.querySelector('#screen-clip-text').value`), '', 'ready for the next');
  fs.writeFileSync(clipFile, 'copied on the mac');
  await js(`document.querySelector('[data-screen="clip-get"]').click()`);
  await until(`document.querySelector('#screen-clip-text').value === 'copied on the mac'`, 'what was copied there');
  await js(`document.querySelector('#screen-clip-btn').click()`);
  assert.equal(await js(`document.querySelector('#screen-clip').hidden`), true);

  // The phone's way in (a stream out, POSTs in; no WebSocket there): the same viewer over it.
  assert.equal(
    await js(`await (async () => {
      const { StreamChannel } = await import('/screen.js');
      const { default: RFB } = await import('/vendor/novnc/core/rfb.js');
      const el = document.body.appendChild(document.createElement('div'));
      const r = new RFB(el, new StreamChannel(), { credentials: { password: 'secret' } });
      const how = await new Promise((res) => { r.addEventListener('connect', () => res('connected')); r.addEventListener('disconnect', () => res('disconnected')); });
      r.sendKey(0x7a, null);
      await new Promise((res) => setTimeout(res, 300));
      const size = el.querySelector('canvas').width;
      r.disconnect();
      el.remove();
      return how + ' ' + size;
    })()`),
    'connected 64',
  );
  for (let i = 0; i < 50 && keys.length < 4; i++) await sleep(100);
  assert.equal(keys[3], 0x7a, 'what it sends arrives');
  await until(`(await (await fetch('/api/screen')).json()).viewers.length === 1`, 'that view gone again');

  // Turn off ends the view; closing the dialog leaves nothing connected.
  await js(`document.querySelector('#screen-off').click()`);
  await until(`/controls the whole computer/.test(${body}) && document.querySelector('#screen-view').hidden`, 'off again');
  for (let i = 0; i < 50 && conns; i++) await sleep(100);
  assert.equal(conns, 0, 'the connection to the service is closed');
  await js(`document.querySelector('#screen-dialog [data-screen="close"]').click()`);
  await until(`!document.querySelector('#screen-dialog').open`, 'closed');
  await api('PUT', '/screen/settings', { enabled: false, port: 5900 });
  await new Promise((r) => vnc.close(r));
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Decide: a question arrives with a recommendation, on its inbox card too; doing it; a standing decision then answers the next one', { skip }, async () => {
  await api('PUT', '/judge', { enabled: true });
  const mk = async (intent) => {
    const [a] = await api('POST', '/agents', { intents: [intent], workdir: home });
    await until(`(await (await fetch('/api/agents')).json()).find((v) => v.id === '${a.id}')?.questions?.length === 1`, 'its question', 20_000);
    return a;
  };
  const a = await mk('Pick a store #question');
  // Looked at now, not at the next 20-second round.
  await api('POST', '/advisor/briefs/refresh', { key: '' });
  await until(`document.querySelector('#decide-count').textContent === '1'`, 'one waiting on the button', 20_000);
  await js(`document.querySelector('#decide-btn').click()`);
  await until(`document.querySelector('#decide-dialog').open && document.querySelector('#decide-body .decide-card .decide-rec')`, 'the Decide window with its card');
  const card = await js(`document.querySelector('#decide-body .decide-card').textContent.replace(/\\s+/g, ' ')`);
  assert.match(card, /Postgres or SQLite for the cache\?/);
  assert.match(card, /Recommended Postgres 90% sure/);
  assert.match(card, /Fake reasoning: Postgres\./);
  assert.match(card, /Fake evidence/);
  assert.match(card, /Risk: Fake risk/);
  assert.match(card, /SQLite → Fake consequence of SQLite/);
  assert.match(card, /Try both/);
  await js(`document.querySelector('[data-decide="close"]').click()`);

  // The same recommendation on the inbox card.
  await js(`document.querySelector('.side-tab[data-tab="inbox"], [data-tab="inbox"]').click()`);
  await until(`document.querySelector('#inbox-view [data-need="q:${a.id}:"] .decide-advice, #inbox-view .decide-advice')`, 'the recommendation in the inbox');
  await js(`document.querySelector('#inbox-view .decide-advice [data-decide-apply="0"]').click()`);
  await until(`Object.values((await (await fetch('/api/agents')).json()).find((v) => v.id === '${a.id}').answers ?? {})[0]?.text === 'Postgres'`, 'answered as recommended');
  await until(`document.querySelector('#decide-count').textContent === ''`, 'nothing waiting');
  const log = await api('GET', '/decisions');
  const d = log.items.find((i) => i.agentId === a.id);
  assert.deepEqual([d.decision, d.reason, d.followed, d.by], ['Postgres', 'Fake reasoning: Postgres.', true, 'you']);

  // A standing decision, written in the window; the next agent's question is answered without you.
  await js(`document.querySelector('#decide-btn').click()`);
  await js(`document.querySelector('[data-decide-tab="standing"]').click()`);
  await js(`document.querySelector('[data-decide="add"]').click()`);
  await js(`(() => { const f = document.querySelector('[data-decide-form="standing"]'); f.kind.value = 'question'; f.when.value = 'an agent asks which store to use for the cache'; f.action.value = 'answer'; f.text.value = 'Postgres'; f.requestSubmit(); })()`);
  await until(`document.querySelector('#decide-body .decide-card .decide-rec')?.textContent.includes('an agent asks which store to use for the cache')`, 'the standing decision listed');
  assert.match(await js(`document.querySelector('.decide-autonomy select').value`), /^standing$/, 'only standing decisions act by default');
  const b = await mk('Pick a store again #question');
  await api('POST', '/advisor/briefs/refresh', { key: '' });
  await until(`Object.values((await (await fetch('/api/agents')).json()).find((v) => v.id === '${b.id}').answers ?? {})[0]?.text === 'Postgres'`, 'decided for you', 20_000);
  await js(`document.querySelector('[data-decide-tab="handled"]').click()`);
  await until(`document.querySelector('#decide-body .decide-card')?.textContent.includes('Answered: Postgres')`, 'reported under Handled for you');
  assert.match(await js(`document.querySelector('#decide-body .decide-card').textContent.replace(/\\s+/g, ' ')`), /By your standing decision: when an agent asks which store to use for the cache\./);
  // The other tabs draw.
  for (const t of ['priority', 'tradeoffs', 'lookback', 'waiting']) {
    await js(`document.querySelector('[data-decide-tab="${t}"]').click()`);
    await until(`document.querySelector('[data-decide-tab="${t}"]').classList.contains('active') && document.querySelector('#decide-body .decide-scroll')`, `the ${t} tab`);
  }
  await js(`document.querySelector('[data-decide="close"]').click()`);
  await js(`document.querySelector('[data-tab="agents"]').click()`);
  await api('PUT', '/judge', { enabled: false });
  for (const id of [a.id, b.id]) await fetch(`${base}/api/agents/${id}`, { method: 'DELETE', headers: { 'x-agentmgr': '1' } });
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
  assert.equal(await js(`document.querySelector('[data-debug-text]').value`), 'Unstable at max scale');
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

test('Reverse engineer: a target and a question beside the session, whether REA is there, the report with its diagram, and building your own', { skip }, async () => {
  const a = (await api('GET', '/agents')).find((v) => v.intent === 'Task 3');
  await js(`document.querySelector('#agent-list li[data-id="${a.id}"]').click()`);
  await until(`document.querySelector('#detail-body button[data-act="reverse"]')`, 'the Reverse engineer button');
  await js(`document.querySelector('#detail-body button[data-act="reverse"]').click()`);
  await until(`!document.querySelector('#side-pane').hidden && document.querySelector('[data-side="reverse"]').classList.contains('active') && document.querySelector('[data-reverse-text]')`, 'the Reverse tab beside the session');
  assert.equal(await js(`document.querySelector('[data-reverse-form] button.primary').textContent`), 'Investigate');
  assert.equal(await js(`Boolean(document.querySelector('[data-reverse-build]'))`), false, 'nothing to build before a report');
  // REA is not registered here: said, with how to set it up; and what this is for.
  await until(`document.querySelector('.reverse-rea.missing')`, 'REA not found');
  assert.match(await js(`document.querySelector('.reverse-rea.missing').textContent`), /REA was not found[\s\S]*npx rea-agents setup[\s\S]*restart this agent's session/);
  assert.match(await js(`document.querySelector('.reverse-note').textContent`), /software you own or are allowed to analyse/);

  // A question needs a target; with both it goes to the agent's session, rules and all.
  await js(`document.querySelector('[data-reverse-idea]').click()`);
  assert.equal(await js(`document.querySelector('[data-reverse-text]').value`), 'How does search work?');
  await js(`document.querySelector('[data-reverse-form]').requestSubmit()`);
  await sleep(300);
  assert.equal(await js(`document.querySelectorAll('.debug-asked').length`), 0, 'not sent without a target');
  await js(`(() => { document.querySelector('[data-reverse-target]').value = '/Applications/Notes.app'; document.querySelector('[data-reverse-form]').requestSubmit(); })()`);
  await until(`document.querySelector('.debug-asked summary')?.textContent === 'Asked (1)'`, 'the question listed');
  await until(`document.querySelector('#terminal .xterm-rows').textContent.replace(/\\s/g, '').includes('whatyoucouldnotdetermine.')`, "typed into the agent's session", 20_000);
  const sent = (await api('GET', '/agents')).find((v) => v.id === a.id).reverse;
  assert.deepEqual([sent.target, sent.asks.map((x) => [x.kind, x.text])], ['/Applications/Notes.app', [['reverse', 'How does search work?']]]);

  // REA registered in the project's .mcp.json: seen on Check again.
  fs.writeFileSync(path.join(a.workdir, '.mcp.json'), JSON.stringify({ mcpServers: { rea: { command: 'node', args: ['/opt/rea/main.js'] } } }));
  await js(`document.querySelector('[data-reverse-recheck]').click()`);
  await until(`document.querySelector('.reverse-rea.ok')`, 'REA found');
  assert.match(await js(`document.querySelector('.reverse-rea.ok').textContent`), /REA is registered in the project's \.mcp\.json/);
  fs.rmSync(path.join(a.workdir, '.mcp.json'));

  // The agent writes its report: drawn here, the path animated; then our own version is asked for, by part.
  const dir = path.join(home, 'briefs', a.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'REVERSE.md'), '# Reverse engineering: search in Notes\n## Summary\nAn SQLite full-text index.\n## How it works\n```mermaid\nflowchart LR\n  A["SearchBar"] e1@--> B["fts5 query"]\n  e1@{ animate: true }\n  classDef inferred stroke:#f59e0b,stroke-dasharray:4\n  class B inferred\n```\n## Findings\n1. Uses FTS5 (confirmed).\n## Build it\n1. An index table.\n');
  await until(`document.querySelector('.debug-report h1')?.textContent === 'Reverse engineering: search in Notes'`, 'the report', 20_000);
  await until(`document.querySelector('.debug-report .diagram svg')`, 'its diagram drawn', 20_000);
  assert.equal(await js(`document.querySelector('[data-reverse-form] button.primary').textContent`), 'Ask');
  assert.equal(await js(`document.querySelector('[data-reverse-target]').value`), '/Applications/Notes.app', 'the target is remembered');
  await until(`/report/.test(document.querySelector('#detail-body button[data-act="reverse"]').textContent)`, 'the button says there is a report');
  await js(`(() => { const t = document.querySelector('[data-reverse-text]'); t.focus(); t.value = 'the index table'; })()`);
  await js(`document.querySelector('[data-reverse-build]').click()`);
  await until(`document.querySelector('.debug-asked summary')?.textContent === 'Asked (2)' && document.querySelector('.debug-asked li:last-child').textContent.trim() === 'build Build it: the index table'`, 'the build asked for');
  // Security audit on the same agent: nothing named audits the whole project; the report, then fixes by number.
  await js(`document.querySelector('[data-side="security"]').click()`);
  await until(`document.querySelector('[data-security-text]') && !document.querySelector('[data-reverse-target]')`, 'the Security tab');
  assert.equal(await js(`document.querySelector('[data-security-form] button.primary').textContent`), 'Audit');
  // The view says "Loading…" until the agent's audit state has been read.
  await until(`/does not replace a penetration test/.test(document.querySelector('.security-view')?.textContent ?? '')`, 'what an audit is not');
  await js(`document.querySelector('[data-security-form]').requestSubmit()`);
  await until(`document.querySelector('.debug-asked summary')?.textContent === 'Asked (1)' && document.querySelector('.debug-asked li').textContent.trim() === 'The whole project'`, 'the audit asked for');
  fs.writeFileSync(path.join(dir, 'SECURITY-AUDIT.md'), '# Security audit: the whole project\n## Summary\nOne high finding. 0 critical, 1 high, 0 medium, 0 low.\n## Attack surface\n```mermaid\nflowchart LR\n  A["POST /import"] e1@--> B["readFile"]\n  e1@{ animate: true }\n  classDef fault stroke:#ef4444,stroke-width:3px\n  class B fault\n```\n## Findings\n| # | Severity | Title | Where | Status |\n|---|---|---|---|---|\n| 1 | high | Path traversal in import | src/import.js:12 | verified |\n');
  await until(`document.querySelector('.debug-report h1')?.textContent === 'Security audit: the whole project'`, 'the audit report', 20_000);
  await until(`document.querySelector('.debug-report .diagram svg') && document.querySelector('.debug-report table')`, 'its diagram and findings table', 20_000);
  await js(`document.querySelector('[data-security-form]').requestSubmit()`);
  await sleep(300);
  assert.equal(await js(`document.querySelector('.debug-asked summary').textContent`), 'Asked (1)', 'a follow-up says what to look at');
  await js(`(() => { document.querySelector('[data-security-text]').value = '1'; })()`);
  await js(`document.querySelector('[data-security-fix]').click()`);
  await until(`document.querySelector('.debug-asked summary')?.textContent === 'Asked (2)' && document.querySelector('.debug-asked li:last-child').textContent.trim() === 'fix Fix findings: 1'`, 'the fix asked for');
  // Debug on the same agent is its own thing.
  await js(`document.querySelector('[data-side="debug"]').click()`);
  await until(`document.querySelector('[data-debug-text]') && !document.querySelector('[data-reverse-target]')`, 'the Debug tab');
  assert.equal(await js(`document.querySelectorAll('.debug-asked').length`), 0, 'nothing asked there');
  await js(`document.querySelector('#side-close').click()`);
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Usage: the chip by the connection light, every engine with what is used and left, the alert and hold levels, and where new agents start', { skip }, async () => {
  // Nothing read yet: no chip. Then Claude Code's status line writes its numbers (as statusline.js does).
  assert.equal(await js(`document.querySelector('#usage-chip').hidden`), true);
  const soon = Math.floor(Date.now() / 1000) + 2 * 3600 + 60;
  fs.mkdirSync(path.join(home, 'usage'), { recursive: true });
  fs.writeFileSync(path.join(home, 'usage', 'claude.json'), JSON.stringify({ at: new Date().toISOString(), version: '9.9.9', rate_limits: { five_hour: { used_percentage: 86, resets_at: soon }, seven_day: { used_percentage: 41.2, resets_at: soon + 4 * 86400 } } }));
  await until(`!document.querySelector('#usage-chip').hidden && document.querySelector('#usage-chip').textContent === 'Claude Code 5h 86% · wk 41%'`, 'the chip', 40_000);
  assert.equal(await js(`document.querySelector('#usage-chip').classList.contains('warn')`), true, 'past the alert level');
  await js(`document.querySelector('#usage-chip').click()`);
  await until(`document.querySelector('#usage-dialog').open && document.querySelector('[data-usage-engine="claude"] [data-usage-window="five_hour"]')`, 'the Usage window');
  const r = await js(`({
    five: document.querySelector('[data-usage-window="five_hour"]').textContent.replace(/\\s+/g, ' ').trim(),
    week: document.querySelector('[data-usage-window="seven_day"]').textContent.replace(/\\s+/g, ' ').trim(),
    level: document.querySelector('[data-usage-engine="claude"] .usage-level').textContent,
    head: document.querySelector('[data-usage-engine="claude"] .plan-project-head').textContent.replace(/\\s+/g, ' '),
    bar: document.querySelector('[data-usage-window="five_hour"] .os-meter span').style.width,
    warn: document.querySelector('[data-usage-set="warnAt"]').value,
    hold: document.querySelector('[data-usage-set="holdAt"]').value,
  })`);
  assert.match(r.five, /^5-hour session\s*86% used\s*14% left\s*resets in 2h/);
  assert.match(r.week, /^Week\s*41% used\s*59% left\s*resets in 4 days/);
  assert.deepEqual([r.level, r.bar, r.warn, r.hold], ['Getting close', '86%', '80', 'off']);
  assert.match(r.head, /from Claude Code 9\.9\.9[\s\S]*✓ New agents start here/);

  try {
    // Hold new work at 85%: no new agent on Claude Code, and the reason is said.
    await js(`(() => { const s = document.querySelector('[data-usage-set="holdAt"]'); s.value = '85'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until(`document.querySelector('[data-usage-engine="claude"] .usage-level')?.textContent === 'Held for new work'`, 'held');
    const refused = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentmgr': '1' }, body: JSON.stringify({ intents: ['Held back'], workdir: home }) });
    assert.match((await refused.json()).error, /Claude Code is held for new work: 86% of its 5-hour session limit is used/);
    assert.ok(refused.status >= 400);
    // Another engine is one click away for new agents; then back.
    const other = 'codex';
    await until(`document.querySelector('[data-usage-default="codex"]')`, 'another installed engine is offered');
    await js(`document.querySelector('[data-usage-default="${other}"]').click()`);
    await until(`(await (await fetch('/api/usage')).json()).default === '${other}'`, 'new agents start there');
    await until(`/New agents start here/.test(document.querySelector('[data-usage-engine="${other}"] .plan-project-head')?.textContent ?? '')`, 'marked in the window');
  } finally {
    // Whatever happened above, the tests after this one can start agents.
    await api('PUT', '/usage', { engine: 'claude', holdAt: 'off' });
  }
  await until(`document.querySelector('[data-usage-set="holdAt"]').value === 'off' && document.querySelector('[data-usage-engine="claude"] .usage-level').textContent === 'Getting close'`, 'not held any more');
  // Lean output: off until switched on; then the sessions started from now on trim long command output.
  assert.equal(await js(`document.querySelector('[data-usage-lean]').checked`), false);
  await js(`document.querySelector('[data-usage-lean]').click()`);
  await until(`(await (await fetch('/api/usage')).json()).lean.enabled === true && document.querySelector('[data-usage-lean]')?.checked`, 'lean output on');
  assert.match(await js(`document.querySelector('.usage-lean').textContent`), /Nothing long enough to trim yet/);
  await api('PUT', '/usage', { lean: false });
  await until(`document.querySelector('[data-usage-lean]')?.checked === false`, 'and off again');
  // Read now: a one-word session brings the numbers as they are now, not as the last reply left them.
  await js(`document.querySelector('[data-usage-is-default]').click()`);
  await until(`[...document.querySelectorAll('.toast')].some((t) => /New agents already start on Claude Code/.test(t.textContent))`, 'pressing the engine new agents already start on says so');
  await js(`document.querySelector('[data-usage="refresh"]').click()`);
  await until(`/^5-hour session\\s*12% used\\s*88% left/.test(document.querySelector('[data-usage-window="five_hour"]')?.textContent.replace(/\\s+/g, ' ').trim() ?? '')`, 'a reading taken now', 30_000);
  await until(`document.querySelector('[data-usage="refresh"]').textContent === '↻ Read now' && /from Claude Code 9\\.9\\.10/.test(document.querySelector('[data-usage-engine="claude"] .plan-project-head').textContent)`, 'where it came from');
  await js(`document.querySelector('[data-usage="close"]').click()`);
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Skills: the skills Claude Code has here with their scripts flagged, one read, and one removed', { skip }, async () => {
  const dir = path.join(home, 'claude', 'skills', 'pdf');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: pdf\ndescription: Read and fill PDF forms.\n---\n# Working with PDFs\n\nUse the script.\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'fill.py'), 'print(1)\n');
  await js(`document.querySelector('#skills-btn').click()`);
  await until(`document.querySelector('#skills-dialog').open && document.querySelector('[data-skill="personal/pdf"]')`, 'the Skills window');
  const row = await js(`document.querySelector('[data-skill="personal/pdf"]').textContent.replace(/\\s+/g, ' ').trim()`);
  assert.match(row, /^pdf ?1 script Read .*Remove Read and fill PDF forms\. added by hand ?2 files/);
  assert.equal(await js(`document.querySelector('[data-skills-place="personal"] h3').textContent`), 'Yours (every project)');
  assert.equal(await js(`Boolean(document.querySelector('[data-skill-check="personal/pdf"]'))`), false, 'nothing to check for one added by hand');
  // Read it: its files, and its instructions without the front matter.
  await js(`document.querySelector('[data-skill-show="personal/pdf"]').click()`);
  await until(`document.querySelector('#skills-body .md h1')?.textContent === 'Working with PDFs'`, 'the skill to read');
  assert.match(await js(`document.querySelector('.skills-files').textContent.replace(/\\s+/g, ' ')`), /2 files, 1 of them script.*scripts\/fill\.py .*script/);
  assert.equal(await js(`/name: pdf/.test(document.querySelector('#skills-body .md').textContent)`), false);
  await js(`document.querySelector('[data-skills="back"]').click()`);
  // A repository that is not one is refused before anything is fetched.
  await js(`(() => { const f = document.querySelector('[data-skills-form]'); f.repo.value = 'not a repository'; f.requestSubmit(); })()`);
  await until(`[...document.querySelectorAll('.toast')].some((t) => /Give a repository/.test(t.textContent))`, 'a bad repository refused');
  // Removed: its folder is gone.
  await api('DELETE', '/skills?id=' + encodeURIComponent('personal/pdf'));
  await js(`document.querySelector('[data-skills="refresh"]').click()`);
  await until(`!document.querySelector('[data-skill="personal/pdf"]') && /No skills here/.test(document.querySelector('[data-skills-place="personal"]').textContent)`, 'the skill gone');
  assert.equal(fs.existsSync(dir), false);
  await js(`document.querySelector('[data-skills="close"]').click()`);
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Board: agents as cards by where their work stands, resumed and closed from it; a lane of ports for each in its detail and in OS', { skip }, async () => {
  const running = async (id) => {
    for (let i = 0; i < 100 && (await api('GET', '/agents')).find((v) => v.id === id)?.status !== 'running'; i++) await sleep(100);
  };
  const [a] = await api('POST', '/agents', { intents: ['Board: stay open'], workdir: home });
  const [b] = await api('POST', '/agents', { intents: ['Board: closed one'], workdir: home });
  await running(a.id);
  await running(b.id);
  await api('POST', `/agents/${b.id}/stop`);
  const col = (id) => `document.querySelector('[data-board-card="${id}"]')?.closest('[data-board-col]').dataset.boardCol`;
  await js(`document.querySelector('#board-btn').click()`);
  await until(`document.querySelector('#board-dialog').open && ${col(a.id)} === 'idle' && ${col(b.id)} === 'closed'`, 'the board with both cards');
  assert.deepEqual(await js(`[...document.querySelectorAll('[data-board-col] h3')].map((h) => h.firstChild.textContent.trim())`), ['Starting', 'Working', 'Needs you', 'Waiting', 'In review', 'Done', 'Closed']);
  assert.equal(await js(`Number(document.querySelector('[data-board-col="closed"] h3 .hint').textContent) === document.querySelectorAll('[data-board-col="closed"] [data-board-card]').length`), true, 'the count of a column');
  // Resume from the Closed column; close from Waiting. Each card moves by itself.
  await js(`document.querySelector('[data-board-card="${b.id}"] [data-board-act="start"]').click()`);
  await until(`${col(b.id)} === 'idle'`, 'the resumed one in Waiting', 15_000);
  // (The button is there while its card is in Waiting: a burst of output moves it to Working for a moment.)
  await until(`(document.querySelector('[data-board-card="${a.id}"] [data-board-act="stop"]')?.click(), ${col(a.id)} === 'closed')`, 'the closed one in Closed', 20_000);
  // A drag: onto a column agents reach by themselves it says so; from Closed onto Waiting it resumes.
  const drag = (id, to) => js(`(() => {
    const dt = new DataTransfer();
    const card = document.querySelector('[data-board-card="${id}"]');
    const target = document.querySelector('[data-board-col="${to}"]');
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const lit = target.classList.contains('drop');
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return lit;
  })()`);
  assert.equal(await drag(a.id, 'review'), true, 'the column lights up under the card');
  await until(`[...document.querySelectorAll('.toast')].some((t) => /moves to In review by itself/.test(t.textContent))`, 'why nothing moved');
  assert.equal(await js(col(a.id)), 'closed');
  await drag(a.id, 'idle');
  await until(`['idle', 'working'].includes(${col(a.id)})`, 'resumed by a drag', 15_000);
  // (A session that is producing output is not closed by a drag: wait for it to be quiet.)
  for (let i = 0; i < 20 && (await js(col(b.id))) !== 'closed'; i++) {
    await drag(b.id, 'closed');
    await sleep(750);
  }
  assert.equal(await js(col(b.id)), 'closed', 'closed by a drag');
  // A card opens its agent, whose detail has its lane.
  await js(`document.querySelector('[data-board-card="${a.id}"] b').click()`);
  await until(`!document.querySelector('#board-dialog').open && location.hash === '#${a.id}'`, 'the agent opened');
  const lane = (await api('GET', '/agents')).find((v) => v.id === a.id).laneInfo;
  assert.ok(lane && lane.last - lane.first === 9, JSON.stringify(lane));
  await until(`[...document.querySelectorAll('#detail dl.kv dt')].some((d) => d.textContent === 'Lane' && d.nextElementSibling.textContent.replace(/\\s+/g, ' ').trim() === 'ports ${lane.first}–${lane.last} · names end with ${lane.suffix}')`, 'the lane in its detail');
  // OS: the lane beside the open session, and the switches for lanes.
  await js(`document.querySelector('#os-btn').click()`);
  await until(`document.querySelector('[data-os-agent="${a.id}"]')?.closest('tr').querySelector('.os-ports').textContent.includes('${lane.first}–${lane.last}')`, 'the lane in OS', 15_000);
  assert.deepEqual(await js(`[...document.querySelectorAll('[data-os-lanes]')].map((c) => [c.dataset.osLanes, c.checked])`), [['enabled', true], ['port', true]]);
  await js(`document.querySelector('[data-os-lanes="port"]').click()`);
  await until(`document.querySelector('[data-os-lanes="port"]')?.checked === false && [...document.querySelectorAll('.toast')].some((t) => /PORT is left alone/.test(t.textContent))`, 'PORT off');
  assert.equal((await api('GET', '/lanes')).port, false);
  await js(`document.querySelector('[data-os-lanes="enabled"]').click()`);
  await until(`!document.querySelector('[data-os-lanes="port"]') && document.querySelector('[data-os-lanes="enabled"]').checked === false`, 'lanes off');
  await api('PUT', '/lanes', { enabled: true, port: true });
  await js(`document.querySelector('[data-os="close"]').click()`);
  for (const x of [a, b]) await api('DELETE', `/agents/${x.id}`);
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
  // The window first shows the projects it knew before; the one just made arrives with its refresh.
  await until(`document.querySelector('form[data-plan-dates=""] option[value=${JSON.stringify(w1.shortcut)}]')`, 'the new project in the form', 20_000);
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
  // The meeting is at 23:50 today: in the day's last half hour there is no free time left before it
  // (and at midnight it is no longer today's), so that part is left out of a run that late.
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < 23 * 60 + 30) {
    await js(`document.querySelector('[data-day="settings"]').click()`);
    await js(`(() => { const f = document.querySelector('[data-day-form]'); f.ics.value = 'http://127.0.0.1:${notes.address().port}/secret/cal.ics'; f.workStart.value = '00:00'; f.workEnd.value = '23:59'; f.requestSubmit(); })()`);
    await until(`document.querySelector('.day-meeting b')?.textContent === 'Design sync'`, 'the meeting', 20_000);
    const dayRows = await js(`({ free: document.querySelectorAll('.day-free').length, about: document.querySelector('.day-meeting [data-day-agent]')?.textContent, head: document.querySelector('.today-day-head').textContent, html: document.querySelector('#today-body').innerHTML.includes('secret') })`);
    assert.ok(dayRows.free >= 1, 'free time before it');
    assert.equal(dayRows.about, 'task-2', 'the agent the meeting names');
    assert.match(dayRows.head, /1 meeting today \(5m\)[\s\S]*Next: Design sync/);
    assert.equal(dayRows.html, false, "the calendar's address isn't shown");
  }
  await js(`document.querySelector('[data-today="close"]').click()`);
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Runbooks: written from the code changes of a time frame, read, revised, edited and deleted in Plan', { skip }, async () => {
  // A project that is a git repository with two commits; one names a Jira ticket (Jira is not set up here).
  const repo = path.join(home, 'rb');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'config.js'), 'export const retry_limit = 3;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Add retries');
  fs.writeFileSync(path.join(repo, 'config.js'), 'export const retry_limit = 5;\n');
  git('commit', '-q', '-am', 'SUP-7 Raise retry_limit to 5');
  await api('POST', '/projects', { shortcut: 'rbproj', dir: repo });

  await js(`document.querySelector('#plan-btn').click()`);
  await until(`document.querySelector('#plan-dialog').open && document.querySelector('[data-plan-tab="runbooks"]')`, 'the Plan window');
  await js(`document.querySelector('[data-plan-tab="runbooks"]').click()`);
  await until(`document.querySelector('[data-rb-form="new"] input[name="key"]')`, 'the Runbooks tab, a release ticket first');
  await js(`document.querySelector('[data-rb-source="code"]').click()`);
  await until(`document.querySelector('[data-rb-form="new"] select[name="project"] option[value="rbproj"]')`, 'the project to read');
  await js(`(() => { const f = document.querySelector('[data-rb-form="new"]'); f.project.value = 'rbproj'; f.since.value = '2020-01-01'; f.note.value = 'Cover the retries'; f.requestSubmit(); })()`);
  await until(`document.querySelector('.rb-list .rb-status.ready')`, 'written', 30_000);
  const row = await js(`document.querySelector('.rb-list tr').textContent.replace(/\\s+/g, ' ')`);
  assert.match(row, /Fake runbook for the changes to the code of rb from 2020-01-01 until now/, 'titled by its own heading');
  assert.match(row, /rb: code changes since 2020-01-01 · 2 commits, 1 file /);

  // Read it: the chatter before the title is gone, the table is a table, and the diff reached the model.
  await js(`document.querySelector('[data-rb-open]').click()`);
  await until(`document.querySelector('#rb-doc h1')`, 'the runbook');
  const doc = await js(`({ h1: document.querySelector('#rb-doc h1').textContent, text: document.querySelector('#rb-doc').textContent, table: document.querySelectorAll('#rb-doc table tr').length, h2: [...document.querySelectorAll('#rb-doc h2')].map((h) => h.textContent) })`);
  assert.doesNotMatch(doc.text, /Here you go/);
  assert.match(doc.text, /Written from 0 tickets and 2 commits\./);
  assert.match(doc.text, /Saw the diff of retry_limit\./);
  assert.match(doc.text, /Cover the retries/);
  assert.ok(doc.table >= 2 && doc.h2.includes('To confirm with engineering'), JSON.stringify(doc.h2));

  // Revise with a note, then edit by hand.
  await js(`(() => { const f = document.querySelector('[data-rb-form="revise"]'); f.note.value = 'Add the on-call rota'; f.requestSubmit(); })()`);
  await until(`/Revised\\./.test(document.querySelector('#rb-doc')?.textContent ?? '') && /Add the on-call rota/.test(document.querySelector('#rb-doc').textContent)`, 'revised with the note', 30_000);
  await js(`document.querySelector('[data-rb="edit"]').click()`);
  await until(`document.querySelector('[data-rb-text]')`, 'the editor');
  await js(`(() => { const t = document.querySelector('[data-rb-text]'); t.value = t.value.replace('Check the setting.', 'Check the setting in Admin.'); document.querySelector('[data-rb="save"]').click(); })()`);
  await until(`/Check the setting in Admin\\./.test(document.querySelector('#rb-doc')?.textContent ?? '')`, 'your edit saved');
  const id = (await api('GET', '/runbooks')).items[0].id;
  assert.equal((await api('GET', '/runbooks')).items[0].edited, true);
  const dl = await js(`const rbRes = await fetch('/api/runbooks/${id}?format=markdown'); ({ type: rbRes.headers.get('content-type'), name: rbRes.headers.get('content-disposition'), text: await rbRes.text() })`);
  assert.match(dl.type, /text\/markdown/);
  assert.match(dl.name, /attachment; filename=".*\.md"/);
  assert.match(dl.text, /^# Fake runbook[\s\S]*Check the setting in Admin\./);

  // What can't be written says why: a ticket needs Jira, a time frame needs commits.
  await js(`document.querySelector('[data-rb="back"]').click()`);
  await js(`(() => { const f = document.querySelector('[data-rb-form="new"]'); f.project.value = 'rbproj'; f.since.value = '2000-01-01'; f.until.value = '2000-01-02'; f.requestSubmit(); })()`);
  await until(`/Nothing was committed in rb between 2000-01-01 and 2000-01-02/.test(document.querySelector('.rb-list')?.textContent ?? '')`, 'no commits in the frame', 20_000);
  assert.equal((await fetch(`${base}/api/runbooks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentmgr': '1' }, body: JSON.stringify({ source: 'code', project: 'rbproj', since: '2999-01-01' }) })).status, 400, 'a time frame in the future');
  await js(`document.querySelector('[data-rb-source="ticket"]').click()`);
  await js(`(() => { const f = document.querySelector('[data-rb-form="new"]'); f.key.value = 'https://x.atlassian.net/browse/rel-42'; f.requestSubmit(); })()`);
  await until(`/Release ticket REL-42[\\s\\S]*Jira is not set up/.test(document.querySelector('.rb-list')?.textContent ?? '')`, 'Jira is not set up', 20_000);
  for (let n = 3; n > 0; n--) {
    await js(`document.querySelector('[data-rb-remove]:not([disabled])').click()`);
    await until(`document.querySelectorAll('.rb-list tr').length === ${n - 1}`, `${n - 1} left`);
  }
  await js(`document.querySelector('[data-plan="close"]').click()`);
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Files: a folder on this computer listed, a file sent into it, a folder opened and a file fetched', { skip }, async () => {
  const dir = path.join(home, 'files-test');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'build.log'), 'built fine');
  fs.writeFileSync(path.join(dir, 'report.txt'), 'the report');
  const names = `[...document.querySelectorAll('#files-list .files-name')].map((n) => n.textContent)`;
  await js(`document.querySelector('#files-btn').click()`);
  await until(`document.querySelector('#files-dialog').open && document.querySelector('#files-path').value`, 'the dialog, at a folder');
  // Typed, a folder is gone to; not this computer's own Downloads in a test.
  await js(`(() => { const p = document.querySelector('#files-path'); p.value = ${JSON.stringify(dir)}; p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  await until(`JSON.stringify(${names}) === '["logs","report.txt"]'`, 'folders first, then files');
  assert.match(await js(`document.querySelector('#files-note').textContent`), /goes into files-test/);
  // Dropped (or picked) files go into the folder shown, and never over one that is there.
  const drop = (name, text) => js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)})); document.querySelector('#files-dialog').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
  await drop('photo.jpg', 'from the phone');
  await until(`${names}.includes('photo.jpg')`, 'the file sent, in the list');
  assert.equal(fs.readFileSync(path.join(dir, 'photo.jpg'), 'utf8'), 'from the phone');
  await drop('report.txt', 'another');
  await until(`${names}.includes('report (2).txt')`, 'a second one beside the first');
  assert.equal(fs.readFileSync(path.join(dir, 'report.txt'), 'utf8'), 'the report');
  // A folder opens; a file is a download of that file.
  await js(`document.querySelector('#files-list [data-dir]').click()`);
  await until(`JSON.stringify(${names}) === '["build.log"]' && document.querySelector('#files-path').value.endsWith('/logs')`, 'inside logs');
  assert.equal(await js(`await (async () => { const a = document.querySelector('#files-list a'); const r = await fetch(a.href); return a.download + ' | ' + r.headers.get('content-disposition').split(';')[0] + ' | ' + (await r.text()); })()`), 'build.log | attachment | built fine');
  await js(`document.querySelector('#files-up').click()`);
  await until(`${names}.includes('logs')`, 'up again');
  // Reached from the terminal on this computer and from Screen too.
  assert.equal(await js(`document.querySelectorAll('#machine-dialog [data-open-files], #screen-dialog [data-open-files]').length`), 2);
  await js(`document.querySelector('#files-close').click()`);
  await until(`!document.querySelector('#files-dialog').open`, 'closed');
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Open Terminal on a phone: a swipe scrolls back through what was printed, and forward again', { skip }, async () => {
  await width(390, 800);
  await js(`document.querySelector('#machine-btn').click()`);
  const rows = `(document.querySelector('#machine-term .xterm-rows')?.textContent ?? '')`;
  await until(`document.querySelector('#machine-dialog').open && document.querySelector('#machine-term .xterm-rows')`, 'the terminal');
  await sleep(1500);
  await js(`document.querySelector('#machine-term textarea').focus()`);
  await send('Input.insertText', { text: `printf 'L%s-\\n' $(seq 1 300)` });
  await key('Enter', 'Enter', 13);
  await until(`${rows}.includes('L300-')`, 'the lines printed', 15_000);
  const at = await js(`(() => { const r = document.querySelector('#machine-term').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 3 }; })()`);
  const swipe = async (dy) => {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
    for (let i = 1; i <= 8; i++) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at.x, y: at.y + (dy * i) / 8 }] });
      await sleep(20);
    }
    await sleep(150); // a pause: no flick
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await swipe(240);
  await until(`!${rows}.includes('L300-') && /L2\\d\\d-/.test(${rows})`, 'earlier lines after a swipe down');
  await swipe(-240);
  await until(`${rows}.includes('L300-')`, 'the end again after a swipe up');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  const n = await js(`Number(document.querySelector('#machine-tabs .term-tab.active').dataset.n)`);
  await js(`document.querySelector('#machine-close').click()`);
  await api('POST', '/machine/shell/drop', { n });
  await width(1600);
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Inbox, one at a time: a single card with the next after it, stepped through with ‹ › and a swipe; Show all brings the list back', { skip }, async () => {
  const made = await api('POST', '/agents', { intents: ['First, please #ask me', 'Second, please #ask me'], workdir: home });
  await js(`document.querySelector('[data-tab="inbox"]').click()`);
  const cards = `document.querySelectorAll('#inbox-view .needs.inbox > .need')`;
  const seen = `[...${cards}].filter((c) => c.offsetParent !== null)`;
  await until(`${cards}.length >= 2`, 'two cards at least', 30_000);
  // Two agents asking the same thing get a card for both as well: wait for a count that holds.
  let total = 0;
  for (let i = 0, last = -1; i < 40 && total !== last; i++) {
    last = total;
    await sleep(700);
    total = await js(`${cards}.length`);
  }
  assert.equal(await js(`${seen}.length`), total, 'the whole list on a wide screen');
  await js(`document.querySelector('#inbox-view [data-inbox-one]').click()`);
  await until(`${seen}.length === 1 && document.querySelector('.inbox-step')`, 'one card');
  // Where the steps are gone, say what the inbox looks like instead of failing on a missing element.
  const now = () => js(`document.querySelector('.inbox-step span') ? document.querySelector('.inbox-step span').textContent + ' ' + ${seen}[0].dataset.need
    : 'no steps: ' + JSON.stringify({ at: location.href, cards: [...${cards}].map((c) => c.dataset.need), hidden: document.querySelector('#inbox-view').hidden, head: document.querySelector('#inbox-view .counts')?.textContent ?? document.querySelector('#inbox-view').textContent.slice(0, 200), open: [...document.querySelectorAll('dialog[open]')].map((d) => d.id) })`);
  const first = await now();
  assert.match(first, new RegExp(`^1 of ${total} `));
  await js(`document.querySelector('[data-inbox-step="1"]').click()`);
  const second = await now();
  assert.match(second, new RegExp(`^2 of ${total} `));
  assert.notEqual(second.split(' ').pop(), first.split(' ').pop(), 'another card');
  // A swipe to the right goes back; one to the left goes on, and round to the first after the last.
  const swipe = async (from, to) => {
    const y = await js(`Math.round(${seen}[0].getBoundingClientRect().top + 20)`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: (from + to) / 2, y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: to, y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(100);
  };
  const box = await js(`(() => { const r = document.querySelector('#inbox-view').getBoundingClientRect(); return { left: Math.round(r.left + 30), right: Math.round(r.right - 30) }; })()`);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await swipe(box.left, box.right);
  assert.equal(await now(), first, 'swiped back');
  await swipe(box.right, box.left);
  assert.equal(await now(), second, 'swiped on');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  // Reloaded, it is still one at a time, and the last card steps round to the first.
  assert.equal(await js(`localStorage.getItem('agentmgr.inboxOne')`), '1');
  for (let i = 2; i < total; i++) await js(`document.querySelector('[data-inbox-step="1"]').click()`);
  await js(`document.querySelector('[data-inbox-step="1"]').click()`);
  assert.equal(await now(), first, 'round to the first');
  // Answered, a card gives way to the next: still one shown, of one fewer.
  const key = first.split(' ').pop();
  const id = made.map((a) => a.id).find((x) => key.includes(x)) ?? made[0].id;
  await api('POST', `/agents/${id}/stop`);
  await api('DELETE', `/agents/${id}`).catch(() => {});
  await until(`${cards}.length < ${total} && ${seen}.length === (${cards}.length ? 1 : 0)`, 'the next card in its place', 20_000);
  await js(`document.querySelector('#inbox-view [data-inbox-one]')?.click()`);
  await until(`${seen}.length === ${cards}.length && !document.querySelector('.inbox-step')`, 'the whole list again');
  assert.equal(await js(`localStorage.getItem('agentmgr.inboxOne')`), '0');
  for (const a of made) await api('DELETE', `/agents/${a.id}`).catch(() => {});
  await js(`document.querySelector('[data-tab="agents"]').click()`);
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Value: the pull requests merged next to the value, by day, week, month, quarter and year', { skip }, async () => {
  await js(`document.querySelector('#value-btn').click()`);
  await until(`document.querySelector('#value-dialog').open && document.querySelector('#value-body .value-cards')`, 'Value, open');
  assert.deepEqual(await js(`[...document.querySelectorAll('#value-body [data-value-period]')].map((b) => b.textContent)`), ['Day', 'Week', 'Month', 'Quarter', 'Year']);
  const card = `[...document.querySelectorAll('#value-body .value-card')].find((c) => c.textContent.startsWith('Pull requests'))`;
  assert.match(await js(`${card}.textContent.replace(/\\s+/g, ' ')`), /^Pull requests\s*0\s*merged · 0 a day/);
  await js(`document.querySelector('#value-body [data-value-period="year"]').click()`);
  await until(`document.querySelector('#value-body [data-value-period="year"].active') && document.querySelectorAll('#value-body .value-bar').length === 5`, 'five years of bars');
  assert.equal(await js(`document.querySelector('#value-body .value-period b').textContent`), String(new Date().getFullYear()));
  assert.match(await js(`document.querySelector('#value-body .value-bar.on').title`), /0 pull requests merged$/);
  assert.equal(await js(`document.querySelector('#value-body .value-bar.on .lbl').textContent`), String(new Date().getFullYear()));
  await js(`document.querySelector('#value-body [data-value-period="week"]').click()`);
  await until(`document.querySelector('#value-body [data-value-period="week"].active')`, 'back to weeks');
  await js(`document.querySelector('#value-dialog').close()`);
});

test('Weekly summary: opened from the Work record, last week and this week so far, copied and saved', { skip }, async () => {
  await js(`document.querySelector('#worklog-btn').click()`);
  await until(`document.querySelector('#worklog-dialog').open`, 'the Work record');
  await js(`document.querySelector('#weekly-open').click()`);
  const wd = `document.querySelector('#weekly-dialog')`;
  await until(`${wd}.open && ${wd}.querySelector('.weekly-md h1')`, 'the summary');
  assert.match(await js(`${wd}.querySelector('.weekly-md h1').textContent`), /^Weekly summary: /);
  assert.deepEqual(await js(`[...${wd}.querySelectorAll('#weekly-tabs .chip')].map((c) => [c.textContent, c.classList.contains('active')])`), [['Week', true], ['Month', false], ['Quarter', false], ['Last week', true], ['This week so far', false]]);
  await js(`${wd}.querySelector('[data-weekly-kind="month"]').click()`);
  await until(`/^Monthly summary: /.test(${wd}.querySelector('.weekly-md h1')?.textContent ?? '') && ${wd}.querySelector('[data-weekly-current="1"]').textContent === 'This month so far'`, 'the month');
  await js(`${wd}.querySelector('[data-weekly-kind="week"]').click()`);
  await until(`/^Weekly summary: /.test(${wd}.querySelector('.weekly-md h1')?.textContent ?? '')`, 'the week again');
  assert.match(await js(`${wd}.querySelector('.weekly-md').textContent`), /the week as it ended/);
  await js(`${wd}.querySelector('[data-weekly-current="1"]').click()`);
  await until(`/the week so far/.test(${wd}.querySelector('.weekly-md')?.textContent ?? '')`, 'this week so far');
  assert.match(await js(`${wd}.querySelector('#weekly-note').textContent`), /Nothing is sent from here\./);
  await js(`${wd}.querySelector('[data-weekly="save"]').click()`);
  await until(`/^Saved as .*weekly-\\d{4}-\\d\\d-\\d\\d\\.md\\./.test(${wd}.querySelector('#weekly-note').textContent)`, 'saved on this computer');
  const file = (await api('GET', '/weekly?current=1')).file;
  assert.match(fs.readFileSync(file, 'utf8'), /^# Weekly summary: /);
  await width(390);
  assert.ok(await js(`${wd}.getBoundingClientRect().right <= 390 && ${wd}.scrollWidth <= ${wd}.clientWidth + 1`), 'fits a phone');
  await width(1600);
  await js(`${wd}.querySelector('[data-weekly="close"]').click()`);
  await js(`document.querySelector('#worklog-dialog').close()`);
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Quality: the share of merged pull requests that held up, why each did not, Not a problem and back, only the problems, by year', { skip }, async () => {
  await js(`document.querySelector('#quality-btn').click()`);
  await until(`document.querySelector('#quality-dialog').open && document.querySelector('#quality-body .value-cards')`, 'Quality, open');
  const cards = () => js(`Object.fromEntries([...document.querySelectorAll('#quality-body .value-card')].map((c) => [c.children[0].textContent, c.children[1].textContent + ' | ' + (c.children[2]?.textContent ?? '')]))`);
  const c = await cards();
  assert.equal(c['Held up'], '33% | 1 of 3 looked at; 1 still watched');
  assert.equal(c['Problems after the merge'], '2 | 67% of those looked at');
  assert.deepEqual([c.Reverted.split(' | ')[0], c['Fixed afterwards'].split(' | ')[0], c['Checks failed'].split(' | ')[0]], ['1', '1', '0']);
  assert.equal(c['Changes requested'], '33% | by a reviewer, before the merge (1)');
  assert.equal(c['Opened to merged'], '3h | median');
  // Track record: what was said as they merged against what held, and the level the project's record supports.
  await api('PUT', '/autonomy', { project: 'Shop', level: 'pr' });
  await js(`document.querySelector('#quality-body [data-quality-mode="record"]').click()`);
  await until(`document.querySelector('#quality-body .rec-table')`, 'the track record');
  const rc = await cards();
  assert.deepEqual([rc['Held up'], rc['Said by the agents'], rc['Not settled yet']], ['0% | 0 of 2 settled pull requests', '93% | their own confidence, on average; 0% of those held up', '2 | still watched, or not looked at']);
  const recRows = () => js(`[...document.querySelectorAll('#quality-body .rec-table tbody tr')].map((r) => [...r.children].map((td) => td.textContent.replace(/\\s+/g, ' ').trim()).join(' | '))`);
  const rr = await recRows();
  assert.ok(rr.includes('90 to 100% | 0 of 2 | 0% | 93% | too few to say'), rr.join('\n'));
  assert.ok(rr.includes('Ready to approve | 0 of 1 | 0% | too few to say') && rr.includes('Tests tested: a break not noticed | 0 of 1 | 0% | too few to say') && rr.includes('claude · opus | 0 of 2 | 0% | too few to say') && rr.includes('Run to pull request | 0 of 2 | 0% | too few to say'), rr.join('\n'));
  assert.ok(rr.some((x) => /^Shop \| 0 of 2 \| 0% \| Run to pull request \| The record supports Agree, then run ?2 of its last 2 merged pull requests did not hold up \| Set Agree, then run ?Use the default$/.test(x)), rr.join('\n'));
  await js(`document.querySelector('#quality-body [data-record-level="run"]').click()`);
  await until(`document.querySelector('#quality-body [data-record-level="ask"]')`, 'set, and the next step down offered');
  assert.deepEqual((await api('GET', '/autonomy')).projects, { Shop: 'run' });
  await js(`document.querySelector('#quality-body [data-record-level="default"]').click()`);
  await until(`!document.querySelector('#quality-body [data-record-level]')`, 'the default again: nothing below Ask me');
  assert.deepEqual((await api('GET', '/autonomy')).projects, {});
  await width(390);
  assert.ok(await js(`document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('#quality-body .value-card, #quality-body .issues-scroll')].every((el) => el.getBoundingClientRect().right <= 390)`), 'the record fits a phone');
  await width(1600);
  await js(`document.querySelector('#quality-body [data-quality-mode="after"]').click()`);
  await until(`document.querySelector('#quality-body .quality-items')`, 'back to After the merge');
  assert.match(await js(`document.querySelector('#quality-body .value-period').textContent`), /4 pull requests from agents merged · 1 not looked at yet/);
  assert.match(await js(`document.querySelector('#quality-body').textContent`), /GitHub is not asked on this computer/);
  const rows = () => js(`[...document.querySelectorAll('#quality-body .quality-items tbody tr')].map((r) => [r.children[1].querySelector('a').textContent, r.children[2].textContent.trim(), r.children[3].textContent.replace(/\\s+/g, ' ').trim()])`);
  const byName = async (n) => (await rows()).find((r) => r[0].startsWith(`#${n} `));
  assert.deepEqual(await byName(71), ['#71 Cache prices', 'Fixed afterwards', '#75 Fix stale prices same file: src/cache.js']);
  assert.deepEqual(await byName(72), ['#72 Export orders', 'Reverted', 'Reverted by #76 Revert "Export orders"']);
  assert.deepEqual((await byName(73)).slice(0, 2), ['#73 Faster search', 'Fine so far']);
  assert.deepEqual(await byName(74), ['#74 New footer', 'Not looked at', 'GitHub is not asked here']);
  assert.equal(await js(`document.querySelector('#quality-body .value-bar.on').title.replace(/^.*?: /, '')`), '4 merged, 2 with a problem, 33% held up');
  // Not a problem: the fix was about something else. It counts as held up, marked as yours; Undo takes it back.
  const btn = (n, label) => `[...document.querySelectorAll('#quality-body .quality-items tbody tr')].find((r) => r.textContent.includes('#${n} ')).querySelector('button[data-quality-mark]')`;
  assert.equal(await js(`${btn(71)}.textContent`), 'Not a problem');
  await js(`${btn(71)}.click()`);
  await until(`${btn(71)}?.textContent === 'Undo'`, 'marked as not a problem');
  assert.deepEqual(await byName(71), ['#71 Cache prices', 'Held up ✎', 'You said so']);
  assert.equal((await cards())['Held up'], '67% | 2 of 3 looked at; 1 still watched');
  // Only the ones with a problem.
  await js(`document.querySelector('#quality-body [data-quality-only]').click()`);
  await until(`document.querySelectorAll('#quality-body .quality-items tbody tr').length === 1`, 'only the reverted one');
  assert.equal((await rows())[0][0], '#72 Export orders');
  await js(`document.querySelector('#quality-body [data-quality-only]').click()`);
  await until(`document.querySelectorAll('#quality-body .quality-items tbody tr').length === 4`, 'all four again');
  await js(`${btn(71)}.click()`);
  await until(`${btn(71)}?.textContent === 'Not a problem'`, 'back to what was found');
  // It was a problem nothing here saw.
  assert.equal(await js(`${btn(73)}.textContent`), 'It was a problem');
  await js(`${btn(73)}.click()`);
  await until(`${btn(73)}?.textContent === 'Undo'`, 'marked as a problem');
  assert.equal((await cards())['Problems after the merge'], '3 | 100% of those looked at');
  await js(`${btn(73)}.click()`);
  await until(`${btn(73)}?.textContent === 'It was a problem'`, 'and back');
  // By year; the watch days saved.
  await js(`document.querySelector('#quality-body [data-quality-period="year"]').click()`);
  await until(`document.querySelector('#quality-body [data-quality-period="year"].active') && document.querySelectorAll('#quality-body .value-bar').length === 5`, 'five years of bars');
  assert.equal(await js(`document.querySelector('#quality-body .value-period b').textContent`), String(new Date().getFullYear()));
  await js(`(() => { const f = document.querySelector('[data-quality-settings]'); f.watchDays.value = '21'; f.requestSubmit(); })()`);
  await until(`document.querySelector('[data-quality-settings]').watchDays.value === '21' && document.querySelector('#quality-body').textContent.includes('within 21 days')`, 'the watch days saved');
  assert.equal((await api('GET', '/quality')).settings.watchDays, 21);
  await api('PUT', '/quality', { watchDays: 14 });
  await js(`document.querySelector('#quality-body [data-quality-period="week"]').click()`);
  await until(`document.querySelector('#quality-body [data-quality-period="week"].active')`, 'back to weeks');
  await js(`document.querySelector('#quality-dialog').close()`);
  // The shortcut opens it too.
  await key('KeyQ', 'Q', 81, 8);
  await until(`document.querySelector('#quality-dialog').open`, 'opened with Q');
  await js(`document.querySelector('#quality-dialog').close()`);
});

test('Standards, in Quality: a proposed lesson worded and accepted, one of your own, a high-risk path, and the checks of the bar', { skip }, async () => {
  await js(`document.querySelector('#quality-btn').click()`);
  await until(`document.querySelector('#quality-dialog').open && document.querySelector('#quality-body [data-quality-mode="standards"] .badge')?.textContent === '1'`, 'Quality, with one lesson proposed');
  await js(`document.querySelector('#quality-body [data-quality-mode="standards"]').click()`);
  await until(`document.querySelector('#quality-body .std-proposed')`, 'Standards, open');
  const repo = async () => (await api('GET', '/standards')).repos.find((r) => r.name === 'acme/shop');
  assert.equal(await js(`document.querySelector('#quality-body [data-std-repo]').selectedOptions[0].textContent`), 'acme/shop (1 proposed)');
  assert.equal(await js(`document.querySelector('#quality-body .std-proposed .hint').textContent`), '#72 Export orders · Reverted by #76 Revert "Export orders"');
  // Not worded yet: Accept asks for the words. Worded: it joins the lessons, and the badge goes.
  await js(`document.querySelector('#quality-body .std-proposed [data-std="accept"]').click()`);
  await until(`[...document.querySelectorAll('.toast, #toast')].some((t) => /Word the lesson first/.test(t.textContent))`, 'asked for the words');
  await js(`(() => { const i = document.querySelector('#quality-body .std-proposed input'); i.focus(); i.value = 'Exports are paged, never loaded whole'; })()`);
  await js(`document.querySelector('#quality-body .std-proposed [data-std="accept"]').click()`);
  await until(`!document.querySelector('#quality-body .std-proposed') && document.querySelector('#quality-body .std-list .std-text')?.textContent === 'Exports are paged, never loaded whole'`, 'accepted');
  assert.equal(await js(`document.querySelector('#quality-body [data-quality-mode="standards"] .badge')`), null);
  assert.deepEqual((await repo()).lessons.map((l) => [l.text, l.source.number]), [['Exports are paged, never loaded whole', 72]]);
  // One of your own.
  await js(`(() => { const f = document.querySelector('#quality-body [data-std-form="lesson"]'); f.text.value = 'Every endpoint checks permissions in a test'; f.requestSubmit(); })()`);
  await until(`document.querySelectorAll('#quality-body .std-list .std-text').length === 2`, 'a lesson added');
  assert.match(await js(`document.querySelector('#quality-body .std-section h3').textContent`), /^Lessons 2 of 40$/);
  // A high-risk path, with why.
  await js(`(() => { const f = document.querySelector('#quality-body [data-std-form="risk"]'); f.pattern.value = 'src/payments/**'; f.why.value = 'money'; f.requestSubmit(); })()`);
  await until(`[...document.querySelectorAll('#quality-body code.std-text')].some((c) => c.textContent === 'src/payments/**')`, 'marked high risk');
  assert.deepEqual((await repo()).risk, [{ pattern: 'src/payments/**', why: 'money' }]);
  // The bar: a built-in check turned on, a command added and removed.
  await js(`document.querySelector('#quality-body [data-std-bar="tests"]').click()`);
  await until(`document.querySelector('#quality-body [data-std-bar="tests"]')?.checked && [...document.querySelectorAll('#quality-body .std-section h3')].some((h) => h.textContent === 'Quality bar 2 checks')`, 'tests required');
  await js(`(() => { const f = document.querySelector('#quality-body [data-std-form="check"]'); f.label.value = 'Lint'; f.command.value = 'npm run lint'; f.requestSubmit(); })()`);
  await until(`[...document.querySelectorAll('#quality-body code.std-text')].some((c) => c.textContent === 'npm run lint')`, 'a check added');
  assert.deepEqual((await repo()).bar, { tests: true, secrets: true, checks: [{ name: 'Lint', command: 'npm run lint' }] });
  await js(`document.querySelector('#quality-body [data-std="uncheck"][data-name="Lint"]').click()`);
  await until(`![...document.querySelectorAll('#quality-body code.std-text')].some((c) => c.textContent === 'npm run lint')`, 'the check removed');
  await js(`document.querySelector('#quality-body [data-std="unrisk"]').click()`);
  await until(`!document.querySelector('#quality-body [data-std="unrisk"]')`, 'no longer high risk');
  // Removed: one that came from a pull request stays dismissed, so it is not proposed again.
  await js(`document.querySelector('#quality-body [data-std-lesson="p72"] [data-std="remove"]').click()`);
  await until(`document.querySelectorAll('#quality-body .std-list .std-text').length === 1`, 'the lesson removed');
  const end = await repo();
  assert.deepEqual([end.lessons.length, end.proposed.length, end.dismissed, end.risk.length, end.bar.checks.length], [1, 0, 1, 0, 0]);
  // Fits a phone: nothing wider than the dialog.
  assert.ok(await js(`document.querySelector('#quality-body').scrollWidth <= document.querySelector('#quality-body').clientWidth + 1`), 'no sideways scroll');
  await js(`document.querySelector('#quality-body [data-quality-mode="after"]').click()`);
  await until(`document.querySelector('#quality-body .value-cards')`, 'back to After the merge');
  await js(`document.querySelector('#quality-dialog').close()`);
});

test('Update: written when an agent finishes, a card in the inbox, the Slack message and email to change and send, the link to the details', { skip }, async () => {
  const http = await import('node:http');
  const got = [];
  const hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      got.push(JSON.parse(b).text);
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  await api('PUT', '/announce/slack', { webhookUrl: `http://127.0.0.1:${hook.address().port}/services/T/B/u` });
  await api('PUT', '/announce/settings', { auto: true });
  try {
    const [a] = await api('POST', '/agents', { intents: ['Ship the export #done'], workdir: home });
    const card = `document.querySelector('#inbox-view [data-need="update:${a.id}"]')`;
    await js(`document.querySelector('[data-tab="inbox"]').click()`);
    await until(card, 'its card in the inbox', 30_000);
    assert.match(await js(`${card}.textContent.replace(/\\s+/g, ' ')`), /Update to send.*Ship the export #done: finished.*It is finished: what to tell the people who asked is written.*Nothing is sent until you send it/);
    await js(`${card}.querySelector('[data-ib="update-open"]').click()`);
    await until(`document.querySelector('#doc-dialog').open && document.querySelector('#doc-body [data-upd]')`, 'the update, open');
    const val = (k) => js(`document.querySelector('#doc-body [data-upd-text="${k}"]').value`);
    assert.equal(await val('slack'), '*Ship the export #done*: finished\n• Safe call.');
    assert.equal(await val('subject'), 'Ship the export #done: finished');
    assert.match(await val('email'), /^Hi Pat,\n\n- It is finished\./);
    assert.equal(await val('to'), '', 'a name is not an address');
    assert.equal(await js(`document.querySelector('#doc-body [data-upd-text="to"]').placeholder`), "Pat Lee's address");
    assert.match(await js(`document.querySelector('#doc-body .upd-details').textContent`), /Update: .*What was asked.*Ship the export #done.*Status.*It is finished/s);
    await until(`document.querySelector('[data-upd-act="post-slack"]').textContent === 'Post to the updates webhook'`, 'where it would be posted');
    assert.match(await js(`document.querySelector('[data-upd-note="slack"]').textContent`), /No link to the details yet/);

    // Your words, and the link to the details, are what goes out; what you typed survives the page's updates.
    await js(`(() => { const t = document.querySelector('[data-upd-text="slack"]'); t.value = 'The export is live. Thanks all.'; const l = document.querySelector('[data-upd-text="link"]'); l.value = 'https://docs.example.com/d/9'; l.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until(`/The link to the details goes under it/.test(document.querySelector('[data-upd-note="slack"]').textContent)`, 'the link kept');
    assert.equal(await val('slack'), 'The export is live. Thanks all.', 'not written over');
    // Asked twice: the first press posts nothing.
    await js(`document.querySelector('[data-upd-act="post-slack"]').click()`);
    assert.equal(await js(`document.querySelector('[data-upd-act="post-slack"]').textContent`), 'Post it to the updates webhook?');
    await sleep(300);
    assert.deepEqual(got, []);
    await js(`document.querySelector('[data-upd-act="post-slack"]').click()`);
    await until(`/^Posted /.test(document.querySelector('[data-upd-note="slack"]').textContent)`, 'posted, and said so');
    assert.deepEqual(got, ['The export is live. Thanks all.\n\nDetails: https://docs.example.com/d/9']);
    assert.equal(await js(`document.querySelector('[data-upd-act="post-slack"]').textContent`), 'Post to the updates webhook');

    // Its statements were checked against the work by another model: said over the drafts, the whole check one press away.
    await until(`document.querySelector('[data-upd-claims] [data-doc="claims"]:not([data-run])')`, 'the check, said over the drafts', 30_000);
    assert.match(await js(`document.querySelector('[data-upd-claims]').textContent`), /^(Read before sending: |Checked against the work: ).*\d+ backed/);
    assert.equal(await val('slack'), 'The export is live. Thanks all.', 'still not written over');
    await js(`document.querySelector('[data-upd-claims] [data-doc="claims"]').click()`);
    await until(`document.querySelector('#doc-body .cl [data-claims-text="update"]')`, 'the claims check, open');
    assert.match(await js(`document.querySelector('#doc-title').textContent`), /^Claims · /);
    assert.match(await js(`document.querySelector('#doc-meta').textContent`), /^Checked .* by Codex/);
    const checked = await js(`document.querySelector('#doc-body .cl').textContent.replace(/\\s+/g, ' ')`);
    assert.match(checked, /The agent's brief.*Update.*Sources: What the app measured/);
    assert.match(await js(`document.querySelector('[data-claims-text="brief"] .cl-claim.cl-not_backed .cl-said').closest('ul').textContent`), /Fix the token refresh in `auth\/session\.go`/, 'what the brief says and nothing shows');
    assert.ok(await js(`document.querySelector('[data-claims-text="brief"] details.cl-group').open && !document.querySelector('[data-claims-text="update"] details .cl-chip.cl-backed').closest('details').open`), 'what needs reading is open; the backed ones are folded');
    assert.ok(await js(`document.documentElement.scrollWidth <= window.innerWidth`), 'no sideways scroll');
    await js(`document.querySelector('#doc-close').click()`);
    await until(`!${card}`, 'sent: out of the inbox');

    // Reached from the agent's documents too, and one that is not needed is set aside.
    const [b] = await api('POST', '/agents', { intents: ['Tidy the logs #done'], workdir: home });
    const other = `document.querySelector('#inbox-view [data-need="update:${b.id}"]')`;
    await until(other, 'the next one', 30_000);
    await js(`${other}.querySelector('[data-ib="update-dismiss"]').click()`);
    await until(`!${other}`, 'set aside');
    assert.equal((await api('GET', `/agents/${b.id}`)).docs.update.parts.subject, 'Tidy the logs #done: finished', 'still there to open');
    for (const x of [a, b]) await api('DELETE', `/agents/${x.id}`).catch(() => {});
    await js(`document.querySelector('[data-tab="agents"]').click()`);
    assert.deepEqual(errors, [], 'no errors on the page');
  } finally {
    await api('PUT', '/announce/settings', { auto: false });
    await api('PUT', '/announce/slack', { webhookUrl: '' });
    hook.close();
  }
});

test('Without you and ground rules: the level on a new agent and on one that runs, your rules and the models in Settings, and the agent\'s own confidence in its results', { skip }, async () => {
  // New agent: a level past "Ask me" also asks to agree on what done means first.
  await js(`document.querySelector('#new-btn')?.click()`);
  const sel = `document.querySelector('#new-dialog select[name="autonomy"]')`;
  assert.deepEqual(await js(`[...${sel}.options].map((o) => o.textContent)`), ['The default', 'Ask me', 'Agree, then run', 'Run to pull request', 'Run to merge']);
  assert.equal(await js(`document.querySelector('#new-dialog input[name="acceptance"]').checked`), false);
  await js(`(() => { ${sel}.value = 'pr'; ${sel}.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await js(`document.querySelector('#new-dialog input[name="acceptance"]').checked`), true, 'what done means is agreed first');
  // It says that permission prompts still stop it, until the mode is one that does not ask for each.
  const perm = `document.querySelector('#new-autonomy-perm')`;
  assert.equal(await js(`${perm}.hidden`), false);
  assert.match(await js(`${perm}.textContent`), /still stops at each permission prompt.*never answered for you/);
  await js(`document.querySelector('#new-autonomy-auto').click()`);
  assert.deepEqual(await js(`[${perm}.hidden, document.querySelector('#new-dialog select[name="permissionMode"]').value]`), [true, 'auto']);
  await js(`(() => { const m = document.querySelector('#new-dialog select[name="permissionMode"]'); m.value = ''; m.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await js(`${perm}.hidden`), false);
  await js(`(() => { ${sel}.value = ''; ${sel}.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#new-dialog input[name="acceptance"]').checked = false; document.querySelector('#new-dialog').close(); })()`);
  assert.equal(await js(`${perm}.hidden`), true);

  // Settings: your ground rules, one per line, and the level and models for agents that run without you.
  await js(`document.querySelector('#settings-btn').click()`);
  const form = `document.querySelector('#settings-form')`;
  await until(`document.querySelector('#settings-dialog').open && !document.querySelector('#settings-autonomy').hidden && ${form}.autoModels.value`, 'settings open');
  assert.equal(await js(`${form}.autoModels.value`), 'fable, opus, sonnet');
  assert.equal(await js(`${form}.autoLevel.value`), 'ask');
  assert.match(await js(`document.querySelector('#settings-ground').textContent.replace(/\\s+/g, ' ')`), /Ground rules Your own rules for every agent, in every repository, one per line/);
  await js(`(() => { ${form}.groundRules.value = '- Ask before adding a dependency\\nNever force-push'; ${form}.autoModels.value = 'opus, sonnet'; })()`);
  await width(390);
  assert.ok(await js(`['#settings-ground', '#settings-autonomy'].every((q) => document.querySelector(q).getBoundingClientRect().right <= 390 && document.querySelector(q).scrollWidth <= document.querySelector(q).clientWidth + 1)`), 'both fit a phone');
  await width(1600);
  await js(`${form}.requestSubmit()`);
  await until(`!document.querySelector('#settings-dialog').open`, 'settings saved');
  assert.deepEqual((await api('GET', '/ground-rules')).rules, ['Ask before adding a dependency', 'Never force-push']);
  assert.deepEqual((await api('GET', '/autonomy')).models, ['opus', 'sonnet']);
  await js(`document.querySelector('#settings-btn').click()`);
  await until(`document.querySelector('#settings-dialog').open && ${form}.groundRules.value`, 'settings open again');
  assert.equal(await js(`${form}.groundRules.value`), 'Ask before adding a dependency\nNever force-push');
  assert.equal(await js(`${form}.autoModels.value`), 'opus, sonnet');
  await js(`document.querySelector('#settings-cancel').click()`);

  // An agent that runs without you: its row, and the dialog to change how far it goes.
  const [a] = await api('POST', '/agents', { intents: ['Add a cache'], autonomy: 'merge', acceptance: false, start: false });
  await js(`document.querySelector('[data-tab="agents"]').click()`);
  await until(`document.querySelector('#agent-list li[data-id="${a.id}"]')`, 'the agent listed');
  await js(`document.querySelector('#agent-list li[data-id="${a.id}"]').click()`);
  const row = `document.querySelector('.auto-row')`;
  await until(`${row} && /Run to merge/.test(${row}.textContent)`, 'its level on the agent');
  await js(`${row}.querySelector('[data-act="auto-open"]').click()`);
  const dlg = `document.querySelector('#auto-dialog')`;
  await until(`${dlg}.open`, 'the dialog');
  assert.match(await js(`${dlg}.textContent.replace(/\\s+/g, ' ')`), /^ ?Without you: .*How far it goes .*merged when its checks pass, the scorecard says ready and no high-risk path is touched\. Never done for you: answering a permission prompt, or a question about deleting, publishing, money, credentials or the scope of the task\. It still stops at each permission prompt, and waits for you in the inbox\. .*Nothing was done for you yet\./);
  await js(`(() => { const s = ${dlg}.querySelector('[data-auto="level"]'); s.value = 'run'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`/Agree, then run/.test(${row}?.textContent ?? '')`, 'the level changed');
  assert.equal((await api('GET', `/agents/${a.id}`)).autonomy.level, 'run');
  await width(390);
  assert.ok(await js(`${dlg}.getBoundingClientRect().width <= 390 && ${dlg}.scrollWidth <= ${dlg}.clientWidth + 1`), 'fits a phone');
  await width(1600);
  await js(`(() => { const s = ${dlg}.querySelector('[data-auto="level"]'); s.value = 'ask'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`!${row} && document.querySelector('[data-act="auto-open"]')?.textContent === 'Run without me…'`, 'asks you again: the way back in');
  await js(`${dlg}.querySelector('[data-auto="close"]').click()`);

  // Its own confidence in what it built, from its brief, beside the results.
  const briefs = path.join(home, 'briefs', a.id);
  fs.mkdirSync(briefs, { recursive: true });
  await api('POST', `/agents/${a.id}/start`);
  await until(`document.querySelector('#agent-list li[data-id="${a.id}"] .pill')?.textContent && true`, 'started');
  for (let i = 0; i < 100 && (await api('GET', `/agents/${a.id}`)).status !== 'running'; i++) await sleep(200);
  await sleep(1500); // the stand-in engine writes its own brief as it starts
  fs.writeFileSync(path.join(briefs, 'PROOF.md'), '## The cache answers\nCommand: `echo ok`\nExit: 0\n```\nok\n```\n## The suite passes\nCommand: false\nExit: 0\n```\n12 passed\n```\n## Saved the log\nCommand: echo hi > log.txt\nExit: 0\n## Read the config\nCommand: none\nLooked at <config>.\n');
  fs.writeFileSync(path.join(briefs, 'BRIEF.md'), 'Status: done\n## Problem\nx\n## Solution\ny\n## Risks\n- [x] A stale entry is served: avoided, the expiry test passes\n- [ ] The cache grows without <limit>\n## Options\n1. Cache in memory: one process | now: high | later: low | cost: small | risk: low | when: one server is enough\n2. Shared cache: a service | now: medium | later: high | cost: large | risk: medium | when: a second server is planned\n- Preferred: 1, because it ships <now>\n## Checks\n- [x] the cache answers\n- [x] the suite passes\n## Results\nOutcome: done\nConfidence: 60% - read the code, ran nothing <b>yet</b>\n- Delivered: a cache\n- Not done: eviction when <full>\n## Self-review\n- [x] Asked: the cache, as asked\n- [x] Works: echo ok answered\n- [!] Edges: a full cache is not handled\n- [-] Undo: nothing stored\n');
  await until(`document.querySelector('.own-conf .tag')`, 'its confidence shown', 30_000);
  assert.match(await js(`document.querySelector('.own-conf').textContent.replace(/\\s+/g, ' ')`), /Its own confidence: 60% read the code, ran nothing <b>yet<\/b>/);
  assert.ok(await js(`document.querySelector('.own-conf .tag').classList.contains('conf-low')`));
  assert.ok(await js(`document.documentElement.scrollWidth <= window.innerWidth`), 'no sideways scroll');

  // What it left out, and the proof of its checks: its record, and the commands run again here when you ask.
  await until(`document.querySelector('.results .proof-row [data-act="proof-open"]')`, 'the proof row');
  assert.match(await js(`document.querySelector('.results .not-done').textContent.replace(/\\s+/g, ' ')`), /Not done, as the agent says ?eviction when <full>/);
  assert.match(await js(`document.querySelector('.results .proof-row').textContent.replace(/\\s+/g, ' ')`), /Proof 3 recorded runs, 1 by reading Open/);
  assert.match(await js(`document.querySelector('.results .risks').textContent.replace(/\\s+/g, ' ')`), /Risks it named before starting 1 avoided, 1 not checked ?Avoided A stale entry is served: avoided, the expiry test passes ?Not checked The cache grows without <limit>/);
  assert.ok(await js(`document.querySelector('.results .risks').open`), 'open when one was not checked');
  // Its self-review: the same first-principles questions, each answer set against what the app measured.
  assert.match(await js(`document.querySelector('.results .checklist summary').textContent.replace(/\\s+/g, ' ')`), /Self-review 2 hold, 1 no, 1 not applicable, 4 not checked · the app backs 1, contradicts 1/);
  assert.match(await js(`document.querySelector('.results .checklist li.cl-contra').textContent.replace(/\\s+/g, ' ')`), /Holds Asked the cache, as asked ?Contradicted It lists as not done: eviction when <full>/);
  assert.ok(await js(`document.querySelector('.results .checklist').open && document.querySelector('.results .checklist').scrollWidth <= document.querySelector('.results .checklist').clientWidth + 1`), 'open, and fits');
  // Read first: how much this finished work needs reading, why, and the queue in the top bar.
  await until(`document.querySelector('.results .read-first-row .tag')`, 'the review level in its Results');
  assert.match(await js(`document.querySelector('.results .read-first-row').textContent.replace(/\\s+/g, ' ')`), /^Review (Read closely|Look) .* Why$/);
  await js(`document.querySelector('.results [data-act="readfirst-open"]').click()`);
  const rfd = `document.querySelector('#readfirst-dialog')`;
  await until(`${rfd}.open && ${rfd}.querySelectorAll('.rf-item').length === 1`, 'why, for this one');
  const why = await js(`${rfd}.querySelector('.rf-item').textContent.replace(/\\s+/g, ' ')`);
  assert.match(why, /It lists 1 thing as not done: eviction when <full> \+6/);
  assert.match(why, /1 risk it named was not checked: The cache grows without <limit> \+5/);
  assert.match(why, /Its own confidence is 60%: read the code, ran nothing <b>yet<\/b> \+15/);
  assert.match(await js(`${rfd}.querySelector('#readfirst-body > .hint').textContent`), /No model decides it\. "Skim" means nothing measured speaks against it, not that it is correct\./);
  await width(390);
  assert.ok(await js(`${rfd}.getBoundingClientRect().right <= 390 && ${rfd}.scrollWidth <= ${rfd}.clientWidth + 1 && [...${rfd}.querySelectorAll('.rf-item')].every((li) => li.getBoundingClientRect().right <= 390)`), 'the queue fits a phone');
  await width(1600);
  await js(`${rfd}.querySelector('[data-rf="close"]').click()`);
  await js(`document.querySelector('#readfirst-btn').click()`);
  await until(`${rfd}.open && ${rfd}.querySelectorAll('.rf-item').length >= 1 && /Finished work waiting for your review: /.test(${rfd}.textContent)`, 'the whole queue from the top bar');
  // At a glance: this finished agent under To review, with why; a click opens it; it fits a phone.
  await js(`${rfd}.querySelector('[data-rf="close"]').click()`);
  await js(`document.querySelector('#glance-btn').click()`);
  const gld = `document.querySelector('#glance-dialog')`;
  await until(`${gld}.open && ${gld}.querySelector('.gl-review [data-gl-agent="${a.id}"], .gl-item.gl-review[data-gl-agent="${a.id}"]')`, 'this agent under To review');
  assert.match(await js(`${gld}.querySelector('.gl-item[data-gl-agent="${a.id}"] .gl-why').textContent`), /^(Read closely|Look): /);
  assert.match(await js(`${gld}.querySelector('.gl-line').textContent`), /^\d+ agents?: .*\d+ to review/);
  await width(390);
  assert.ok(await js(`${gld}.getBoundingClientRect().right <= 390 && ${gld}.scrollWidth <= ${gld}.clientWidth + 1`), 'the glance fits a phone');
  await width(1600);
  await js(`${gld}.querySelector('.gl-item[data-gl-agent="${a.id}"]').click()`);
  await until(`!${gld}.open`, 'closed on opening the agent');
  await js(`document.querySelector('#readfirst-btn').click()`);
  await until(`${rfd}.open && ${rfd}.querySelectorAll('.rf-item').length >= 1`, 'the queue again');
  // The understanding check, from the queue: questions to answer first, the answer shown, and whether you knew it.
  await js(`${rfd}.querySelector('[data-rf-understand]').click()`);
  const ud = `document.querySelector('#understand-dialog')`;
  await until(`${ud}.open && ${ud}.querySelector('.us-item') || ${ud}.querySelector('.error')`, 'the questions', 30_000);
  const usText = await js(`${ud}.textContent.replace(/\\s+/g, ' ')`);
  assert.ok(/Do you understand it\?/.test(usText), usText.slice(0, 200));
  if (await js(`Boolean(${ud}.querySelector('.us-item'))`)) {
    assert.equal(await js(`${ud}.querySelectorAll('.us-a').length`), 0, 'no answer until asked');
    await js(`${ud}.querySelector('[data-us-show="0"]').click()`);
    await until(`${ud}.querySelector('.us-a')`, 'the answer shown');
    await js(`${ud}.querySelector('[data-us-knew="0"][data-v="false"]').click()`);
    await until(`${ud}.querySelector('.us-item.us-miss') && /Knew 0 of|1 of \\d+ answered/.test(${ud}.textContent)`, 'said you did not know it', 15_000);
  }
  await width(390);
  assert.ok(await js(`${ud}.getBoundingClientRect().right <= 390 && ${ud}.scrollWidth <= ${ud}.clientWidth + 1`), 'the check fits a phone');
  await width(1600);
  await js(`${ud}.querySelector('[data-us="close"]').click()`);
  // Marked as reviewed: it leaves the queue and its Results; brought back for the rest of this test.
  const waitingBefore = await js(`${rfd}.querySelectorAll('.rf-item').length`);
  await js(`${rfd}.querySelector('[data-rf-reviewed="${a.id}"]').click()`);
  await until(`${rfd}.querySelectorAll('.rf-item').length === ${waitingBefore} - 1 && !document.querySelector('.results .read-first-row')`, 'reviewed: out of the queue');
  await api('POST', '/read-first/reviewed', { agent: a.id, reviewed: false });
  await until(`document.querySelector('.results .read-first-row')`, 'back in the queue');
  await js(`${rfd}.querySelector('[data-rf="close"]').click()`);
  // The ways it weighed, preferred first; and Insights with what it is worth now and later, the kind of idea and the paths.
  assert.match(await js(`document.querySelector('.results .vl-options').textContent.replace(/\\s+/g, ' ')`), /Paths it weighed 2, preferred first: Cache in memory ?Preferred Cache in memory one process ?now high ?later low ?cost small ?risk low ?Pick when: one server is enough ?Shared cache a service ?now medium ?later high ?cost large ?risk medium ?Pick when: a second server is planned ?Try this path ?Why the first it ships <now>/);
  await js(`document.querySelector('[data-act="insights"]').click()`);
  await until(`document.querySelector('.insight-wide .insight.paths .vl-paths')`, 'Insights, with the decision cards', 30_000);
  const wideCards = await js(`Object.fromEntries([...document.querySelectorAll('.insight-wide .insight')].map((c) => [c.querySelector('h4').textContent, c.textContent.replace(/\\s+/g, ' ').trim()]))`);
  assert.match(wideCards['⚖️ Value: now and later'], /Now High ?support stops answering this by hand ?Later Medium ?the same check serves two planned features ?Waiting costs about three hours of support a week ?Design for now the gain is sure and near/);
  assert.match(wideCards['💡 Kind of idea'], /Worth a white paper ?New caching by <intent>, not by key ?Next write it up for the platform team/);
  assert.match(wideCards['🧭 Paths, preferred first'], /Preferred Cache in memory one process, no new service ?now high ?later low ?cost small ?risk low ?Pick when: one server is enough ?Shared cache .*Why the first it ships this week and does not block the second/);
  assert.equal(await js(`document.querySelectorAll('.insight-grid:not(.insight-wide) .insight').length`), 4, 'the four quick cards as before');
  // Kept private, by your own word: shown with why and what is held; allowed again; and back.
  assert.equal(await js(`document.querySelector('.kept-private')`), null);
  await js(`document.querySelector('[data-act="idea-keep"]').click()`);
  await until(`document.querySelector('.results .kept-private')`, 'kept private');
  assert.match(await js(`document.querySelector('.results .kept-private').textContent.replace(/\\s+/g, ' ')`), /🔒 Kept private You marked it private\. The app does not publish or send it: .*Publishing before filing can cost the right to a patent; talk to a patent attorney first\. Allow sharing/);
  assert.equal((await api('POST', `/agents/${a.id}/drive`)).error?.startsWith('Publishing to Google Drive is held'), true);
  await js(`document.querySelector('[data-act="idea-allow"]').click()`);
  await until(`!document.querySelector('.kept-private') && document.querySelector('.kept-private-off')`, 'sharing allowed');
  await js(`document.querySelector('[data-act="idea-reset"]').click()`);
  await until(`!document.querySelector('.kept-private-off')`, 'back to what was read');
  // The agent itself says part of its design is new: a card in the inbox until you decide.
  fs.writeFileSync(path.join(briefs, 'BRIEF.md'), fs.readFileSync(path.join(briefs, 'BRIEF.md'), 'utf8').replace('- Preferred: 1, because it ships <now>\n', '- Preferred: 1, because it ships <now>\n- New: eviction by <intent>\n'));
  await until(`document.querySelector('.need.idea')`, 'the card', 30_000);
  const ideaCard = `document.querySelector('.need.idea')`;
  assert.match(await js(`(${ideaCard}).textContent.replace(/\\s+/g, ' ')`), /Possibly patentable.*🔒 The agent says part of its design may be new: eviction by <intent>.*Kept private until you decide.*Keep it private ?Allow sharing/);
  await js(`document.querySelector('.need.idea [data-ib="idea-allow"]').click()`);
  await until(`!document.querySelector('.need.idea') && !document.querySelector('.results .kept-private')`, 'decided: the card is gone');
  await width(390);
  assert.ok(await js(`document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.insight-wide .insight, .vl-options')].every((el) => el.getBoundingClientRect().right <= 390)`), 'the decision cards fit a phone');
  await width(1600);
  await js(`document.querySelector('.results [data-act="proof-open"]').click()`);
  const pd = `document.querySelector('#proof-dialog')`;
  await until(`${pd}.open && ${pd}.querySelectorAll('.proof-list li').length === 4`, 'the proof opens');
  assert.match(await js(`${pd}.textContent.replace(/\\s+/g, ' ')`), /Proof: .*The agent's own record of what it ran\. Its brief ticks 2 checks as passed; 3 have a command and output here\..*Not done, as the agent says ?eviction when <full>.*The cache answers ?echo ok exit 0 ?ok.*Saved the log ?echo hi > log\.txt exit 0 ?Not run again by the app: it writes to a file\..*Read the config ?Verified by reading: Looked at <config>\./);
  assert.equal(await js(`${pd}.querySelector('[data-proof="run"]').textContent`), 'Run these 2 again here');
  await js(`${pd}.querySelector('[data-proof="run"]').click()`);
  await until(`${pd}.querySelectorAll('.proof-list .tag').length === 3`, 'run again', 30_000);
  assert.deepEqual(await js(`[...${pd}.querySelectorAll('.proof-list .tag')].map((t) => t.textContent)`), ['Same result', 'Different result', 'Not run again']);
  assert.match(await js(`${pd}.textContent.replace(/\\s+/g, ' ')`), /Run again: exit 1, and its last recorded line was not printed.*Run again here .*: 1 same, 1 different, 1 not run\./);
  // Test the tests, in the same dialog: its changed lines broken one at a time, its tests run on each.
  const wd = (await api('GET', `/agents/${a.id}`)).workdir;
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: wd, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'start');
  const calc = "export function price(n, member) {\n  if (n <= 0) return 0;\n  const base = n * 5;\n  return member && n >= 10 ? base - 2 : base;\n}\nexport const label = (n) => (n === 1 ? 'item' : 'items');\n";
  fs.writeFileSync(path.join(wd, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(wd, 'calc.js'), calc);
  fs.writeFileSync(path.join(wd, 'calc.test.js'), "import assert from 'node:assert';\nimport { price } from './calc.js';\nassert.equal(price(0), 0);\nassert.equal(price(2), 10);\nassert.equal(price(10, true), 48);\nassert.equal(price(10, false), 50);\n");
  assert.match(await js(`${pd}.querySelector('.breaks-head').textContent`), /Test the tests/);
  assert.equal(await js(`${pd}.querySelector('[data-breaks="command"]').placeholder`), 'echo ok && false', 'the passing commands it recorded, as the default');
  assert.equal(await js(`${pd}.querySelector('button[data-breaks="run"]').textContent`), 'Break the code and run the tests');
  await js(`(() => { const i = ${pd}.querySelector('[data-breaks="command"]'); i.focus(); i.value = 'node calc.test.js'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  // (The stand-in agent prints now and then, which counts as working for a moment: asked again then.)
  for (let i = 0; i < 20 && !(await js(`${pd}.querySelectorAll('.breaks-list li').length`)); i++) {
    await js(`${pd}.querySelector('button[data-breaks="run"]:not([disabled])')?.click()`);
    await sleep(1500);
  }
  await until(`${pd}.querySelectorAll('.breaks-list li').length === 4`, 'the breaks tried', 30_000);
  assert.deepEqual(await js(`[...${pd}.querySelectorAll('.breaks-list .tag')].map((t) => t.textContent)`), ['Caught', 'Caught', 'Caught', 'Not noticed']);
  assert.match(await js(`${pd}.textContent.replace(/\\s+/g, ' ')`), /with node calc\.test\.js: 3 of 4 breaks caught by its tests\..*calc\.js:6 === became !== ?export const label = .*The tests still passed with this line wrong: nothing checks it\./);
  assert.equal(await js(`${pd}.querySelector('[data-breaks="command"]').value`), 'node calc.test.js', 'the command typed is kept');
  assert.equal(fs.readFileSync(path.join(wd, 'calc.js'), 'utf8'), calc, 'the file is as it was');
  assert.equal(await js(`${pd}.querySelector('button[data-breaks="send"]').textContent`), 'Tell the agent');
  await js(`${pd}.querySelector('button[data-breaks="send"]').click()`);
  await until(`${pd}.querySelector('button[data-breaks="send"]')?.textContent === 'Tell the agent again'`, 'sent to the agent');
  assert.match(await js(`${pd}.textContent.replace(/\\s+/g, ' ')`), /The ones not noticed were sent to the agent/);
  await width(390);
  assert.ok(await js(`[...${pd}.querySelectorAll('.breaks-list li, .breaks-cmd input')].every((li) => li.getBoundingClientRect().right <= 390)`), 'the breaks fit a phone');
  assert.ok(await js(`${pd}.getBoundingClientRect().right <= 390 && ${pd}.scrollWidth <= ${pd}.clientWidth + 1 && [...${pd}.querySelectorAll('.proof-list li')].every((li) => li.getBoundingClientRect().right <= 390)`), 'the proof fits a phone');
  await width(1600);
  await js(`${pd}.querySelector('[data-proof="close"]').click()`);
  await until(`/1 different when run again/.test(document.querySelector('.results .proof-row .tag')?.textContent ?? '')`, 'the result beside the results');
  await until(`/Tests tested 3 of 4 breaks caught/.test(document.querySelector('.results')?.textContent.replace(/\\s+/g, ' ') ?? '')`, 'the breaks beside the results');
  assert.ok(!fs.existsSync(path.join((await api('GET', `/agents/${a.id}`)).workdir, 'log.txt')), 'the command that writes a file was not run');

  // A question it stops on is answered for you: a card in the inbox, seen with OK, and on its record.
  await api('PUT', '/judge', { enabled: true });
  try {
    const [w] = await api('POST', '/agents', { intents: ['Add a cache #waiting'], autonomy: 'run', acceptance: false });
    await js(`document.querySelector('[data-tab="inbox"]').click()`);
    const card = `document.querySelector('#inbox-view [data-need^="auto:${w.id}:"]')`;
    await until(card, 'answered for you, in the inbox', 90_000);
    assert.match(await js(`${card}.textContent.replace(/\\s+/g, ' ')`), /Done for you.*Which database should I use\? Answered for you: SQLite From: routine detail, cheap to change; ground rules read · Claude Code opus, 90% sure/);
    await width(390);
    assert.ok(await js(`${card}.getBoundingClientRect().right <= 390 && document.documentElement.scrollWidth <= window.innerWidth`), 'the card fits a phone');
    await width(1600);
    await js(`${card}.querySelector('[data-ib="auto-ok"]').click()`);
    await until(`!${card}`, 'seen: out of the inbox');
    await js(`document.querySelector('[data-tab="agents"]').click()`);
    await js(`document.querySelector('#agent-list li[data-id="${w.id}"]').click()`);
    await until(`/1 answered/.test(${row}?.textContent ?? '')`, 'on the agent: 1 answered');
    await js(`${row}.querySelector('[data-act="auto-open"]').click()`);
    await until(`${dlg}.open && ${dlg}.querySelector('.auto-log li')`, 'its record');
    assert.match(await js(`${dlg}.querySelector('.auto-log li').textContent.replace(/\\s+/g, ' ')`), /Answered .*Which database should I use\? → SQLite From: routine detail.*Change answer…/);
    assert.equal(await js(`Boolean(${dlg}.querySelector('.auto-log [data-auto="ok"]'))`), false, 'already seen');
    await js(`${dlg}.querySelector('[data-auto="close"]').click()`);
    await api('DELETE', `/agents/${w.id}`).catch(() => {});
  } finally {
    await api('PUT', '/judge', { enabled: false });
  }

  await api('PUT', '/ground-rules', { text: '' });
  await api('PUT', '/autonomy', { models: 'fable, opus, sonnet' });
  await api('DELETE', `/agents/${a.id}`).catch(() => {});
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Drop to start: a ticket, requirements and a design dropped on the page open New agents filled in; files attach; the form takes more', { skip }, async () => {
  // What a drag from another window carries: links as a uri-list and as text, or files.
  const drag = (type, target, { uris = '', text = '', file = null } = {}) =>
    js(`(() => {
      const dt = new DataTransfer();
      if (${JSON.stringify(uris)}) dt.setData('text/uri-list', ${JSON.stringify(uris)});
      if (${JSON.stringify(text)}) dt.setData('text/plain', ${JSON.stringify(text)});
      if (${JSON.stringify(file)}) dt.items.add(new File(['# PRD\\nFast checkout'], ${JSON.stringify(file)}, { type: 'text/markdown' }));
      const ev = new DragEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, dataTransfer: dt });
      document.querySelector(${JSON.stringify(target)}).dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`);
  const overlay = `document.querySelector('#drop-overlay')`;
  const form = `document.querySelector('#new-form')`;
  const ticket = 'https://acme.atlassian.net/browse/SHOP-142';
  const links = `${ticket}\nhttps://docs.google.com/document/d/1abc/edit\nhttps://www.figma.com/file/abc/Checkout`;
  await js(`document.querySelector('[data-tab="agents"]').click()`);
  assert.equal(await js(`${overlay}.hidden`), true);

  // Dragging over the page: the frame says what a drop does. Dropping opens the form, filled in.
  assert.equal(await drag('dragover', 'main, body', { uris: links, text: links }), true, 'the page takes it');
  assert.equal(await js(`${overlay}.hidden`), false);
  assert.match(await js(`${overlay}.textContent.replace(/\\s+/g, ' ')`), /Drop to start a new agent ?Tickets, requirements, designs, screenshots or files/);
  assert.equal(await js(`getComputedStyle(${overlay}).pointerEvents`), 'none', 'what is under it still gets the drop');
  await drag('drop', 'main, body', { uris: links, text: links });
  await until(`document.querySelector('#new-dialog').open`, 'New agents opened');
  assert.equal(await js(`${overlay}.hidden`), true);
  assert.equal(await js(`${form}.intents.value`), `${ticket}\n\nContext:\n- Requirements: https://docs.google.com/document/d/1abc/edit\n- Design: https://www.figma.com/file/abc/Checkout`);
  assert.equal(await js(`${form}.split.value`), 'one', 'one agent for the ticket and its context');
  assert.match(await js(`document.querySelector('#new-drop .drop-added').textContent`), /^Added: 1 ticket, 1 requirements link, 1 design\. Check the request below, then start\.$/);
  assert.ok(await js(`document.querySelector('#new-drop').classList.contains('filled')`));
  assert.match(await js(`document.querySelector('#new-dialog button[type=submit]').textContent`), /^Create agent$/);

  // On the open form: a repository link fills the repository, a file attaches, and the page frame stays away.
  assert.equal(await drag('dragover', '#new-drop', { uris: 'https://github.com/acme/web' }), true);
  assert.ok(await js(`document.querySelector('#new-drop').classList.contains('over')`), 'the box lights up');
  assert.equal(await js(`${overlay}.hidden`), true, 'a dialog is open: no page frame');
  await drag('drop', '#new-drop', { uris: 'https://github.com/acme/web' });
  assert.equal(await js(`${form}.repo.value`), 'https://github.com/acme/web.git');
  assert.ok(!(await js(`document.querySelector('#new-drop').classList.contains('over')`)));
  assert.equal(await js(`${form}.intents.value.split('\\n')[0]`), ticket, 'the request is left as it was');
  await drag('drop', '#new-drop', { file: 'prd.md' });
  await until(`/prd\\.md/.test(document.querySelector('#new-attach .attach-chips').textContent) && !/uploading/.test(document.querySelector('#new-attach .attach-chips').textContent)`, 'the file attached');
  assert.match(await js(`document.querySelector('#new-drop .drop-added').textContent`), /^Added: 1 file\./);
  // Text moved inside the page (a drag that started here) is left alone.
  await js(`document.dispatchEvent(new DragEvent('dragstart', { bubbles: true }))`);
  assert.equal(await drag('dragover', '#new-drop', { text: 'moved text' }), false);
  await js(`document.dispatchEvent(new DragEvent('dragend', { bubbles: true }))`);
  // On a phone the box fits, and offers to choose files.
  await width(390);
  assert.ok(await js(`(() => { const d = document.querySelector('#new-dialog').getBoundingClientRect(); return d.right <= 390 && [...document.querySelectorAll('#new-form > *')].every((el) => el.getBoundingClientRect().right <= d.right); })()`), 'fits a phone: nothing in the form is cut off');
  assert.ok(await js(`Boolean(document.querySelector('#new-drop [data-drop-act="pick"]'))`));
  await width(1600);

  // Opened again: empty, nothing "added".
  await js(`(() => { ${form}.intents.value = ''; ${form}.repo.value = ''; document.querySelector('#new-attach [data-drop]')?.click(); document.querySelector('#new-dialog').close(); })()`);
  await js(`document.querySelector('#new-btn').click()`);
  assert.equal(await js(`document.querySelector('#new-drop .drop-added').textContent`), '');
  assert.ok(!(await js(`document.querySelector('#new-drop').classList.contains('filled')`)));
  // Several tickets: one agent each.
  await drag('drop', '#new-drop', { text: 'https://acme.atlassian.net/browse/SHOP-1 https://acme.atlassian.net/browse/SHOP-2' });
  assert.equal(await js(`${form}.split.value`), 'lines');
  assert.match(await js(`document.querySelector('#new-dialog button[type=submit]').textContent`), /^Create 2 agents$/);
  await js(`(() => { ${form}.intents.value = ''; document.querySelector('#new-dialog').close(); })()`);
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('Acceptance: what done means waits in the inbox, the points changed and agreed, then each one with what the check found', { skip }, async () => {
  const repo = path.join(home, 'accept-repo');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo });
  g('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), '# x\n');
  g('add', '.');
  g('commit', '-q', '-m', 'first');
  // Asked for in New agent.
  await js(`document.querySelector('#new-btn')?.click()`);
  assert.match(await js(`document.querySelector('#new-dialog input[name="acceptance"]').closest('label').textContent.replace(/\\s+/g, ' ')`), /Agree on what done means first/);
  assert.equal(await js(`document.querySelector('#new-dialog input[name="acceptance"]').checked`), false, 'off unless asked for');
  await js(`document.querySelector('#new-dialog').close()`);

  const [a] = await api('POST', '/agents', { intents: ['Add a CSV export'], dir: repo, acceptance: true });
  const row = `document.querySelector('.acc-row')`;
  await js(`document.querySelector('[data-tab="agents"]').click()`);
  await until(`document.querySelector('#agent-list li[data-id="${a.id}"]')`, 'the agent listed');
  await js(`document.querySelector('#agent-list li[data-id="${a.id}"]').click()`);
  await until(`${row} && /being written/.test(${row}.textContent)`, 'its points are being written');
  assert.equal(await js(`${row}.querySelector('[data-act="accept-open"]').disabled`), true);

  // The agent writes its spec: a card in the inbox with the points.
  const briefs = path.join(home, 'briefs', a.id);
  fs.mkdirSync(briefs, { recursive: true });
  fs.writeFileSync(path.join(briefs, 'SPEC.md'), '# Spec: export\n## Acceptance criteria\n- GET /export.csv answers 200\n- The first row is the header\n- It is fast <b>enough</b>\n');
  const card = `document.querySelector('#inbox-view [data-need="acceptance:${a.id}"]')`;
  await js(`document.querySelector('[data-tab="inbox"]').click()`);
  await until(card, 'its card in the inbox', 30_000);
  assert.match(await js(`${card}.textContent.replace(/\\s+/g, ' ')`), /Done means.*What done means: 3 points.*GET \/export\.csv answers 200.*The first row is the header.*It is fast <b>enough<\/b>.*The agent changes nothing until you agree/);

  // Change points: reword one, take one out, add one of your own; what is typed survives the page's updates.
  await js(`${card}.querySelector('[data-ib="accept-open"]').click()`);
  const dlg = `document.querySelector('#accept-dialog')`;
  await until(`${dlg}.open && ${dlg}.querySelectorAll('[data-acc-point]').length === 3`, 'the points, to edit');
  assert.match(await js(`${dlg}.querySelector('#acc-title').textContent`), /^What done means: /);
  assert.match(await js(`${dlg}.querySelector('#acc-body .hint').textContent`), /changes nothing until you agree/);
  await js(`(() => { const t = ${dlg}.querySelector('[data-acc-point="1"]'); t.value = 'The first row is the header, in table order #notmet'; })()`);
  await js(`${dlg}.querySelector('[data-acc-remove="2"]').click()`);
  await js(`${dlg}.querySelector('[data-acc="add"]').click()`);
  assert.equal(await js(`document.activeElement === ${dlg}.querySelector('[data-acc-point="2"]')`), true, 'the new point has the cursor');
  await js(`(() => { ${dlg}.querySelector('[data-acc-point="2"]').value = 'Dates are ISO 8601'; })()`);
  await api('PATCH', `/agents/${a.id}`, { priority: 'P1' });
  await sleep(400);
  assert.deepEqual(await js(`[...${dlg}.querySelectorAll('[data-acc-point]')].map((t) => t.value)`), ['GET /export.csv answers 200', 'The first row is the header, in table order #notmet', 'Dates are ISO 8601'], 'not written over');
  assert.match(await js(`${dlg}.querySelector('[data-acc="agree"]').textContent`), /^Agree and start$/);
  await js(`${dlg}.querySelector('[data-acc="agree"]').click()`);
  await until(`${dlg}.querySelectorAll('.acc-list li').length === 3`, 'agreed: the points, not checked yet');
  assert.match(await js(`${dlg}.querySelector('#acc-body').textContent.replace(/\\s+/g, ' ')`), /Agreed .* Not checked yet: the work is scored against these when the agent says it is done\..*Not checked yet GET \/export\.csv answers 200.*table order #notmet \(yours\).*Dates are ISO 8601 \(yours\)/);
  const got = (await api('GET', `/agents/${a.id}`)).acceptance;
  assert.deepEqual(got.points.map((p) => p.from), ['agent', 'you', 'you']);
  await until(`!${card}`, 'out of the inbox');

  // Checked: each point with what was found and why; the one not met is plain to see, also on the agent.
  fs.writeFileSync(path.join(repo, 'export.js'), 'export const csv = () => "a,b\\n";\n');
  await js(`${dlg}.querySelector('[data-acc="check"]').click()`);
  await until(`${dlg}.querySelector('.acc-chip.acc-not_met')`, 'checked', 30_000);
  assert.deepEqual(await js(`[...${dlg}.querySelectorAll('.acc-list li .acc-chip')].map((c) => c.textContent)`), ['Met', 'Not met', 'Met']);
  assert.match(await js(`${dlg}.querySelector('.acc-list li:nth-child(2) .acc-evidence').textContent`), /seen in H1/);
  assert.match(await js(`${dlg}.querySelector('#acc-body .hint').textContent`), /^Agreed .*\. Checked /);
  assert.equal(await js(`${dlg}.querySelector('[data-acc="check"]').textContent`), 'Check again');
  assert.ok(await js(`document.documentElement.scrollWidth <= window.innerWidth`), 'no sideways scroll');
  // On a phone: the dialog fits.
  await width(390);
  assert.ok(await js(`${dlg}.getBoundingClientRect().width <= 390 && ${dlg}.scrollWidth <= ${dlg}.clientWidth + 1`), 'fits a phone');
  await width(1600);

  // Change the points afterwards: back to editing, and cancel leaves them.
  await js(`${dlg}.querySelector('[data-acc="edit"]').click()`);
  await until(`${dlg}.querySelectorAll('[data-acc-point]').length === 3`, 'editing the agreed points');
  assert.match(await js(`${dlg}.querySelector('[data-acc="agree"]').textContent`), /^Agree on these$/);
  await js(`${dlg}.querySelector('[data-acc="cancel"]').click()`);
  await until(`${dlg}.querySelectorAll('.acc-list li').length === 3`, 'back to the results');
  await js(`${dlg}.querySelector('[data-acc="close"]').click()`);
  await js(`document.querySelector('[data-tab="agents"]').click()`);
  await js(`document.querySelector('#agent-list li[data-id="${a.id}"]').click()`);
  await until(`${row} && /2 of 3 met, 1 not met/.test(${row}.textContent)`, 'on the agent: 2 of 3 met');
  assert.ok(await js(`${row}.querySelector('.tag').classList.contains('acc-bad')`));
  await api('DELETE', `/agents/${a.id}`).catch(() => {});
  assert.deepEqual(errors, [], 'no errors on the page');
});

test('1.72 on a phone: Why on a review line, Try this path, the guess, and Glance with Your calibration and Night watch', { skip }, async () => {
  const repo = path.join(home, 'r172');
  fs.mkdirSync(repo, { recursive: true });
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# cart\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'init');

  // The guess, in New agent: given with it, kept on it.
  await js(`document.querySelector('#new-btn')?.click()`);
  await until(`document.querySelector('#new-dialog').open`, 'New agent');
  assert.deepEqual(await js(`[...document.querySelectorAll('#new-dialog .guess-row select')].map((s) => s.name)`), ['guessFinish', 'guessHours', 'guessReview']);
  await js(`document.querySelector('#new-dialog').close()`);
  const [a] = await api('POST', '/agents', { intents: ['Fix the cart total'], dir: repo, worktree: true, guess: { finish: 'yes', hours: 2, review: 'look' } });
  assert.deepEqual([a.guess.finish, a.guess.hours, a.guess.review], ['yes', 2, 'look']);
  let ra;
  for (let i = 0; i < 100 && !(ra = await api('GET', `/agents/${a.id}`)).workdir; i++) await sleep(200);
  for (let i = 0; i < 100 && (await api('GET', `/agents/${a.id}`)).status !== 'running'; i++) await sleep(200);
  ra = await api('GET', `/agents/${a.id}`);
  // Its change, and the edit that wrote it in its conversation.
  fs.writeFileSync(path.join(ra.workdir, 'cart.js'), 'export const total = (xs) =>\n  xs.reduce((n, x) => n + x.cents, 0);\n');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  const { transcriptPath } = await import('../src/tracker.js');
  const file = transcriptPath(ra.workdir, ra.sessionId);
  process.env.CLAUDE_CONFIG_DIR = prev;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = new Date().toISOString();
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user', timestamp: at, message: { content: 'Sum the cart in <cents>' } })}\n${JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: 'Cents avoid rounding.' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: path.join(ra.workdir, 'cart.js'), content: 'export const total = (xs) =>\n  xs.reduce((n, x) => n + x.cents, 0);\n' } }] } })}\n`);

  await js(`document.querySelector('[data-tab="agents"]').click()`);
  await until(`document.querySelector('#agent-list li[data-id="${a.id}"]')`, 'listed');
  await js(`document.querySelector('#agent-list li[data-id="${a.id}"]').click()`);
  await until(`document.querySelector('[data-act="changes"]:not([disabled])')`, 'Review changes');
  await js(`document.querySelector('[data-act="changes"]').click()`);
  const rv = `document.querySelector('#review-dialog')`;
  await until(`${rv}.open && ${rv}.querySelector('tr.rv-add .rv-why')`, 'an added line with its ?', 20_000);
  await width(390);
  await js(`${rv}.querySelector('tr.rv-add:nth-of-type(2) .rv-why, tr.rv-add .rv-why').click()`);
  await until(`${rv}.querySelector('.rv-why-body') || ${rv}.querySelector('.rv-why-row .hint:not(:empty)')?.textContent.includes('No edit')`, 'why it is there', 15_000);
  const why = await js(`${rv}.querySelector('.rv-why-row').textContent.replace(/\\s+/g, ' ')`);
  assert.match(why, /Why is this line here\? Written by Write.* What it was asked ?Sum the cart in <cents> What it said just before ?Cents avoid rounding\./);
  assert.ok(await js(`${rv}.querySelector('.rv-why-row').getBoundingClientRect().right <= 390 + 1 && document.documentElement.scrollWidth <= 390`), 'fits a phone');
  await js(`${rv}.querySelector('[data-rv-why-close]').click()`);
  await until(`!${rv}.querySelector('.rv-why-row')`, 'closed');
  await width(1600);
  await js(`${rv}.close()`);

  // Try this path: on the path it did not take, starting a race.
  const briefs = path.join(home, 'briefs', a.id);
  for (let i = 0; i < 50 && !fs.existsSync(path.join(briefs, 'BRIEF.md')); i++) await sleep(200);
  await sleep(300);
  fs.writeFileSync(path.join(briefs, 'BRIEF.md'), 'Status: working\n## Problem\nx\n## Options\n1. Sum in cents: one pass | now: high | later: medium | cost: small | risk: low | when: always\n2. Money type: a class | now: low | later: high | cost: medium | risk: medium | when: more currencies\n- Preferred: 1, because it is small\n## Results\nOutcome: in progress\n');
  await until(`document.querySelector('.results [data-act="try-path"][data-path="2"]')`, 'Try this path on path 2', 20_000);
  assert.equal(await js(`document.querySelectorAll('.results [data-act="try-path"]').length`), 1, 'not on the path it takes');
  await js(`document.querySelector('.results [data-act="try-path"]').click()`);
  await until(`document.querySelector('#race-dialog').open`, 'the race opens');
  await until(`document.querySelector('.results [data-act="try-path-open"]')`, 'being tried, by whom');
  const race = (await api('GET', `/agents/${a.id}`)).raceId;
  const other = (await api('GET', `/races/${race}`)).rows.find((r) => r.id !== a.id);
  await js(`document.querySelector('#race-dialog').close()`);

  // Glance on a phone: your calibration, and night watch turned on and off.
  await width(390);
  await js(`document.querySelector('#glance-btn').click()`);
  const gl = `document.querySelector('#glance-dialog')`;
  await until(`${gl}.open && ${gl}.querySelector('.gl-line')`, 'the glance');
  await js(`${gl}.querySelector('[data-gl="calibration"]').click()`);
  await until(`${gl}.querySelector('.cal-lines')`, 'your calibration');
  assert.match(await js(`${gl}.querySelector('.cal-lines').textContent`), /No guess has settled yet|Whether it finishes/);
  assert.ok(await js(`${gl}.scrollWidth <= ${gl}.clientWidth + 1 && ${gl}.getBoundingClientRect().right <= 390`), 'calibration fits a phone');
  await js(`${gl}.querySelector('[data-gl-back]').click()`);
  await until(`${gl}.querySelector('.gl-line')`, 'back to the glance');
  await js(`${gl}.querySelector('[data-gl="night"]').click()`);
  await until(`${gl}.querySelector('[data-nw="enabled"]')`, 'night watch');
  assert.equal(await js(`${gl}.querySelector('[data-nw="enabled"]').checked`), false, 'off until turned on');
  await js(`(() => { const c = ${gl}.querySelector('[data-nw="enabled"]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  // The box is ticked at once; the setting is saved when the page's request reaches the daemon.
  for (let i = 0; i < 30 && !(await api('GET', '/night-watch')).settings.enabled; i++) await sleep(100);
  assert.equal((await api('GET', '/night-watch')).settings.enabled, true);
  await js(`(() => { const s = ${gl}.querySelector('[data-nw="hour"]'); s.value = '5'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  for (let i = 0; i < 30 && (await api('GET', '/night-watch')).settings.hour !== 5; i++) await sleep(100);
  assert.equal((await api('GET', '/night-watch')).settings.hour, 5);
  await js(`${gl}.querySelector('[data-nw="run"]').click()`);
  await until(`/Last run/.test(${gl}.textContent)`, 'run now', 20_000);
  assert.ok(await js(`${gl}.scrollWidth <= ${gl}.clientWidth + 1 && ${gl}.getBoundingClientRect().right <= 390`), 'night watch fits a phone');
  await api('PUT', '/night-watch', { enabled: false });
  await js(`${gl}.querySelector('[data-gl="close"]').click()`);
  await width(1600);

  await api('DELETE', `/races/${race}`).catch(() => {});
  for (const id of [other.id, a.id]) await api('DELETE', `/agents/${id}?deleteWorkspace=1`).catch(() => {});
  assert.deepEqual(errors, [], 'no errors on the page');
});
