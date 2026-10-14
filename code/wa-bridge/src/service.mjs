// Starting and stopping the daemon process.
//
// With systemd (a user session: `systemctl --user` works) the daemon runs as the user unit wa-bridge.service and is
// ALWAYS started through it, never spawned next to it. The unit restarts it after a crash (exit 1), leaves it
// stopped after `wa stop` (exit 0) and never restarts a second instance (exit 2); see lifecycle.mjs.
// Without systemd (containers, WSL without systemd) it is spawned detached with its output appended to
// logs/daemon-stdout.log and logs/daemon-stderr.log, and then does not survive a reboot.

import { mkdirSync, openSync, closeSync, existsSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfCommand } from './self.mjs';

export const DAEMON_SCRIPT = fileURLToPath(new URL('./daemon.mjs', import.meta.url));
export const UNIT_NAME = 'wa-bridge.service';

/** Run a command quietly; { status, stdout, stderr }. Injectable for tests. */
export function runQuiet(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
  return { status: r.error ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : '') };
}

export function unitPath(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'systemd', 'user', UNIT_NAME);
}

/** A user systemd instance is reachable (desktop sessions, SSH logins with lingering, most distros). */
export function systemdAvailable(run = runQuiet) {
  return process.platform === 'linux' && run('systemctl', ['--user', 'show-environment']).status === 0;
}

// systemd unit syntax: % starts a specifier and $ a variable; quote anything that is not plain.
function unitWord(s) {
  const esc = String(s).replace(/%/g, '%%').replace(/\$/g, '$$$$');
  return /^[A-Za-z0-9_\-./=:@+,%]+$/.test(esc) ? esc : `"${esc.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function unitText({ command = selfCommand(), dataDir }) {
  return [
    '# Written by wa-bridge (`wa start` / `wa connect`). Remove with: wa uninstall',
    '[Unit]',
    'Description=WA Bridge — WhatsApp gateway for AI agents',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${[...command, 'daemon'].map(unitWord).join(' ')}`,
    `Environment=${unitWord(`WA_BRIDGE_HOME=${dataDir}`)}`,
    // crash -> restart; `wa stop` (exit 0) -> stays stopped; already running (exit 2) -> never restarted
    'Restart=on-failure',
    'RestartSec=10',
    'RestartPreventExitStatus=2',
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function unitInstalled(env = process.env) {
  return existsSync(unitPath(env));
}

/** Write (or refresh) the unit and enable it at login. Returns { path, changed }. */
export function installUnit({ dataDir, command, run = runQuiet, env = process.env } = {}) {
  const path = unitPath(env);
  const text = unitText({ command, dataDir });
  const changed = !existsSync(path) || readFileSync(path, 'utf8') !== text;
  if (changed) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text, { mode: 0o644 });
    must(run('systemctl', ['--user', 'daemon-reload']), 'systemctl --user daemon-reload');
  }
  must(run('systemctl', ['--user', 'enable', UNIT_NAME]), `systemctl --user enable ${UNIT_NAME}`);
  return { path, changed };
}

export function uninstallUnit({ run = runQuiet, env = process.env } = {}) {
  const path = unitPath(env);
  if (!existsSync(path)) return false;
  run('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  rmSync(path, { force: true });
  run('systemctl', ['--user', 'daemon-reload']);
  return true;
}

export const startUnit = (run = runQuiet) => must(run('systemctl', ['--user', 'start', UNIT_NAME]), `systemctl --user start ${UNIT_NAME}`);
export const stopUnit = (run = runQuiet) => must(run('systemctl', ['--user', 'stop', UNIT_NAME]), `systemctl --user stop ${UNIT_NAME}`);
export const restartUnit = (run = runQuiet) => must(run('systemctl', ['--user', 'restart', UNIT_NAME]), `systemctl --user restart ${UNIT_NAME}`);

/** { active, sub, enabled, pid, restarts } from systemd, or null without systemd. */
export function unitStatus(run = runQuiet) {
  const r = run('systemctl', ['--user', 'show', UNIT_NAME, '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState', '-p', 'MainPID', '-p', 'NRestarts']);
  if (r.status !== 0) return null;
  const kv = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=')).map(([k, ...v]) => [k, v.join('=')]));
  return { active: kv.ActiveState, sub: kv.SubState, enabled: kv.UnitFileState, pid: Number(kv.MainPID) || null, restarts: Number(kv.NRestarts) || 0 };
}

/** Without lingering, user services stop when the user's last session ends (logout, headless reboot). */
export function lingerEnabled(run = runQuiet, user = process.env.USER) {
  const r = run('loginctl', ['show-user', user || '', '-p', 'Linger']);
  return r.status === 0 ? /Linger=yes/.test(r.stdout) : null;
}

/** Spawn the daemon detached from this process. Returns its pid. */
export function startDetached(paths, { execPath = process.execPath, env = process.env } = {}) {
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const out = openSync(join(paths.logs, 'daemon-stdout.log'), 'a', 0o600);
  const err = openSync(join(paths.logs, 'daemon-stderr.log'), 'a', 0o600);
  try {
    const child = spawn(execPath, ['--disable-warning=ExperimentalWarning', DAEMON_SCRIPT], {
      detached: true,
      stdio: ['ignore', out, err],
      env: { ...env, WA_BRIDGE_HOME: paths.root },
      windowsHide: true,
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

/**
 * Start the daemon the right way for this machine. With systemd: install the unit when asked (`install`),
 * then start it through systemd. Returns 'systemd' or 'detached'.
 */
export function startDaemonProcess(paths, { install = false, run = runQuiet, env = process.env } = {}) {
  if (systemdAvailable(run)) {
    if (unitInstalled(env) || install) {
      if (install) installUnit({ dataDir: paths.root, run, env });
      startUnit(run);
      return 'systemd';
    }
  }
  startDetached(paths, { env });
  return 'detached';
}

function must(r, what) {
  if (r.status !== 0) throw Object.assign(new Error(`${what} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`), { code: 'service_failed' });
  return r;
}
