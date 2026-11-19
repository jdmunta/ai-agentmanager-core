// npm test: the unit tests, and the end-to-end tests split into slices that run side by side,
// each against a daemon and a home of its own (see E2E_PART in e2e.test.js). Each run's output is
// printed whole once it ends; the exit code is the first failure's. E2E_PARTS=1 runs them in one.
// On CI the first run to fail ends them all, so a failure is known as soon as it happens and not
// when the slowest run is through (TEST_ALL=1 lets them all finish). Not on your own computer,
// where the runs ended early would leave their daemons and browser behind.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const parts = Math.max(1, Number(process.env.E2E_PARTS) || Math.min(4, os.availableParallelism()));
const runs = [
  { label: 'unit', files: ['unit.test.js', 'agentkit.test.js'], env: {} },
  { label: 'browser', files: ['browser.test.js'], env: {} },
  ...Array.from({ length: parts }, (_, i) => ({ label: `e2e ${i + 1}/${parts}`, files: ['e2e.test.js'], env: { E2E_PART: `${i + 1}/${parts}` } })),
];

const failFast = Boolean(process.env.CI) && process.env.TEST_ALL !== '1';
const children = new Set();
let stopped = null; // the run whose failure ended the others

const run = ({ label, files, env }) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files.map((f) => path.join(here, f))], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    children.add(child);
    child.on('close', (code) => {
      children.delete(child);
      // A run ended because another failed has nothing of its own to say.
      if (stopped && stopped !== label) return resolve({ label, code: 0, out: '', cut: true });
      process.stdout.write(`\n# ---- ${label} (${Math.round((Date.now() - started) / 1000)}s, exit ${code}) ----\n${out}`);
      if (code && failFast && !stopped) {
        stopped = label;
        for (const other of children) other.kill('SIGKILL');
      }
      resolve({ label, code, out });
    });
  });

const results = await Promise.all(runs.map(run));
const num = (out, k) => Number(out.match(new RegExp(`^# ${k} (\\d+)`, 'm'))?.[1] ?? 0);
const sum = (k) => results.reduce((n, r) => n + num(r.out, k), 0);
console.log(`\n# all: ${sum('tests')} tests, ${sum('pass')} pass, ${sum('fail')} fail`);
for (const r of results) if (r.code) console.log(`# failed: ${r.label}`);
const cut = results.filter((r) => r.cut).map((r) => r.label);
if (cut.length) console.log(`# not finished, ended at that failure: ${cut.join(', ')} (TEST_ALL=1 runs them all)`);
process.exitCode = results.find((r) => r.code)?.code ?? 0;
