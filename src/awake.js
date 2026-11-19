// Awake: a sleeping computer runs no agents and cannot be reached from the phone. While this is
// on, the computer is kept from going to sleep by itself: always, or only while an agent works.
// The display may still sleep and lock, and closing a laptop's lid still puts it to sleep.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export const AWAKE_MODES = ['off', 'working', 'always'];
const GRACE_MS = 5 * 60_000; // after the last agent stops working: its next turn is often minutes away

const fail = (status, message) => Object.assign(new Error(message), { status });

export const awakeSettings = (config) => ({ mode: AWAKE_MODES.includes(config.awake?.mode) ? config.awake.mode : 'off' });

/** What keeps this computer awake for as long as it runs, and ends with this process: [command, args], or null. */
export function keeper(platform = process.platform, exists = fs.existsSync) {
  // -i: no idle sleep. -w: until this process is gone, so nothing is left behind.
  if (platform === 'darwin' && exists('/usr/bin/caffeinate')) return ['/usr/bin/caffeinate', ['-i', '-w', String(process.pid)]];
  const inhibit = ['/usr/bin/systemd-inhibit', '/bin/systemd-inhibit'].find((p) => exists(p));
  if (platform === 'linux' && inhibit) return [inhibit, ['--what=idle:sleep', '--who=AI Agent Manager', '--why=Agents are working, or the computer is reached from a phone', 'tail', '--pid', String(process.pid), '-f', '/dev/null']];
  return null;
}

export class Awake {
  /** `working()` says whether an agent is working now. `run` and `how` stand in for the system's in tests. */
  constructor({ config, working = () => false, how = keeper(), run = (cmd, args) => spawn(cmd, args, { stdio: 'ignore' }), now = () => Date.now(), log = () => {}, timer = true }) {
    Object.assign(this, { config, working, how, run, now, log });
    this.child = null;
    this.workedAt = 0;
    if (timer) {
      this.timer = setInterval(() => this.tick(), 20_000);
      this.timer.unref();
    }
    this.tick();
  }

  get settings() {
    return awakeSettings(this.config);
  }

  status() {
    return { ...this.settings, supported: Boolean(this.how), holding: Boolean(this.child) };
  }

  change(b = {}) {
    if (!AWAKE_MODES.includes(b.mode)) throw fail(400, `mode is one of: ${AWAKE_MODES.join(', ')}`);
    if (b.mode !== 'off' && !this.how) throw fail(400, 'This computer has nothing here to keep it awake with (macOS: caffeinate; Linux: systemd-inhibit)');
    this.config.awake = { mode: b.mode };
    this.tick();
    return this.config.awake;
  }

  /** Hold the computer awake, or let go, as the mode and the agents say. */
  tick() {
    const { mode } = this.settings;
    if (mode === 'working' && this.working()) this.workedAt = this.now();
    const want = Boolean(this.how) && (mode === 'always' || (mode === 'working' && this.workedAt > 0 && this.now() - this.workedAt < GRACE_MS));
    if (want && !this.child) {
      const child = this.run(...this.how);
      this.child = child;
      child.on?.('error', () => this.child === child && (this.child = null));
      child.on?.('exit', () => this.child === child && (this.child = null));
      this.log('awake: keeping this computer from sleeping');
    } else if (!want && this.child) this.stop();
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill();
    } catch {}
    this.log('awake: the computer may sleep again');
  }
}
