// Screen: this computer's screen, shown and controlled from the page (a pop-up to answer, another
// program to watch), from the phone too. It does not capture the screen itself: the computer's own
// screen sharing does (macOS: System Settings → General → Sharing → Screen Sharing; elsewhere any
// VNC server on this computer), and asks for its own sign-in. This relays that connection to
// signed-in pages: bytes in, bytes out, to a port on this computer only.
//
// Whoever uses it controls the whole computer, so it is off until turned on, and only from the
// computer itself.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';

export const SCREEN_DEFAULTS = { enabled: false, port: 5900 };
const HOST = '127.0.0.1'; // never another computer: this is not a way into the network
const MAX_VIEWERS = 4;
const QUIET_MS = 60_000; // a stream whose page went away without closing it

const CLIP_MAX = 200_000; // characters of text to and from the clipboard

const fail = (status, message) => Object.assign(new Error(message), { status });

export function screenSettings(config) {
  const d = { ...SCREEN_DEFAULTS, ...(config.screen ?? {}) };
  const port = Number(d.port);
  return { enabled: d.enabled === true, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : SCREEN_DEFAULTS.port };
}

/** Whether something listens on the port (the screen sharing service is on). */
export function listening(port, ms = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const out = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 3000 }, (err, stdout) => resolve(err ? null : String(stdout).trim())));
const KICKSTART = '/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart';

/**
 * A Mac with Remote Management on (instead of plain Screen Sharing) lets in only the users listed
 * there, and refuses everyone else as if the password were wrong. Whether this computer's user is
 * let in: `{ user, allowed, fix }`, or null where that does not apply.
 */
export async function macAccess() {
  if (process.platform !== 'darwin' || !fs.existsSync('/Library/Application Support/Apple/Remote Desktop/RemoteManagement.launchd')) return null;
  const user = os.userInfo().username;
  const everyone = (await out('/usr/bin/defaults', ['read', '/Library/Preferences/com.apple.RemoteManagement', 'ARD_AllLocalUsers'])) === '1';
  const listed = /naprivs:\s*-?\d/.test((await out('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'naprivs'])) ?? '');
  return { user, allowed: everyone || listed, fix: `sudo ${KICKSTART} -configure -users ${user} -access -on -privs -ControlObserve` };
}

/** Run a program with `input` on its standard input; what it prints. */
const pipe = (cmd, args, input = null) =>
  new Promise((resolve, reject) => {
    // UTF-8 whatever the daemon was started with: pbcopy and pbpaste go by the locale.
    const child = spawn(cmd, args, { env: { ...process.env, LC_CTYPE: 'UTF-8' }, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
    const chunks = [];
    const timer = setTimeout(() => child.kill(), 4000);
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', (err) => reject(fail(501, err.code === 'ENOENT' ? `${cmd} is not on this computer` : err.message)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(fail(500, `${cmd} failed`));
    });
    if (input !== null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });

/**
 * This computer's clipboard, as text: `read()` and `write(text)`. Asked of the computer itself and
 * not of its screen sharing, which on a Mac shares the clipboard only with Apple's own viewer.
 */
export function systemClipboard(platform = process.platform) {
  // A file in its place, for the tests: they must not take over the clipboard of whoever runs them.
  const file = process.env.AGENTMGR_CLIPBOARD_FILE;
  if (file) return { read: async () => fs.promises.readFile(file, 'utf8').catch(() => ''), write: (text) => fs.promises.writeFile(file, text) };
  if (platform === 'darwin') return { read: () => pipe('/usr/bin/pbpaste', []), write: (text) => pipe('/usr/bin/pbcopy', [], text) };
  const wayland = Boolean(process.env.WAYLAND_DISPLAY);
  return {
    read: () => (wayland ? pipe('wl-paste', ['--no-newline']) : pipe('xclip', ['-selection', 'clipboard', '-o'])),
    write: (text) => (wayland ? pipe('wl-copy', [], text) : pipe('xclip', ['-selection', 'clipboard', '-i'], text)),
  };
}

export class Screen {
  /** `onChange(viewers)` is called when someone connects or leaves. `mac` and `clip` stand in for macAccess and the clipboard in tests. */
  constructor({ config, onChange = () => {}, log = () => {}, mac = macAccess, clip = systemClipboard() }) {
    this.mac = mac;
    this.clip = clip;
    this.config = config;
    this.onChange = onChange;
    this.log = log;
    this.links = new Map(); // id -> { socket, who, since, last, timer }
  }

  get settings() {
    return screenSettings(this.config);
  }

  viewers() {
    return [...this.links.values()].map((l) => ({ who: l.who, since: l.since }));
  }

  async status() {
    const s = this.settings;
    const [on, mac] = await Promise.all([listening(s.port), s.enabled ? this.mac() : null]);
    return { ...s, platform: process.platform, listening: on, mac, viewers: this.viewers() };
  }

  /** From the computer itself only (the route is local-only). Turning it off ends every viewer. */
  change(b = {}) {
    const next = { ...this.settings };
    if ('enabled' in b) next.enabled = b.enabled === true || b.enabled === 'on';
    if ('port' in b) {
      const port = Number(b.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail(400, 'port is a number from 1 to 65535');
      next.port = port;
    }
    this.config.screen = next;
    if (!next.enabled) for (const id of [...this.links.keys()]) this.close(id, 'Screen access was turned off');
    return next;
  }

  /**
   * The computer's clipboard goes with its screen: whoever may use the one may read and set the
   * other, and nobody may while screen access is off.
   */
  async clipboard() {
    if (!this.settings.enabled) throw fail(403, 'Screen access is off. Turn it on on the computer itself: the Screen button.');
    const text = await this.clip.read();
    return { text: text.slice(0, CLIP_MAX), cut: text.length > CLIP_MAX };
  }

  async setClipboard(text) {
    if (!this.settings.enabled) throw fail(403, 'Screen access is off. Turn it on on the computer itself: the Screen button.');
    if (typeof text !== 'string') throw fail(400, 'text is required');
    if (text.length > CLIP_MAX) throw fail(413, `That is more than the ${CLIP_MAX / 1000}k characters the clipboard takes from here`);
    await this.clip.write(text);
    return { ok: true, length: text.length };
  }

  /**
   * A connection to the screen sharing service for one page. `sink.data(buffer)` gets what it
   * sends, `sink.end(reason)` is called once when it is over. Returns the link's id.
   */
  open(sink, who = 'this computer') {
    const s = this.settings;
    if (!s.enabled) throw fail(403, 'Screen access is off. Turn it on on the computer itself: the Screen button.');
    if (this.links.size >= MAX_VIEWERS) throw fail(429, `${MAX_VIEWERS} devices are viewing the screen already`);
    const id = crypto.randomBytes(12).toString('hex');
    const socket = net.connect({ host: HOST, port: s.port });
    socket.setNoDelay(true);
    const link = { socket, sink, who, since: new Date().toISOString(), last: Date.now(), timer: null, ended: false };
    this.links.set(id, link);
    socket.on('data', (buf) => sink.data(buf));
    socket.on('error', (err) => this.close(id, err.code === 'ECONNREFUSED' ? 'Screen sharing is not on on this computer' : err.message));
    socket.on('close', () => this.close(id, 'The screen sharing service closed the connection'));
    this.log(`screen: ${who} connected`);
    this.onChange(this.viewers());
    return id;
  }

  /** A link fed by POSTs (the phone): it ends when its page stops sending and listening. */
  watch(id, alive) {
    const link = this.links.get(id);
    if (!link) return;
    link.timer = setInterval(() => !alive() && Date.now() - link.last > QUIET_MS && this.close(id, 'The page went away'), 15_000);
    link.timer.unref?.();
  }

  write(id, buf) {
    const link = this.links.get(id);
    if (!link) throw fail(410, 'This screen connection has ended');
    link.last = Date.now();
    link.socket.write(buf);
  }

  close(id, reason = 'Closed') {
    const link = this.links.get(id);
    if (!link || link.ended) return;
    link.ended = true;
    this.links.delete(id);
    clearInterval(link.timer);
    link.socket.destroy();
    try {
      link.sink.end(reason);
    } catch {}
    this.log(`screen: ${link.who} left (${reason})`);
    this.onChange(this.viewers());
  }

  closeAll(reason) {
    for (const id of [...this.links.keys()]) this.close(id, reason);
  }
}
