// How to invoke this wa-bridge from elsewhere (the systemd unit, agents' MCP configs).
//
// Installed: the launcher ~/.wa-bridge/bin/wa-bridge sets WA_BRIDGE_LAUNCHER to its own absolute path, so every
// generated config points at that one stable file and never at a versioned directory (upgrades need no edits).
// From a git checkout: the current node binary plus bin/wa.mjs.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BIN_SCRIPT = fileURLToPath(new URL('../bin/wa.mjs', import.meta.url));

export function launcherPath(env = process.env) {
  const p = env.WA_BRIDGE_LAUNCHER;
  return p && existsSync(p) ? p : null;
}

/** argv prefix that runs `wa-bridge`; append e.g. ['daemon'] or ['mcp']. */
export function selfCommand(env = process.env) {
  const launcher = launcherPath(env);
  if (launcher) return [launcher];
  return [process.execPath, '--disable-warning=ExperimentalWarning', BIN_SCRIPT];
}

export const isInstalled = (env = process.env) => !!launcherPath(env);
