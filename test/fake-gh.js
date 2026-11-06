#!/usr/bin/env node
// Stand-in for the gh CLI: pull requests live in $FAKE_GH_STATE (JSON { prs: [...] }, each with
// gh's own field names plus headRefName; review feedback in { feedback: { <number>: ... } }), and every
// call is logged to $FAKE_GH_LOG.
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = process.env.FAKE_GH_STATE;
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { prs: [] };
fs.appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(args)}\n`);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const pick = (pr) => {
  const fields = (opt('--json') ?? '').split(',').filter(Boolean);
  return fields.length ? Object.fromEntries(fields.map((f) => [f, pr[f] ?? null])) : pr;
};
const save = () => fs.writeFileSync(file, JSON.stringify(state));

const [group, cmd] = args;
if (group === 'pr' && cmd === 'list') {
  console.log(JSON.stringify(state.prs.filter((p) => p.headRefName === opt('--head')).map(pick)));
} else if (group === 'pr' && cmd === 'view') {
  const pr = state.prs.find((p) => p.url === args[2]);
  if (!pr) {
    console.error('no pull requests found');
    process.exit(1);
  }
  console.log(JSON.stringify(pick(pr)));
} else if (group === 'pr' && cmd === 'merge') {
  const pr = state.prs.find((p) => p.url === args[2]);
  if (!pr || pr.state !== 'OPEN') {
    console.error('Pull request is not open');
    process.exit(1);
  }
  if (!args.includes('--auto')) pr.state = 'MERGED';
  else pr.autoMerge = true;
  save();
} else if (group === 'search' && cmd === 'issues') {
  const repo = opt('--repo');
  const owner = opt('--owner');
  const label = opt('--label');
  const hits = (state.issues ?? []).filter((i) => i.state === 'OPEN' && i.labels.includes(label) && (!repo || i.repository.nameWithOwner === repo) && (!owner || i.repository.nameWithOwner.startsWith(`${owner}/`)));
  console.log(JSON.stringify(hits.map(pick)));
} else if (group === 'issue' && cmd === 'comment') {
  const issue = (state.issues ?? []).find((i) => i.url === args[2]);
  issue.comments = [...(issue.comments ?? []), opt('--body')];
  save();
} else if (group === 'pr' && cmd === 'create') {
  const number = state.prs.length + 1;
  const pr = { number, url: `https://github.com/acme/demo/pull/${number}`, title: opt('--title') ?? 'From commits', state: 'OPEN', isDraft: args.includes('--draft'), headRefName: opt('--head'), baseRefName: opt('--base') };
  state.prs.push(pr);
  save();
  console.log(pr.url);
} else if (group === 'api' && cmd === 'graphql') {
  // Review feedback: state.feedback[number] holds { comments, reviews, reviewThreads } as gh's GraphQL gives them.
  const number = args.find((a) => a.startsWith('number='))?.slice(7);
  const empty = { comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } };
  console.log(JSON.stringify({ data: { repository: { pullRequest: state.feedback?.[number] ?? empty } } }));
} else if (group === 'search' && cmd === 'prs') {
  // PRs where your review is requested: state.requested, as gh search gives them.
  console.log(JSON.stringify((state.requested ?? []).map(pick)));
} else if (group === 'api' && args.includes('--input')) {
  // A pending review: line 999 isn't in the diff, so GitHub refuses comments on it.
  const payload = JSON.parse(fs.readFileSync(opt('--input'), 'utf8'));
  if ((payload.comments ?? []).some((c) => c.line === 999)) {
    console.error('gh: Unprocessable Entity (HTTP 422): line must be part of the diff');
    process.exit(1);
  }
  state.reviews = [...(state.reviews ?? []), { path: args.find((a) => a.startsWith('repos/')), ...payload }];
  save();
  console.log(JSON.stringify({ id: 1, html_url: 'https://github.com/acme/demo/pull/5#pullrequestreview-1', state: 'PENDING' }));
} else if (group === 'pr' && cmd === 'comment') {
  console.log(`${args[2]}#issuecomment-1`);
} else {
  console.error(`fake gh: unsupported ${args.join(' ')}`);
  process.exit(1);
}
