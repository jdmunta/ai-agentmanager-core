// The agent on stdio, for clients that start it as a program:
//   ACP (`<agent> acp`): editors and AI Agent Manager's ACP engine drive it like a coding agent.
//   MCP (`<agent> mcp`): other agents get one tool, ask_<name>, that hands it a task.
// Both are newline-delimited JSON-RPC 2.0. Nothing but protocol goes to stdout.
import crypto from 'node:crypto';
import readline from 'node:readline';

function serve(handle, { input = process.stdin, output = process.stdout } = {}) {
  const send = (m) => output.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  readline.createInterface({ input }).on('line', async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg.method) return;
    try {
      const result = await handle(msg.method, msg.params ?? {}, send);
      if (msg.id != null) send({ id: msg.id, result: result ?? {} });
    } catch (err) {
      if (msg.id != null) send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
    }
  });
}

/** ACP: sessions are conversations; a prompt is a run whose steps stream as updates. */
export function serveAcp(agent, io) {
  serve(async (method, p, send) => {
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: agent.spec.name, title: agent.spec.title, version: '1.0.0' }, authMethods: [] };
    if (method === 'session/new') return { sessionId: `ak-${crypto.randomUUID()}` };
    if (method === 'session/load') return {};
    if (method === 'session/cancel') return {};
    if (method === 'session/prompt') {
      const text = (p.prompt ?? []).map((b) => b.text ?? '').join('').trim();
      const update = (u) => send({ method: 'session/update', params: { sessionId: p.sessionId, update: u } });
      const onStep = (s) => {
        if (s.type === 'plan' || s.type === 'check' || s.type === 'reflect') update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `[${s.type}] ${s.text}\n` } });
      };
      agent.on('step', onStep);
      try {
        const r = await agent.run(text, { source: 'acp', conversation: `acp:${p.sessionId}` });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: r.result } });
        return { stopReason: r.status === 'failed' ? 'refusal' : 'end_turn' };
      } finally {
        agent.off('step', onStep);
      }
    }
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }, io);
}

/** MCP: one tool, ask_<name>, whose answer is the run's result. */
export function serveMcp(agent, io) {
  const tool = `ask_${agent.spec.name.replace(/-/g, '_')}`;
  serve(async (method, p) => {
    if (method === 'initialize') return { protocolVersion: p.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: agent.spec.name, version: '1.0.0' } };
    if (method === 'notifications/initialized' || method === 'ping') return {};
    if (method === 'tools/list') {
      return { tools: [{ name: tool, description: `${agent.spec.title}: ${agent.spec.description || agent.spec.goal}`, inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'What you want done' } }, required: ['task'] } }] };
    }
    if (method === 'tools/call') {
      if (p.name !== tool) throw Object.assign(new Error(`Unknown tool ${p.name}`), { code: -32602 });
      const r = await agent.run(String(p.arguments?.task ?? ''), { source: 'mcp' });
      return { content: [{ type: 'text', text: r.result }], isError: r.status === 'failed' };
    }
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }, io);
}

/**
 * The approver (`<agent> approver`): the MCP tool Claude asks (--permission-prompt-tool) before a
 * tool that isn't allowed outright. It hands the request to the running agent (AGENTKIT_APPROVAL_URL,
 * with AGENTKIT_APPROVAL_TOKEN), which asks a person, and answers with their decision.
 */
export function serveApprover({ url, token, fetchImpl = fetch } = {}, io) {
  serve(async (method, p) => {
    if (method === 'initialize') return { protocolVersion: p.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agentkit-approver', version: '1.0.0' } };
    if (method === 'notifications/initialized' || method === 'ping') return {};
    if (method === 'tools/list') {
      return { tools: [{ name: 'decide', description: 'Asks a person whether a tool may run', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name'] } }] };
    }
    if (method === 'tools/call') {
      const a = p.arguments ?? {};
      let d = { allow: false, message: 'No one could be asked (the agent is not reachable)' };
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ tool: a.tool_name, input: a.input ?? {} }) });
        if (res.ok) d = await res.json();
      } catch {}
      const text = d.allow ? JSON.stringify({ behavior: 'allow', updatedInput: a.input ?? {} }) : JSON.stringify({ behavior: 'deny', message: d.message || 'A person declined this' });
      return { content: [{ type: 'text', text }] };
    }
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }, io);
}
