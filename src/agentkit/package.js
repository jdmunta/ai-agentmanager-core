// Package an agent as one executable (Node's single executable applications): the runtime bundled
// with esbuild, the agent's files embedded as assets, injected with postject into the official Node
// binary (from nodejs.org, same version as this one, checksum-verified, cached) for each platform.
// The prepared blob depends only on the Node version, so every platform builds from here; macOS
// ones must be signed, so they build on a Mac. The engine CLIs it drives are installed separately.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadAgent } from './spec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Assembled at run time: the literal must not appear in the bundle we inject (this file is part of
// it), or postject finds the sentinel twice.
const FUSE = ['NODE', 'SEA', 'FUSE', 'fce680ab2cc467b6e072b8b5df1996b2'].join('_');
export const HOST = `${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`;
export const PLATFORMS = ['macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64'];
const sh = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024, ...opts }, (e, out, err) => (e ? reject(new Error(`${path.basename(cmd)} failed: ${`${err}\n${out}`.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-4).join(' ') || e.message}`)) : resolve(String(out)))),
  );

/** The agent's own files to embed: agent.yaml, its instructions file, tests, and anything it names. */
function agentFiles(dir) {
  const keep = ['agent.yaml', 'agent.yml', 'agent.json', 'instructions.md', 'tests.yaml', 'README.md'];
  return keep.filter((f) => fs.existsSync(path.join(dir, f)));
}

/** One file: the runtime and its libraries (express, yaml, commander) as CommonJS. */
async function bundle(outFile) {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'agentkit', 'sea-main.js')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // import.meta.url doesn't exist in CommonJS; give the modules that use it this file's URL.
    define: { 'import.meta.url': '__agentkitUrl' },
    banner: { js: "const __agentkitUrl = require('node:url').pathToFileURL(__filename).href;" },
    logLevel: 'error',
  });
}

/** The official Node binary for a platform (this Node's version), downloaded once and checked. */
export async function nodeBinary(platform, { cacheDir, log = () => {} } = {}) {
  const v = process.version;
  const [osName, arch] = platform.split('-');
  const dist = `node-${v}-${osName === 'macos' ? 'darwin' : 'linux'}-${arch}`;
  const dir = path.join(cacheDir, dist);
  const bin = path.join(dir, 'node');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(dir, { recursive: true });
  const base = `https://nodejs.org/dist/${v}`;
  log(`downloading Node ${v} for ${platform}`);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = new RegExp(`^([0-9a-f]{64})\\s+${dist}\\.tar\\.gz$`, 'm').exec(sums)?.[1];
  if (!want) throw new Error(`nodejs.org has no ${dist}.tar.gz`);
  const res = await fetch(`${base}/${dist}.tar.gz`);
  if (!res.ok) throw new Error(`Download of ${dist} failed (HTTP ${res.status})`);
  const tgz = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(tgz).digest('hex');
  if (got !== want) throw new Error(`${dist}.tar.gz failed its checksum; not using it`);
  const tmp = path.join(dir, 'node.tar.gz');
  fs.writeFileSync(tmp, tgz);
  await sh('tar', ['-xzf', tmp, '-C', dir, '--strip-components', '2', `${dist}/bin/node`]);
  fs.rmSync(tmp);
  return bin;
}

/** Inject the blob into a copy of `nodeBin` (signature removed and re-applied for macOS). */
async function inject(nodeBin, blob, out, { mac }) {
  fs.copyFileSync(nodeBin, out);
  fs.chmodSync(out, 0o755);
  if (mac) await sh('codesign', ['--remove-signature', out]);
  await sh(process.execPath, [createRequire(import.meta.url).resolve('postject/dist/cli.js'), out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE, ...(mac ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
  if (mac) await sh('codesign', ['--sign', '-', out]);
}

/**
 * Build `<outDir>/<name>-<platform>` for an agent folder (any platform; macOS ones on a Mac).
 * Returns { file, platform, size }.
 */
export async function packageAgent(agentDir, { outDir, platform = HOST, cacheDir = path.join(os.homedir(), '.agentmanager', 'node-dist'), log = () => {} } = {}) {
  const spec = loadAgent(agentDir);
  if (spec.engine.startsWith('acp:')) throw Object.assign(new Error('ACP engines are not supported in a packaged agent yet; run its folder with agentkit'), { status: 400 });
  if (!PLATFORMS.includes(platform)) throw Object.assign(new Error(`platform: one of ${PLATFORMS.join(', ')}`), { status: 400 });
  if (platform.startsWith('macos-') && process.platform !== 'darwin') throw Object.assign(new Error('macOS executables are built on a Mac (they must be signed there)'), { status: 400 });
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `agentkit-pack-${spec.name}-`));
  try {
    log('bundling the runtime');
    await bundle(path.join(work, 'main.cjs'));
    const files = agentFiles(spec.dir);
    const assets = { 'manifest.json': path.join(work, 'manifest.json') };
    for (const f of files) assets[`files/${f}`] = path.join(spec.dir, f);
    const build = crypto.createHash('sha256').update(files.map((f) => fs.readFileSync(path.join(spec.dir, f))).join('\0')).digest('hex').slice(0, 16);
    fs.writeFileSync(assets['manifest.json'], JSON.stringify({ name: spec.name, title: spec.title, build, files }));
    const out = path.join(outDir, `${spec.name}-${platform}`);
    fs.writeFileSync(path.join(work, 'sea.json'), JSON.stringify({ main: path.join(work, 'main.cjs'), output: path.join(work, 'blob'), disableExperimentalSEAWarning: true, useCodeCache: false, assets }));
    log('preparing the blob');
    await sh(process.execPath, ['--experimental-sea-config', path.join(work, 'sea.json')]);
    const nodeBin = await nodeBinary(platform, { cacheDir, log });
    log(`making the executable for ${platform}`);
    await inject(nodeBin, path.join(work, 'blob'), out, { mac: platform.startsWith('macos-') });
    return { file: out, platform, size: fs.statSync(out).size };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
