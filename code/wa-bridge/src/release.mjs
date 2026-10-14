// Where releases come from and how they are verified. Used by `wa update`; install/install.sh carries the same
// public key (scripts/build-release.mjs refuses to build when they differ).
//
// A release is a directory of files:
//   SHA256SUMS                      sha256 + name of every file below, and of the Node tarballs it needs
//   SHA256SUMS.sig                  Ed25519 signature of SHA256SUMS, base64
//   wa-bridge-<ver>-linux-<arch>.tar.gz
//   install.sh
// Node itself is downloaded from nodejs.org and must match BOTH nodejs.org's SHASUMS256.txt and our signed list.

import { createPublicKey, createPrivateKey, sign, verify } from 'node:crypto';

export const DEFAULT_REPO = 'xrig-io/wa-bridge';

/** Ed25519 public keys (raw 32 bytes, base64) whose signatures are accepted. Rotate by adding the new key first. */
export const TRUSTED_KEYS = [
  'hjEXz90rJ8GyNNoCePO3a9Usd4xGcKMxDRkZOKo71EU=',
];

export const NODE_MIRROR = 'https://nodejs.org/dist';

export function downloadUrl({ version, env = process.env } = {}) {
  if (env.WA_BRIDGE_DOWNLOAD_URL) return env.WA_BRIDGE_DOWNLOAD_URL.replace(/\/$/, '');
  const repo = env.WA_BRIDGE_REPO || DEFAULT_REPO;
  return version ? `https://github.com/${repo}/releases/download/v${version}` : `https://github.com/${repo}/releases/latest/download`;
}

export const nodeMirror = (env = process.env) => (env.WA_BRIDGE_NODE_MIRROR || NODE_MIRROR).replace(/\/$/, '');

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyFromRaw(b64) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function rawPublicKey(keyObject) {
  return keyObject.export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519_PREFIX.length).toString('base64');
}

/** True when `sigB64` is a valid signature of `data` by one of `keys`. */
export function verifySums(data, sigB64, keys = TRUSTED_KEYS) {
  const sig = Buffer.from(String(sigB64).trim(), 'base64');
  if (sig.length !== 64) return false;
  return keys.some((k) => { try { return verify(null, Buffer.from(data), publicKeyFromRaw(k), sig); } catch { return false; } });
}

export function signSums(data, privatePem) {
  return sign(null, Buffer.from(data), createPrivateKey(privatePem)).toString('base64');
}

/** Parse SHA256SUMS into { files: {name: sha256}, version, node, appFor(arch), nodeFor(arch) }. */
export function parseSums(text) {
  const files = {};
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m) files[m[2]] = m[1];
  }
  const app = Object.keys(files).map((f) => /^wa-bridge-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-linux-(x64|arm64)\.tar\.gz$/.exec(f)).filter(Boolean);
  const node = Object.keys(files).map((f) => /^node-(v\d+\.\d+\.\d+)-linux-(x64|arm64)\.tar\.gz$/.exec(f)).filter(Boolean);
  return {
    files,
    version: app[0]?.[1] || null,
    node: node[0]?.[1] || null,
    appFor: (arch) => app.find((m) => m[2] === arch)?.[0] || null,
    nodeFor: (arch) => node.find((m) => m[2] === arch)?.[0] || null,
  };
}

/** -1 / 0 / 1, semver order (a pre-release sorts before its release). */
export function compareVersions(a, b) {
  const pa = String(a).split('-');
  const pb = String(b).split('-');
  const na = pa[0].split('.').map(Number);
  const nb = pb[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) < (nb[i] || 0) ? -1 : 1;
  if (pa[1] === pb[1]) return 0;
  if (!pa[1]) return 1;
  if (!pb[1]) return -1;
  return pa[1] < pb[1] ? -1 : 1;
}

export function hostArch(arch = process.arch) {
  if (arch === 'x64' || arch === 'arm64') return arch;
  throw new Error(`unsupported CPU architecture: ${arch} (wa-bridge ships for x64 and arm64)`);
}
