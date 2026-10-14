// `wa update [--version X] [--force] [--rollback]` and `wa post-install` (run by install.sh and by updates).
//
// An update is verified exactly like a fresh install (release signature, Node against nodejs.org and the signed
// list, tarball against the signed list), smoke-tested before the switch, preceded by a snapshot of wa.sqlite,
// and rolled back automatically when a daemon that was running does not come back on the new version.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, clientConfig } from '../client.mjs';
import { defaultDataDir } from '../config.mjs';
import { installLayout, linkedVersion, nodeBinary, pruneInstall, switchLink } from '../install-layout.mjs';
import { ourDaemonAnswers } from '../lifecycle.mjs';
import { compareVersions, downloadUrl, hostArch, nodeMirror, parseSums, verifySums } from '../release.mjs';
import { installUnit, restartUnit, startDetached, systemdAvailable, unitInstalled, unitStatus } from '../service.mjs';
import { VERSION } from '../version.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function daemonUp() {
  const c = clientConfig(undefined, { requireToken: false });
  return !!c.token && ourDaemonAnswers(c.port, c.token);
}

async function waitFor(pred, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await pred()) return true; await sleep(300); }
  return false;
}

/** Online backup of the message store before code that may migrate it runs. Keeps the newest two. */
async function snapshotStore(fromVersion, line) {
  const dataDir = defaultDataDir();
  const db = join(dataDir, 'wa.sqlite');
  if (!existsSync(db)) return null;
  const dir = join(dataDir, 'pre-update');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, `wa-${fromVersion}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}.sqlite`);
  const { DatabaseSync, backup } = await import('node:sqlite');
  const src = new DatabaseSync(db, { readOnly: true });
  try { await backup(src, dest); } finally { src.close(); }
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sqlite')).sort().reverse().slice(2)) rmSync(join(dir, f), { force: true });
  line(`  store snapshot: ${dest}`);
  return dest;
}

export async function updateCommand(pos, flags, { line = (s = '') => console.log(s), env = process.env } = {}) {
  const layout = installLayout(env);
  if (!layout) throw new Error('wa update works on installed copies (the curl installer); in a git checkout use: git pull && npm ci');
  if (flags.rollback) return rollback(layout, line);

  const wanted = flags.version ? String(flags.version).replace(/^v/, '') : null;
  const base = downloadUrl({ version: wanted, env });
  line(`checking ${base}`);
  const sumsText = (await download(`${base}/SHA256SUMS`)).toString('utf8');
  const sig = (await download(`${base}/SHA256SUMS.sig`)).toString('utf8');
  if (!verifySums(sumsText, sig)) throw new Error('the release signature (SHA256SUMS.sig) is not valid; nothing was changed');
  const sums = parseSums(sumsText);
  const arch = hostArch();
  const appFile = sums.appFor(arch);
  const nodeFile = sums.nodeFor(arch);
  if (!appFile || !nodeFile) throw new Error(`the release has no linux-${arch} build`);
  const next = sums.version;
  if (wanted && next !== wanted) throw new Error(`asked for ${wanted} but the release is ${next}`);
  if (!wanted && !flags.force && compareVersions(next, VERSION) <= 0) { line(`wa-bridge ${VERSION} is up to date`); return 0; }

  const tmp = mkdtempSync(join(tmpdir(), 'wa-bridge-update-'));
  try {
    // Node: reuse when present, else nodejs.org, checked against nodejs.org and the signed list
    const nodeVersion = sums.node;
    const nodeBin = nodeBinary(layout, nodeVersion);
    const haveNode = existsSync(nodeBin) && spawnSync(nodeBin, ['--version'], { encoding: 'utf8' }).stdout.trim() === nodeVersion;
    if (!haveNode) {
      line(`downloading Node ${nodeVersion}`);
      const tgz = await download(`${nodeMirror(env)}/${nodeVersion}/${nodeFile}`);
      const official = (await download(`${nodeMirror(env)}/${nodeVersion}/SHASUMS256.txt`)).toString('utf8');
      const got = sha256(tgz);
      if (parseSums(official).files[nodeFile] !== got) throw new Error(`${nodeFile} does not match nodejs.org's SHASUMS256.txt`);
      if (sums.files[nodeFile] !== got) throw new Error(`${nodeFile} does not match the signed release list`);
      writeFileSync(join(tmp, nodeFile), tgz);
      const dir = nodeFile.replace(/\.tar\.gz$/, '');
      execFileSync('tar', ['-xzf', join(tmp, nodeFile), '-C', tmp, `${dir}/bin/node`, `${dir}/LICENSE`]);
      mkdirSync(join(layout.node, nodeVersion, 'bin'), { recursive: true });
      renameSync(join(tmp, dir, 'bin', 'node'), nodeBin);
      renameSync(join(tmp, dir, 'LICENSE'), join(layout.node, nodeVersion, 'LICENSE'));
    }

    line(`downloading wa-bridge ${next}`);
    const app = await download(`${base}/${appFile}`);
    if (sha256(app) !== sums.files[appFile]) throw new Error(`${appFile} does not match the signed release list`);
    writeFileSync(join(tmp, appFile), app);
    const stage = join(layout.versions, `.${next}.installing`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    execFileSync('tar', ['-xzf', join(tmp, appFile), '-C', stage, '--strip-components=1']);
    const smoke = spawnSync(nodeBin, ['--disable-warning=ExperimentalWarning', join(stage, 'bin', 'wa.mjs'), 'version', '--json'], { encoding: 'utf8' });
    let got = null;
    try { got = JSON.parse(smoke.stdout).version; } catch { /* reported below */ }
    if (got !== next) { rmSync(stage, { recursive: true, force: true }); throw new Error(`wa-bridge ${next} does not start on this machine; nothing was switched`); }

    const wasRunning = await daemonUp();
    await snapshotStore(VERSION, line);
    const from = linkedVersion(layout.current);
    if (existsSync(join(layout.versions, next))) rmSync(join(layout.versions, next), { recursive: true, force: true });
    renameSync(stage, join(layout.versions, next));
    if (from && from !== next) switchLink(layout.root, 'previous', from);
    switchLink(layout.root, 'current', next);
    line(`switched ${from || '?'} → ${next}`);

    const post = spawnSync(layout.launcher, ['post-install'], { stdio: 'inherit', env });
    if (wasRunning && !(await waitFor(daemonUp, 30_000))) {
      line(`✗ the daemon did not come back on ${next}; rolling back to ${from}`);
      if (from) {
        switchLink(layout.root, 'current', from);
        switchLink(layout.root, 'previous', next);
        spawnSync(layout.launcher, ['post-install'], { stdio: 'inherit', env });
      }
      throw new Error(`update to ${next} failed and was rolled back; see: wa logs`);
    }
    if (post.status !== 0) line('post-install steps reported a problem; run: wa doctor');
    line(`✓ wa-bridge ${next}${wasRunning ? ' is running' : ' installed'}`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function rollback(layout, line) {
  const cur = linkedVersion(layout.current);
  const prev = linkedVersion(layout.previous);
  if (!prev || !existsSync(join(layout.versions, prev))) throw new Error('there is no previous version to roll back to');
  const wasRunning = await daemonUp();
  switchLink(layout.root, 'current', prev);
  switchLink(layout.root, 'previous', cur);
  line(`switched ${cur} → ${prev}`);
  spawnSync(layout.launcher, ['post-install'], { stdio: 'inherit' });
  if (wasRunning && !(await waitFor(daemonUp, 30_000))) throw new Error(`the daemon did not come back on ${prev}; see: wa logs (a store snapshot is in the data dir under pre-update/)`);
  line(`✓ rolled back to ${prev}`);
  return 0;
}

/**
 * After the code under ~/.wa-bridge/current changed (install.sh, update, rollback): refresh the service unit,
 * restart a daemon that is running so it runs the new code, refresh the agents' skill copies, prune old releases.
 * Never starts a daemon that was not running.
 */
export async function postInstallCommand(pos, flags, { line = (s = '') => console.log(s) } = {}) {
  const layout = installLayout();
  const { paths } = clientConfig(undefined, { requireToken: false });
  if (unitInstalled() && systemdAvailable()) {
    installUnit({ dataDir: paths.root });
    if (unitStatus()?.active === 'active') {
      restartUnit();
      line(`  restarted the background service`);
    }
  } else if (await daemonUp()) {
    await call('POST', '/shutdown').catch(() => {});
    await waitFor(async () => !(await daemonUp()) && !existsSync(paths.lock), 15_000);
    startDetached(paths);
    if (await waitFor(daemonUp, 15_000)) line('  restarted the daemon');
  }
  const { makeContext, addAgents, AGENTS } = await import('./agents/index.mjs');
  const ctx = makeContext();
  const ids = Object.keys(ctx.manifest.agents);
  if (ids.length) {
    const results = addAgents(AGENTS.filter((a) => ids.includes(a.id)), ctx);
    const changed = results.filter((r) => r.mcp === 'updated' || r.skill === 'updated');
    if (changed.length) line(`  refreshed: ${changed.map((r) => r.name).join(', ')}`);
    for (const r of results.filter((x) => x.error)) line(`  ${r.name}: ${r.error}`);
  }
  if (layout) {
    const removed = pruneInstall(layout);
    if (removed.length) line(`  removed old: ${removed.join(', ')}`);
  }
  return 0;
}
