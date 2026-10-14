#!/usr/bin/env node
// End-to-end test of the release pipeline and install/install.sh, without touching the real home directory.
//
//   node scripts/test-install.mjs [--node-cache <dir>] [--serve-only] [--keep]
//
// 1. copies this checkout to a temp dir and patches in a throwaway signing key (the real key never leaves CI)
// 2. builds two releases (current version, and current+1 for the update test), writes and signs SHA256SUMS
// 3. serves them, plus a Node mirror, from a local HTTP server
// 4. (unless --serve-only) runs install.sh in a throwaway HOME and checks: install, re-install, wa version,
//    wa doctor, a daemon start (detached), wa update, wa update --rollback, wa uninstall
// With --serve-only it prints the URLs and keeps serving (CI runs install.sh inside Docker images against it).

import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, cpSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
const flag = (n) => process.argv.includes(`--${n}`);
const nodeVersion = `v${readFileSync(join(ROOT, '.node-version'), 'utf8').trim().replace(/^v/, '')}`;
// the "next" release runs on a different Node, so `wa update` has to install a new runtime (like a real bump)
const nextNode = arg('next-node') || (nodeVersion === 'v22.23.2' ? 'v24.21.0' : 'v22.23.2');
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const work = mkdtempSync(join(tmpdir(), 'wab-install-test-'));
let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? '  ✓' : '  ✗'} ${what}`); if (!cond) failures++; };

// Async on purpose for everything that talks to the in-process HTTP server: a sync spawn would block the event
// loop that serves the downloads, and the installer would wait forever.
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (opts.check !== false && r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
}

try {
  // 1. a copy that trusts a throwaway key
  const src = join(work, 'src');
  cpSync(ROOT, src, { recursive: true, filter: (p) => !/\/(node_modules|dist|\.git)(\/|$)/.test(p.slice(ROOT.length)) });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  const keyFile = join(work, 'test-key.pem');
  writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const patch = (file, re, to) => writeFileSync(join(src, file), readFileSync(join(src, file), 'utf8').replace(re, to));
  patch('install/install.sh', /^PUBKEYS='[^']+'/m, `PUBKEYS='${pub}'`);
  patch('src/release.mjs', /export const TRUSTED_KEYS = \[[^\]]*\]/, `export const TRUSTED_KEYS = ['${pub}']`);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: src, stdio: ['ignore', 'ignore', 'inherit'] });

  // 2. two releases
  const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version;
  const [maj, min, pat] = version.split('-')[0].split('.').map(Number);
  const next = `${maj}.${min}.${pat + 1}`;
  const www = join(work, 'www');
  const nodeCache = arg('node-cache');
  for (const nv of [nodeVersion, nextNode]) {
    const nodeDir = join(www, 'node', nv);
    mkdirSync(nodeDir, { recursive: true });
    for (const f of [`node-${nv}-linux-${arch}.tar.gz`, 'SHASUMS256.txt']) {
      const cached = nodeCache && [join(nodeCache, f), join(nodeCache, f === 'SHASUMS256.txt' ? `SHASUMS256-${nv}.txt` : f)].find(existsSync);
      if (cached) cpSync(cached, join(nodeDir, f));
      else run('curl', ['-fsSL', '-o', join(nodeDir, f), `https://nodejs.org/dist/${nv}/${f}`]);
    }
  }
  for (const [v, nv] of [[version, nodeVersion], [next, nextNode]]) {
    writeFileSync(join(src, '.node-version'), nv.slice(1) + '\n');
    const nodeDir = join(www, 'node', nv);
    const out = join(www, `v${v}`);
    run(process.execPath, [join(src, 'scripts', 'build-release.mjs'), '--arch', arch, '--out', out, '--version', v], { cwd: src, stdio: ['ignore', 'inherit', 'inherit'] });
    cpSync(join(src, 'install', 'install.sh'), join(out, 'install.sh'));
    run(process.execPath, [join(src, 'scripts', 'make-sums.mjs'), out, '--node-sums', join(nodeDir, 'SHASUMS256.txt')], { cwd: src, stdio: 'ignore' });
    run(process.execPath, [join(src, 'scripts', 'sign.mjs'), out, '--key', keyFile], { cwd: src, stdio: 'ignore' });
  }

  // 3. serve
  const server = createServer((req, res) => {
    const p = join(www, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(www) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200);
    createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const urls = { current: `${base}/v${version}`, next: `${base}/v${next}`, node: `${base}/node` };
  if (flag('serve-only')) {
    console.log(JSON.stringify({ ...urls, version, next, work }));
    await new Promise(() => {}); // until killed
  }

  // 4. install into a throwaway home
  const home = join(work, 'home');
  mkdirSync(home);
  const sysPath = '/usr/local/bin:/usr/bin:/bin';
  const env = { HOME: home, PATH: sysPath, SHELL: '/bin/bash', TMPDIR: join(work, 'tmp'), LANG: 'C.UTF-8', WA_BRIDGE_DOWNLOAD_URL: urls.current, WA_BRIDGE_NODE_MIRROR: urls.node };
  mkdirSync(env.TMPDIR);
  const sh = (extra = {}, args = []) => runAsync('sh', [join(www, `v${version}`, 'install.sh'), ...args], { env: { ...env, ...extra } });
  const wa = (args, extra = {}) => runAsync(join(home, '.wa-bridge', 'bin', 'wa-bridge'), args, { env: { ...env, PATH: `${home}/.local/bin:${sysPath}`, WA_BRIDGE_PORT: String(39000 + (process.pid % 1000)), ...extra } });

  console.log(`install test (linux-${arch}, ${version} → ${next})`);
  let r = await sh();
  ok(r.status === 0, `install.sh exits 0${r.status ? `\n${r.stdout}\n${r.stderr}` : ''}`);
  ok(/✓ wa-bridge .* installed/.test(r.stdout), 'reports the install');
  ok(lstatSync(join(home, '.local', 'bin', 'wa')).isSymbolicLink(), '`wa` linked in ~/.local/bin');
  ok(readFileSync(join(home, '.profile'), 'utf8').includes('# >>> wa-bridge >>>'), 'PATH line added for login shells');
  ok(readFileSync(join(home, '.bashrc'), 'utf8').includes('# >>> wa-bridge >>>'), 'PATH line added for bash');
  ok(readlinkSync(join(home, '.wa-bridge', 'current')) === `versions/${version}`, 'current → the new version');
  r = await wa(['version', '--json']);
  const v = JSON.parse(r.stdout || '{}');
  ok(v.version === version && v.node === nodeVersion, `wa version → ${v.version} on ${v.node}`);
  ok(v.data === join(home, '.local', 'share', 'wa-bridge'), 'data dir pinned by the launcher');

  r = await sh();
  ok(r.status === 0 && (readFileSync(join(home, '.profile'), 'utf8').match(/>>> wa-bridge >>>/g) || []).length === 1, 're-running is a repair: no duplicate PATH lines');
  rmSync(join(home, '.wa-bridge', '.wa-bridge-install')); // an install made before the marker existed
  r = await sh();
  ok(r.status === 0 && existsSync(join(home, '.wa-bridge', '.wa-bridge-install')), 'an install without the marker is still repaired (recognised by its launcher)');
  const foreignRoot = join(home, 'not-ours');
  mkdirSync(foreignRoot);
  writeFileSync(join(foreignRoot, 'precious.txt'), 'x');
  r = await sh({ WA_BRIDGE_INSTALL: foreignRoot });
  ok(r.status !== 0 && /is not a wa-bridge install/.test(r.stderr) && readdirSync(foreignRoot).join() === 'precious.txt', 'a non-empty directory that is not a wa-bridge install is refused untouched');

  // a read-only rc file (e.g. managed by home-manager) is warned about, never fatal
  const home2 = join(work, 'home2');
  mkdirSync(home2);
  writeFileSync(join(home2, '.zshrc'), '# managed\n');
  chmodSync(join(home2, '.zshrc'), 0o444);
  r = await sh({ HOME: home2, SHELL: '/bin/zsh' });
  ok(r.status === 0 && /could not add ~\/\.local\/bin to PATH in .*\.zshrc/.test(r.stderr) && !/PATH in:.*\.zshrc/.test(r.stdout), 'a read-only ~/.zshrc only warns, and is not reported as changed');
  chmodSync(join(home2, '.zshrc'), 0o644);

  r = await sh({}, ['--version', '9.9.9']);
  ok(r.status !== 0 && /asked for 9\.9\.9/.test(r.stderr), 'a version that does not match the release is refused');

  // tamper with the release: the signature check must stop it
  const tampered = join(www, 'tampered');
  cpSync(join(www, `v${version}`), tampered, { recursive: true });
  writeFileSync(join(tampered, 'SHA256SUMS'), readFileSync(join(tampered, 'SHA256SUMS'), 'utf8').replace(/^[0-9a-f]/, (c) => (c === '0' ? '1' : '0')));
  r = await sh({ WA_BRIDGE_DOWNLOAD_URL: `${base}/tampered`, WA_BRIDGE_INSTALL: join(home, 'other-root') });
  ok(r.status !== 0 && /signature is not valid/.test(r.stderr) && !existsSync(join(home, 'other-root', 'versions')) && !existsSync(join(home, 'other-root', 'bin', 'wa-bridge')) && !existsSync(join(home, 'other-root', 'node', nodeVersion)), `a tampered SHA256SUMS is refused before anything is installed${r.status === 0 ? '' : ''}`);

  r = await wa(['start', '--no-service']);
  ok(r.status === 0, `wa start (detached)${r.status ? `: ${r.stderr}` : ''}`);
  r = await wa(['status']);
  ok(/state: +unlinked/.test(r.stdout), 'daemon answers, unlinked');
  r = await wa(['doctor', '--json']);
  let checks = [];
  try { checks = JSON.parse(r.stdout); } catch { /* reported */ }
  ok(checks.some((c) => c.level === 'ok' && /daemon answers/.test(c.text)), 'wa doctor sees the daemon');
  ok(checks.some((c) => c.level === 'ok' && /installed launcher/.test(c.text)), 'wa doctor sees the installed launcher');

  r = await wa(['update'], { WA_BRIDGE_DOWNLOAD_URL: urls.next });
  ok(r.status === 0 && readlinkSync(join(home, '.wa-bridge', 'current')) === `versions/${next}`, `wa update → ${next}${r.status ? `\n${r.stdout}\n${r.stderr}` : ''}`);
  ok(readlinkSync(join(home, '.wa-bridge', 'previous')) === `versions/${version}`, 'previous → the old version');
  const vNext = JSON.parse((await wa(['version', '--json'])).stdout);
  ok(vNext.version === next && vNext.node === nextNode, `the launcher runs the new version on its new Node (${vNext.node})`);
  ok(existsSync(join(home, '.wa-bridge', 'node', nodeVersion)) && existsSync(join(home, '.wa-bridge', 'node', nextNode)), 'both runtimes kept while the previous release is kept');
  ok(/state: +unlinked/.test((await wa(['status'])).stdout), 'the daemon came back after the update');
  r = await wa(['update'], { WA_BRIDGE_DOWNLOAD_URL: urls.next });
  ok(r.status === 0 && /up to date/.test(r.stdout), 'a second update is a no-op');

  r = await wa(['update', '--rollback']);
  const vBack = JSON.parse((await wa(['version', '--json'])).stdout || '{}');
  ok(r.status === 0 && vBack.version === version && vBack.node === nodeVersion, `wa update --rollback → ${version} on ${vBack.node}${r.status ? `\n${r.stdout}\n${r.stderr}` : ''}`);
  ok(/state: +unlinked/.test((await wa(['status'])).stdout), 'the daemon came back after the rollback');

  writeFileSync(join(home, '.wa-bridge', 'my-notes.txt'), 'not wa-bridge\'s'); // must survive uninstall
  r = await wa(['uninstall', '--yes']);
  ok(r.status === 0, `wa uninstall${r.status ? `\n${r.stdout}\n${r.stderr}` : ''}`);
  ok(!existsSync(join(home, '.wa-bridge', 'versions')) && !existsSync(join(home, '.wa-bridge', 'bin', 'wa-bridge')), 'the install is removed');
  ok(readFileSync(join(home, '.wa-bridge', 'my-notes.txt'), 'utf8') === 'not wa-bridge\'s', 'a file wa-bridge did not create is left alone');
  rmSync(join(home, '.wa-bridge', 'my-notes.txt'));
  ok(!existsSync(join(home, '.local', 'bin', 'wa')), 'alias removed');
  ok(!readFileSync(join(home, '.profile'), 'utf8').includes('wa-bridge'), 'PATH line removed');
  ok(existsSync(join(home, '.local', 'share', 'wa-bridge', 'wa.sqlite')), 'data kept without --purge');
  await new Promise((res) => server.close(res));
} catch (e) {
  console.error(e.stack || e.message);
  failures++;
} finally {
  // a daemon left running by a failed step
  spawnSync('pkill', ['-f', `${work}/home/.wa-bridge`], { stdio: 'ignore' });
  if (!flag('keep')) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall install checks passed');
process.exit(failures ? 1 : 0);

