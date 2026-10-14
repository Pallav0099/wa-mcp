// Release verification, the SHA256SUMS manifest, version order, install-layout housekeeping, uninstall helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, parseSums, rawPublicKey, signSums, verifySums, TRUSTED_KEYS, downloadUrl } from '../src/release.mjs';
import { pruneInstall, switchLink, linkedVersion } from '../src/install-layout.mjs';
import { stripPathBlock } from '../src/cli/uninstall.mjs';

const SUMS = `${'a'.repeat(64)}  wa-bridge-0.3.0-linux-x64.tar.gz
${'b'.repeat(64)}  wa-bridge-0.3.0-linux-arm64.tar.gz
${'c'.repeat(64)}  install.sh
${'d'.repeat(64)}  node-v24.21.0-linux-x64.tar.gz
${'e'.repeat(64)}  node-v24.21.0-linux-arm64.tar.gz
`;

test('signatures: valid for the signer only; any change to the list breaks it', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const pub = rawPublicKey(publicKey);
  const sig = signSums(SUMS, pem);
  assert.equal(verifySums(SUMS, sig, [pub]), true);
  assert.equal(verifySums(SUMS.replace('aaaa', 'aaab'), sig, [pub]), false, 'tampered list');
  assert.equal(verifySums(SUMS, sig, TRUSTED_KEYS), false, 'signed by a key the code does not trust');
  assert.equal(verifySums(SUMS, 'not base64 at all', [pub]), false);
  assert.equal(verifySums(SUMS, sig, ['short']), false, 'a malformed key is simply not trusted');
});

test('the shipped trusted key and the installer key agree', () => {
  const sh = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');
  const key = /^PUBKEY='([^']+)'/m.exec(sh)[1];
  assert.ok(TRUSTED_KEYS.includes(key));
  assert.equal(Buffer.from(key, 'base64').length, 32);
});

test('SHA256SUMS names the version, the Node runtime and the file per architecture', () => {
  const s = parseSums(SUMS + 'garbage line\n');
  assert.equal(s.version, '0.3.0');
  assert.equal(s.node, 'v24.21.0');
  assert.equal(s.appFor('arm64'), 'wa-bridge-0.3.0-linux-arm64.tar.gz');
  assert.equal(s.nodeFor('x64'), 'node-v24.21.0-linux-x64.tar.gz');
  assert.equal(s.files['install.sh'], 'c'.repeat(64));
  assert.equal(Object.keys(s.files).length, 5);
});

test('versions order like semver; pre-releases before their release', () => {
  assert.equal(compareVersions('0.2.0', '0.2.1'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-rc1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc1'), 1);
});

test('download locations: latest, a pinned version, or an explicit mirror', () => {
  assert.equal(downloadUrl({ env: {} }), 'https://github.com/xrig-io/wa-bridge/releases/latest/download');
  assert.equal(downloadUrl({ version: '0.3.0', env: { WA_BRIDGE_REPO: 'me/fork' } }), 'https://github.com/me/fork/releases/download/v0.3.0');
  assert.equal(downloadUrl({ version: '0.3.0', env: { WA_BRIDGE_DOWNLOAD_URL: 'http://mirror/x/' } }), 'http://mirror/x');
});

test('pruning keeps current, previous and the Node runtimes they need; nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'wab-layout-'));
  try {
    const layout = { root, versions: join(root, 'versions'), node: join(root, 'node'), current: join(root, 'current'), previous: join(root, 'previous') };
    for (const [v, n] of [['0.1.0', 'v22.23.2'], ['0.2.0', 'v24.21.0'], ['0.3.0', 'v24.21.0'], ['.0.4.0.installing', 'v24.21.0']]) {
      mkdirSync(join(layout.versions, v), { recursive: true });
      writeFileSync(join(layout.versions, v, 'NODE_VERSION'), n + '\n');
    }
    for (const n of ['v22.23.2', 'v24.21.0']) mkdirSync(join(layout.node, n, 'bin'), { recursive: true });
    switchLink(root, 'current', '0.3.0');
    switchLink(root, 'previous', '0.2.0');
    assert.equal(readlinkSync(layout.current), 'versions/0.3.0');
    const removed = pruneInstall(layout);
    assert.deepEqual(removed.sort(), ['.0.4.0.installing', '0.1.0', 'node v22.23.2'].sort());
    assert.ok(existsSync(join(layout.versions, '0.2.0')) && existsSync(join(layout.versions, '0.3.0')));
    assert.ok(existsSync(join(layout.node, 'v24.21.0')));
    switchLink(root, 'current', '0.2.0'); // atomic replacement of an existing link
    assert.equal(linkedVersion(layout.current), '0.2.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('uninstall removes exactly the PATH block the installer appended', () => {
  const original = 'export EDITOR=vim\nalias ll="ls -l"\n';
  const block = '\n# >>> wa-bridge >>>\ncase ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n# <<< wa-bridge <<<\n';
  assert.equal(stripPathBlock(original + block), original);
  assert.equal(stripPathBlock(original + block + 'export LATER=1\n'), original + 'export LATER=1\n');
  assert.equal(stripPathBlock(original), original);
});


