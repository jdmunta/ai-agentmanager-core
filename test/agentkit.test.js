// agentkit: the runtime for agents built from agent.yaml (docs/agentkit.md), with a fake engine.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Agent, verdictOf } from '../src/agentkit/agent.js';
import { startHttp } from '../src/agentkit/http.js';
import { checkAgent, loadAgent } from '../src/agentkit/spec.js';
import { cronMatches } from '../src/agentkit/triggers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkit-'));
const env = { ...process.env, AGENTKIT_CLAUDE_BIN: `${process.execPath} ${path.join(here, 'fake-agentkit-claude.js')}`, FAKE_AGENTKIT_LOG: path.join(tmp, 'engine.log'), FAKE_AGENTKIT_STATE: path.join(tmp, 'engine-state.json') };
const calls = () => fs.readFileSync(env.FAKE_AGENTKIT_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function makeAgent(name, extra = '') {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'instructions.md'), 'Label it, then draft a reply.\n');
  fs.writeFileSync(path.join(dir, 'agent.yaml'), `name: ${name}\ntitle: Ticket triage\ngoal: Every ticket is labelled.\ninstructions: instructions.md\nengine: claude\ntools:\n  jira: { command: jira-mcp, env: { TOKEN: \"\${AK_TEST_TOKEN}\" } }\nallow: [Read, "mcp__jira__*"]\napprove: [mcp__jira__transition]\ninterfaces: { http: { port: 0 } }\n${extra}`);
  return dir;
}

test('spec: defaults, ${VAR} from the environment, instructions from a file, mistakes reported together', () => {
  const s = loadAgent(makeAgent('spec-a'), { env: { AK_TEST_TOKEN: 'secret' } });
  assert.equal(s.instructions, 'Label it, then draft a reply.');
  assert.equal(s.tools.jira.env.TOKEN, 'secret');
  assert.deepEqual(s.missingEnv, []);
  assert.deepEqual(s.loop, { plan: true, check: true, maxSteps: 4, budgetUsd: null });
  assert.equal(s.workdir, path.join(tmp, 'spec-a', 'work'));
  assert.deepEqual(loadAgent(makeAgent('spec-b'), { env: {} }).missingEnv, ['AK_TEST_TOKEN']);
  assert.throws(() => checkAgent({ name: 'Bad Name', engine: 'gpt', triggers: [{ every: '1s' }, { cron: '* *' }, { nope: 1 }] }, { dir: tmp }), (e) => e.errors.length === 6);
  assert.equal(checkAgent({ name: 'ok', goal: 'g', engine: 'acp:opencode' }, { dir: tmp }).engine, 'acp:opencode');
});

test('loop: plan, act, check (and act again on what is left), reflect into memory; tools and approvals reach the engine', async () => {
  const agent = new Agent(loadAgent(makeAgent('loop'), { env }), { env });
  const r = await agent.run('Ticket 7 #again', { source: 'cli' });
  assert.equal(r.status, 'done');
  assert.match(r.result, /Did it for: Ticket 7 #again \(and the rest\)/);
  assert.equal(r.costUsd, 0.06, 'six engine turns');
  const c = calls().slice(-6);
  assert.deepEqual(c.map((x) => (x.args.includes('--resume') ? 'resume' : 'new')), ['new', 'resume', 'resume', 'resume', 'resume', 'resume'], 'one session for the run');
  assert.match(c[0].prompt, /^Your goal \(this is your whole job\): Every ticket is labelled\.\n\nNew input, from a request:\nTicket 7 #again/);
  const args = c[0].args;
  assert.ok(args.includes('--mcp-config') && args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project', "the person's own Claude settings stay out");
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 3), ['Read', 'mcp__jira__*']);
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'mcp__jira__transition', 'approval tools kept out of reach');
  assert.equal(c[0].cwd, fs.realpathSync(path.join(tmp, 'loop', 'work')));
  assert.match(fs.readFileSync(path.join(tmp, 'loop', '.agentkit', 'memory.md'), 'utf8'), /- inputs so far/);
  // Memory goes into the next run's system prompt; the run is in the log.
  await agent.run('Ticket 8', { source: 'every 10m' });
  const second = calls().at(-4); // plan, act, check (done), reflect
  assert.match(second.args[second.args.indexOf('--append-system-prompt') + 1], /What you learned in earlier runs/);
  assert.match(second.prompt, /from a trigger \(every 10m\)/);
  assert.deepEqual(agent.runs().map((x) => x.input), ['Ticket 8', 'Ticket 7 #again']);
  assert.deepEqual(verdictOf('sure {"done": false, "remaining": "x"}'), { done: false, remaining: 'x' });
  assert.equal(verdictOf('The goal is not met yet').done, false);
});

test('http: chat keeps a conversation, the API runs and lists, webhooks trigger, A2A card and tasks', async () => {
  const agent = new Agent(loadAgent(makeAgent('web', 'triggers:\n  - webhook: /hooks/ticket\n'), { env }), { env });
  const web = await startHttp(agent, { port: 0 });
  const post = (p, body) => fetch(`${web.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    assert.match(await (await fetch(web.url)).text(), /<title>Ticket triage<\/title>/);
    const a = await post('/api/chat', { message: 'first', conversation: 'c1' });
    const b = await post('/api/chat', { message: 'second', conversation: 'c1' });
    assert.match(a.result, /session inputs 1/);
    assert.match(b.result, /session inputs 2/, 'the follow-up continued the engine session');
    assert.equal((await post('/api/chat', {})).error, 'message is required');
    assert.equal((await post('/hooks/ticket', { id: 99 })).accepted, true);
    await new Promise((r) => setTimeout(r, 300));
    await agent.queue;
    assert.ok(agent.runs().some((x) => x.source === 'webhook /hooks/ticket' && x.input === '{"id":99}'));
    const card = await (await fetch(`${web.url}/.well-known/agent.json`)).json();
    assert.equal(card.name, 'Ticket triage');
    assert.equal(card.url, `${web.url}/a2a`);
    const sent = await post('/a2a', { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'triage ticket 5' }] } } });
    assert.equal(sent.result.status.state, 'completed');
    assert.match(sent.result.artifacts[0].parts[0].text, /Did it for: triage ticket 5/);
    const got = await post('/a2a', { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: sent.result.id } });
    assert.equal(got.result.id, sent.result.id);
    assert.equal((await post('/a2a', { jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
  } finally {
    await web.close();
  }
});

/** Start `agentkit <cmd> <agent>` and talk JSON-RPC to it over stdio. */
function stdioClient(cmd, dir) {
  const child = spawn(process.execPath, [path.join(here, '..', 'bin', 'agentkit.js'), cmd, dir], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  const updates = [];
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    if (m.method === 'session/update') updates.push(m.params.update);
    else waiting.get(m.id)?.(m);
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { call, updates, close: () => child.kill() };
}

test('stdio: as an MCP tool, and as an ACP agent with its steps streamed', async () => {
  const dir = makeAgent('stdio');
  const mcp = stdioClient('mcp', dir);
  try {
    assert.equal((await mcp.call('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'stdio');
    const tools = (await mcp.call('tools/list', {})).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ['ask_stdio']);
    const r = await mcp.call('tools/call', { name: 'ask_stdio', arguments: { task: 'from another agent' } });
    assert.match(r.result.content[0].text, /Did it for: from another agent/);
  } finally {
    mcp.close();
  }
  const acp = stdioClient('acp', dir);
  try {
    assert.equal((await acp.call('initialize', { protocolVersion: 1 })).result.protocolVersion, 1);
    const { sessionId } = (await acp.call('session/new', { cwd: dir, mcpServers: [] })).result;
    const r = await acp.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'from an editor' }] });
    assert.equal(r.result.stopReason, 'end_turn');
    assert.ok(acp.updates.some((u) => u.sessionUpdate === 'agent_thought_chunk' && /^\[plan\]/.test(u.content.text)), 'plan streamed as thoughts');
    assert.match(acp.updates.find((u) => u.sessionUpdate === 'agent_message_chunk').content.text, /Did it for: from an editor/);
  } finally {
    acp.close();
  }
});

test('triggers: cron fields (lists, ranges, steps)', () => {
  const d = new Date(2026, 10, 2, 9, 30); // Monday 09:30
  assert.ok(cronMatches('30 9 * * 1-5', d));
  assert.ok(cronMatches('*/15 * * * *', d));
  assert.ok(!cronMatches('0 9 * * *', d));
  assert.ok(cronMatches('0,30 8-10 2 11 1', d));
  assert.ok(!cronMatches('30 9 * * 0,6', d));
});
