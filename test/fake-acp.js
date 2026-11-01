#!/usr/bin/env node
// A stand-in ACP agent (JSON-RPC over stdio) for tests: streams a reply, runs a "command" tool,
// asks permission when the prompt has "#perm", writes a file through the client with "#write",
// and replays history on session/load. Sessions live in FAKE_ACP_DIR (or the temp folder).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const dir = process.env.FAKE_ACP_DIR || path.join(os.tmpdir(), 'fake-acp');
fs.mkdirSync(dir, { recursive: true });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
let nextId = 1000;
const pending = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const history = (sid) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8'));
  } catch {
    return [];
  }
};
const remember = (sid, h) => fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify(h));

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.id != null && !m.method) return pending.get(m.id)?.(m.result ?? m.error);
  const { id, method, params = {} } = m;
  if (method === 'initialize') return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '1' }, authMethods: [] } });
  if (method === 'session/new') {
    const sid = `fake-${crypto.randomUUID()}`;
    remember(sid, []);
    return send({ id, result: { sessionId: sid } });
  }
  if (method === 'session/load') {
    for (const turn of history(params.sessionId)) {
      update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: turn.user } });
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: turn.agent } });
    }
    return send({ id, result: {} });
  }
  if (method === 'session/prompt') {
    const sid = params.sessionId;
    const text = params.prompt.map((b) => b.text ?? '').join('');
    update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } });
    let allowed = true;
    if (text.includes('#perm')) {
      const r = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 't1', title: 'Run npm test' }, options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
      allowed = r?.outcome?.outcome === 'selected' && r.outcome.optionId !== 'no';
    }
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: allowed ? 'PASS 3 tests' : 'not allowed' } }] });
    if (text.includes('#write')) {
      const target = path.join(params.cwd ?? process.cwd(), 'acp-wrote.txt');
      await ask('fs/write_text_file', { sessionId: sid, path: target, content: 'written by fake acp\n' });
      update(sid, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Edit file', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: target, oldText: '', newText: 'written by fake acp\n' }] });
    }
    const reply = `echo: ${text}${text.includes('http') ? '' : ' https://github.com/acme/demo/pull/7'}`;
    for (const part of [reply.slice(0, 6), reply.slice(6)]) update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } });
    update(sid, { sessionUpdate: 'usage_update', used: 1200, size: 200000 });
    remember(sid, [...history(sid), { user: text, agent: reply }]);
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (method === 'session/cancel') return;
  if (id != null) send({ id, error: { code: -32601, message: `unknown ${method}` } });
});
