// OS: the computer the agents run on, and how loaded it is right now. The basics (name, system,
// processor, memory, disks, uptime), the load (processor, load average, memory, swap) with the last
// ten minutes of it, what each open agent session takes (its whole process tree), and the busiest
// processes. Read from the system itself with `ps` and the like; nothing is sent anywhere.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SAMPLE_MS = 5000;
const KEEP = 120; // ten minutes of samples
const run = (cmd, args, timeout = 4000) =>
  new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (e, out) => resolve(e ? '' : String(out))));
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/** Processor time so far, summed over the cores: { busy, total } in ms. */
export function cpuTimes(cpus = os.cpus()) {
  let busy = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    const all = t.user + t.nice + t.sys + t.irq + t.idle;
    total += all;
    busy += all - t.idle;
  }
  return { busy, total };
}

/** `vm_stat` (macOS) as bytes: what is free or can be freed at once, and what is compressed. */
export function parseVmStat(text) {
  const page = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
  const n = (name) => Number(text.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * page;
  if (!/^Pages free:/m.test(text)) return null;
  return {
    available: n('Pages free') + n('Pages inactive') + n('Pages purgeable') + n('Pages speculative'),
    wired: n('Pages wired down'),
    compressed: n('Pages occupied by compressor'),
  };
}

/** `/proc/meminfo` (Linux) as bytes. */
export function parseMeminfo(text) {
  const n = (name) => {
    const m = text.match(new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = n('MemTotal');
  if (total === null) return null;
  const swapTotal = n('SwapTotal') ?? 0;
  return { total, available: n('MemAvailable') ?? (n('MemFree') ?? 0) + (n('Buffers') ?? 0) + (n('Cached') ?? 0), swap: { total: swapTotal, used: swapTotal - (n('SwapFree') ?? 0) } };
}

/** `sysctl -n vm.swapusage` (macOS): "total = 2048.00M  used = 1024.50M  free = …". */
export function parseSwapUsage(text) {
  const n = (name) => {
    const m = text.match(new RegExp(`${name} = ([\\d.]+)([KMG])`));
    return m ? Math.round(Number(m[1]) * { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2]]) : null;
  };
  const total = n('total');
  return total === null ? null : { total, used: n('used') ?? 0 };
}

/** `ps -Ao pid=,ppid=,pcpu=,rss=,comm=` as [{ pid, ppid, cpu (% of one core), mem (bytes), name, command }]. */
export function parsePs(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    const command = m[5];
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3].replace(',', '.')) || 0, mem: Number(m[4]) * 1024, name: command.startsWith('/') ? path.basename(command) : command, command });
  }
  return out;
}

/** What a process and everything under it takes: { cpu, mem, count }. */
export function treeUsage(procs, rootPid) {
  const kids = new Map();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const root = procs.find((p) => p.pid === rootPid);
  if (!root) return null;
  let cpu = 0;
  let mem = 0;
  let count = 0;
  const seen = new Set();
  for (const todo = [root]; todo.length; ) {
    const p = todo.pop();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    cpu += p.cpu;
    mem += p.mem;
    count++;
    todo.push(...(kids.get(p.pid) ?? []));
  }
  return { cpu: Math.round(cpu * 10) / 10, mem, count };
}

/** How busy a computer is, in a word: load per core and memory in use decide it. */
export function loadLevel({ cpuPercent = 0, load1 = 0, cores = 1, memPercent = 0 } = {}) {
  const perCore = load1 / Math.max(1, cores);
  if (cpuPercent >= 90 || perCore >= 1.5 || memPercent >= 92) return 'heavy';
  if (cpuPercent >= 60 || perCore >= 0.8 || memPercent >= 80) return 'busy';
  return 'light';
}

/** "macOS 15.1", "Ubuntu 24.04.1 LTS", or what the system calls itself. */
async function osName() {
  if (process.platform === 'darwin') {
    const v = (await run('sw_vers', ['-productVersion'])).trim();
    if (v) return `macOS ${v}`;
  }
  if (process.platform === 'linux') {
    try {
      const pretty = fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1];
      if (pretty) return pretty;
    } catch {}
  }
  return `${os.type()} ${os.release()}`;
}

async function memory() {
  const total = os.totalmem();
  let available = os.freemem();
  let swap = null;
  let compressed = null;
  if (process.platform === 'darwin') {
    const [vm, sw] = await Promise.all([run('vm_stat', []), run('sysctl', ['-n', 'vm.swapusage'])]);
    const v = parseVmStat(vm);
    if (v) ({ available, compressed } = v);
    swap = parseSwapUsage(sw);
  } else if (process.platform === 'linux') {
    try {
      const m = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'));
      if (m) ({ available, swap } = m);
    } catch {}
  }
  available = Math.min(total, Math.max(0, available));
  return { total, available, used: total - available, percent: pct(total - available, total), compressed, swap: swap?.total ? { ...swap, percent: pct(swap.used, swap.total) } : null };
}

/** The disks behind the folders named, one row a disk: [{ label, path, total, free, used, percent }]. */
async function disks(folders) {
  const out = [];
  const seen = new Set();
  for (const [label, dir] of folders) {
    try {
      const s = await fs.promises.statfs(dir);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      const key = `${total}:${s.bfree}`;
      if (!total || seen.has(key)) continue;
      seen.add(key);
      out.push({ label, path: dir, total, free, used: total - free, percent: pct(total - free, total) });
    } catch {}
  }
  return out;
}

export class System {
  /** `agents()` lists the agent records (id, name, pid of its open session); `folders()` the [label, dir] pairs whose disks to show. */
  constructor({ agents = () => [], folders = () => [['Home', os.homedir()]], version = null, timer = true } = {}) {
    Object.assign(this, { agents, folders, version });
    this.history = [];
    this.last = cpuTimes();
    this.cpuPercent = 0;
    this.started = Date.now();
    if (timer) {
      this.timer = setInterval(() => this.sample(), SAMPLE_MS);
      this.timer.unref?.();
    }
  }

  close() {
    clearInterval(this.timer);
  }

  /** One more point of the last ten minutes: processor and memory in use. */
  sample() {
    const now = cpuTimes();
    const total = now.total - this.last.total;
    if (total > 0) this.cpuPercent = pct(now.busy - this.last.busy, total);
    this.last = now;
    this.history.push({ at: Date.now(), cpu: this.cpuPercent, mem: pct(os.totalmem() - os.freemem(), os.totalmem()), load: Math.round(os.loadavg()[0] * 100) / 100 });
    if (this.history.length > KEEP) this.history.splice(0, this.history.length - KEEP);
  }

  async view() {
    const cpus = os.cpus();
    const cores = cpus.length || 1;
    const [name, mem, disk, ps] = await Promise.all([(this.osName ??= osName()), memory(), disks(this.folders()), run('ps', ['-Ao', 'pid=,ppid=,pcpu=,rss=,comm='])]);
    const procs = parsePs(ps);
    // The memory in the history is the same measure as the one shown (what can't be freed at once).
    if (this.history.length) this.history[this.history.length - 1].mem = mem.percent;
    const load = os.loadavg().map((n) => Math.round(n * 100) / 100);
    const sessions = this.agents()
      .filter((a) => a.pid)
      .map((a) => ({ id: a.id, name: a.name, pid: a.pid, ...(treeUsage(procs, a.pid) ?? { cpu: 0, mem: 0, count: 0 }) }))
      .filter((a) => a.count)
      .sort((x, y) => y.cpu - x.cpu || y.mem - x.mem);
    const self = treeUsage(procs, process.pid);
    const nets = Object.entries(os.networkInterfaces())
      .flatMap(([nic, list]) => (list ?? []).filter((n) => !n.internal && n.family === 'IPv4').map((n) => ({ nic, address: n.address })));
    return {
      at: new Date().toISOString(),
      level: loadLevel({ cpuPercent: this.cpuPercent, load1: load[0], cores, memPercent: mem.percent }),
      host: {
        name: os.hostname(),
        os: name,
        kernel: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        uptime: Math.round(os.uptime()),
        user: (() => {
          try {
            return os.userInfo().username;
          } catch {
            return null;
          }
        })(),
        addresses: nets,
      },
      cpu: { model: cpus[0]?.model?.trim() || null, cores, percent: this.cpuPercent, load, loadPerCore: Math.round((load[0] / cores) * 100) / 100 },
      memory: mem,
      disks: disk,
      app: { version: this.version, node: process.version, pid: process.pid, uptime: Math.round((Date.now() - this.started) / 1000), mem: process.memoryUsage().rss, cpu: self?.cpu ?? null },
      agents: {
        open: sessions.length,
        cpu: Math.round(sessions.reduce((n, a) => n + a.cpu, 0) * 10) / 10,
        mem: sessions.reduce((n, a) => n + a.mem, 0),
        list: sessions,
      },
      processes: {
        count: procs.length,
        top: [...procs].sort((x, y) => y.cpu - x.cpu || y.mem - x.mem).slice(0, 12).map(({ pid, cpu, mem: m, name: n, command }) => ({ pid, cpu, mem: m, name: n, command })),
      },
      history: this.history,
      sampleSeconds: SAMPLE_MS / 1000,
    };
  }
}
