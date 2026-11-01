#!/usr/bin/env node
// agentkit: run an agent described by agent.yaml (docs/agentkit.md).
//   agentkit run <agent> [--once "<input>"] [--port N]   triggers, chat page, API and A2A; or one run
//   agentkit acp <agent>                                  ACP on stdio
//   agentkit mcp <agent>                                  MCP on stdio (one tool: ask_<name>)
//   agentkit check <agent>                                validate agent.yaml
//   agentkit init <folder>                                a starter agent to edit
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { Agent } from '../src/agentkit/agent.js';
import { startHttp } from '../src/agentkit/http.js';
import { loadAgent } from '../src/agentkit/spec.js';
import { serveAcp, serveMcp } from '../src/agentkit/stdio.js';
import { startTriggers } from '../src/agentkit/triggers.js';

// Status goes to stderr: stdout belongs to the protocol (acp, mcp) or the result (--once).
const say = (m) => process.stderr.write(`[agentkit] ${m}\n`);
const load = (ref) => {
  const spec = loadAgent(ref);
  if (spec.missingEnv.length) say(`warning: not set in the environment: ${spec.missingEnv.join(', ')}`);
  return spec;
};

const program = new Command().name('agentkit').description('Run agents described by agent.yaml');

program
  .command('run')
  .argument('[agent]', 'the agent folder (or its agent.yaml)', '.')
  .option('--once <input>', 'do one run with this input, print the result and exit')
  .option('-p, --port <port>', 'HTTP port (default: agent.yaml interfaces.http.port, or 7700)')
  .action(async (ref, opts) => {
    const spec = load(ref);
    const agent = new Agent(spec);
    agent.on('step', (s) => s.type !== 'start' && s.type !== 'end' && say(`${s.run} ${s.type}${s.text ? `: ${String(s.text).split('\n')[0].slice(0, 120)}` : ''}`));
    if (opts.once !== undefined) {
      const r = await agent.run(opts.once, { source: 'cli' });
      process.stdout.write(`${r.result}\n`);
      process.exit(r.status === 'failed' ? 1 : 0);
    }
    say(`${spec.title} (${spec.engine}) · working in ${spec.workdir}`);
    const stop = startTriggers(agent, { log: say });
    const web = spec.interfaces.http ? await startHttp(agent, { port: opts.port ? Number(opts.port) : spec.interfaces.http.port, host: spec.interfaces.http.host, log: say }) : null;
    agent.on('run', (r) => say(`run ${r.id} ${r.status} (${r.source}, ${Math.round(r.ms / 1000)}s${r.costUsd ? `, $${r.costUsd.toFixed(3)}` : ''})`));
    const quit = async () => {
      stop();
      await web?.close();
      process.exit(0);
    };
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
  });

program
  .command('acp')
  .argument('[agent]', 'the agent folder', '.')
  .action((ref) => serveAcp(new Agent(load(ref))));

program
  .command('mcp')
  .argument('[agent]', 'the agent folder', '.')
  .action((ref) => serveMcp(new Agent(load(ref))));

program
  .command('check')
  .argument('[agent]', 'the agent folder', '.')
  .action((ref) => {
    const s = load(ref);
    console.log(`${s.title} (${s.name}): engine ${s.engine}${s.model ? ` (${s.model})` : ''}, ${Object.keys(s.tools).length} MCP server(s), triggers: ${s.triggers.map((t) => t.label).join(', ') || 'none'}; interfaces: ${['http', 'a2a', 'acp', 'mcp'].filter((k) => s.interfaces[k]).join(', ')}`);
  });

program
  .command('init')
  .argument('<folder>', 'where to create the agent')
  .option('-n, --name <name>', 'its name (default: the folder name)')
  .action((folder, opts) => {
    const dir = path.resolve(folder);
    if (fs.existsSync(path.join(dir, 'agent.yaml'))) throw new Error(`${dir} already has an agent.yaml`);
    const name = (opts.name ?? path.basename(dir)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-agent';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'agent.yaml'),
      `name: ${name}\ntitle: ${name}\ndescription: What this agent does, in one line.\ngoal: |\n  What is true when the agent has done its job.\ninstructions: instructions.md\nengine: claude\n\ntools: {}            # MCP servers, e.g.  jira: { command: npx, args: [-y, "@acme/jira-mcp"] }\nallow: [Read, Grep, Glob]\n\ntriggers: []         # e.g.  - every: 30m   - cron: "0 9 * * 1-5"   - webhook: /hooks/new   - watch: ./inbox\n\nloop: { plan: true, check: true, maxSteps: 4 }\nmemory: true\ninterfaces: { http: { port: 7700 }, a2a: true, acp: true, mcp: true }\n`,
    );
    fs.writeFileSync(path.join(dir, 'instructions.md'), '# How to do the job\n\n1. …\n2. …\n\nWhen something is unclear, say what you need rather than guessing.\n');
    console.log(`Created ${path.join(dir, 'agent.yaml')}. Edit it, then: agentkit run ${folder}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`agentkit: ${err.message}`);
  process.exit(1);
});
