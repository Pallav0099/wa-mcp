// `wa uninstall [--purge] [--yes]`: undo everything the installer and wa-bridge did on this machine.
//
//   agents' MCP entries + skills (exactly what agents.json recorded) → the service unit → PATH lines and aliases
//   → ~/.wa-bridge. The data directory (credentials, messages) stays unless --purge, and --purge first unlinks
//   the device on WhatsApp's side, because deleting local data never removes it from the phone's list.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { call, clientConfig, ensureDaemon, stoppedFlag } from '../client.mjs';
import { installLayout } from '../install-layout.mjs';
import { ourDaemonAnswers } from '../lifecycle.mjs';
import { systemdAvailable, uninstallUnit, unitInstalled, unitPath } from '../service.mjs';
import { confirm } from './prompt.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INSTALL_ENTRIES = ['bin/wa-bridge', 'bin/.wa-bridge.tmp', 'versions', 'node', 'current', 'previous', '.current.tmp', '.previous.tmp', '.wa-bridge-install'];

/** Delete what the installer created under root (never anything else), then root itself when it is empty. */
export function removeInstallTree(root) {
  for (const e of INSTALL_ENTRIES) rmSync(join(root, e), { recursive: true, force: true });
  if (existsSync(root)) {
    for (const f of readdirSync(root)) if (/^\.update-/.test(f)) rmSync(join(root, f), { recursive: true, force: true });
    for (const d of [join(root, 'bin'), root]) {
      try { if (!readdirSync(d).length) rmdirSync(d); } catch { /* not empty or gone */ }
    }
  }
}

/** Remove the block install.sh appended to a shell rc file (a blank line + the marked lines), leaving the rest as it was. */
export function stripPathBlock(text) {
  return text.replace(/\n?# >>> wa-bridge >>>\n[\s\S]*?# <<< wa-bridge <<<\n?/, '');
}

export async function uninstallCommand(pos, flags, { line = (s = '') => console.log(s), env = process.env } = {}) {
  const layout = installLayout(env);
  const { paths, port, token } = clientConfig(undefined, { requireToken: false });
  const what = flags.purge
    ? `Remove wa-bridge AND delete all its data in ${paths.root} (WhatsApp credentials, every stored message, media)?`
    : `Remove wa-bridge from this machine? (your data in ${paths.root} is kept)`;
  const ok = await confirm(what, { yes: flags.yes, defaultYes: false });
  if (!ok) { line('Nothing changed.'); return 1; }

  // 1. --purge: unlink on WhatsApp's side while we still can
  if (flags.purge) {
    try {
      if (existsSync(paths.auth) && !(token && (await ourDaemonAnswers(port, token)))) {
        rmSync(stoppedFlag(paths), { force: true }); // the daemon would honour a `wa stop` and exit at once
        await ensureDaemon({ ignoreStopped: true }); // WhatsApp can only be told while connected
      }
      let h = await call('GET', '/health');
      for (let i = 0; i < 40 && h.linked && h.state !== 'open' && ['starting', 'connecting', 'reconnecting'].includes(h.state); i++) {
        await sleep(500);
        h = await call('GET', '/health');
      }
      if (h.linked && h.state === 'open') {
        await call('POST', '/logout', { confirm: 'LOGOUT' });
        line('✓ unlinked from WhatsApp (the phone no longer lists this device)');
        await sleep(1500);
      } else if (h.linked) {
        line(`! not connected (${h.state}), so WhatsApp could not be told: remove "Chrome (Windows)" under Linked devices on the phone`);
      }
    } catch {
      if (existsSync(paths.auth)) line('! the daemon was not reachable: if this device is still listed under Linked devices on the phone, remove it there');
    }
  }

  // 2. agents
  try {
    const { makeContext, removeAgents, AGENTS } = await import('./agents/index.mjs');
    const ctx = makeContext({ env });
    const ids = Object.keys(ctx.manifest.agents);
    const agents = AGENTS.filter((a) => ids.includes(a.id) || a.status(ctx).mcp === 'ok');
    for (const r of removeAgents(agents, ctx)) line(r.error ? `✗ ${r.name}: ${r.error}` : `✓ ${r.name}: wa-bridge removed`);
  } catch (e) {
    line(`✗ agents: ${e.message}`);
  }

  // 3. service / daemon
  // the unit files go even without a reachable user bus (su, plain SSH): a unit left behind would point at a
  // deleted launcher and fail at every login
  if (unitInstalled()) {
    if (!systemdAvailable()) line('! the systemd user session is not reachable; removing the unit files anyway (run `systemctl --user daemon-reload` in a login session)');
    uninstallUnit();
    line(`✓ removed the background service (${unitPath()})`);
  }
  const { unscheduleBackups } = await import('./backup.mjs');
  if (unscheduleBackups()) line('✓ removed the daily backup timer (existing backups are kept)');
  if (token && (await ourDaemonAnswers(port, token))) {
    await call('POST', '/shutdown').catch(() => {});
    line('✓ stopped the daemon');
  }
  rmSync(stoppedFlag(paths), { force: true });

  // 4. PATH lines and command aliases
  const home = env.HOME || homedir();
  for (const rc of ['.profile', '.bashrc', '.zshrc'].map((f) => join(home, f))) {
    if (!existsSync(rc)) continue;
    const t = readFileSync(rc, 'utf8');
    const s = stripPathBlock(t);
    if (s !== t) { writeFileSync(rc, s); line(`✓ removed the PATH line from ${rc}`); }
  }
  const fish = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'fish', 'conf.d', 'wa-bridge.fish');
  if (existsSync(fish) && readFileSync(fish, 'utf8').includes('wa-bridge installer')) { rmSync(fish, { force: true }); line(`✓ removed ${fish}`); }
  if (layout) {
    for (const name of ['wa', 'wa-bridge']) {
      const p = join(home, '.local', 'bin', name);
      try { if (lstatSync(p).isSymbolicLink() && readlinkSync(p) === layout.launcher) { rmSync(p); line(`✓ removed ${p}`); } } catch { /* not there */ }
    }
    // 5. the install itself: only what install.sh / wa update create, then the root if that left it empty
    //    (WA_BRIDGE_INSTALL may point at a directory with other things in it; those are never touched).
    //    This process keeps running from the deleted files until it exits; that is fine on Linux.
    removeInstallTree(layout.root);
    line(existsSync(layout.root) ? `✓ removed wa-bridge from ${layout.root} (other files there were left alone)` : `✓ removed ${layout.root}`);
  } else {
    line('· running from a source checkout: the checkout itself is left alone');
  }

  // 6. data
  if (flags.purge) {
    rmSync(paths.root, { recursive: true, force: true });
    line(`✓ deleted ${paths.root}`);
  } else {
    line(`Your data is still in ${paths.root} (delete it with: rm -rf '${paths.root}')`);
  }
  line('wa-bridge is uninstalled.');
  return 0;
}
