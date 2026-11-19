// Screen: this computer's screen in the page, to answer a pop-up or watch another program, from
// the phone too. The computer's own screen sharing draws it and asks for its own sign-in (macOS:
// your Mac user name and password); the daemon relays the connection (src/screen.js) and noVNC
// shows it. Off until turned on, on the computer itself.
import { REMOTE, post } from '/transport.js';

const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * What noVNC needs of a WebSocket, over a stream out and POSTs in: the phone has no WebSocket to
 * the daemon (transport.js). What is sent goes strictly in order, one request at a time.
 */
export class StreamChannel {
  constructor() {
    this.binaryType = 'arraybuffer';
    this.protocol = '';
    this.readyState = 'connecting';
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this.id = null;
    this.queue = [];
    this.sending = false;
    this.es = new EventSource('/api/screen/stream');
    this.es.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'open') {
        this.id = msg.id;
        this.readyState = 'open';
        this.onopen?.();
      } else if (msg.t === 'd') this.onmessage?.({ data: unb64(msg.d).buffer });
      else if (msg.t === 'end') this.finish(msg.reason);
    };
    // The stream does not come back by itself: a new one would be a new connection to the screen.
    this.es.onerror = () => this.finish(this.id ? 'The connection was lost' : 'Screen access is off, or you are signed out');
  }

  send(data) {
    if (this.readyState !== 'open') return;
    this.queue.push(new Uint8Array(data).slice()); // noVNC reuses its buffer
    this.pump();
  }

  async pump() {
    if (this.sending) return;
    this.sending = true;
    while (this.queue.length && this.readyState === 'open') {
      const all = new Uint8Array(this.queue.reduce((n, q) => n + q.length, 0));
      let at = 0;
      for (const q of this.queue.splice(0)) {
        all.set(q, at);
        at += q.length;
      }
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok && this.readyState === 'open'; attempt++) {
        try {
          const res = await post('/api/screen/input', { id: this.id, d: b64(all) });
          if (res.ok) ok = true;
          else if (res.status >= 400 && res.status < 500) break; // ended or signed out: a retry won't change it
        } catch {
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
        }
      }
      // A gap in what the screen sharing service receives can't be repaired: end it.
      if (!ok) this.finish('The connection was lost');
    }
    this.sending = false;
  }

  finish(reason) {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.es.close();
    this.onclose?.({ code: 1000, reason, wasClean: true });
  }

  close() {
    this.finish('Closed');
  }
}

// Keys a phone's keyboard does not have (X11 keysyms).
const KEYS = { esc: 0xff1b, tab: 0xff09, enter: 0xff0d, back: 0xff08, up: 0xff52, down: 0xff54, left: 0xff51, right: 0xff53 };
const keysymOf = (ch) => {
  const cp = ch.codePointAt(0);
  if (ch === '\n') return KEYS.enter;
  return cp < 0x100 ? cp : 0x01000000 + cp;
};

// Shortcuts for the bar's Keys list. On a Mac the screen sharing service takes Super as Command
// and Alt as Option.
const MOD = { cmd: 0xffeb, ctrl: 0xffe3, alt: 0xffe9, shift: 0xffe1 };
const key = (ch) => ch.codePointAt(0);
const COMBOS = (mac) => {
  const m = mac ? 'cmd' : 'ctrl';
  const sign = mac ? '⌘' : 'Ctrl+';
  return [
    ...(mac ? [['⌘Space · Spotlight', ['cmd'], 0x20], ['⌘Tab · switch app', ['cmd'], KEYS.tab], ['⌘` · next window', ['cmd'], key('`')]] : [['Alt+Tab · switch window', ['alt'], KEYS.tab]]),
    [`${sign}C · copy`, [m], key('c')],
    [`${sign}V · paste`, [m], key('v')],
    [`${sign}X · cut`, [m], key('x')],
    [`${sign}A · select all`, [m], key('a')],
    [`${sign}Z · undo`, [m], key('z')],
    [`${sign}S · save`, [m], key('s')],
    [`${sign}W · close window`, [m], key('w')],
    ...(mac ? [['⌘Q · quit app', ['cmd'], key('q')], ['⌥⌘Esc · force quit', ['alt', 'cmd'], KEYS.esc]] : [['Alt+F4 · close', ['alt'], 0xffc1]]),
    ['↑', [], KEYS.up],
    ['↓', [], KEYS.down],
    ['←', [], KEYS.left],
    ['→', [], KEYS.right],
    ['⌫ · delete', [], KEYS.back],
    ['Space', [], 0x20],
  ];
};

export function initScreen({ api, esc, toast, $ }) {
  const dialog = $('#screen-dialog');
  const body = $('#screen-body');
  const view = $('#screen-view');
  const state = $('#screen-state');
  let status = null;
  let awake = null; // whether the computer is kept from sleeping (src/awake.js)
  let rfb = null;
  let ended = null; // why the last connection ended
  // While a mouse button is down noVNC lays a sheet over the page to follow the mouse, and takes
  // it away when the button comes up on that sheet. Under this dialog the sheet never gets that,
  // and would stay over the page after the dialog closes, taking the next click. Taken away here.
  let release = () => {};

  const remote = () => document.body.classList.contains('remote');

  // Zoom: the screen is drawn larger than the dialog and scrolled. A finger on it clicks in the
  // computer, so moving around is its own mode (Move), which puts a sheet over the screen.
  const ZOOMS = [1, 1.5, 2, 3, 4];
  let zoom = 1;
  let moving = false;
  let stage = null;
  function layout(keep = true) {
    if (!stage) return;
    const cx = keep && view.scrollWidth ? (view.scrollLeft + view.clientWidth / 2) / view.scrollWidth : 0.5;
    const cy = keep && view.scrollHeight ? (view.scrollTop + view.clientHeight / 2) / view.scrollHeight : 0.5;
    if (zoom === 1 || pad) moving = false;
    view.classList.toggle('zoomed', zoom > 1);
    // The outer size: scrollbars that take room must not make the screen smaller than the zoom says.
    const w = view.offsetWidth;
    const h = view.offsetHeight;
    stage.style.width = `${Math.round(w * zoom)}px`;
    stage.style.height = `${Math.round(h * zoom)}px`;
    view.scrollLeft = cx * w * zoom - w / 2;
    view.scrollTop = cy * h * zoom - h / 2;
    stage.querySelector('.screen-pan').hidden = !moving;
    $('#screen-zoom-now').textContent = zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`;
    const move = $('#screen-move');
    move.hidden = zoom === 1 || pad; // as a trackpad the screen follows the pointer
    move.setAttribute('aria-pressed', String(moving));
    move.classList.toggle('on', moving);
    const sheet = stage.querySelector('.screen-pad');
    sheet.hidden = !pad;
    stage.querySelector('.screen-pointer').hidden = !pad;
    const padBtn = $('#screen-pad');
    padBtn.setAttribute('aria-pressed', String(pad));
    padBtn.classList.toggle('on', pad);
    if (pad) point(false);
  }
  function setZoom(step) {
    const at = ZOOMS.indexOf(zoom);
    zoom = step === 0 ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, at + step))];
    layout();
  }
  new ResizeObserver(() => layout()).observe(view);

  // Trackpad: a fingertip covers the button it aims at, so the screen can be a trackpad instead.
  // A drag anywhere moves a pointer drawn here (slowly for a slow finger), a tap clicks where it
  // is, two fingers scroll or, tapped, right-click, and a finger held down first drags.
  let pad = false;
  try {
    pad = localStorage.getItem('screen-pad') === '1';
  } catch {}
  let at = null; // the pointer, in the computer's screen pixels
  /** Where the pointer is: in the drawn screen (what noVNC counts in), in the stage and in the page. */
  function spot() {
    const c = stage?.querySelector('canvas');
    if (!c?.width || !rfb?._handleMouseMove) return null;
    at ??= { x: c.width / 2, y: c.height / 2 };
    at.x = Math.max(0, Math.min(c.width - 1, at.x));
    at.y = Math.max(0, Math.min(c.height - 1, at.y));
    const r = c.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    // The middle of the pixel, so that it is the same pixel again when noVNC counts back.
    const x = ((Math.floor(at.x) + 0.5) / c.width) * r.width;
    const y = ((Math.floor(at.y) + 0.5) / c.height) * r.height;
    return { x, y, left: r.left - s.left + x, top: r.top - s.top + y, pageX: r.left + x, pageY: r.top + y, per: c.width / (r.width || 1) };
  }
  /** Draw the pointer where it is, keep it in view when zoomed in, and tell the computer. */
  function point(send = true) {
    const p = spot();
    if (!p) return null;
    const arrow = stage.querySelector('.screen-pointer');
    arrow.style.left = `${p.left}px`;
    arrow.style.top = `${p.top}px`;
    const edge = 36;
    if (p.left < view.scrollLeft + edge) view.scrollLeft = p.left - edge;
    else if (p.left > view.scrollLeft + view.clientWidth - edge) view.scrollLeft = p.left - view.clientWidth + edge;
    if (p.top < view.scrollTop + edge) view.scrollTop = p.top - edge;
    else if (p.top > view.scrollTop + view.clientHeight - edge) view.scrollTop = p.top - view.clientHeight + edge;
    if (send) rfb._handleMouseMove(p.x, p.y);
    return p;
  }
  /** The ring that shows the page took a tap. */
  function ring(x, y) {
    const el = document.createElement('div');
    el.className = 'screen-tap';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    dialog.append(el);
    setTimeout(() => el.remove(), 450);
  }
  /** The trackpad's gestures, on the sheet that covers the screen while it is on. */
  function trackpad(sheet, mine) {
    const HOLD = 450; // ms a finger rests before it holds the button down
    const STEP = 28; // px two fingers move for one notch of the wheel
    let g = null; // the gesture under way
    const mid = (ts) => ({ x: [...ts].reduce((n, t) => n + t.clientX, 0) / ts.length, y: [...ts].reduce((n, t) => n + t.clientY, 0) / ts.length });
    const button = (mask) => {
      const p = rfb === mine && spot();
      if (p) mine._handleMouseButton(p.x, p.y, mask);
      return p;
    };
    const down = () => (g?.held ? 0x1 : 0);
    const arrow = () => stage?.querySelector('.screen-pointer');
    sheet.addEventListener('touchstart', (e) => {
      e.preventDefault(); // no focus change (the phone's keyboard stays open) and no made-up mouse
      const m = mid(e.touches);
      if (!g) {
        g = { fingers: 0, moved: false, held: false, far: 0, sx: 0, sy: 0, since: e.timeStamp, timer: null };
        g.timer = setTimeout(() => {
          if (!g || g.moved || g.fingers !== 1 || !button(0x1)) return;
          g.held = true;
          arrow()?.classList.add('held');
        }, HOLD);
      }
      g.fingers = Math.max(g.fingers, e.touches.length);
      if (e.touches.length > 1) clearTimeout(g.timer);
      Object.assign(g, { x: m.x, y: m.y, last: e.timeStamp });
    }, { passive: false });
    sheet.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (!g) return;
      const m = mid(e.touches);
      const dx = m.x - g.x;
      const dy = m.y - g.y;
      const ms = Math.max(1, e.timeStamp - g.last);
      Object.assign(g, { x: m.x, y: m.y, last: e.timeStamp });
      g.far += Math.hypot(dx, dy);
      // A finger is never quite still: only past this is it a move, not a tap.
      if (!g.moved && g.far < 8 && !g.held) return;
      g.moved = true;
      if (!g.held) clearTimeout(g.timer);
      if (e.touches.length > 1) {
        // As on the phone itself: what is under the fingers goes where they go.
        g.sx += dx;
        g.sy += dy;
        for (const [axis, back, on] of [['sy', 0x8, 0x10], ['sx', 0x20, 0x40]]) {
          while (Math.abs(g[axis]) >= STEP) {
            const notch = g[axis] > 0 ? back : on;
            g[axis] -= Math.sign(g[axis]) * STEP;
            button(down() | notch);
            button(down());
          }
        }
        return;
      }
      const p = spot();
      if (!p) return;
      // A slow finger moves the pointer less than its own way, for small targets; a quick one crosses the screen.
      const gain = p.per * Math.max(0.35, Math.min(2.5, 0.35 + 1.5 * (Math.hypot(dx, dy) / ms)));
      at.x += dx * gain;
      at.y += dy * gain;
      point();
    }, { passive: false });
    const end = (e) => {
      e.preventDefault();
      if (!g) return;
      if (e.touches.length) {
        // One finger of several lifted: the rest carry on from where they are.
        const m = mid(e.touches);
        Object.assign(g, { x: m.x, y: m.y, last: e.timeStamp });
        return;
      }
      const was = g;
      g = null;
      clearTimeout(was.timer);
      if (was.held) {
        button(0);
        arrow()?.classList.remove('held');
      } else if (!was.moved && e.type === 'touchend' && e.timeStamp - was.since < HOLD) {
        // Press and release apart, as a hand on a mouse: a Mac does not take them in one instant.
        const p = button(was.fingers > 1 ? 0x4 : 0x1);
        if (p) ring(p.pageX, p.pageY);
        setTimeout(() => button(0), 100);
      }
    };
    sheet.addEventListener('touchend', end, { passive: false });
    sheet.addEventListener('touchcancel', end, { passive: false });
  }
  function setPad(on) {
    pad = on;
    try {
      localStorage.setItem('screen-pad', on ? '1' : '0');
    } catch {}
    layout();
    if (on) {
      point();
      toast('Trackpad: drag to move the pointer, tap to click. Two fingers scroll, or tapped, right-click. Hold, then drag, to drag.', 7000);
    }
  }
  // The button is for fingers: it shows once the page has been touched.
  const showPad = () => ($('#screen-pad').hidden = false);
  if (navigator.maxTouchPoints > 0 || pad) showPad(); // on already: there must be a way to turn it off
  else dialog.addEventListener('touchstart', showPad, { once: true, passive: true, capture: true });
  const others = (v = status?.viewers ?? []) => v.filter((x) => x.who !== 'this computer');

  /** The dot on the button: someone on another device is looking at this computer's screen. */
  function showViewers(viewers) {
    if (status) status.viewers = viewers;
    const far = others(viewers);
    $('#screen-dot').hidden = !far.length;
    $('#screen-btn').title = far.length ? `Screen: viewed now from ${far.map((x) => x.who).join(', ')}` : "This computer's screen, to answer a pop-up or watch another program, from any device you're signed in on";
    if (dialog.open && !rfb) render();
  }

  /** A Mac with Remote Management on refuses a user it does not list, whatever the password. */
  function notListed() {
    const m = status?.mac;
    if (!m || m.allowed) return '';
    return `<div class="screen-note"><p><b>This Mac will refuse ${esc(m.user)}, even with the right password.</b> It has Remote Management on, which lets in only the users listed there, and ${esc(m.user)} is not one of them.</p>
      <p>On the Mac: <b>System Settings → General → Sharing → Remote Management → ⓘ</b>, add your user with Observe and Control. Or in a terminal on it (the Terminal button here will do):</p>
      <p><code>${esc(m.fix)}</code></p></div>`;
  }

  /** A sleeping computer shows nothing and runs nothing: it can be kept awake, from here too. */
  function keepAwake() {
    if (!awake?.supported) return '';
    const opt = (v, label) => `<option value="${v}"${awake.mode === v ? ' selected' : ''}>${label}</option>`;
    return `<p class="screen-awake"><label>Keep this computer awake <select data-screen-awake>${opt('off', 'No')}${opt('working', 'While an agent works')}${opt('always', 'Always')}</select></label>
      <span class="hint">${awake.mode === 'off' ? 'Asleep, it cannot be reached from here and its agents stop.' : 'It will not go to sleep by itself. The display may still sleep and lock; a closed lid still puts a laptop to sleep.'}</span></p>`;
  }

  function render() {
    const s = status;
    const connected = Boolean(rfb);
    view.hidden = !connected;
    body.hidden = connected;
    $('#screen-keys').hidden = !connected;
    if (!connected) showClip(false);
    $('#screen-off').hidden = remote() || !s?.enabled;
    if (connected || !s) return;
    const far = others();
    const viewed = far.length ? `<p class="hint">Viewed now from ${far.map((x) => esc(x.who)).join(', ')}.</p>` : '';
    if (!s.enabled) {
      state.textContent = 'Off';
      body.innerHTML = `<h3>This computer's screen, here and on your phone</h3>
        <p>See the whole screen and click or type in it: a pop-up that needs an answer, another program you want to watch.</p>
        <p class="hint">Whoever uses this controls the whole computer, not only the agents. It is off until you turn it on, and it can only be turned on here, on the computer itself. The computer's own screen sharing still asks for its sign-in every time.</p>
        ${remote() ? '<p><b>Off.</b> Turn it on on the computer: the Screen button, or <code>agentmgr screen --on</code>.</p>' : '<p><button class="primary" data-screen="on">Turn on</button></p>'}${keepAwake()}`;
      return;
    }
    if (!s.listening) {
      state.textContent = 'Screen sharing is off';
      body.innerHTML = `<h3>Turn on screen sharing on this computer</h3>
        ${s.platform === 'darwin' ? '<p>On the Mac: <b>System Settings → General → Sharing → Screen Sharing</b>, on. Leave "Allow access for" on your own user.</p>' : `<p>Start a VNC server on this computer that listens on port ${s.port} of 127.0.0.1 only.</p>`}
        <p class="hint">AI Agent Manager does not capture the screen itself: it relays the computer's own screen sharing (port ${s.port}) to pages that are signed in.</p>
        <p><button class="primary" data-screen="check">Check again</button></p>${viewed}`;
      return;
    }
    state.textContent = ended ? 'Ended' : 'Ready';
    body.innerHTML = `${ended ? `<p><b>Ended:</b> ${esc(ended)}</p>` : '<h3>Ready</h3>'}${notListed()}
      <p class="hint">${s.platform === 'darwin' ? 'The Mac asks for your Mac user name and password next. They go to the Mac and are not kept.' : 'The computer asks for its screen sharing password next. It is not kept.'}</p>
      <p><button class="primary" data-screen="connect">${ended ? 'Connect again' : 'Connect'}</button></p>${viewed}${keepAwake()}`;
  }

  async function refresh() {
    awake = await api('GET', '/awake').catch(() => null);
    try {
      status = await api('GET', '/screen');
    } catch (err) {
      status = null;
      body.hidden = false;
      body.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
    showViewers(status?.viewers ?? []);
    render();
  }

  function drop(reason) {
    const was = rfb;
    rfb = null;
    ended = reason;
    release();
    try {
      was?.disconnect();
    } catch {}
    view.replaceChildren();
    if (dialog.open) refresh();
  }

  /** The sign-in the screen sharing service asks for: on a Mac, user name and password. */
  function askCredentials(types) {
    view.hidden = true;
    body.hidden = false;
    state.textContent = 'Sign in';
    const mac = status?.platform === 'darwin';
    body.innerHTML = `<form id="screen-login" class="screen-login" autocomplete="off">
        <h3>${mac ? 'Sign in to this Mac' : 'Screen sharing password'}</h3>
        ${types.includes('username') ? `<label>${mac ? 'Mac user name' : 'User name'} <input name="username" autocapitalize="none" autocorrect="off" spellcheck="false" required /></label>` : ''}
        ${types.includes('password') ? '<label>Password <input name="password" type="password" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" required /></label><label class="screen-show"><input type="checkbox" data-screen-show /> Show the password</label>' : ''}
        <p class="hint">Sent to the computer's screen sharing and not kept anywhere.</p>
        <p><button class="primary" type="submit">Sign in</button> <button type="button" class="ghost" data-screen="cancel">Cancel</button></p>
      </form>`;
    body.querySelector('input')?.focus();
  }

  async function connect() {
    ended = null;
    state.textContent = 'Connecting…';
    body.innerHTML = '<p class="hint">Connecting to this computer\'s screen…</p>';
    let RFB;
    try {
      ({ default: RFB } = await import('/vendor/novnc/core/rfb.js'));
      ({ releaseCapture: release } = await import('/vendor/novnc/core/util/events.js'));
    } catch (err) {
      return drop(`The viewer could not be loaded (${err.message})`);
    }
    stage = document.createElement('div');
    stage.className = 'screen-stage';
    stage.innerHTML = '<div class="screen-pan" hidden></div><div class="screen-pad" hidden></div><div class="screen-pointer" hidden></div>';
    view.replaceChildren(stage);
    zoom = 1;
    at = null;
    const mine = new RFB(stage, REMOTE ? new StreamChannel() : `ws://${location.host}/ws/screen`);
    rfb = mine;
    mine.scaleViewport = true;
    // A finger: the screen must not take the focus from Type here, or the phone's keyboard closes
    // at every tap. With it open you tap a field on the computer and type, as in a terminal here.
    // A tap is sent by noVNC as move, press and release in the same instant, which a Mac does not
    // take as a click. Spaced out as a hand on a mouse would, with a ring where the tap landed so
    // you can see the page took it.
    const tap = mine._handleTapEvent?.bind(mine);
    const button = mine._handleMouseButton;
    if (tap && button) {
      mine._handleTapEvent = (ev, bmask) => {
        const calls = [];
        mine._handleMouseButton = (...args) => calls.push(args);
        try {
          tap(ev, bmask);
        } finally {
          mine._handleMouseButton = button;
        }
        calls.forEach((args, i) => setTimeout(() => rfb === mine && button.apply(mine, args), 50 + i * 100));
        ring(ev.detail.clientX, ev.detail.clientY);
      };
    }
    trackpad(stage.querySelector('.screen-pad'), mine);
    stage.addEventListener('mouseup', () => setTimeout(release), true); // after noVNC has had it
    // A mouse still gives the screen the focus, for the computer's own keyboard.
    let touched = 0;
    stage.addEventListener('touchstart', () => {
      touched = Date.now();
      mine.focusOnClick = false;
    }, { capture: true, passive: true });
    stage.addEventListener('mousedown', () => {
      if (Date.now() - touched > 1000) mine.focusOnClick = true;
    }, { capture: true });
    mine.background = '#0f1117';
    mine.addEventListener('credentialsrequired', (e) => rfb === mine && askCredentials(e.detail?.types ?? ['password']));
    mine.addEventListener('securityfailure', (e) => rfb === mine && drop(e.detail?.reason ? `Sign-in refused: ${e.detail.reason}` : 'Sign-in refused: check the user name and password'));
    mine.addEventListener('connect', () => {
      if (rfb !== mine) return;
      state.textContent = 'Connected';
      combos = COMBOS(status?.platform === 'darwin');
      combo.innerHTML = '<option value="">Keys…</option>' + combos.map(([label], i) => `<option value="${i}">${esc(label)}</option>`).join('');
      render();
      layout(false);
      mine.focus();
    });
    mine.addEventListener('disconnect', (e) => rfb === mine && drop(e.detail?.clean ? 'The connection was closed' : 'The connection was lost, or screen access is off'));
    mine.addEventListener('desktopname', (e) => rfb === mine && e.detail?.name && ($('#screen-name').textContent = e.detail.name));
    render();
    // Until the screen arrives the page shows why it waits.
    view.hidden = true;
    body.hidden = false;
  }

  dialog.addEventListener('submit', (e) => {
    if (e.target.id !== 'screen-login') return;
    e.preventDefault();
    const f = e.target;
    const creds = {};
    if (f.username) creds.username = f.username.value;
    if (f.password) creds.password = f.password.value;
    state.textContent = 'Signing in…';
    body.innerHTML = '<p class="hint">Signing in…</p>';
    rfb?.sendCredentials(creds);
  });

  // Typed blind on a phone, a password goes wrong easily: let it be seen.
  dialog.addEventListener('change', async (e) => {
    if (e.target.matches('[data-screen-show]')) e.target.form.password.type = e.target.checked ? 'text' : 'password';
    if (e.target.matches('[data-screen-awake]')) {
      try {
        awake = await api('PUT', '/awake', { mode: e.target.value });
        toast(awake.mode === 'off' ? 'This computer may go to sleep by itself again' : awake.mode === 'always' ? 'This computer is kept awake' : 'This computer is kept awake while an agent works');
      } catch (err) {
        toast(`Error: ${err.message}`, 6000);
      }
      if (!rfb) render();
    }
  });

  // The computer's clipboard. Its screen sharing does not share it with a browser (a Mac's only
  // with Apple's own viewer), so the daemon reads and sets it: text typed or pasted here goes
  // there, and what was copied there comes here.
  const clipText = $('#screen-clip-text');
  function showClip(on) {
    $('#screen-clip').hidden = !on;
    $('#screen-clip-btn').setAttribute('aria-pressed', String(on));
    $('#screen-clip-btn').classList.toggle('on', on);
    if (on) clipText.focus();
  }
  async function clip(what) {
    if (what === 'clip-get') {
      const got = await api('GET', '/screen/clipboard');
      clipText.value = got.text;
      clipText.select();
      if (!got.text) return toast("The computer's clipboard has no text");
      // The page may put it on this device's clipboard only where the browser lets it.
      const here = await navigator.clipboard?.writeText(got.text).then(() => true, () => false);
      return toast(`${got.cut ? 'The first part of what' : 'What'} was copied on the computer${here ? ' is on this device\'s clipboard now' : ': copy it from the box'}`);
    }
    const text = clipText.value;
    if (!text) return toast('Type or paste the text first');
    await api('PUT', '/screen/clipboard', { text });
    if (what === 'clip-paste' && rfb) {
      const mod = MOD[status?.platform === 'darwin' ? 'cmd' : 'ctrl'];
      rfb.sendKey(mod, null, true);
      rfb.sendKey(key('v'), null);
      rfb.sendKey(mod, null, false);
      clipText.value = '';
      return toast('Pasted on the computer');
    }
    toast("On the computer's clipboard");
  }

  dialog.addEventListener('click', async (e) => {
    const key = e.target.closest('[data-screen-key]');
    if (key && rfb) return rfb.sendKey(KEYS[key.dataset.screenKey], null);
    const z = e.target.closest('[data-screen-zoom]');
    if (z) return setZoom(Number(z.dataset.screenZoom));
    const b = e.target.closest('[data-screen]');
    if (!b) return;
    const what = b.dataset.screen;
    try {
      if (what === 'on' || what === 'off') {
        status = await api('PUT', '/screen/settings', { enabled: what === 'on' });
        if (what === 'off') drop(null);
        toast(what === 'on' ? 'Screen access on: signed-in devices can reach this computer\'s screen' : 'Screen access off');
        ended = null;
        render();
      } else if (what === 'check') await refresh();
      else if (what === 'connect') await connect();
      else if (what === 'move') {
        moving = !moving;
        layout();
      } else if (what === 'pad') setPad(!pad);
      else if (what === 'clip') showClip($('#screen-clip').hidden);
      else if (what.startsWith('clip-')) await clip(what); else if (what === 'cancel') drop('You cancelled the sign-in');
      else if (what === 'close') dialog.close();
    } catch (err) {
      toast(`Error: ${err.message}`, 6000);
    }
  });

  // Shortcuts and keys a phone's keyboard does not have: held in order, released in reverse.
  let combos = [];
  const combo = $('#screen-combo');
  combo.addEventListener('change', () => {
    const picked = combos[combo.value];
    combo.value = '';
    if (!picked || !rfb) return;
    const [, mods, sym] = picked;
    for (const m of mods) rfb.sendKey(MOD[m], null, true);
    rfb.sendKey(sym, null);
    for (const m of [...mods].reverse()) rfb.sendKey(MOD[m], null, false);
  });

  // A phone has no keyboard until a field is focused: what is typed here is sent key by key.
  const typed = $('#screen-type');
  typed.addEventListener('input', () => {
    if (rfb) for (const ch of typed.value) rfb.sendKey(keysymOf(ch), null);
    typed.value = '';
  });
  let keyAt = 0; // when a key below was last sent, so it is not sent twice
  typed.addEventListener('keydown', (e) => {
    const k = { Enter: 'enter', Backspace: 'back', Tab: 'tab', Escape: 'esc' }[e.key];
    if (!k || !rfb) return;
    e.preventDefault();
    e.stopPropagation();
    keyAt = Date.now();
    rfb.sendKey(KEYS[k], null);
  });
  // A phone's keyboard does not always say which key it was in keydown: Return and delete also
  // arrive as what they would do to the field.
  typed.addEventListener('beforeinput', (e) => {
    const k = { insertLineBreak: 'enter', insertParagraph: 'enter', deleteContentBackward: 'back' }[e.inputType];
    if (!k || !rfb) return;
    e.preventDefault();
    if (Date.now() - keyAt > 80) rfb.sendKey(KEYS[k], null);
  });

  // The phone's keyboard covers the lower half of the page: while it is up, the dialog is the part
  // above it, so the whole screen stays in view.
  const vv = window.visualViewport;
  function aboveKeyboard() {
    const up = dialog.open && vv && innerHeight - vv.height > 120;
    dialog.style.height = up ? `${Math.round(vv.height)}px` : '';
    dialog.style.top = up ? `${Math.round(vv.offsetTop)}px` : '';
    dialog.style.bottom = up ? 'auto' : '';
  }
  vv?.addEventListener('resize', aboveKeyboard);
  vv?.addEventListener('scroll', aboveKeyboard);

  // Esc belongs to the screen while it is shown, not to the dialog.
  dialog.addEventListener('cancel', (e) => rfb && e.preventDefault());
  dialog.addEventListener('close', () => {
    const was = rfb;
    rfb = null;
    ended = null;
    release();
    try {
      was?.disconnect();
    } catch {}
    view.replaceChildren();
  });

  $('#screen-btn').onclick = async () => {
    $('#screen-name').textContent = '';
    if (!dialog.open) dialog.showModal();
    await refresh();
  };

  // The dot is right from the start, not only after someone connects.
  api('GET', '/screen').then((s) => showViewers(s.viewers)).catch(() => {});

  return { viewers: showViewers };
}
