// Keep an agent running in the background: a launchd agent (macOS) or a systemd user service
// (Linux) that starts it at login and restarts it if it crashes. It runs through your login shell,
// so it finds the engine CLIs and the tokens your terminal has.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sh = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(String(out)))));
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Where the service files go, and what they're called, for an agent. */
export function servicePaths(name, home = os.homedir()) {
  const label = `dev.agentkit.${name}`;
  return {
    label,
    plist: path.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    unitName: `agentkit-${name}.service`,
    unit: path.join(home, '.config', 'systemd', 'user', `agentkit-${name}.service`),
  };
}

/**
 * What the service runs: `argv` starts the agent in the foreground (`<exe> run` for a packaged one,
 * `node agentkit.js run <dir>` otherwise); settings that change where it lives or which engine
 * binaries it uses carry over.
 */
export function serviceSpec({ name, dir, argv, env = process.env, shell = process.env.SHELL || '/bin/sh' }) {
  const keep = {};
  for (const [k, v] of Object.entries(env)) if (/^AGENTKIT_/.test(k) && v) keep[k] = v;
  return { name, dir, log: path.join(dir, 'agent.log'), env: keep, command: [shell, '-l', '-c', `exec ${argv.map(q).join(' ')}`] };
}

export function plist(s, label = servicePaths(s.name).label) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${s.command.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>WorkingDirectory</key><string>${xml(s.dir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(s.env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>StandardOutPath</key><string>${xml(s.log)}</string>
  <key>StandardErrorPath</key><string>${xml(s.log)}</string>
</dict>
</plist>
`;
}

export function unit(s) {
  const cmd = s.command.map((a) => `"${a.replace(/(["\\])/g, '\\$1')}"`).join(' ');
  return `[Unit]
Description=agentkit agent ${s.name}

[Service]
ExecStart=${cmd}
WorkingDirectory=${s.dir}
Restart=on-failure
${Object.entries(s.env).map(([k, v]) => `Environment=${k}=${v}\n`).join('')}StandardOutput=append:${s.log}
StandardError=append:${s.log}

[Install]
WantedBy=default.target
`;
}

const uid = () => process.getuid();

export async function install(s) {
  const p = servicePaths(s.name);
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.dirname(p.plist), { recursive: true });
    await sh('launchctl', ['bootout', `gui/${uid()}/${p.label}`]).catch(() => {});
    fs.writeFileSync(p.plist, plist(s, p.label));
    await sh('launchctl', ['bootstrap', `gui/${uid()}`, p.plist]);
    return { file: p.plist, manager: 'launchd' };
  }
  if (process.platform === 'linux') {
    fs.mkdirSync(path.dirname(p.unit), { recursive: true });
    fs.writeFileSync(p.unit, unit(s));
    await sh('systemctl', ['--user', 'daemon-reload']);
    await sh('systemctl', ['--user', 'enable', '--now', p.unitName]);
    return { file: p.unit, manager: 'systemd', note: 'To keep it running when you are logged out: loginctl enable-linger $USER' };
  }
  throw new Error(`Background service is not supported on ${process.platform}`);
}

export async function uninstall(name) {
  const p = servicePaths(name);
  if (process.platform === 'darwin') {
    await sh('launchctl', ['bootout', `gui/${uid()}/${p.label}`]).catch(() => {});
    fs.rmSync(p.plist, { force: true });
    return { file: p.plist };
  }
  if (process.platform === 'linux') {
    await sh('systemctl', ['--user', 'disable', '--now', p.unitName]).catch(() => {});
    fs.rmSync(p.unit, { force: true });
    await sh('systemctl', ['--user', 'daemon-reload']).catch(() => {});
    return { file: p.unit };
  }
  throw new Error(`Background service is not supported on ${process.platform}`);
}

export async function status(name) {
  const p = servicePaths(name);
  if (process.platform === 'darwin') return { installed: fs.existsSync(p.plist), running: await sh('launchctl', ['print', `gui/${uid()}/${p.label}`]).then((o) => /state = running/.test(o), () => false), file: p.plist };
  if (process.platform === 'linux') return { installed: fs.existsSync(p.unit), running: await sh('systemctl', ['--user', 'is-active', p.unitName]).then(() => true, () => false), file: p.unit };
  return { installed: false, running: false, file: null };
}
