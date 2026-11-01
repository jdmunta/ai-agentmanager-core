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
  // mcp__jira__* also covers the approval tool, so it goes through the approver instead.
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read');
  assert.ok(!args.includes('mcp__jira__*'));
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], 'mcp__agentkit_approval__decide', 'approval tools ask a person');
  assert.ok(!args.includes('--disallowedTools'));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers), ['jira', 'agentkit_approval']);
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

// Builds a real executable only when this Node's official binary is already cached (no download in
// tests); the packaged agent then runs one input through the fake engine from its own home.
const cachedNode = path.join(os.homedir(), '.agentmanager', 'node-dist', `node-${process.version}-${process.platform}-${process.arch}`, 'node');
test('package: one executable that checks and runs the agent', { skip: !['darwin', 'linux'].includes(process.platform) || !fs.existsSync(cachedNode) ? 'no cached Node binary' : false, timeout: 300_000 }, async () => {
  const { packageAgent, HOST } = await import('../src/agentkit/package.js');
  const dir = makeAgent('packed', '');
  const r = await packageAgent(dir, { outDir: path.join(tmp, 'dist'), platform: HOST, cacheDir: path.dirname(path.dirname(cachedNode)) });
  assert.equal(path.basename(r.file), `packed-${HOST}`);
  const home = path.join(tmp, 'packed-home');
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn(r.file, args, { env: { ...env, AGENTKIT_HOME: home, AK_TEST_TOKEN: 't' } });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ code, out }));
    });
  const checked = await run(['check']);
  assert.equal(checked.code, 0);
  assert.match(checked.out, /Ticket triage \(packed\)/);
  assert.ok(fs.existsSync(path.join(home, 'agent.yaml')) && fs.existsSync(path.join(home, 'instructions.md')));
  const once = await run(['--once', 'ticket 1']);
  assert.equal(once.code, 0);
  assert.ok(once.out.trim().length > 0);
  await assert.rejects(packageAgent(dir, { outDir: tmp, platform: 'windows-x64' }), /platform/);
});

test('service: a launchd agent and a systemd unit that run it through the login shell', async () => {
  const { serviceSpec, plist, unit, servicePaths } = await import('../src/agentkit/service.js');
  const s = serviceSpec({ name: 'packed', dir: '/srv/packed', argv: ["/opt/it's/packed", 'run'], env: { AGENTKIT_HOME: '/srv/packed', HOME: '/x', AGENTKIT_CLAUDE_BIN: '' }, shell: '/bin/zsh' });
  assert.deepEqual(s.env, { AGENTKIT_HOME: '/srv/packed' });
  assert.deepEqual(s.command, ['/bin/zsh', '-l', '-c', `exec '/opt/it'\\''s/packed' 'run'`]);
  const p = plist(s);
  assert.match(p, /<string>dev\.agentkit\.packed<\/string>/);
  assert.match(p, /<key>AGENTKIT_HOME<\/key><string>\/srv\/packed<\/string>/);
  assert.match(p, /<key>StandardOutPath<\/key><string>\/srv\/packed\/agent\.log<\/string>/);
  const u = unit(s);
  assert.match(u, /^ExecStart="\/bin\/zsh" "-l" "-c" "exec /m);
  assert.match(u, /Restart=on-failure/);
  assert.equal(servicePaths('packed', '/h').unit, '/h/.config/systemd/user/agentkit-packed.service');
});

test('approvals: a tool on the approve list waits for a person (chat page or AI Agent Manager); others are refused', async () => {
  const { toolMatches } = await import('../src/agentkit/approvals.js');
  assert.ok(toolMatches('mcp__jira__*', 'mcp__jira__transition') && toolMatches('Bash(git push:*)', 'Bash') && !toolMatches('mcp__jira__get', 'mcp__jira__transition'));
  const agent = new Agent(loadAgent(makeAgent('appr'), { env }), { env });
  // No one to ask yet: refused at once.
  let r = await agent.run('do #tool:mcp__jira__transition', { source: 'cli' });
  assert.match(r.result, /refused: .*no one can be asked/);
  // Off the approve list: refused without asking.
  const web = await startHttp(agent, { port: 0 });
  r = await agent.run('do #tool:mcp__slack__post', { source: 'cli' });
  assert.match(r.result, /refused: mcp__slack__post is not in this agent's allow list/);
  // On it: the chat page shows it, and a person's answer decides.
  const asked = new Promise((res) => agent.approvals.once('request', res));
  const running = agent.run('do #tool:mcp__jira__transition', { source: 'cli' });
  const a = await asked;
  const list = await (await fetch(`${web.url}/api/approvals`)).json();
  assert.deepEqual(list.map((x) => [x.tool, x.input]), [['mcp__jira__transition', { ticket: 7 }]]);
  assert.equal((await fetch(`${web.url}/api/approvals/${a.id}`, { method: 'POST', body: 'allow=true' })).status, 400, 'JSON only');
  assert.equal((await fetch(`${web.url}/api/approvals/${a.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"allow":true}' })).status, 200);
  assert.match((await running).result, /The tool ran/);
  // Declined, and the decision is kept for the views.
  const asked2 = new Promise((res) => agent.approvals.once('request', res));
  const running2 = agent.run('again #tool:mcp__jira__transition', { source: 'cli' });
  agent.approvals.decide((await asked2).id, false, { by: 'Sam', note: 'not on Fridays' });
  assert.match((await running2).result, /refused: Declined by Sam: not on Fridays/);
  assert.deepEqual(agent.approvals.decided.map((d) => d.allow), [false, true]);
  await web.close();
  agent.close();
});

test('report: runs and approvals go to AI Agent Manager, and its decisions come back', async () => {
  const { startReporting } = await import('../src/agentkit/report.js');
  const { AgentkitReports } = await import('../src/agentkit-reports.js');
  const { paths } = await import('../src/config.js');
  const before = paths.home;
  paths.home = path.join(tmp, 'mgr-home');
  try {
    const reports = new AgentkitReports();
    const token = reports.reportToken();
    // The manager's endpoint, called in-process.
    const fetchImpl = async (url, o) => {
      assert.equal(o.headers.authorization, `Bearer ${token}`);
      const reply = reports.report(JSON.parse(o.body));
      return { ok: true, status: 200, json: async () => reply };
    };
    const agent = new Agent(loadAgent(makeAgent('reported'), { env }), { env });
    const { stop } = startReporting(agent, { url: 'http://mgr', token, fetchImpl, chat: () => 'http://127.0.0.1:7700', everyMs: 50, fastMs: 20 });
    await new Promise((res) => setTimeout(res, 100));
    assert.ok(agent.approvals.channels.has('manager'));
    await agent.run('Ticket 9', { source: 'cli' });
    const asked = new Promise((res) => agent.approvals.once('request', res));
    const running = agent.run('do #tool:mcp__jira__transition', { source: 'cli' });
    const a = await asked;
    let view;
    for (let i = 0; i < 50 && !view?.pending.length; i++) (await new Promise((res) => setTimeout(res, 20))), (view = reports.list()[0]);
    assert.equal(view.name, 'reported');
    assert.equal(view.chat, 'http://127.0.0.1:7700');
    assert.ok(view.online);
    assert.equal(view.pending[0].id, a.id);
    assert.equal(view.totals.runs, 1);
    reports.decide(view.key, a.id, true, 'Ana');
    assert.throws(() => reports.decide(view.key, a.id, true), /Already decided/);
    assert.match((await running).result, /The tool ran/);
    assert.equal(agent.approvals.decided[0].by, 'Ana');
    for (let i = 0; i < 50 && reports.list()[0].totals.runs < 2; i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal(reports.list()[0].totals.runs, 2);
    assert.equal(reports.list()[0].totals.costUsd, 0.08);
    stop();
    agent.close();
    reports.save(true);
    assert.equal(new AgentkitReports().list()[0].name, 'reported', 'kept across restarts');
  } finally {
    paths.home = before;
  }
});

test('report: over https to a self-signed certificate, only the pinned one is trusted', async () => {
  const { pinnedPost } = await import('../src/agentkit/report.js');
  const { execFileSync } = await import('node:child_process');
  const crypto = await import('node:crypto');
  const https = await import('node:https');
  const key = path.join(tmp, 'k.pem');
  const cert = path.join(tmp, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  let got = null;
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => ((got = b), res.end('{"decisions":[]}')));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${server.address().port}/api/agentkit/report`;
  const pin = new crypto.X509Certificate(fs.readFileSync(cert)).fingerprint256;
  const res = await pinnedPost(url, { headers: { 'content-type': 'application/json' }, body: '{"hi":1}', pin });
  assert.ok(res.ok);
  assert.deepEqual(await res.json(), { decisions: [] });
  assert.equal(got, '{"hi":1}');
  got = null;
  await assert.rejects(pinnedPost(url, { headers: {}, body: '{"secret":1}', pin: 'AA:BB' }), /does not match/);
  assert.equal(got, null, 'nothing sent to the wrong certificate');
  server.close();
});
