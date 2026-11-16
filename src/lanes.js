// Lanes: a range of ports and a name ending of its own for every agent. Worktrees keep agents'
// files apart, but two dev servers still want the same port and two test runs the same database.
// An agent's lane is in its environment (PORT, AGENT_PORT, AGENT_PORTS, AGENT_SUFFIX) and in its
// instructions; a lane is free again when its agent is deleted. What each open session listens on
// is read from the system itself (`lsof`, or `ss` on Linux), so a port outside a lane shows.

import { execFile } from 'node:child_process';

export const LANE_DEFAULTS = { enabled: true, base: 21000, size: 10, port: true };
const TOP = 32767; // below the ports systems hand out on their own

const int = (v, min, max, fallback) => (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : fallback);

export function laneSettings(config = {}) {
  const c = config.lanes ?? {};
  return {
    enabled: c.enabled !== false,
    base: int(c.base, 1024, TOP - 100, LANE_DEFAULTS.base),
    size: int(c.size, 1, 100, LANE_DEFAULTS.size),
    port: c.port !== false,
  };
}

/** Lane n (from 1): its ports and the ending for names, or null when it runs past the top. */
export function laneOf(n, settings = LANE_DEFAULTS) {
  if (!Number.isInteger(n) || n < 1) return null;
  const first = settings.base + (n - 1) * settings.size;
  const last = first + settings.size - 1;
  return last > TOP ? null : { n, first, last, suffix: `_a${n}` };
}

/** The lowest lane no agent has, passing over lanes that hold a port of this app's own. */
export function nextLane(taken, settings = LANE_DEFAULTS, reserved = []) {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const lane = laneOf(n, settings);
    if (!lane) return null;
    if (used.has(n) || reserved.some((p) => p >= lane.first && p <= lane.last)) continue;
    return n;
  }
}

/** What a lane adds to its agent's environment. PORT only when asked: many dev servers read it. */
export function laneEnv(lane, settings = LANE_DEFAULTS) {
  if (!lane) return {};
  return {
    AGENT_LANE: String(lane.n),
    AGENT_PORT: String(lane.first),
    AGENT_PORT_END: String(lane.last),
    AGENT_PORTS: `${lane.first}-${lane.last}`,
    AGENT_SUFFIX: lane.suffix,
    ...(settings.port ? { PORT: String(lane.first) } : {}),
  };
}

/** The lane, said to the agent with its other instructions. */
export function lanePrompt(lane, settings = LANE_DEFAULTS) {
  const range = lane.first === lane.last ? `port ${lane.first}` : `a port from ${lane.first} to ${lane.last}`;
  return [
    'Other agents work on this computer at the same time as you, each in its own copy of the code.',
    `For anything you start that listens on a port (a dev server, an API, a database, a test server), use ${range}: only you have ${lane.first === lane.last ? 'it' : 'them'} (AGENT_PORTS${settings.port ? `; PORT is already ${lane.first}` : ''}). Pass the port explicitly when the tool ignores PORT.`,
    'If a port outside that range is taken, leave what holds it running: it belongs to another agent or to the user.',
    `For anything you create by name outside your folder (a database, a schema, a container, a compose project, a temp folder), end its name with ${lane.suffix} (AGENT_SUFFIX).`,
  ].join(' ');
}

const portOf = (addr) => {
  const m = String(addr).match(/:(\d{1,5})$/);
  return m ? Number(m[1]) : null;
};

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` as [{ pid, name, port, address }], one row a process and port. */
export function parseLsof(text) {
  const out = [];
  const seen = new Set();
  let pid = null;
  let name = '';
  for (const line of String(text).split('\n')) {
    const v = line.slice(1);
    if (line[0] === 'p') {
      pid = Number(v);
      name = '';
    } else if (line[0] === 'c') name = v;
    else if (line[0] === 'n' && pid) {
      const port = portOf(v);
      if (!port || seen.has(`${pid}:${port}`)) continue;
      seen.add(`${pid}:${port}`);
      out.push({ pid, name, port, address: v.slice(0, v.lastIndexOf(':')) });
    }
  }
  return out;
}

/** `ss -ltnpH` (Linux) as the same rows. Sockets of other users come without a process and are left out. */
export function parseSs(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text).split('\n')) {
    const cols = line.trim().split(/\s+/);
    const port = portOf(cols[3] ?? '');
    if (cols[0] !== 'LISTEN' || !port) continue;
    for (const m of line.matchAll(/\("([^"]*)",pid=(\d+)/g)) {
      const pid = Number(m[2]);
      if (seen.has(`${pid}:${port}`)) continue;
      seen.add(`${pid}:${port}`);
      out.push({ pid, name: m[1], port, address: cols[3].slice(0, cols[3].lastIndexOf(':')) });
    }
  }
  return out;
}

/** Every process under one (itself included). */
export function treePids(procs, rootPid) {
  const kids = new Map();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const seen = new Set();
  for (const todo = [rootPid]; todo.length; ) {
    const pid = todo.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    todo.push(...(kids.get(pid) ?? []));
  }
  return seen;
}

/**
 * What each open session listens on. `sessions`: [{ id, name, pid, lane }] (lane from laneOf, or
 * null). Each gets `ports` [{ port, pid, name, inLane }], lowest first, and `taken`: ports of its
 * lane that something else holds [{ port, pid, name, by }] (`by`: the other agent's id, or null).
 */
export function portsBySession(sessions, procs, listeners) {
  const owner = new Map(); // pid -> session id
  for (const s of sessions) if (s.pid) for (const pid of treePids(procs, s.pid)) if (!owner.has(pid)) owner.set(pid, s.id);
  const within = (lane, port) => Boolean(lane && port >= lane.first && port <= lane.last);
  return sessions.map((s) => ({
    ...s,
    ports: listeners
      .filter((l) => owner.get(l.pid) === s.id)
      .map((l) => ({ port: l.port, pid: l.pid, name: l.name, inLane: within(s.lane, l.port) }))
      .sort((a, b) => a.port - b.port),
    taken: listeners
      .filter((l) => within(s.lane, l.port) && owner.get(l.pid) !== s.id)
      .map((l) => ({ port: l.port, pid: l.pid, name: l.name, by: owner.get(l.pid) ?? null }))
      .sort((a, b) => a.port - b.port),
  }));
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => resolve(e && !out ? '' : String(out))));

/** What listens on this computer now, among the processes this user may see. */
export async function listeners() {
  // lsof ends with an error when there is nothing to list; what it printed still counts.
  const lsof = parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']));
  if (lsof.length || process.platform !== 'linux') return lsof;
  return parseSs(await run('ss', ['-ltnpH']));
}
