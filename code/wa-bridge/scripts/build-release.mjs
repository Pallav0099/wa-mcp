#!/usr/bin/env node
// Build one release tarball:  node scripts/build-release.mjs [--arch x64|arm64] [--out dist] [--version X.Y.Z]
//
// The tarball holds everything the installer puts in ~/.wa-bridge/versions/<ver>/: bin/, src/, skill/, the
// production node_modules for that CPU (sharp ships a native binary per architecture), NODE_VERSION and
// RELEASE.json. Install scripts never run (npm ci --ignore-scripts; see package.json allowScripts).
// Output is reproducible: sorted entries, fixed owner and mtime (SOURCE_DATE_EPOCH or the last commit).
//
// Then: scripts/make-sums.mjs writes SHA256SUMS for dist/ (plus the Node tarballs), scripts/sign.mjs signs it.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRUSTED_KEYS, hostArch } from '../src/release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = arg('version', pkg.version);
const arch = hostArch(arg('arch', process.arch));
const outDir = resolve(arg('out', join(ROOT, 'dist')));
const nodeVersion = `v${readFileSync(join(ROOT, '.node-version'), 'utf8').trim().replace(/^v/, '')}`;
const epoch = process.env.SOURCE_DATE_EPOCH
  || (() => { try { return execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return '0'; } })();

// the installer must trust exactly the keys `wa update` trusts
const installer = readFileSync(join(ROOT, 'install', 'install.sh'), 'utf8');
const shKey = /^PUBKEY='([^']+)'/m.exec(installer)?.[1];
if (!shKey || !TRUSTED_KEYS.includes(shKey)) {
  console.error('install/install.sh PUBKEY is not one of src/release.mjs TRUSTED_KEYS; refusing to build');
  process.exit(1);
}

const name = `wa-bridge-${version}-linux-${arch}`;
const stage = mkdtempSync(join(tmpdir(), 'wab-build-'));
const top = join(stage, name);
try {
  mkdirSync(top);
  for (const p of ['bin', 'src', 'skill', 'package.json', 'package-lock.json', 'README.md', 'LICENSE']) {
    if (existsSync(join(ROOT, p))) cpSync(join(ROOT, p), join(top, p), { recursive: true });
  }
  if (version !== pkg.version) { // test builds with another version number
    const staged = JSON.parse(readFileSync(join(top, 'package.json'), 'utf8'));
    staged.version = version;
    writeFileSync(join(top, 'package.json'), JSON.stringify(staged, null, 2) + '\n');
  }
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--os=linux', `--cpu=${arch}`], { cwd: top, stdio: ['ignore', 'ignore', 'inherit'] });
  rmSync(join(top, 'node_modules', '.package-lock.json'), { force: true });

  // the only native code allowed is sharp's prebuilt binary for this CPU
  const natives = walk(join(top, 'node_modules')).filter((f) => f.endsWith('.node')).map((f) => relative(top, f));
  const unexpected = natives.filter((f) => !f.startsWith(`node_modules/@img/sharp-linux-${arch}/`));
  if (unexpected.length) throw new Error(`unexpected native modules:\n  ${unexpected.join('\n  ')}`);
  if (!natives.length) throw new Error(`sharp's linux-${arch} binary is missing`);

  writeFileSync(join(top, 'NODE_VERSION'), nodeVersion + '\n');
  writeFileSync(join(top, 'RELEASE.json'), JSON.stringify({ name: 'wa-bridge', version, arch, platform: 'linux', node: nodeVersion }, null, 2) + '\n');
  writeFileSync(join(top, 'THIRD-PARTY-LICENSES.txt'), thirdParty(join(top, 'node_modules')));

  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${name}.tar.gz`);
  const tar = ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rwX,go+rX,go-w', '-cf', '-', '-C', stage, name];
  const tarball = execFileSync('tar', tar, { maxBuffer: 1 << 30 });
  const gz = execFileSync('gzip', ['-9', '-n'], { input: tarball, maxBuffer: 1 << 30 });
  writeFileSync(out, gz);
  const sha = createHash('sha256').update(gz).digest('hex');
  console.log(`${sha}  ${relative(process.cwd(), out)}  (${(gz.length / 1048576).toFixed(1)} MB, node ${nodeVersion})`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** name@version: license for every installed package (node_modules/<name> and node_modules/@scope/<name>). */
function thirdParty(nm) {
  const entries = new Set();
  const isPackageJson = (p) => /(^|\/)node_modules\/(@[^/]+\/)?[^/@][^/]*\/package\.json$/.test(p);
  for (const f of walk(nm).filter((p) => isPackageJson(relative(dirname(nm), p)))) {
    let j;
    try { j = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    if (!j.name || !j.version) continue;
    entries.add(`${j.name}@${j.version}: ${typeof j.license === 'string' ? j.license : j.license?.type || 'see the package'}`);
  }
  return ['Third-party packages bundled with wa-bridge (name@version: license)', '', ...[...entries].sort()].join('\n') + '\n';
}
