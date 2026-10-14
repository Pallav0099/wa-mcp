// Starting and stopping the daemon process.
//
// With a service manager (systemd --user, see M3 additions below) the daemon is ALWAYS started through it, never
// spawned next to it. Without one (containers, WSL without systemd) it is spawned detached, with its output
// appended to logs/daemon-stdout.log and logs/daemon-stderr.log; it then does not survive a reboot.

import { mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DAEMON_SCRIPT = fileURLToPath(new URL('./daemon.mjs', import.meta.url));

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
