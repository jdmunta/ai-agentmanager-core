// Meta's Muse Code CLI (`muse`) as an agent engine (checked against Muse Code 1.4.14; fixtures in
// test/fixtures/muse). Differences from Claude Code that shape this adapter:
//   - Muse picks its own session IDs; the manager adopts the one it creates. Sessions live in
//     $XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<id>/session.jsonl, and the runtime.session.metadata
//     record near the top holds the folder it ran in (workspace_root).
//   - `muse resume <id>` takes no message, so a message for a resumed session is typed once it
//     is idle (supports.resumePrompt: false).
//   - No flag for extra instructions: they go in the first message of a new session.
//   - The log is Muse's own event log; this reads only the run events (prompt, reply, usage).
//     Tool calls aren't read yet, so stuck detection has no commands or edits for Muse agents.
//   - Approval questions ("Would you like to run the following command?") are matched from the
//     wording in the binary; the trust question was seen on a real screen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractRefs } from '../tracker.js';

// MUSE_DATA_HOME is AI Agent Manager's own override (tests); Muse itself uses the XDG folder.
const dataHome = () => process.env.MUSE_DATA_HOME || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'muse');
const sessionsDir = () => path.join(dataHome(), 'sessions');
const configHome = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'muse');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const ANSI = /\x1b(\[[0-9;?<>=]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][0-9A-B]|[=>78c])/g;
const readdir = (d) => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};

/** Day folders from `sinceMs` to today (sessions are filed by their start date). */
function dayDirs(sinceMs) {
  const out = [];
  const d = new Date(Math.min(sinceMs, Date.now()));
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < 400 && d.getTime() <= Date.now(); i++, d.setDate(d.getDate() + 1)) {
    out.push(path.join(sessionsDir(), String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  return out;
}

/** The folder a session ran in: workspace_root in its runtime.session.metadata record (one of the first lines). */
function sessionCwd(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        if (!line.includes('"runtime.session.metadata"')) continue;
        const m = /"(?:workspace_root|cwd)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(line);
        return m ? JSON.parse(m[1]) : null;
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

const found = new Map(); // session id -> file
function findSession(sessionId) {
  if (!UUID.test(String(sessionId))) return null;
  const hit = found.get(sessionId);
  if (hit && fs.existsSync(hit)) return hit;
  // Newest days first; a session resumed today is still filed under the day it started.
  for (const y of readdir(sessionsDir()).filter((n) => /^\d{4}$/.test(n)).sort().reverse()) {
    for (const m of readdir(path.join(sessionsDir(), y)).sort().reverse()) {
      for (const d of readdir(path.join(sessionsDir(), y, m)).sort().reverse()) {
        const file = path.join(sessionsDir(), y, m, d, sessionId, 'session.jsonl');
        if (fs.existsSync(file)) {
          found.set(sessionId, file);
          return file;
        }
      }
    }
  }
  return null;
}

/** Read the complete lines added since the cursor's offset. */
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
    const start = cursor.offset;
    cursor.offset += lastNl + 1;
    const out = [];
    let at = start;
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      const here = at;
      at += Buffer.byteLength(line) + 1;
      // Only the run events matter here; skip the rest without parsing it.
      if (!line.includes('"runtime.session"') || !line.includes('"kind":"run"')) continue;
      try {
        out.push({ rec: JSON.parse(line), at: here });
      } catch {}
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** A run event: { kind, ...fields } for the person's message, the reply, usage and the end of a turn. */
const runEvent = (rec) => (rec.payload_type === 'runtime.session' && rec.payload?.kind === 'run' ? rec.payload.event ?? null : null);
const atOf = (rec) => (rec.recorded_at ? Math.floor(rec.recorded_at / 1000) : Date.now());

/**
 * Permission modes in Muse terms: a built-in permission profile, or no approval and no sandbox.
 * Muse's own default is the Auto-review profile (a model reviews what isn't plainly safe).
 */
const MODES = {
  default: [],
  acceptEdits: [],
  plan: ['--permission-profile', ':read-only'],
  auto: ['--permission-profile', ':auto-review'],
  bypassPermissions: ['--yolo'],
};

/** The model Muse is set to use (its settings file), or null. */
function configuredModel() {
  try {
    return JSON.parse(fs.readFileSync(path.join(configHome(), 'settings.json'), 'utf8')).model ?? null;
  } catch {
    return null;
  }
}

export default {
  id: 'muse',
  label: 'Muse Code',
  supports: { chooseSessionId: false, cost: false, planHandoff: false, fork: false, oneShot: true, resumePrompt: false },
  permissionModes: Object.keys(MODES),
  // Muse reads the first of these it finds, walking up to the repo root.
  rulesFiles: ['AGENTS.md', 'CLAUDE.md'],
  install: 'Install Muse Code (curl -fsSL https://dev.meta.ai/install.sh | bash) and run `muse login`',

  // On a hangup Muse records no clean end and warns on the next resume; SIGTERM ends it cleanly.
  stopSignal: 'SIGTERM',

  bin: (config) => config.engines?.muse?.bin ?? 'muse',
  extraArgs: (config) => [...(config.engines?.muse?.args ?? [])],

  /** Something the person should know before choosing Muse, or null. */
  notice() {
    const model = configuredModel();
    return /contributor/i.test(model ?? '') ? `Contributor mode (${model}): Meta may use your code and conversations to improve its products.` : null;
  },

  /**
   * Full arguments for a launch. The folder is trusted for the run (nothing is saved), so the
   * trust question doesn't stop a new agent. Resume takes no message; it is typed when idle.
   */
  launchArgs({ extra = [], permissionMode, model, instructions, sessionId, resume, prompt }) {
    const opts = [...extra, '--trust-workspace', ...(MODES[permissionMode] ?? MODES.default)];
    if (model) opts.push('--model', model);
    if (resume) return ['resume', sessionId, ...opts];
    const first = [instructions, prompt && (instructions ? `Your task:\n${prompt}` : prompt)].filter(Boolean).join('\n\n---\n\n');
    // "--" so a message starting with "-" isn't read as a flag.
    return [...opts, ...(first ? ['--', first] : [])];
  },

  sessionFile: (cwd, sessionId) => findSession(sessionId) ?? path.join(sessionsDir(), `missing-${sessionId}`, 'session.jsonl'),
  hasSession: (cwd, sessionId) => Boolean(findSession(sessionId)),
  subagentFiles: () => [],

  /** Sessions Muse started in this folder since a time; the manager adopts a new one. */
  recentSessions(cwd, sinceMs) {
    const want = real(cwd);
    const out = [];
    for (const dir of dayDirs(sinceMs)) {
      for (const id of readdir(dir)) {
        if (!UUID.test(id)) continue;
        const file = path.join(dir, id, 'session.jsonl');
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        if (st.mtimeMs < sinceMs) continue;
        const where = sessionCwd(file);
        if (!where || real(where) !== want) continue;
        found.set(id, file);
        out.push({ sessionId: id, file, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs });
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  },

  /** Usage (one entry per model call), PR and bug links from the person's messages and the replies. */
  scan(file, cursor, bugPatterns = []) {
    const result = { prs: [], bugs: [], title: null, lastPrompt: null, cost: null, lastActivity: null };
    cursor.usage ??= new Map();
    cursor.offset ??= 0;
    const recs = newRecords(file, cursor);
    result.lastActivity = cursor.lastActivity ?? null;
    if (!recs) return result;
    for (const { rec, at } of recs) {
      const e = runEvent(rec);
      if (!e) continue;
      if (e.kind === 'model_completed' && e.usage) {
        const u = e.usage;
        const cached = u.cached_tokens ?? 0;
        // Cached tokens are counted inside input_tokens, as with OpenAI's API.
        cursor.usage.set(`r${at}`, { input: Math.max(0, (u.input_tokens ?? 0) - cached), output: (u.output_tokens ?? 0) + (u.reasoning_tokens ?? 0), cacheCreation: 0, cacheRead: cached });
      } else if (e.kind === 'started' || e.kind === 'assistant_message_committed') {
        const text = String(e.prompt ?? e.text ?? '');
        if (e.kind === 'started' && text) result.lastPrompt = text.slice(0, 500);
        const refs = extractRefs(text, bugPatterns);
        result.prs.push(...refs.prs);
        result.bugs.push(...refs.bugs);
      }
    }
    return result;
  },

  /** Commands and edits for stuck detection: not read from Muse's log yet. */
  activity(file, state) {
    state.events ??= [];
    return state;
  },

  /** A readable digest of the conversation, for Explain and documents. */
  digest(file, { maxChars = 24_000 } = {}) {
    const events = [];
    for (const { rec } of newRecords(file, { offset: 0 }) ?? []) {
      const e = runEvent(rec);
      if (e?.kind === 'started' && e.prompt) events.push(`[user] ${String(e.prompt).slice(0, 1200)}`);
      else if (e?.kind === 'assistant_message_committed' && e.text) events.push(`[agent] ${String(e.text).slice(0, 1800)}`);
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
    return { digest: [head, ...tail].filter(Boolean).join('\n'), events: events.length, edited: [] };
  },

  copySession: () => false,

  attention: [
    [/Doyoutrustthisworkspace\?/i, 'Folder trust prompt'],
    [/Wouldyouliketo(run|allow)/i, 'Permission prompt'],
  ],

  /** Muse's menus: "Do you trust this workspace? … ⟩ 1  Trust and continue  2  Quit  Use Up/Down…". */
  promptChoices(screen) {
    const text = String(screen ?? '')
      .replace(/\x1b\[(\d*)C/g, ' ')
      .replace(ANSI, ' ')
      .replace(/\s+/g, ' ');
    const at = Math.max(text.lastIndexOf('Would you like'), text.lastIndexOf('Do you trust this workspace'));
    if (at < 0) return { question: '', choices: [] };
    const tail = text.slice(at);
    const question = (/^(.*?\?)/.exec(tail)?.[1] ?? '').slice(0, 200);
    const choices = new Map();
    for (const m of tail.matchAll(/(?:⟩\s*)?\b(\d)\.?\s+(.+?)(?=\s+(?:⟩\s*)?\d\.?\s+[A-Z]|\s+Use Up\/Down|\s+Esc |$)/g)) {
      if (!choices.has(m[1])) choices.set(m[1], m[2].trim().slice(0, 100));
    }
    return { question, choices: [...choices.entries()].sort(([a], [b]) => a - b).map(([key, label]) => ({ key, label })) };
  },

  /** Nothing to save: each launch passes --trust-workspace (trust for that run only). */
  trust: () => false,

  /** One-shot in the read-only profile (no writes or side-effecting commands), no web tools, not logged; the prompt is the last argument. */
  oneShotArgs: (config, { model, prompt = '', extra = [] } = {}) => ['exec', ...extra, '--no-session-log', '--permission-profile', ':read-only', '--disable-web-tools', ...(model ? ['--model', model] : []), '--', prompt],
  oneShotStdin: false,
  // `muse exec` takes options only after the subcommand, configured extra arguments included.
  oneShotExtra: true,

  stripEnv: [],
};
