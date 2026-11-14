#!/usr/bin/env node
// Claude Code's status line for the sessions AI Agent Manager starts. Claude Code hands its status
// line command a JSON object on stdin; for Pro, Max and Ultra plans it carries `rate_limits` (the
// 5-hour and 7-day windows: used_percentage and resets_at). This writes those numbers where the
// daemon reads them (AGENTMGR_USAGE_FILE), then prints the status line: your own status line
// command's output if you have one (AGENTMGR_USER_STATUSLINE, given the same JSON), else a short
// line with the model and what is used. Nothing is sent anywhere. Standalone: node built-ins only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let text = '';
try {
  text = fs.readFileSync(0, 'utf8');
} catch {}
let input = {};
try {
  input = JSON.parse(text);
} catch {}

const file = process.env.AGENTMGR_USAGE_FILE;
const limits = input?.rate_limits;
if (file && limits && typeof limits === 'object') {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), rate_limits: limits, version: input.version ?? null, model: input.model?.display_name ?? input.model?.id ?? null }));
    fs.renameSync(tmp, file);
  } catch {}
}

const own = process.env.AGENTMGR_USER_STATUSLINE;
if (own) {
  const r = spawnSync(own, { shell: true, input: text, encoding: 'utf8', timeout: 5000, env: { ...process.env, AGENTMGR_USER_STATUSLINE: '' } });
  if (r.stdout) process.stdout.write(r.stdout);
} else {
  const pc = (w) => (typeof w?.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : null);
  const parts = [input?.model?.display_name, pc(limits?.five_hour) && `5h ${pc(limits.five_hour)}`, pc(limits?.seven_day) && `week ${pc(limits.seven_day)}`].filter(Boolean);
  process.stdout.write(parts.join(' · '));
}
