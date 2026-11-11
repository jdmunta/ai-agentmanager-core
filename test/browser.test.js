// The page itself, in headless Chrome, against a daemon of its own (test/fake-claude.js as the
// engine): the top bar fits the window, and the split screen splits, loads, types, resizes and
// remembers. Skipped when no Chrome-family browser is installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

let home, daemon, chrome, ws, base;
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
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claudeBin: process.execPath, claudeArgs: [path.join(here, 'fake-claude.js')], updates: { check: false }, judge: { enabled: false }, shell: '/bin/sh' }));
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
    assert.equal(r.inRow + r.inMore, 14, `${w}px: every view button is in the row or in More`);
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
