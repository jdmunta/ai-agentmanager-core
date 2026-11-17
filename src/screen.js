// Screen: this computer's screen, shown and controlled from the page (a pop-up to answer, another
// program to watch), from the phone too. It does not capture the screen itself: the computer's own
// screen sharing does (macOS: System Settings → General → Sharing → Screen Sharing; elsewhere any
// VNC server on this computer), and asks for its own sign-in. This relays that connection to
// signed-in pages: bytes in, bytes out, to a port on this computer only.
//
// Whoever uses it controls the whole computer, so it is off until turned on, and only from the
// computer itself.
import net from 'node:net';
import crypto from 'node:crypto';

export const SCREEN_DEFAULTS = { enabled: false, port: 5900 };
const HOST = '127.0.0.1'; // never another computer: this is not a way into the network
const MAX_VIEWERS = 4;
const QUIET_MS = 60_000; // a stream whose page went away without closing it

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

export class Screen {
  /** `onChange(viewers)` is called when someone connects or leaves. */
  constructor({ config, onChange = () => {}, log = () => {} }) {
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
    return { ...s, platform: process.platform, listening: await listening(s.port), viewers: this.viewers() };
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
