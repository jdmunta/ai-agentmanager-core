// The fakes (fake-claude.js, fake-gh.js, …) append a JSON line per call to a log; the tests read
// it while they are still running. A line being written is not whole yet: it is left for the next
// read (a test that waits reads again), not parsed.
import fs from 'node:fs';

/** The log's complete lines, parsed. A missing file is an empty log. */
export function readLog(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
