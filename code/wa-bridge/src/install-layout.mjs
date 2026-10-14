// The layout install/install.sh creates, as seen from the running code:
//
//   ~/.wa-bridge/bin/wa-bridge        launcher (sets WA_BRIDGE_LAUNCHER + WA_BRIDGE_HOME, runs current/)
//   ~/.wa-bridge/node/<vX.Y.Z>/bin/node
//   ~/.wa-bridge/versions/<ver>/      one release each (NODE_VERSION names its Node)
//   ~/.wa-bridge/current  -> versions/<ver>
//   ~/.wa-bridge/previous -> versions/<ver>   (what `wa update --rollback` goes back to)

import { existsSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { launcherPath } from './self.mjs';

export function installLayout(env = process.env) {
  const launcher = launcherPath(env);
  if (!launcher) return null;
  const root = dirname(dirname(launcher));
  return {
    root, launcher,
    versions: join(root, 'versions'), node: join(root, 'node'),
    current: join(root, 'current'), previous: join(root, 'previous'),
  };
}

export function linkedVersion(link) {
  try { return readlinkSync(link).replace(/^versions\//, ''); } catch { return null; }
}

/** Point root/<name> at versions/<ver> atomically (rename(2) replaces the link itself, never its target). */
export function switchLink(root, name, version) {
  const tmp = join(root, `.${name}.tmp`);
  rmSync(tmp, { force: true });
  symlinkSync(`versions/${version}`, tmp);
  renameSync(tmp, join(root, name));
}

export function nodeVersionOf(layout, version) {
  try { return readFileSync(join(layout.versions, version, 'NODE_VERSION'), 'utf8').trim(); } catch { return null; }
}

export function nodeBinary(layout, nodeVersion) {
  return join(layout.node, nodeVersion, 'bin', 'node');
}

/** Delete releases other than current and previous (and leftovers of interrupted installs), then unused Node runtimes. */
export function pruneInstall(layout) {
  const keep = new Set([linkedVersion(layout.current), linkedVersion(layout.previous)].filter(Boolean));
  const removed = [];
  if (existsSync(layout.versions)) {
    for (const v of readdirSync(layout.versions)) {
      if (keep.has(v)) continue;
      rmSync(join(layout.versions, v), { recursive: true, force: true });
      removed.push(v);
    }
  }
  const nodes = new Set([...keep].map((v) => nodeVersionOf(layout, v)).filter(Boolean));
  if (existsSync(layout.node) && nodes.size) {
    for (const n of readdirSync(layout.node)) {
      if (!nodes.has(n)) { rmSync(join(layout.node, n), { recursive: true, force: true }); removed.push(`node ${n}`); }
    }
  }
  return removed;
}
