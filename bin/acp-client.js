#!/usr/bin/env node
// A terminal client for agents that speak ACP (the Agent Client Protocol: JSON-RPC over stdio, as
// Gemini CLI, OpenCode, Goose and others do). AI Agent Manager runs it in an agent's terminal: it
// starts the agent, draws its messages, tool calls and plan as text, turns lines you type into
// prompts, asks permission as a numbered menu (so the inbox can answer it), and keeps a session log
// (JSONL) that AI Agent Manager reads like any engine's transcript.
//
//   acp-client.js --log <dir> [--session <id>] [--prompt <text>] [--yes] [--allow-dir <dir>]... -- <agent command...>
//   acp-client.js --once [--deny] -- <agent command...>      (prompt on stdin; prints only the reply)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) {
  console.error('usage: acp-client.js [options] -- <agent command...>');
  process.exit(2);
}
const opts = argv.slice(0, sep);
const command = argv.slice(sep + 1);
const flag = (n) => opts.includes(n);
const value = (n) => (opts.includes(n) ? opts[opts.indexOf(n) + 1] : null);
const values = (n) => opts.flatMap((o, i) => (o === n ? [opts[i + 1]] : []));
const once = flag('--once');
const yes = flag('--yes');
const deny = flag('--deny');
const logDir = once ? null : value('--log');
const cwd = process.cwd();
const allowDirs = [cwd, ...values('--allow-dir')].map((d) => path.resolve(d));

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const out = (s) => (once ? null : process.stdout.write(s));

// ------------------------------------------------------------ the session log
let logFile = null;
let pendingLog = [];
function log(rec) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n';
  if (!logDir) return;
  if (!logFile) return void pendingLog.push(line);
  fs.appendFileSync(logFile, line);
}
function openLog(sessionId, fresh) {
  if (!logDir) return;
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, `${sessionId}.jsonl`);
  if (fresh || !fs.existsSync(logFile)) fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), type: 'meta', sessionId, cwd, agent: command[0] }) + '\n');
  for (const l of pendingLog) fs.appendFileSync(logFile, l);
  pendingLog = [];
}

// ------------------------------------------------------------ JSON-RPC over the agent's stdio
// Its own process group: Ctrl+C in the terminal reaches only this client, which cancels the turn.
const child = spawn(command[0], command.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env, detached: !once });
child.on('error', (err) => {
  console.error(`${YELLOW}Could not start ${command[0]}: ${err.message}${RESET}`);
  process.exit(127);
});
child.stderr.on('data', (d) => {
  if (!once && process.env.AGENTMGR_ACP_DEBUG) process.stderr.write(`${DIM}${d}${RESET}`);
});
let nextId = 1;
const waiting = new Map();
const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    send({ id, method, params });
  });
const notify = (method, params) => send({ method, params });

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null && !msg.method) {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (!w) return;
    msg.error ? w.reject(Object.assign(new Error(msg.error.message ?? 'error'), { code: msg.error.code, data: msg.error.data })) : w.resolve(msg.result);
    return;
  }
  if (msg.method === 'session/update') return onUpdate(msg.params?.update ?? {});
  if (msg.id != null && msg.method) {
    // The agent asks us something.
    handle(msg.method, msg.params ?? {}).then(
      (result) => send({ id: msg.id, result }),
      (err) => send({ id: msg.id, error: { code: -32603, message: err.message } }),
    );
  }
});
child.on('exit', (code) => {
  flushMessage();
  out(`\r\n${DIM}[agent exited${code ? ` with code ${code}` : ''}]${RESET}\r\n`);
  process.exit(code ?? 0);
});

// ------------------------------------------------------------ what the agent sends
let message = ''; // the agent's reply being streamed
let replyText = ''; // all reply text this turn (for --once)
let thinking = false;
const tools = new Map(); // toolCallId -> { title, kind }
function flushMessage() {
  if (message.trim()) log({ type: 'agent', text: message });
  message = '';
}
const textOf = (content) =>
  (Array.isArray(content) ? content : [content])
    .map((c) => (c?.type === 'content' ? c.content : c))
    .map((c) => (c?.type === 'text' ? c.text : ''))
    .join('');

function onUpdate(u) {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const t = u.content?.type === 'text' ? u.content.text : '';
      if (thinking) out(RESET), (thinking = false);
      message += t;
      replyText += t;
      if (once) return;
      out(t.replace(/\n/g, '\r\n'));
      return;
    }
    case 'agent_thought_chunk':
      if (!thinking) out(`${DIM}`), (thinking = true);
      out((u.content?.text ?? '').replace(/\n/g, '\r\n'));
      return;
    case 'user_message_chunk':
      // History when a session is loaded.
      out(`\r\n${CYAN}› ${(u.content?.text ?? '').replace(/\n/g, '\r\n  ')}${RESET}\r\n`);
      return;
    case 'tool_call': {
      flushMessage();
      tools.set(u.toolCallId, { title: u.title ?? 'tool', kind: u.kind ?? 'other' });
      out(`\r\n${BOLD}⏺ ${u.title ?? 'tool'}${RESET} ${DIM}${u.kind ?? ''}${RESET}\r\n`);
      log({ type: 'tool', id: u.toolCallId, title: u.title, kind: u.kind, status: u.status ?? 'pending', input: u.rawInput ?? null });
      return toolContent(u);
    }
    case 'tool_call_update': {
      const t = tools.get(u.toolCallId) ?? { title: u.title ?? 'tool', kind: u.kind ?? 'other' };
      if (u.title) t.title = u.title;
      tools.set(u.toolCallId, t);
      toolContent(u);
      if (u.status === 'completed' || u.status === 'failed') {
        const text = textOf(u.content ?? []).trim();
        const lines = text.split('\n');
        out(`${DIM}  ⎿ ${u.status === 'failed' ? `${YELLOW}failed${RESET}${DIM}` : 'done'}${lines[0] ? `: ${lines.slice(0, 4).join('\r\n    ')}${lines.length > 4 ? ` … (${lines.length - 4} more lines)` : ''}` : ''}${RESET}\r\n`);
        log({ type: 'tool', id: u.toolCallId, title: t.title, kind: t.kind, status: u.status, input: u.rawInput ?? null, output: (text || JSON.stringify(u.rawOutput ?? '')).slice(-4000), failed: u.status === 'failed' });
      }
      return;
    }
    case 'plan':
      out(`\r\n${BOLD}Plan${RESET}\r\n${(u.entries ?? []).map((e) => `  ${e.status === 'completed' ? '☑' : e.status === 'in_progress' ? '▶' : '☐'} ${e.content}`).join('\r\n')}\r\n`);
      log({ type: 'plan', entries: (u.entries ?? []).map((e) => ({ content: e.content, status: e.status })) });
      return;
    case 'usage_update':
      log({ type: 'usage', used: u.used ?? null, size: u.size ?? null, cost: u.cost ?? null });
      return;
    default:
  }
}

/** Diffs in a tool call: the file it edits. */
function toolContent(u) {
  for (const c of u.content ?? []) {
    if (c?.type === 'diff' && c.path) {
      out(`${DIM}  ✎ ${c.path}${RESET}\r\n`);
      log({ type: 'edit', path: c.path, removed: String(c.oldText ?? '').split('\n').length, added: String(c.newText ?? '').split('\n').length, oldText: String(c.oldText ?? '').slice(0, 2000), newText: String(c.newText ?? '').slice(0, 2000) });
    }
  }
}

const inside = (p) => allowDirs.some((d) => p === d || p.startsWith(d + path.sep));

/** Requests from the agent: permission, and reading or writing files for it. */
async function handle(method, p) {
  if (method === 'session/request_permission') return permission(p);
  if (method === 'fs/read_text_file') {
    const text = fs.readFileSync(p.path, 'utf8');
    if (p.line == null && p.limit == null) return { content: text };
    const lines = text.split('\n');
    const from = Math.max(0, (p.line ?? 1) - 1);
    return { content: lines.slice(from, p.limit != null ? from + p.limit : undefined).join('\n') };
  }
  if (method === 'fs/write_text_file') {
    const target = path.resolve(p.path);
    if (!inside(target)) throw new Error(`Writing outside the agent's folder is not allowed: ${target}`);
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, p.content ?? '');
    out(`${DIM}  ✎ wrote ${target}${RESET}\r\n`);
    log({ type: 'edit', path: target, removed: before ? before.split('\n').length : 0, added: String(p.content ?? '').split('\n').length, oldText: before.slice(0, 2000), newText: String(p.content ?? '').slice(0, 2000) });
    return {};
  }
  throw Object.assign(new Error(`Not supported: ${method}`), { code: -32601 });
}

let answer = null; // resolves with the next line typed while a permission menu is open
async function permission(p) {
  const options = p.options ?? [];
  const title = p.toolCall?.title ?? 'a tool';
  const pick = (kinds) => options.find((o) => kinds.includes(o.kind));
  if (yes || deny || once) {
    const o = deny || once ? pick(['reject_once', 'reject_always']) : pick(['allow_once', 'allow_always']);
    log({ type: 'permission', title, choice: o?.name ?? 'cancelled', auto: true });
    return o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : { outcome: { outcome: 'cancelled' } };
  }
  flushMessage();
  out(`\r\n${YELLOW}${BOLD}Permission needed: ${title}${RESET}\r\n${options.map((o, i) => `  ${i + 1}. ${o.name}`).join('\r\n')}\r\n${YELLOW}Choose 1-${options.length} (Enter for 1):${RESET} `);
  const typed = await new Promise((resolve) => (answer = resolve));
  const n = Number(typed.trim() || '1');
  const o = options[n - 1];
  log({ type: 'permission', title, choice: o?.name ?? 'cancelled' });
  return o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : { outcome: { outcome: 'cancelled' } };
}

// ------------------------------------------------------------ the session and prompts
let sessionId = null;
let turn = null; // the prompt in flight
const queue = [];

async function prompt(text) {
  if (turn) return void queue.push(text);
  log({ type: 'user', text });
  replyText = '';
  out(`${DIM}`);
  turn = request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  let stop = 'end_turn';
  try {
    stop = (await turn)?.stopReason ?? 'end_turn';
  } catch (err) {
    stop = 'error';
    out(`\r\n${YELLOW}${err.message}${RESET}\r\n`);
  }
  turn = null;
  flushMessage();
  log({ type: 'turn_end', stopReason: stop });
  if (once) {
    process.stdout.write(replyText.trim() + '\n');
    child.kill();
    process.exit(stop === 'error' ? 1 : 0);
  }
  out(`${RESET}\r\n${stop !== 'end_turn' ? `${DIM}[${stop}]${RESET}\r\n` : ''}`);
  if (queue.length) return prompt(queue.shift());
  ready();
}
const ready = () => out(`\r\n${CYAN}›${RESET} `);

async function main() {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: 'ai-agentmanager', title: 'AI Agent Manager', version: '1' },
  });
  const resume = value('--session');
  if (resume && init?.agentCapabilities?.loadSession) {
    sessionId = resume;
    openLog(sessionId, false);
    out(`${DIM}Resuming session ${sessionId}…${RESET}\r\n`);
    await request('session/load', { sessionId, cwd, mcpServers: [] });
  } else {
    if (resume) out(`${DIM}This agent can't resume sessions; starting a new one.${RESET}\r\n`);
    sessionId = (await request('session/new', { cwd, mcpServers: [] })).sessionId;
    openLog(sessionId, true);
  }
  out(`${DIM}${init?.agentInfo?.title ?? command[0]} · session ${sessionId}${RESET}\r\n`);
  const first = value('--prompt');
  if (once) {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return prompt(text);
  }
  if (first) await prompt(first);
  else ready();
}

// Lines you type: an answer to an open permission menu, else a prompt. Ctrl+C cancels the turn.
if (!once) {
  // Don't echo control characters (a pasted message's markers) as ^[[200~.
  if (process.stdin.isTTY) spawn('stty', ['-echoctl'], { stdio: ['inherit', 'ignore', 'ignore'] });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  // A message typed in as a bracketed paste (several lines) is one prompt, not one per line.
  let pasting = null;
  rl.on('line', (raw) => {
    let line = raw;
    if (line.includes('\x1b[200~')) {
      pasting = [];
      line = line.slice(line.indexOf('\x1b[200~') + 6);
    }
    if (pasting) {
      const end = line.indexOf('\x1b[201~');
      if (end < 0) return void pasting.push(line);
      pasting.push(line.slice(0, end));
      line = pasting.join('\n') + line.slice(end + 6);
      pasting = null;
    }
    if (answer) {
      const a = answer;
      answer = null;
      return a(line);
    }
    if (line.trim() && sessionId) prompt(line);
    else if (!turn) ready();
  });
  process.on('SIGINT', () => {
    if (turn && sessionId) {
      notify('session/cancel', { sessionId });
      out(`\r\n${DIM}[cancelling…]${RESET}\r\n`);
    } else {
      child.kill();
      process.exit(130);
    }
  });
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => (child.kill('SIGTERM'), process.exit(0)));
}

main().catch((err) => {
  const auth = /auth/i.test(err.message) || err.code === -32000;
  console.error(`\r\n${YELLOW}${auth ? `${command[0]} needs signing in first (run it once in a terminal): ` : ''}${err.message}${RESET}`);
  child.kill();
  process.exit(1);
});
