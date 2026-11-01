#!/usr/bin/env node
// Stand-in for `claude -p --output-format json` in agentkit tests: answers each loop step
// (plan, act, check, reflect), keeps sessions (--session-id / --resume), and logs its arguments
// to FAKE_AGENTKIT_LOG. An input containing "#again" fails its first check; "#tool:<name>" makes
// the act step ask the approver (--permission-prompt-tool) for that tool first, like Claude does.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

/** Ask the approver MCP server from --mcp-config about a tool, as Claude would. */
function askApprover(tool) {
  const name = opt('--permission-prompt-tool').split('__')[1];
  const server = JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8')).mcpServers[name];
  const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  return new Promise((resolve) => {
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.id === 1) send({ id: 2, method: 'tools/call', params: { name: 'decide', arguments: { tool_name: tool, input: { ticket: 7 } } } });
      if (m.id === 2) {
        child.kill();
        resolve(JSON.parse(m.result.content[0].text));
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  });
}

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', async () => {
  const session = opt('--resume') ?? opt('--session-id');
  if (process.env.FAKE_AGENTKIT_LOG) fs.appendFileSync(process.env.FAKE_AGENTKIT_LOG, JSON.stringify({ args, prompt, cwd: process.cwd() }) + '\n');
  const stateFile = process.env.FAKE_AGENTKIT_STATE;
  const state = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const seen = (state[session] ??= { inputs: [], checks: 0 });
  const input = /New input, from [^:]+:\n([\s\S]*?)\n\n(?:Write a short|Treat the input)/.exec(prompt)?.[1];
  if (input) seen.inputs.push(input);
  let result;
  if (/Write a short numbered plan/.test(prompt)) result = `1. Look at: ${input}\n2. Do it`;
  else if (/Check your last result/.test(prompt)) result = JSON.stringify(seen.inputs.at(-1)?.includes('#again') && seen.checks++ === 0 ? { done: false, remaining: 'the second half' } : { done: true });
  else if (/remember for next time/.test(prompt)) result = `- inputs so far in this session: ${seen.inputs.length}`;
  else if (/#tool:/.test(seen.inputs.at(-1) ?? '') && opt('--permission-prompt-tool')) {
    const d = await askApprover(/#tool:(\S+)/.exec(seen.inputs.at(-1))[1]);
    result = d.behavior === 'allow' ? 'The tool ran' : `The tool was refused: ${d.message}`;
  } else result = `Did it for: ${seen.inputs.at(-1) ?? '(none)'}${/Continue with what is left/.test(prompt) ? ' (and the rest)' : ''}; session inputs ${seen.inputs.length}; system has goal: ${(opt('--append-system-prompt') ?? '').includes('Your goal:')}`;
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result, session_id: session, total_cost_usd: 0.01 }));
});
