#!/usr/bin/env node
// Write <dir>/SHA256SUMS for a release:  node scripts/make-sums.mjs <dir> [--node-sums <SHASUMS256.txt>]
//
// Lists every wa-bridge-*.tar.gz and install.sh in <dir>, plus the Node tarballs the release needs, so the one
// signature over SHA256SUMS covers Node too. The Node hashes come from nodejs.org's SHASUMS256.txt for the
// version in .node-version (downloaded, or given with --node-sums for offline/test builds).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeMirror } from '../src/release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(process.argv[2] || join(ROOT, 'dist'));
const i = process.argv.indexOf('--node-sums');
const nodeVersion = `v${readFileSync(join(ROOT, '.node-version'), 'utf8').trim().replace(/^v/, '')}`;

const nodeSums = i > 0 ? readFileSync(process.argv[i + 1], 'utf8') : await (async () => {
  const res = await fetch(`${nodeMirror()}/${nodeVersion}/SHASUMS256.txt`);
  if (!res.ok) throw new Error(`cannot fetch Node ${nodeVersion} checksums: HTTP ${res.status}`);
  return res.text();
})();

const lines = [];
const files = readdirSync(dir).filter((f) => /^wa-bridge-.+-linux-(x64|arm64)\.tar\.gz$/.test(f) || f === 'install.sh').sort();
const arches = new Set();
for (const f of files) {
  lines.push(`${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}`);
  const m = /-linux-(x64|arm64)\.tar\.gz$/.exec(f);
  if (m) arches.add(m[1]);
}
if (!arches.size) throw new Error(`no wa-bridge tarballs in ${dir}`);
for (const arch of [...arches].sort()) {
  const name = `node-${nodeVersion}-linux-${arch}.tar.gz`;
  const m = new RegExp(`^([0-9a-f]{64})\\s+${name.replace(/\./g, '\\.')}$`, 'm').exec(nodeSums);
  if (!m) throw new Error(`${name} is not in nodejs.org's SHASUMS256.txt for ${nodeVersion}`);
  lines.push(`${m[1]}  ${name}`);
}
writeFileSync(join(dir, 'SHA256SUMS'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
