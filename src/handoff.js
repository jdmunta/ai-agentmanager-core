// Moving an agent to another machine through the hub, so it continues there: same session (its
// conversation), same branch, its uncommitted work. Code travels through the repo's own remote
// (a handoff branch holding a snapshot of the folder, deleted once the move is done); the
// conversation travels through the hub in chunks; the hub keeps neither. Both machines must
// allow "move" in their hub settings.
//
// On the machine it leaves: export (close the session, snapshot and push the work, hold the
// transcript), chunk (pieces of the transcript), done (mark it moved, or start it again if the
// move failed). On the machine it joins: import (create the agent in the matching project, with
// the same session id), put (transcript pieces), finish (check out the work, place the
// conversation, resume it if it was running).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as git from './git.js';
import { projectRef } from './fleet.js';
import { engineOf } from './engines/index.js';
import { briefPath } from './brief.js';

const err = (status, message) => Object.assign(new Error(message), { status });
export const CHUNK_BYTES = 512 * 1024; // base64 keeps a piece under the runner link's 1 MB frames
const EXPIRE_MS = 30 * 60_000;
export const handoffBranch = (agentId) => `agentmgr-handoff/${agentId}`;
const MAX_TRANSCRIPT_BYTES = 200 * 1024 * 1024;
/** A plain object of links small enough to keep (they come from the other machine). */
const small = (o) => Boolean(o) && typeof o === 'object' && !Array.isArray(o) && JSON.stringify(o).length < 100_000;

/** A transcript's lines with the old folder replaced by the new one where Claude recorded it. */
export function moveTranscript(text, fromCwd, toCwd) {
  if (!fromCwd || fromCwd === toCwd) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes(fromCwd)) return line;
      try {
        const o = JSON.parse(line);
        if (o.cwd === fromCwd) o.cwd = toCwd;
        else if (typeof o.cwd === 'string' && o.cwd.startsWith(`${fromCwd}/`)) o.cwd = toCwd + o.cwd.slice(fromCwd.length);
        return JSON.stringify(o);
      } catch {
        return line;
      }
    })
    .join('\n');
}

export class Handoff {
  constructor({ manager, log = (m) => console.log(`[agentmgr] ${m}`) }) {
    this.manager = manager;
    this.log = log;
    this.exports = new Map(); // exportId -> { agentId, buf, wasRunning, at, remote, branch }
    this.imports = new Map(); // importId -> { agentId, manifest, parts: [], at }
  }

  sweep() {
    const old = Date.now() - EXPIRE_MS;
    for (const [k, v] of this.exports) if (v.at < old) this.exports.delete(k);
    for (const [k, v] of this.imports) if (v.at < old) this.imports.delete(k);
  }

  // ------------------------------------------------------------- leaving

  async export(agent) {
    this.sweep();
    const m = this.manager;
    if (agent.kind !== 'task') throw err(400, 'Only task agents can move to another machine');
    if (agent.status === 'preparing') throw err(409, 'The agent is still setting up');
    if (agent.movedTo) throw err(409, `Already moved to ${agent.movedTo.machine}`);
    const dir = agent.workdir;
    if (!dir || !(await git.isGitRepo(dir))) throw err(400, 'The agent folder is not a git repository');
    const remote = await git.run('git', ['remote', 'get-url', 'origin'], { cwd: dir }).catch(() => '');
    if (!remote) throw err(400, "The agent's repository has no remote (origin), so its work can't reach another machine");
    const engine = engineOf(agent);
    if (engine.id !== 'claude') throw err(400, `Moving ${engine.label} sessions isn't supported yet`);
    const info = m.projectInfo(agent);
    const wasRunning = Boolean(m.runtimes.get(agent.id)?.pty);
    // Close the session so Claude writes everything; it stays closed here from now on.
    await m.stop(agent.id);
    await m.flush().catch(() => {});
    const snap = await git.snapshot(dir, `agentmgr handoff of ${agent.name}`);
    if (!snap) throw err(400, 'The agent folder has no commits yet');
    const branch = handoffBranch(agent.id);
    await git.run('git', ['push', '--force', '--no-verify', 'origin', `${snap.sha}:refs/heads/${branch}`], { cwd: dir, timeout: 180_000 });
    const file = engine.sessionFile(dir, agent.sessionId);
    const buf = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    if (buf.length > MAX_TRANSCRIPT_BYTES) throw err(413, 'The conversation is too large to move');
    const exportId = crypto.randomBytes(8).toString('hex');
    this.exports.set(exportId, { agentId: agent.id, buf, wasRunning, at: Date.now(), dir, branch });
    const brief = m.briefFile?.(agent.id)?.markdown ?? null;
    this.log(`handoff: ${agent.name} packed for another machine (${buf.length} bytes of conversation, work on ${branch})`);
    return {
      exportId,
      manifest: {
        from: { agentId: agent.id, workdir: fs.realpathSync(dir) },
        name: agent.name,
        intent: agent.intent,
        priority: agent.priority,
        model: agent.model ?? null,
        permissionMode: agent.permissionMode ?? null,
        notes: agent.notes ?? null,
        baseRef: agent.baseRef ?? null,
        links: { prs: agent.prs ?? {}, bugs: agent.bugs ?? {} },
        brief: brief && brief.length < 200_000 ? brief : null,
        project: { ref: projectRef(info), name: info.name },
        branch: agent.git?.branch ?? agent.branch ?? null,
        handoffBranch: branch,
        head: snap.head,
        snapshot: snap.sha,
        sessionId: agent.sessionId,
        transcriptBytes: buf.length,
        chunks: Math.ceil(buf.length / CHUNK_BYTES),
        wasRunning,
      },
    };
  }

  chunk(exportId, i) {
    const x = this.exports.get(String(exportId));
    if (!x) throw err(404, 'That move expired; start it again');
    const n = Number(i);
    if (!(n >= 0) || n * CHUNK_BYTES >= Math.max(x.buf.length, 1)) throw err(400, 'No such piece');
    return { i: n, data: x.buf.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES).toString('base64') };
  }

  /** After the other machine answered: mark the agent moved (and drop the handoff branch), or undo. */
  async done(exportId, { ok, machine, agentId: newId } = {}) {
    const x = this.exports.get(String(exportId));
    if (!x) throw err(404, 'That move expired');
    this.exports.delete(String(exportId));
    const m = this.manager;
    if (!ok) {
      // It stays here: open it again as it was.
      await git.run('git', ['push', '--no-verify', 'origin', '--delete', x.branch], { cwd: x.dir, timeout: 60_000 }).catch(() => {});
      if (x.wasRunning) await m.start(x.agentId).catch(() => {});
      return m.get(x.agentId);
    }
    // The other machine has the work now; the branch was only the way there.
    await git.run('git', ['push', '--no-verify', 'origin', '--delete', x.branch], { cwd: x.dir, timeout: 60_000 }).catch(() => {});
    m.patch(x.agentId, { movedTo: { machine: String(machine ?? 'another machine').slice(0, 60), agentId: newId ?? null, at: new Date().toISOString() }, desired: 'stopped' });
    this.log(`handoff: ${m.store.get(x.agentId)?.name} moved to ${machine}`);
    return m.get(x.agentId);
  }

  // ------------------------------------------------------------- joining

  /** Create the agent in the project that matches, with the same session; it sets up its folder. */
  import(manifest, policy, allowedProject) {
    this.sweep();
    const m = this.manager;
    const mf = manifest && typeof manifest === 'object' ? manifest : {};
    if (!/^[\w-]{8,64}$/.test(String(mf.sessionId ?? ''))) throw err(400, 'Missing session');
    if (!/^[0-9a-f]{40,64}$/.test(String(mf.snapshot ?? '')) || !/^[0-9a-f]{40,64}$/.test(String(mf.head ?? ''))) throw err(400, 'Missing work snapshot');
    if (!/^agentmgr-handoff\/[\w-]{1,40}$/.test(String(mf.handoffBranch ?? ''))) throw err(400, 'Bad handoff branch');
    const ref = String(mf.project?.ref ?? '');
    const entry = m.listProjects().find((p) => projectRef(p) === ref);
    if (!entry) throw err(400, `This machine has no project for ${mf.project?.name ?? ref}`);
    if (!allowedProject(policy.projects, entry.name, entry.shortcut)) throw err(403, 'This machine does not share that project with the hub');
    if (m.store.list().some((a) => a.sessionId === mf.sessionId && !a.movedTo)) throw err(409, 'That session is already on this machine');
    const [agent] = m.createMany([String(mf.intent ?? '').slice(0, 10_000) || 'Moved agent'], {
      project: entry.shortcut,
      priority: mf.priority,
      model: mf.model ?? undefined,
      permissionMode: ['default', 'acceptEdits', 'plan'].includes(mf.permissionMode) ? mf.permissionMode : undefined,
      sessionId: mf.sessionId,
      start: false,
      name: mf.name ? String(mf.name).slice(0, 60) : undefined,
    });
    const importId = crypto.randomBytes(8).toString('hex');
    this.imports.set(importId, { agentId: agent.id, manifest: mf, parts: [], at: Date.now() });
    return { importId, agentId: agent.id, name: agent.name };
  }

  put(importId, i, data) {
    const x = this.imports.get(String(importId));
    if (!x) throw err(404, 'That move expired');
    const n = Number(i);
    if (!(n >= 0 && n < Math.max(1, Number(x.manifest.chunks) || 0))) throw err(400, 'No such piece');
    x.parts[n] = Buffer.from(String(data ?? ''), 'base64');
    return { i: n };
  }

  /** A move that failed after the agent was created here: remove it again. */
  async cancel(importId) {
    const x = this.imports.get(String(importId));
    if (!x) return { ok: true };
    this.imports.delete(String(importId));
    await this.manager.remove(x.agentId, { deleteWorkspace: true }).catch(() => {});
    return { ok: true };
  }

  async finish(importId, { timeoutMs = 170_000 } = {}) {
    const x = this.imports.get(String(importId));
    if (!x) throw err(404, 'That move expired');
    const m = this.manager;
    const mf = x.manifest;
    const chunks = Number(mf.chunks) || 0;
    for (let i = 0; i < chunks; i++) if (!x.parts[i]) throw err(400, `Piece ${i + 1} of the conversation is missing`);
    const buf = Buffer.concat(x.parts.slice(0, chunks));
    if (buf.length !== Number(mf.transcriptBytes)) throw err(400, 'The conversation arrived incomplete');
    // Wait for its folder (a clone or worktree of the project).
    const until = Date.now() + timeoutMs;
    let agent = m.store.get(x.agentId);
    while (agent && (agent.status === 'preparing' || !agent.workdir || !fs.existsSync(agent.workdir))) {
      if (agent.status === 'error') throw err(500, `Setting up the folder failed: ${agent.error ?? 'unknown error'}`);
      if (Date.now() > until) throw err(504, 'Setting up the folder is taking too long');
      await new Promise((r) => setTimeout(r, 500));
      agent = m.store.get(x.agentId);
    }
    if (!agent) throw err(404, 'The new agent was removed');
    const dir = agent.workdir;
    const opts = { cwd: dir, timeout: 180_000 };
    await git.run('git', ['fetch', '--no-tags', 'origin', `+refs/heads/${mf.handoffBranch}:refs/agentmgr/handoff/${agent.id}`], opts);
    const branch = /^[\w./-]{1,200}$/.test(String(mf.branch ?? '')) && !String(mf.branch).includes('..') ? mf.branch : null;
    if (branch) await git.run('git', ['checkout', '-q', '-B', branch, mf.head], opts);
    else await git.run('git', ['checkout', '-q', '--detach', mf.head], opts);
    await git.restoreSnapshot(dir, mf.snapshot);
    await git.run('git', ['update-ref', '-d', `refs/agentmgr/handoff/${agent.id}`], opts).catch(() => {});
    // The conversation, where Claude looks for it in this folder.
    const engine = engineOf(agent);
    const file = engine.sessionFile(dir, mf.sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, moveTranscript(buf.toString('utf8'), mf.from?.workdir, fs.realpathSync(dir)));
    m.patch(agent.id, {
      movedFrom: { machine: mf.fromMachine ? String(mf.fromMachine).slice(0, 60) : null, agentId: mf.from?.agentId ?? null, at: new Date().toISOString() },
      ...(mf.notes ? { notes: String(mf.notes).slice(0, 20_000) } : {}),
      ...(mf.baseRef ? { baseRef: String(mf.baseRef).slice(0, 300) } : {}),
      ...(small(mf.links?.prs) ? { prs: mf.links.prs } : {}),
      ...(small(mf.links?.bugs) ? { bugs: mf.links.bugs } : {}),
      ...(branch ? { branch } : {}),
    });
    if (mf.brief) {
      fs.mkdirSync(path.dirname(briefPath(agent.id)), { recursive: true });
      fs.writeFileSync(briefPath(agent.id), String(mf.brief));
    }
    this.imports.delete(String(importId));
    if (mf.wasRunning) await m.start(agent.id);
    this.log(`handoff: ${agent.name} arrived${mf.fromMachine ? ` from ${mf.fromMachine}` : ''}${mf.wasRunning ? ' and resumed' : ''}`);
    return m.get(agent.id);
  }
}
