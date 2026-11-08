#!/usr/bin/env node
// Stand-in for the claude CLI: records its argv, writes a transcript where
// Claude Code would, echoes input, and exits on "exit" or SIGHUP.
import fs from 'node:fs';
import path from 'node:path';
import { transcriptPath } from '../src/tracker.js';

const args = process.argv.slice(2);
if (args.includes('--desktop')) {
  // Hand-off to the Claude desktop app: recorded; FAKE_DESKTOP_FAIL makes it refuse like Claude Code does.
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), args, desktop: true }) + '\n');
  if (!process.stdout.isTTY) {
    process.stderr.write("--desktop opens the Claude Desktop app and can't run non-interactively (redirected output).\n");
    process.exit(1);
  }
  if (process.env.FAKE_DESKTOP_FAIL) {
    process.stderr.write(`${process.env.FAKE_DESKTOP_FAIL}\n`);
    process.exit(1);
  }
  process.stdout.write('Opening in Claude Desktop…\n');
  process.exit(0);
}
if (args.includes('-p')) {
  // Explain: a one-shot call that must have no tools and no MCP servers.
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    const ok = args[args.indexOf('--tools') + 1] === '' && args.includes('--strict-mcp-config');
    const section = (tag) => input.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? '';
    const conv = section('conversation');
    // The AI judge: JSON verdicts (see src/judge.js).
    const json = (o) => process.stdout.write(JSON.stringify(o), () => process.exit(0));
    if (input.startsWith('Write a short spoken standup')) {
      // The standup: each agent's facts, worded; "#plainstandup" in a fact fails the call.
      const facts = JSON.parse(section('facts') || '[]');
      if (!ok || JSON.stringify(facts).includes('#plainstandup')) return process.exit(1);
      return json({ intro: `Spoken intro for ${facts.length}.`, agents: facts.map((f) => ({ id: f.id, text: `Spoken: ${f.name} ${f.needs.length ? 'needs you.' : 'is fine.'}` })) });
    }
    if (input.startsWith('Estimate the business value')) {
      // Value: an estimate from the facts; "#novalue" in the request fails the call.
      const facts = JSON.parse(section('facts') || '{}');
      if (!ok || String(facts.request).includes('#novalue')) return process.exit(1);
      const notes = section('notes');
      return json({ humanHours: 8, savingsUsd: 500, revenueUsd: facts.pullRequests?.length ? 2000 : 0, strategic: 3, category: 'quality', summary: `Fake value for ${facts.name}${notes ? ' (with notes)' : ''}.`, confidence: 0.7, why: { hours: 'about a day', savings: 'fewer tickets', revenue: 'a customer ask', strategic: 'a notable capability' } });
    }
    if (input.startsWith('Publish documents to Google Drive')) {
      // Only the two Drive tools, none of Claude Code's own; reuse the folder it was given.
      fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), args, publish: true }) + '\n');
      const tools = args[args.indexOf('--allowedTools') + 1] ?? '';
      if (args[args.indexOf('--tools') + 1] !== '' || args.includes('--strict-mcp-config') || !/create_file/.test(tools) || !/trash_file/.test(tools)) return json({ errors: ['wrong tools'] });
      const keys = [...input.matchAll(/<document key="(\w+)" title="[^"]*">/g)].map((m) => m[1]);
      const n = (input.match(/^   - \w+: (\S+)$/gm) ?? []).length;
      return json({
        folderId: input.match(/existing folder with id "([^"]+)"/)?.[1] ?? 'folder-fake-1',
        files: keys.map((key) => ({ key, id: `doc-${key}-${n}` })),
        trashed: [...input.matchAll(/^   - \w+: (\S+)$/gm)].map((m) => m[1]),
        errors: input.includes('#half') ? ['one failed'] : [],
      });
    }
    if (input.startsWith('You supervise an AI coding agent for a person.')) {
      if (section('intent').includes('#fine')) return json({ stuck: false, confidence: 0.9, title: 'Converging', diagnosis: 'Each run fails differently', nudge: '' });
      return json({
        stuck: true,
        confidence: 0.9,
        title: 'Stuck on the 401 in auth tests',
        diagnosis: `Retrying npm test without changing the token setup${input.includes('<recent_decisions_by_this_person>') ? ' (calibrated)' : ''}`,
        nudge: 'The 401 means the test client sends no token. Check the auth fixture before rerunning npm test.',
      });
    }
    if (input.startsWith('You supervise an AI coding agent running in a terminal.')) {
      const screen = section('terminal_screen');
      if (screen.includes('Which database')) return json({ state: 'question', confidence: 0.85, summary: 'Asks which database to use', question: 'Which database should I use?', choices: ['Postgres', 'SQLite'] });
      if (screen.includes('All done')) return json({ state: 'done', confidence: 0.9, summary: 'Says the fix is finished', question: '', choices: [] });
      return json({ state: 'idle', confidence: 0.7, summary: 'Waiting for the next instruction', question: '', choices: [] });
    }
    if (input.startsWith('Two AI coding agents work on separate branches')) {
      const both = ['A', 'B'].every((t) => /intent: .*#clash/.test(section(`agent_${t}`)));
      return json(
        both
          ? { conflict: true, confidence: 0.85, reason: 'Both change how session tokens are encoded', mergeFirst: 'A', orderReason: 'A defines the new format', adviceA: 'Land first.', adviceB: 'Build on the new format.' }
          : { conflict: false, confidence: 0.9, reason: 'Unrelated changes', mergeFirst: '', orderReason: '', adviceA: '', adviceB: '' },
      );
    }
    if (input.startsWith('You plan a work order')) {
      // Goals: one task per project listed; "#bogus" also asks for a project that isn't one of them.
      const projects = [...section('projects').matchAll(/^- ([^:]+):/gm)].map((m) => m[1]);
      const outcome = input.match(/<outcome[^>]*>\n([\s\S]*?)\n<\/outcome>/)?.[1] ?? '';
      const tasks = projects.map((p) => ({ project: p, title: `Do the ${p} part of: ${outcome.split('\n')[0]}` }));
      if (outcome.includes('#bogus')) tasks.push({ project: 'nope', title: 'Not a project' });
      return json({ tasks, note: 'One task per project' });
    }
    if (input.startsWith('You check a work order')) {
      // "#more" in the outcome: one more task the first time, then met.
      const outcome = input.match(/<outcome[^>]*>\n([\s\S]*?)\n<\/outcome>/)?.[1] ?? '';
      const done = input.match(/<done>\n([\s\S]*?)\n<\/done>/)?.[1] ?? '';
      const project = input.match(/<projects>\n- ([^:]+):/)?.[1];
      if (outcome.includes('#more') && !done.includes('Finish the rest')) return json({ met: false, reason: 'The docs are missing', tasks: [{ project, title: 'Finish the rest: the docs' }] });
      return json({ met: true, reason: 'Every part was delivered', tasks: [] });
    }
    if (input.startsWith('You schedule a backlog')) {
      const items = [...section('queued').matchAll(/^- (\S+) \[P\d\] \([^)]*\) (.+)$/gm)].map((m) => ({ id: m[1], title: m[2] }));
      const build = items.find((i) => i.title.startsWith('Build'));
      const active = section('in_progress');
      const buildId = build?.id ?? active.match(/^- (\S+) .*Build/m)?.[1];
      return json({
        order: [...items.filter((i) => i === build), ...items.filter((i) => i !== build)].map((i) => i.id),
        hold: items.filter((i) => i.title.includes('#needs-api') && buildId).map((i) => ({ id: i.id, after: buildId, reason: 'Needs the API first' })),
        split: items.filter((i) => i.title.includes('#bundle')).map((i) => ({ id: i.id, reason: 'Three independent tasks', parts: ['Write the docs', 'Add the tests', 'Set up CI'] })),
      });
    }
    if (input.startsWith('You triage alerts')) {
      const kind = input.match(/<alert kind="(\w+)">/)?.[1];
      return json(kind === 'stuck' ? { urgency: 'digest', confidence: 0.8, line: 'Retrying npm test; can wait' } : { urgency: 'now', confidence: 0.8, line: '' });
    }
    if (input.startsWith("You review an AI coding agent's work")) {
      return json({ verdict: 'partial', confidence: 0.8, summary: `Root cause fixed for: ${section('intent')}`, met: ['Root cause found'], missing: ['Manual SSO login not verified'], risks: ['No e2e run'] });
    }
    if (input.startsWith('You help a person supervise')) {
      // Human vs AI, first pass: JSON (wrapped in a fence, as models sometimes do).
      const reply = {
        title: section('intent'),
        human: [1, 2, 3, 4, 5, 6].map((i) => ({ question: `Human question ${i}?`, why_human: 'Needs intent', stakes: 'Wrong product', options: ['A', 'B'], lean: i === 1 ? 'A' : null })),
        ai: [{ question: 'Do the tests pass?', answer: ok ? 'Safe call: yes.' : 'UNSAFE', confidence: 'high', evidence: ['npm test'], check: 'Run npm test' }],
      };
      process.stdout.write('```json\n' + JSON.stringify(reply) + '\n```\n', () => process.exit(0));
      return;
    }
    if (input.startsWith('You check one test of an autonomous agent')) return json({ pass: !section('input').includes('Invoice'), why: 'checked' });
    if (input.startsWith("You score an AI coding agent's changes")) {
      const ids = [...input.matchAll(/<hunk id="(H\d+)"/g)].map((m) => m[1]);
      return json({
        summary: `Scored: ${section('intent').split('\n').find((l) => l.startsWith('# ')) ?? 'no intent file'}`,
        scores: { intent: { score: 88, why: 'Does what was asked' }, scope: { score: 92, why: 'On task' }, plan: { score: 80, why: 'As planned' }, tests: { score: 90, why: 'Tested' }, safety: { score: 85, why: 'Nothing risky' } },
        criteria: [],
        look: ids.slice(0, 1).map((id) => ({ id, reason: 'The core change' })),
      });
    }
    if (input.startsWith("You help a person review an AI coding agent's changes")) {
      // Every hunk but the last, in reverse order (a reading order other than the diff's).
      const ids = [...input.matchAll(/<hunk id="(H\d+)" file="([^"]+)">/g)].map((m) => [m[1], m[2]]);
      return json({
        summary: `Changes for: ${section('intent')}`,
        changes: ids.slice(0, -1).reverse().map(([id, file]) => ({ id, title: `Change ${id}`, what: `Edits ${file}`, why: 'Asked for', risk: id === 'H1' ? 'high' : 'nonsense', check: 'Run it' })).concat([{ id: 'H99', title: 'ghost' }]),
      });
    }
    if (input.startsWith('Draw diagrams')) {
      // Prose around the diagrams (to be stripped), and what it was given to draw from.
      const docs = (input.match(/<document title="([^"]+)">/g) ?? []).map((m) => m.slice(17, -2));
      process.stdout.write(
        `Here are the diagrams.\n# Diagrams: ${section('intent')}\nIntro paragraph.\n## Architecture\n- a bullet\n\`\`\`mermaid\nflowchart LR\n  A["${docs.join(' + ') || 'none'}"] e1@--> B\n  e1@{ animate: true }\n\`\`\`\nA caption.\n## Empty\nNothing drawn.\n## Key interaction\n\`\`\`mermaid\nsequenceDiagram\n  autonumber\n  A->>B: hi\n\`\`\`\nThat's all.\n`,
        () => process.exit(0),
      );
      return;
    }
    const doc = input.match(/^Write a (\w+) document/)?.[1];
    if (doc) {
      process.stdout.write(
        `# ${doc}: ${section('intent')}\n## Summary\n${ok ? 'Safe call.' : 'UNSAFE call.'}\n## Architecture\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`,
        () => process.exit(0),
      );
      return;
    }
    if (/Why[\s\S]*What[\s\S]*How[\s\S]*Now/.test(input.split('<agent_status>')[0])) {
      process.stdout.write(
        `### Why\n- ${ok ? 'Safe call' : 'UNSAFE'}: ${section('intent')}\n### What\n- One\n### How\n- Two\n### Now\n- saw agent text: ${conv.includes('[agent] Looking at')}\n`,
        () => process.exit(0),
      );
      return;
    }
    process.stdout.write(
      `### The ask\n${ok ? 'Safe call.' : 'UNSAFE call.'} Intent: ${section('intent')}\n` +
        `### Where it stands\n${section('agent_status').split('\n')[0]}\n` +
        `### Conclusions so far\nsaw agent text: ${conv.includes('[agent] Looking at')}; repo: ${section('repository').split('\n')[0]}\n`,
      () => process.exit(0),
    );
  });
  await new Promise(() => {});
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sid = flag('--session-id') ?? flag('--resume');
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\n');

const file = transcriptPath(process.cwd(), sid);
fs.mkdirSync(path.dirname(file), { recursive: true });
const write = (rec) => fs.appendFileSync(file, JSON.stringify({ sessionId: sid, ...rec }) + '\n');
write({ type: 'ai-title', aiTitle: 'Fake session title' });
write({
  type: 'assistant',
  message: {
    id: `msg_${Date.now()}`,
    usage: { input_tokens: 12, output_tokens: 34, cache_creation_input_tokens: 56, cache_read_input_tokens: 78 },
    content: [{ type: 'text', text: 'Looking at https://jira.example.com/browse/ABC-4242 now' }],
  },
});
write({ type: 'pr-link', prNumber: 7, prUrl: 'https://github.com/example/repo/pull/7' });

const briefDir = flag('--add-dir');
if (briefDir) {
  fs.writeFileSync(
    path.join(briefDir, 'BRIEF.md'),
    [
      '# Brief',
      // "#done" in the intent: act as if the task is finished.
      (args.includes('--') && args[args.indexOf('--') + 1]?.includes('#done')) || process.env.FAKE_DONE ? 'Status: done' : 'Status: working',
      '## Problem',
      'Login fails for **SSO** users.',
      '## Solution',
      'Fix the token refresh in `auth/session.go`.',
      '## Diagram',
      '```mermaid',
      'flowchart LR',
      '  A[Browser] --> B[Auth service]',
      '```',
      'Token flow after the fix.',
      '## Results',
      'Outcome: blocked',
      '- Delivered: Root cause found in `auth/session.go`',
      '- Blocked by: staging credentials (needs: platform team)',
      '## References',
      '- **PRD**: [SSO login PRD](https://confluence.example.com/prd/42) — sessions must survive token rotation',
      '- **Tech Spec**: none on ABC-4242',
      '## Checks',
      // "#green" in the intent: every check passed.
      ...(args.includes('--') && args[args.indexOf('--') + 1]?.includes('#green') ? ['- [x] go test ./auth/...', '- [x] e2e login suite'] : ['- [x] go test ./auth/...', '- [!] e2e login suite', '- [~] lint', '- [ ] manual SSO login']),
      '',
    ].join('\n'),
  );
}
const prompt = args.includes('--') ? args[args.indexOf('--') + 1] ?? '' : '';
// A session building an agent (src/builder.js): write the agent's files in its folder, as Claude would.
const building = prompt.match(/^Build the agent "([a-z0-9-]+)" \(engine: ([^)]+)\) for this task:\n\n([\s\S]*?)\n\nWrite /);
if (building) {
  const [, name, engine, task] = building;
  fs.writeFileSync('analysis.json', JSON.stringify({ analysis: { problem: `Handle: ${task.slice(0, 40)}`, inputs: ['a ticket'], outputs: ['a label'], risks: ['wrong label'] }, tools: [] }));
  fs.writeFileSync('agent.yaml', `name: ${name}\ntitle: Ticket labeler\ndescription: Labels tickets.\ngoal: Every ticket gets one product-area label.\ninstructions: instructions.md\nengine: ${engine}\ntools: {}\nallow: [Read]\napprove: []\ntriggers:\n  - webhook: /hooks/ticket\nloop: { plan: true, check: true, maxSteps: 4 }\nmemory: true\ninterfaces: { http: { port: 0 }, a2a: true, acp: true, mcp: true }\n`);
  fs.writeFileSync('instructions.md', '1. Read the ticket.\n2. Pick a label.\n');
  fs.writeFileSync('tests.yaml', '- input: Login page crashes\n  expect: labelled auth\n- input: Invoice total wrong\n  expect: labelled billing\n');
}
// A reviewer (src/reviews.js): write REVIEW.json next to the brief, with one blocker, a question and a nit.
const reviewing = prompt.match(/^Review (https:\/\/\S+\/pull\/\d+)/);
if (reviewing && briefDir) {
  fs.writeFileSync(
    path.join(briefDir, 'REVIEW.json'),
    JSON.stringify({
      pr: reviewing[1],
      headSha: process.env.FAKE_REVIEW_HEAD || 'abc1234def',
      verdict: 'approve',
      why: 'The retry loop can spin forever.',
      summary: 'Adds retries to the upload client.',
      blockers: [{ id: 'b1', title: 'Unbounded retry', file: 'src/upload.js', line: 42, category: 'correctness', why: 'No attempt limit: a dead server loops forever.', unblock: 'Cap attempts at 5.', status: 'open' }],
      questions: [{ id: 'q1', question: 'Why retry on 400s?', why: 'Client errors will not succeed on retry.', file: null, line: null }],
      risks: ['More load on a failing server.'],
      testGaps: ['No test for the give-up path.'],
      nits: [{ id: 'n1', text: 'Name the constant.', file: 'src/upload.js', line: 999 }],
      tests: 'npm test: 12 passed.',
    }),
  );
}
// A bug hunter (src/bughunt.js): two findings, one with a failing test, one traced; then done.
if (prompt.startsWith('Bug hunt:') && briefDir) {
  fs.writeFileSync(
    path.join(briefDir, 'FINDINGS.json'),
    JSON.stringify({
      headSha: 'feed1234beef',
      covered: ['src/'],
      findings: [
        { title: 'Upload retries forever on a dead server', file: 'src/upload.js', line: 42, kind: 'correctness', severity: 'high', why: 'No attempt limit.', evidence: { type: 'test', detail: 'FAIL upload.test.js: timed out after 5000ms', test: "test('gives up', ...)" }, fix: 'Cap attempts at 5.', confidence: 0.9 },
        { title: 'Maybe a race in the cache', file: 'src/cache.js', line: 7, kind: 'concurrency', severity: 'medium', why: 'Two writers could overlap.', evidence: { type: 'trace', detail: 'cache.js:7 -> cache.js:12' }, confidence: 0.5 },
      ],
      notes: 'Checked src/.',
    }),
  );
  const brief = path.join(briefDir, 'BRIEF.md');
  fs.writeFileSync(brief, fs.readFileSync(brief, 'utf8').replace('Status: working', 'Status: done'));
}
// "#stuck": the same command failing the same way three times.
if (prompt.includes('#stuck')) {
  for (let i = 0; i < 3; i++) {
    const id = `toolu_${sid.slice(0, 8)}_${i}`;
    const timestamp = new Date().toISOString();
    write({ type: 'assistant', timestamp, message: { id: `msg_stuck_${i}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } });
    write({ type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Exit code 1\nFAIL auth.test.js: expected 200, got 401' }] } });
  }
}
// "#question": a question for the decision inbox, next to the brief.
if (prompt.includes('#question') && briefDir) {
  fs.writeFileSync(
    path.join(briefDir, 'QUESTIONS.md'),
    '## Postgres or SQLite for the cache?\nOptions: Postgres | SQLite\nDefault: SQLite\nThe data set is small.\n',
  );
}
// "#signin": like `railway login`, print a sign-in link whose callback is a port on this machine.
if (prompt.includes('#signin')) {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    const code = new URL(req.url, 'http://x').searchParams.get('code');
    res.end(`<h1>Logged in</h1><p>code ${code}</p>`);
    process.stdout.write(`\r\nLogged in with code ${code}\r\n`);
  });
  srv.listen(0, '127.0.0.1', () => {
    const cb = encodeURIComponent(`http://127.0.0.1:${srv.address().port}/callback`);
    process.stdout.write(`\r\nOpen this link to sign in:\r\nhttps://backboard.example.com/oauth/auth?response_type=code&client_id=c1&redirect_uri=${cb}&state=s1\r\n`);
  });
}
// "#waiting" / "#finish": plain words a rule can't recognize; the AI judge reads them.
if (prompt.includes('#waiting')) setTimeout(() => process.stdout.write('\r\nWhich database should I use for the cache, Postgres or SQLite?\r\n'), 200);
if (prompt.includes('#finish')) setTimeout(() => process.stdout.write('\r\nAll done: the token refresh fix is in.\r\n'), 200);
// The tool call a permission prompt asks about ("#run(<command>)", else npm test), in the transcript
// before the menu shows, as Claude Code writes it; answering "1" gives it a result.
let asked = null;
if (args.includes('--') && args[args.indexOf('--') + 1]?.includes('#ask')) {
  asked = `toolu_ask_${Date.now()}`;
  write({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: `msg_ask_${Date.now()}`, content: [{ type: 'tool_use', id: asked, name: 'Bash', input: { command: /#run\(([^)]+)\)/.exec(prompt)?.[1] ?? 'npm test' } }] } });
  setTimeout(() => process.stdout.write('\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n'), 200);
  // "#blink": keep blinking the ⏺ beside the tool call above the prompt, as newer Claude Code does.
  if (prompt.includes('#blink')) {
    let on = false;
    setTimeout(() => setInterval(() => process.stdout.write(`\x1b[1C\x1b[7A\r\x1b[23A\x1b[38;2;153;153;153m${(on = !on) ? '⏺' : ' '}\x1b[39m\r\r\n${'\r\n'.repeat(22)}`), 300), 400);
  }
}
process.stdout.write(`fake-claude ready ${args.includes('--resume') ? 'resumed' : 'new'} ${sid}\r\n`);
process.stdin.setRawMode?.(true);
process.stdin.on('data', (d) => {
  const s = d.toString();
  if (s.includes('exit')) process.exit(3);
  if (asked && s === '1') {
    write({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: asked, content: 'ok' }] } });
    asked = null;
    // The tool runs and its output scrolls the menu away, as in Claude Code.
    process.stdout.write(`\r\n${'Ran the command: ok\r\n'.repeat(90)}`);
  }
  process.stdout.write(`echo:${s}`);
});
// FAKE_CLAUDE_HUP_DELAY_MS: take that long to close, like a busy session.
process.on('SIGHUP', () => setTimeout(() => process.exit(0), Number(process.env.FAKE_CLAUDE_HUP_DELAY_MS) || 0));
