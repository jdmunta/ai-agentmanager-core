// The entry point of a packaged agent (a single executable made by package.js). Its own files
// (agent.yaml, instructions, tests) are embedded; the first run unpacks them to ~/.agentkit/<name>/,
// where its memory and runs live too. Later runs keep that folder, so edits to its agent.yaml stay
// (until a newer build of the same agent replaces the files it shipped).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sea from 'node:sea';
import { main } from './cli.js';

const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8'));
const dir = process.env.AGENTKIT_HOME ? path.resolve(process.env.AGENTKIT_HOME) : path.join(os.homedir(), '.agentkit', manifest.name);
fs.mkdirSync(dir, { recursive: true });
const stamp = path.join(dir, '.build');
const shipped = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : '';
if (shipped !== manifest.build) {
  for (const f of manifest.files) {
    const target = path.join(dir, f);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(sea.getAsset(`files/${f}`)));
  }
  fs.writeFileSync(stamp, manifest.build);
}

main(process.argv.slice(2), { name: manifest.name, defaultRef: dir, packaged: true });
