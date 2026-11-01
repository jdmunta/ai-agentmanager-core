#!/usr/bin/env node
// Stand-in for `claude -p --output-format json` in agentkit tests: answers each loop step
// (plan, act, check, reflect), keeps sessions (--session-id / --resume), and logs its arguments
// to FAKE_AGENTKIT_LOG. An input containing "#again" fails its first check.
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
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
  else result = `Did it for: ${seen.inputs.at(-1) ?? '(none)'}${/Continue with what is left/.test(prompt) ? ' (and the rest)' : ''}; session inputs ${seen.inputs.length}; system has goal: ${(opt('--append-system-prompt') ?? '').includes('Your goal:')}`;
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result, session_id: session, total_cost_usd: 0.01 }));
});
