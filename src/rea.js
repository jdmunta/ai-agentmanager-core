// Whether REA (the "Reverse Engineer Anything" MCP server, github.com/morluto/rea) is registered
// with Claude Code, read from Claude Code's own files: your settings (~/.claude.json, for every
// folder and for one), and a project's .mcp.json. Nothing is run and nothing is installed here:
// setup is `npx rea-agents setup`, which you run yourself. A plugin that brings REA is not seen
// here, so "not found" is said as that, not as "not installed".

import fs from 'node:fs';
import path from 'node:path';
import { claudeConfigFile } from './trust.js';

export const REA_SETUP = 'npx rea-agents setup';
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** A registered MCP server that is REA: by its name, or by the package it runs. */
export function isRea(name, server) {
  if (/^rea([-_]agents)?$/i.test(String(name))) return true;
  const words = [server?.command, ...(Array.isArray(server?.args) ? server.args : [])].filter((x) => typeof x === 'string').join(' ');
  return /(^|[\s/\\@])rea-agents(\b|@)/.test(words);
}

/** { registered, where, name } for a folder (an agent's workspace): where REA is registered, if it is. */
export function reaStatus(dir = null, { config = claudeConfigFile() } = {}) {
  const c = read(config) ?? {};
  const real = (() => {
    try {
      return dir ? fs.realpathSync(dir) : null;
    } catch {
      return dir;
    }
  })();
  const places = [
    ['your Claude Code settings', c.mcpServers],
    ...(real ? [['this folder, in your Claude Code settings', c.projects?.[real]?.mcpServers ?? c.projects?.[dir]?.mcpServers], ["the project's .mcp.json", read(path.join(real, '.mcp.json'))?.mcpServers]] : []),
  ];
  for (const [where, servers] of places) {
    for (const [name, server] of Object.entries(servers && typeof servers === 'object' ? servers : {})) {
      if (isRea(name, server)) return { registered: true, where, name, setup: REA_SETUP };
    }
  }
  return { registered: false, where: null, name: null, setup: REA_SETUP };
}
