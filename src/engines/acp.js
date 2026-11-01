// Engines for agents that speak ACP (the Agent Client Protocol): Gemini CLI, OpenCode, Goose,
// Qwen Code and any other, from one line of config. AI Agent Manager runs its own terminal client
// (bin/acp-client.js) in the agent's terminal, which talks ACP to the agent and keeps a session log
// in ~/.agentmanager/acp/<engine>/<session>.jsonl; this adapter reads that log for usage, PR and
// bug links, stuck detection and Explain.
//
// config.json: "acp": { "<name>": { "command": ["opencode", "acp"], "label": "OpenCode" } }
// adds (or changes) the engine "acp-<name>". The presets below are offered when installed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../config.js';
import { norm, tailOf } from '../stuck.js';
import { extractRefs } from '../tracker.js';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'acp-client.js');
export const ACP_PRESETS = {
  gemini: { label: 'Gemini CLI', command: ['gemini', '--experimental-acp'] },
  opencode: { label: 'OpenCode', command: ['opencode', 'acp'] },
  goose: { label: 'Goose', command: ['goose', 'acp'] },
  qwen: { label: 'Qwen Code', command: ['qwen', '--experimental-acp'] },
};
const ANSI = /\x1b(\[[0-9;?<>=]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][0-9A-B]|[=>78c])/g;
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Complete JSON lines added since the cursor's offset. */
function newRecords(file, cursor) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size, mtime } = fs.fstatSync(fd);
    cursor.lastActivity = mtime.toISOString();
    if (size < cursor.offset) cursor.offset = 0;
    if (size === cursor.offset) return [];
    const buf = Buffer.alloc(size - cursor.offset);
    fs.readSync(fd, buf, 0, buf.length, cursor.offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return [];
    cursor.offset += lastNl + 1;
    const out = [];
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      try {
        if (line) out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** The engine for one ACP agent. */
export function acpEngine(name, { command, label, args = [] }) {
  const id = `acp-${name}`;
  const logDir = () => path.join(paths.home, 'acp', name);
  const fileOf = (sid) => path.join(logDir(), `${String(sid).replace(/[^\w.-]/g, '_')}.jsonl`);
  const cmd = [command].flat().map(String);
  return {
    id,
    label: label ?? name,
    acp: true,
    // Bypass answers its permission requests "allow" by itself; other modes ask (the inbox can answer).
    supports: { chooseSessionId: false, cost: false, planHandoff: false, fork: false, oneShot: true, resumePrompt: true },
    permissionModes: ['default', 'bypassPermissions'],
    rulesFiles: ['AGENTS.md'],
    install: `Install ${label ?? name} (\`${cmd[0]}\` on the daemon's PATH) and sign in once in a terminal`,

    // The command that has to be installed is the agent's; the client is ours.
    bin: () => process.execPath,
    installedBin: () => cmd[0],
    extraArgs: () => [],

    /** The client in the agent's terminal: the log folder, resume, the first message, then the agent. */
    launchArgs({ permissionMode, writableDir, instructions, sessionId, resume, prompt }) {
      const out = [CLIENT, '--log', logDir()];
      if (permissionMode === 'bypassPermissions') out.push('--yes');
      for (const d of [writableDir ?? []].flat()) out.push('--allow-dir', d);
      if (resume) out.push('--session', sessionId);
      const first = resume ? prompt : [instructions, prompt && (instructions ? `Your task:\n${prompt}` : prompt)].filter(Boolean).join('\n\n---\n\n');
      if (first) out.push('--prompt', first);
      return [...out, '--', ...cmd, ...args];
    },

    sessionFile: (cwd, sid) => fileOf(sid),
    hasSession: (cwd, sid) => fs.existsSync(fileOf(sid)),
    subagentFiles: () => [],

    /** Sessions the client started in this folder since a time (from each log's first line). */
    recentSessions(cwd, sinceMs) {
      const want = real(cwd);
      const out = [];
      let names = [];
      try {
        names = fs.readdirSync(logDir()).filter((n) => n.endsWith('.jsonl'));
      } catch {}
      for (const n of names) {
        const file = path.join(logDir(), n);
        const st = fs.statSync(file);
        if (st.mtimeMs < sinceMs) continue;
        let meta = null;
        try {
          meta = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
        } catch {}
        if (meta?.type !== 'meta' || real(meta.cwd) !== want) continue;
        out.push({ sessionId: meta.sessionId, file, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs });
      }
      return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    },

    /** Usage (the agent's context use, when it reports it), PR and bug links from messages and tool output. */
    scan(file, cursor, bugPatterns = []) {
      const result = { prs: [], bugs: [], title: null, lastPrompt: null, cost: null, lastActivity: null };
      cursor.usage ??= new Map();
      cursor.offset ??= 0;
      const recs = newRecords(file, cursor);
      result.lastActivity = cursor.lastActivity ?? null;
      if (!recs) return result;
      for (const r of recs) {
        if (r.type === 'user') result.lastPrompt = String(r.text ?? '').slice(0, 500);
        if (r.type === 'usage' && r.used != null) cursor.usage.set('context', { input: r.used, output: 0, cacheCreation: 0, cacheRead: 0 });
        const text = r.type === 'agent' || r.type === 'user' ? r.text : r.type === 'tool' ? r.output : '';
        if (text) {
          const refs = extractRefs(String(text), bugPatterns);
          result.prs.push(...refs.prs);
          result.bugs.push(...refs.bugs);
        }
      }
      return result;
    },

    /** Commands and edits, for stuck detection. */
    activity(file, state) {
      state.events ??= [];
      state.offset ??= 0;
      state.inputs ??= {};
      const recs = newRecords(file, state);
      if (!recs) return state;
      for (const r of recs) {
        const t = Date.parse(r.t) || Date.now();
        if (r.type === 'tool' && r.input) state.inputs[r.id] = r.input;
        if (r.type === 'tool' && (r.status === 'completed' || r.status === 'failed') && r.kind === 'execute') {
          const input = r.input ?? state.inputs[r.id] ?? {};
          const out = String(r.output ?? '');
          state.events.push({ t, kind: 'cmd', cmd: norm(String(input.command ?? r.title ?? '')).slice(0, 300), failed: Boolean(r.failed), result: tailOf(out), shown: out.replace(/\s+/g, ' ').trim().slice(-160) });
        } else if (r.type === 'edit') {
          state.events.push({ t, kind: 'edit', file: r.path, edits: [[norm(r.oldText ?? ''), norm(r.newText ?? '')]] });
        }
      }
      if (state.events.length > 400) state.events = state.events.slice(-400);
      return state;
    },

    /** A readable digest of the conversation, for Explain and documents. */
    digest(file, { maxChars = 24_000 } = {}) {
      const events = [];
      const edited = new Set();
      for (const r of newRecords(file, { offset: 0 }) ?? []) {
        if (r.type === 'user') events.push(`[user] ${String(r.text).slice(0, 1200)}`);
        else if (r.type === 'agent') events.push(`[agent] ${String(r.text).slice(0, 1800)}`);
        else if (r.type === 'tool' && (r.status === 'completed' || r.status === 'failed')) events.push(`[action] ${r.title}${r.failed ? ' (failed)' : ''}`);
        else if (r.type === 'edit') edited.add(r.path), events.push(`[action] edited ${r.path}`);
      }
      const head = events.find((e) => e.startsWith('[user]'));
      const tail = [];
      let used = head?.length ?? 0;
      for (let i = events.length - 1; i >= 0 && events[i] !== head; i--) {
        if (used + events[i].length > maxChars) {
          tail.unshift('… (earlier events omitted) …');
          break;
        }
        tail.unshift(events[i]);
        used += events[i].length + 1;
      }
      return { digest: [head, ...tail].filter(Boolean).join('\n'), events: events.length, edited: [...edited] };
    },

    copySession: () => false,

    attention: [[/Permissionneeded:/i, 'Permission prompt']],
    // Its menu reads a line: a choice is the number, then Enter.
    promptKeyEnter: true,

    /** The client's menu: "Permission needed: <title> 1. Allow once 2. Always allow 3. Reject Choose 1-3". */
    promptChoices(screen) {
      const text = String(screen ?? '').replace(ANSI, ' ').replace(/\s+/g, ' ');
      const at = text.lastIndexOf('Permission needed:');
      if (at < 0) return { question: '', choices: [] };
      const tail = text.slice(at);
      const question = (/^Permission needed: (.*?)(?= 1\. )/.exec(tail)?.[1] ?? '').trim().slice(0, 200);
      const choices = [];
      for (const m of tail.matchAll(/\b(\d)\. (.+?)(?= \d\. | Choose |$)/g)) choices.push({ key: m[1], label: m[2].trim().slice(0, 80) });
      return { question: question ? `Allow: ${question}?` : 'Allow this?', choices };
    },

    trust: () => false,

    /** One-shot: the client in --once mode, every permission refused (read-only), the prompt on stdin. */
    oneShotArgs: () => [CLIENT, '--once', '--', ...cmd, ...args],

    stripEnv: [],
  };
}

/** The ACP engines to offer: the presets, with config's own added or changed. */
export function acpEngines(config = {}) {
  const defs = { ...ACP_PRESETS };
  for (const [name, def] of Object.entries(config.acp ?? {})) {
    if (def === false) delete defs[name];
    else if (def?.command) defs[name] = { ...defs[name], ...def };
  }
  return Object.entries(defs).map(([name, def]) => acpEngine(name, def));
}
