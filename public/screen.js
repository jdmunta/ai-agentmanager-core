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

export function initScreen({ api, esc, toast, $ }) {
  const dialog = $('#screen-dialog');
  const body = $('#screen-body');
  const view = $('#screen-view');
  const state = $('#screen-state');
  let status = null;
  let rfb = null;
  let ended = null; // why the last connection ended

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
    if (zoom === 1) moving = false;
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
    move.hidden = zoom === 1;
    move.setAttribute('aria-pressed', String(moving));
    move.classList.toggle('on', moving);
  }
  function setZoom(step) {
    const at = ZOOMS.indexOf(zoom);
    zoom = step === 0 ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, at + step))];
    layout();
  }
  new ResizeObserver(() => layout()).observe(view);
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

  function render() {
    const s = status;
    const connected = Boolean(rfb);
    view.hidden = !connected;
    body.hidden = connected;
    $('#screen-keys').hidden = !connected;
    $('#screen-off').hidden = remote() || !s?.enabled;
    if (connected || !s) return;
    const far = others();
    const viewed = far.length ? `<p class="hint">Viewed now from ${far.map((x) => esc(x.who)).join(', ')}.</p>` : '';
    if (!s.enabled) {
      state.textContent = 'Off';
      body.innerHTML = `<h3>This computer's screen, here and on your phone</h3>
        <p>See the whole screen and click or type in it: a pop-up that needs an answer, another program you want to watch.</p>
        <p class="hint">Whoever uses this controls the whole computer, not only the agents. It is off until you turn it on, and it can only be turned on here, on the computer itself. The computer's own screen sharing still asks for its sign-in every time.</p>
        ${remote() ? '<p><b>Off.</b> Turn it on on the computer: the Screen button, or <code>agentmgr screen --on</code>.</p>' : '<p><button class="primary" data-screen="on">Turn on</button></p>'}`;
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
      <p><button class="primary" data-screen="connect">${ended ? 'Connect again' : 'Connect'}</button></p>${viewed}`;
  }

  async function refresh() {
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
    } catch (err) {
      return drop(`The viewer could not be loaded (${err.message})`);
    }
    stage = document.createElement('div');
    stage.className = 'screen-stage';
    stage.innerHTML = '<div class="screen-pan" hidden></div>';
    view.replaceChildren(stage);
    zoom = 1;
    const mine = new RFB(stage, REMOTE ? new StreamChannel() : `ws://${location.host}/ws/screen`);
    rfb = mine;
    mine.scaleViewport = true;
    mine.background = '#0f1117';
    mine.addEventListener('credentialsrequired', (e) => rfb === mine && askCredentials(e.detail?.types ?? ['password']));
    mine.addEventListener('securityfailure', (e) => rfb === mine && drop(e.detail?.reason ? `Sign-in refused: ${e.detail.reason}` : 'Sign-in refused: check the user name and password'));
    mine.addEventListener('connect', () => {
      if (rfb !== mine) return;
      state.textContent = 'Connected';
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
  dialog.addEventListener('change', (e) => {
    if (e.target.matches('[data-screen-show]')) e.target.form.password.type = e.target.checked ? 'text' : 'password';
  });

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
      } else if (what === 'cancel') drop('You cancelled the sign-in');
      else if (what === 'close') dialog.close();
    } catch (err) {
      toast(`Error: ${err.message}`, 6000);
    }
  });

  // A phone has no keyboard until a field is focused: what is typed here is sent key by key.
  const typed = $('#screen-type');
  typed.addEventListener('input', () => {
    if (rfb) for (const ch of typed.value) rfb.sendKey(keysymOf(ch), null);
    typed.value = '';
  });
  typed.addEventListener('keydown', (e) => {
    const k = { Enter: 'enter', Backspace: 'back', Tab: 'tab', Escape: 'esc' }[e.key];
    if (!k || !rfb) return;
    e.preventDefault();
    e.stopPropagation();
    rfb.sendKey(KEYS[k], null);
  });

  // Esc belongs to the screen while it is shown, not to the dialog.
  dialog.addEventListener('cancel', (e) => rfb && e.preventDefault());
  dialog.addEventListener('close', () => {
    const was = rfb;
    rfb = null;
    ended = null;
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
