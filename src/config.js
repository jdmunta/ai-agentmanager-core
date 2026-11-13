import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.AGENTMGR_HOME || path.join(os.homedir(), '.agentmanager');
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.AGENTMGR_PORT || 4717);

export const paths = {
  home: HOME,
  state: path.join(HOME, 'state.json'),
  config: path.join(HOME, 'config.json'),
  log: path.join(HOME, 'daemon.log'),
  pid: path.join(HOME, 'daemon.pid'),
  workspaces: path.join(HOME, 'workspaces'),
  repos: path.join(HOME, 'repos'),
  // Shared working folder for general (no repo / folder) sessions.
  general: path.join(HOME, 'general'),
  // Holding folder for planning sessions that run while a repo is still cloning.
  planning: path.join(HOME, 'planning'),
  // Per-agent briefs (Problem / Solution / Diagram / Checks), kept outside any repo.
  briefs: path.join(HOME, 'briefs'),
  // Saved terminal output, restored into an agent's terminal after a daemon restart.
  scrollback: path.join(HOME, 'scrollback'),
  // Files attached from the UI (dropped or pasted into a terminal), per agent.
  uploads: path.join(HOME, 'uploads'),
  // Agent teams' handoff files (analysis, critiques, test reports, reviews), per team.
  teams: path.join(HOME, 'teams'),
};

const DEFAULTS = {
  // Binary used to launch agents. Override to test with a stub.
  claudeBin: process.env.AGENTMGR_CLAUDE_BIN || 'claude',
  // Extra args appended to every claude launch, e.g. ["--model", "opus"].
  claudeArgs: [],
  // Default --permission-mode for new agents ("default" passes nothing).
  permissionMode: 'default',
  // Extra regexes (strings) that identify bug keys in transcripts, e.g. ["\\bABC-\\d+\\b"].
  bugPatterns: [],
  // Terminal output kept in memory per agent so a re-opened terminal shows history.
  scrollbackBytes: 1024 * 1024,
  // How often (seconds) running agents get git / PR info refreshed.
  gitRefreshSec: 15,
  prRefreshSec: 120,
  // On daemon start, resume agents that were running when it stopped (restart, crash, reboot).
  autoResume: true,
  // Partial clone for repo URLs: history now, file contents only when checked out.
  // Much faster for big repos. Set to null for full clones.
  cloneFilter: 'blob:none',
  // Seconds between automatic flushes (scrollback, session IDs, usage, state) to disk.
  flushSec: 30,
  // Ask task agents to keep a brief (Problem / Solution / Diagram / Checks) for the UI.
  brief: true,
  // Backlog: items worked on at once per project (overridable per project), and overall.
  backlogParallel: 2,
  backlogMaxActive: 4,
  // How many one-off Claude calls (documents, Explain, Insights) run at once; the rest queue.
  summaryConcurrency: 2,
  // Model for the Explain button's one-off summary (null = Claude's default).
  explainModel: null,
  // Tell agents to review and follow CLAUDE.md, skills, hooks and settings before working.
  reviewConventions: true,
  // Pre-accept Claude's "trust this folder" prompt for the folders agents run in.
  trustAgentFolders: true,
  // A planning session moves into the repo by itself once Claude has been idle this
  // long (and, with its terminal open, you haven't typed for 15 seconds).
  handoffIdleSec: 5,
  // Task agents write a short design doc once their plan is settled and publish it as a claude.ai
  // Artifact, updated when the work is done. Per agent: designDoc. (Publish to Google Drive is a button.)
  designDoc: true,
  // Off unless asked, per agent too: a sample demo page of the change (published as an Artifact)
  // and micro benchmarks of the code it changed, before and after. Per agent: demoPage, benchmarks.
  // Each morning (weekdays), a spoken standup of the agents' news; see standup.js.
  standup: { enabled: true, at: '09:00', weekends: false, ai: true, notify: true },
  // Plan: the tech debt radar (see DEBT_DEFAULTS in debt.js) and the calendar Today is planned around
  // (its private iCal addresses and the working day; see CALENDAR_DEFAULTS in calendar.js).
  debt: { enabled: true },
  calendar: { ics: [], workStart: '09:00', workEnd: '18:00' },
  // AI News: the frontier labs' latest releases, summarized; see NEWS_DEFAULTS in news.js for every field.
  news: { enabled: true },
  demoPage: false,
  benchmarks: false,
  // The AI judge (stuck, idle screens, reviews); see JUDGE_DEFAULTS in judge.js for every field.
  judge: { enabled: true },
  // Clean up old agents: "close-delete", "close" (delete by hand), "manual" or "off"; see cleanup.js.
  cleanup: { strategy: 'close', closeAfterDays: 14, deleteAfterDays: 14 },
  // Shell used for the ancillary terminal in an agent's folder.
  shell: process.env.SHELL || '/bin/zsh',
};

export function ensureHome() {
  for (const dir of [paths.home, paths.workspaces, paths.repos, paths.general, paths.planning, paths.briefs, paths.scrollback]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Invalid ${paths.config}: ${err.message}`);
  }
  return { ...DEFAULTS, ...user };
}

/** Merges `patch` into config.json (top-level keys; objects are merged one level deep). */
export function saveConfig(patch) {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Invalid ${paths.config}: ${err.message}`);
  }
  for (const [k, v] of Object.entries(patch)) {
    user[k] = v && typeof v === 'object' && !Array.isArray(v) && user[k] && typeof user[k] === 'object' ? { ...user[k], ...v } : v;
  }
  fs.mkdirSync(path.dirname(paths.config), { recursive: true });
  fs.writeFileSync(paths.config, `${JSON.stringify(user, null, 2)}\n`);
  return user;
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
