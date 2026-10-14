// `wa start | stop | restart | logs`, and bringUp() shared with `wa connect`.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { call, clientConfig, ensureDaemon, stoppedFlag } from '../client.mjs';
import { ourDaemonAnswers, pidIsDaemon } from '../lifecycle.mjs';
import { installUnit, restartUnit, stopUnit, systemdAvailable, unitInstalled, unitStatus, UNIT_NAME } from '../service.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function answering() {
  const c = clientConfig(undefined, { requireToken: false });
  return !!c.token && ourDaemonAnswers(c.port, c.token);
}

async function waitUntil(pred, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await pred()) return true; await sleep(200); }
  return false;
}

/**
 * Get the daemon running for good: with systemd, install/refresh the user unit (enabled at login) and run it there,
 * handing over from a detached daemon an agent may have started earlier. Clears a `wa stop` flag.
 * Returns { via: 'systemd' | 'detached', unitCreated, started }.
 */
export async function bringUp({ service = true } = {}) {
  const { paths } = clientConfig(undefined, { requireToken: false });
  rmSync(stoppedFlag(paths), { force: true });
  let unitCreated = false;
  if (service && systemdAvailable()) {
    unitCreated = !unitInstalled();
    installUnit({ dataDir: paths.root });
    if (unitStatus()?.active !== 'active' && (await answering())) {
      // running unsupervised (spawned before the unit existed): let systemd own it from now on
      await call('POST', '/shutdown').catch(() => {});
      await waitUntil(async () => !(await answering()), 10_000);
    }
  }
  const r = await ensureDaemon({ ignoreStopped: true }); // goes through the unit whenever one is installed
  return { ...r, via: unitInstalled() && systemdAvailable() ? 'systemd' : 'detached', unitCreated };
}

export async function startCommand(pos, flags) {
  const r = await bringUp({ service: !flags['no-service'] });
  if (r.via === 'systemd') {
    console.log(`${r.started ? 'started' : 'already running'} · systemd --user ${UNIT_NAME}${r.unitCreated ? ' (installed, starts at login)' : ''}`);
  } else {
    const why = flags['no-service'] ? 'not as a service (--no-service)' : 'no systemd user session';
    console.log(`${r.started ? 'started in the background' : 'already running'} · ${why}, so it will not survive a reboot (run wa start again)`);
  }
  return 0;
}

export async function stopCommand() {
  const { paths } = clientConfig(undefined, { requireToken: false });
  writeFileSync(stoppedFlag(paths), `${new Date().toISOString()}\n`, { mode: 0o600 }); // agents' tool calls will not restart it
  let how = null;
  if (unitInstalled() && systemdAvailable()) { stopUnit(); how = 'systemd'; }
  if (await answering()) { // detached, or a stray copy next to the unit
    await call('POST', '/shutdown').catch(() => {});
    how = how || 'api';
  }
  const gone = await waitUntil(async () => !(await answering()) && !existsSync(paths.lock), 10_000);
  if (!gone && existsSync(paths.lock)) {
    const pid = Number(readFileSync(paths.lock, 'utf8').trim());
    if (pid && pidIsDaemon(pid)) { process.kill(pid, 'SIGTERM'); how = 'signal'; }
  }
  console.log(how ? 'stopped; agents will not restart it until: wa start' : 'not running');
  return 0;
}

export async function restartCommand(pos, flags) {
  const { paths } = clientConfig(undefined, { requireToken: false });
  rmSync(stoppedFlag(paths), { force: true });
  if (unitInstalled() && systemdAvailable()) {
    restartUnit();
    const ok = await waitUntil(answering, 15_000);
    console.log(ok ? `restarted · systemd --user ${UNIT_NAME}` : `restart requested, but the daemon is not answering yet; see: wa logs`);
    return ok ? 0 : 1;
  }
  await stopCommand();
  rmSync(stoppedFlag(paths), { force: true });
  return startCommand(pos, flags);
}

export async function logsCommand(pos, flags) {
  const { paths } = clientConfig(undefined, { requireToken: false });
  const lines = String(Number(flags.lines || flags.n) || 40);
  if (unitInstalled() && systemdAvailable()) {
    console.log(`== systemd journal (${UNIT_NAME}: start/stop, stdout, stderr) ==`);
    await run('journalctl', ['--user', '-u', UNIT_NAME, '-n', '15', '--no-pager', '-o', 'short-iso']);
  }
  const daily = join(paths.logs, `wa-bridge-${new Date().toISOString().slice(0, 10)}.log`);
  const files = [daily, join(paths.logs, 'daemon-stderr.log')].filter(existsSync);
  if (!files.length) { console.log(`no log files yet in ${paths.logs}`); return 0; }
  console.log(`== ${files.join(', ')} ==`);
  return run('tail', ['-n', lines, ...(flags.follow ? ['-F'] : []), ...files]);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', (e) => { console.error(`wa: ${cmd}: ${e.message}`); resolve(1); });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}
