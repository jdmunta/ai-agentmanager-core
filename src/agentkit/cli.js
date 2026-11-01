// The agentkit command line (bin/agentkit.js), also inside a packaged agent (sea-main.js), where
// the agent's own folder is the default and `run` is the default command.
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { Agent } from './agent.js';
import { startHttp } from './http.js';
import { loadAgent } from './spec.js';
import { install as serviceInstall, serviceSpec, status as serviceStatus, uninstall as serviceUninstall } from './service.js';
import { startReporting } from './report.js';
import { serveAcp, serveApprover, serveMcp } from './stdio.js';
import { startTriggers } from './triggers.js';

// Status goes to stderr: stdout belongs to the protocol (acp, mcp) or the result (--once).
const say = (m) => process.stderr.write(`[agentkit] ${m}\n`);
const load = (ref) => {
  const spec = loadAgent(ref);
  if (spec.missingEnv.length) say(`warning: not set in the environment: ${spec.missingEnv.join(', ')}`);
  return spec;
};

/** Run the command line; `defaultRef` is the agent folder when none is given. */
export async function main(argv, { name = 'agentkit', defaultRef = '.', packaged = false } = {}) {
  const program = new Command().name(name).description(packaged ? `${name}: an agent built with agentkit` : 'Run agents described by agent.yaml');

  program
    .command('run')
    .argument('[agent]', 'the agent folder (or its agent.yaml)', defaultRef)
    .option('--once <input>', 'do one run with this input, print the result and exit')
    .option('-p, --port <port>', 'HTTP port (default: agent.yaml interfaces.http.port, or 7700)')
    .action(async (ref, opts) => {
      const spec = load(ref);
      const agent = new Agent(spec);
      agent.on('step', (s) => s.type !== 'start' && s.type !== 'end' && say(`${s.run} ${s.type}${s.text ? `: ${String(s.text).split('\n')[0].slice(0, 120)}` : ''}`));
      agent.approvals.on('request', (a) => say(`approval needed: ${a.tool} (${a.id}); approve it ${[agent.approvals.channels.has('chat') && 'on the chat page', agent.approvals.channels.has('manager') && 'in AI Agent Manager'].filter(Boolean).join(' or ')}`));
      agent.approvals.on('decided', (d) => say(`${d.tool}: ${d.allow ? 'approved' : 'declined'} by ${d.by}`));
      let web = null;
      const reporting = spec.report ? startReporting(agent, { url: spec.report.url, token: spec.report.token, cert: spec.report.cert, chat: () => web?.url ?? null, log: say }) : null;
      if (opts.once !== undefined) {
        const r = await agent.run(opts.once, { source: 'cli' });
        await reporting?.flush();
        process.stdout.write(`${r.result}\n`);
        process.exit(r.status === 'failed' ? 1 : 0);
      }
      say(`${spec.title} (${spec.engine}) · working in ${spec.workdir}`);
      const stop = startTriggers(agent, { log: say });
      web = spec.interfaces.http ? await startHttp(agent, { port: opts.port ? Number(opts.port) : spec.interfaces.http.port, host: spec.interfaces.http.host, log: say }) : null;
      reporting?.push(); // with its chat address now
      agent.on('run', (r) => say(`run ${r.id} ${r.status} (${r.source}, ${Math.round(r.ms / 1000)}s${r.costUsd ? `, $${r.costUsd.toFixed(3)}` : ''})`));
      const quit = async () => {
        stop();
        reporting?.stop();
        agent.close();
        await web?.close();
        process.exit(0);
      };
      process.on('SIGINT', quit);
      process.on('SIGTERM', quit);
    });

  program
    .command('acp')
    .argument('[agent]', 'the agent folder', defaultRef)
    .action((ref) => serveAcp(new Agent(load(ref))));

  program
    .command('mcp')
    .argument('[agent]', 'the agent folder', defaultRef)
    .action((ref) => serveMcp(new Agent(load(ref))));

  // Started by Claude as an MCP server (see approvals.js), not by people.
  program
    .command('approver', { hidden: true })
    .action(() => serveApprover({ url: process.env.AGENTKIT_APPROVAL_URL, token: process.env.AGENTKIT_APPROVAL_TOKEN }));

  program
    .command('check')
    .argument('[agent]', 'the agent folder', defaultRef)
    .action((ref) => {
      const s = load(ref);
      console.log(`${s.title} (${s.name}): engine ${s.engine}${s.model ? ` (${s.model})` : ''}, ${Object.keys(s.tools).length} MCP server(s), triggers: ${s.triggers.map((t) => t.label).join(', ') || 'none'}; interfaces: ${['http', 'a2a', 'acp', 'mcp'].filter((k) => s.interfaces[k]).join(', ')}`);
    });

  if (!packaged)
    program
      .command('package')
      .description('Make the agent one executable to run anywhere (macOS or Linux; macOS ones are built on a Mac)')
      .argument('[agent]', 'the agent folder', defaultRef)
      .option('--platform <platform>', 'macos-arm64, macos-x64, linux-x64 or linux-arm64 (default: this computer)')
      .option('-o, --out <folder>', 'where to write it (default: <agent>/dist)')
      .action(async (ref, opts) => {
        const { packageAgent, HOST } = await import('./package.js');
        const spec = load(ref);
        const r = await packageAgent(spec.dir, { outDir: path.resolve(opts.out ?? path.join(spec.dir, 'dist')), platform: opts.platform ?? HOST, log: say });
        console.log(`${r.file} (${(r.size / 1048576).toFixed(0)} MB, ${r.platform}). Run it: ${r.file}   (needs ${spec.engine === 'claude' ? 'Claude Code' : spec.engine} installed and signed in)`);
      });
  if (!packaged)
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

  // In the background: started at login, restarted after a crash, output in <agent>/agent.log.
  const service = program.command('service').description('Keep it running in the background (launchd on macOS, systemd on Linux)');
  const serviceOf = (ref) => {
    const spec = load(ref);
    // A packaged agent runs itself; otherwise this agentkit runs the folder.
    const argv = packaged ? [process.execPath, 'run'] : [process.execPath, path.resolve(process.argv[1]), 'run', spec.dir];
    return { spec, s: serviceSpec({ name: spec.name, dir: spec.dir, argv }) };
  };
  service
    .command('install')
    .argument('[agent]', 'the agent folder', defaultRef)
    .action(async (ref) => {
      const { spec, s } = serviceOf(ref);
      const r = await serviceInstall(s);
      console.log(`${spec.title} now runs in the background (${r.manager}: ${r.file}); output in ${s.log}.${packaged ? ` Keep ${process.execPath} where it is.` : ''}${r.note ? `\n${r.note}` : ''}`);
    });
  service
    .command('uninstall')
    .argument('[agent]', 'the agent folder', defaultRef)
    .action(async (ref) => {
      const r = await serviceUninstall(load(ref).name);
      console.log(`Stopped and removed ${r.file}`);
    });
  service
    .command('status')
    .argument('[agent]', 'the agent folder', defaultRef)
    .action(async (ref) => {
      const r = await serviceStatus(load(ref).name);
      console.log(r.installed ? `installed (${r.file}); ${r.running ? 'running' : 'not running'}` : 'not installed');
    });

    // A packaged agent: `<agent>` runs it, `<agent> --once …` does one run, `<agent> acp|mcp|check` the rest.
    if (packaged && !['run', 'acp', 'mcp', 'check', 'service', 'approver', 'help', '--help', '-h', '--version'].includes(argv[0])) argv = ['run', ...argv];
    return program.parseAsync(argv, { from: 'user' }).catch((err) => {
      console.error(`${name}: ${err.message}`);
      process.exit(1);
    });
  }

