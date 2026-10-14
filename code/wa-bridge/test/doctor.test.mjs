// wa doctor reports problems with a fix, and never starts anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { loadConfig } from '../src/config.mjs';
import { collectChecks } from '../src/cli/doctor.mjs';

async function withHome(fn) {
  const root = mkdtempSync(join(tmpdir(), 'wab-doc-'));
  const saved = { WA_BRIDGE_HOME: process.env.WA_BRIDGE_HOME, WA_BRIDGE_PORT: process.env.WA_BRIDGE_PORT };
  try {
    process.env.WA_BRIDGE_HOME = root;
    return await fn(root);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(root, { recursive: true, force: true });
  }
}

test('doctor: a readable data dir and a dead daemon are failures, each with a fix', { skip: process.platform === 'win32' }, async () => {
  await withHome(async (root) => {
    loadConfig(root);
    chmodSync(root, 0o755);
    const probe = createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    process.env.WA_BRIDGE_PORT = String(probe.address().port);
    await new Promise((r) => probe.close(r)); // a free port: nothing answers
    const checks = await collectChecks({ agentChecks: async () => [] });
    const perm = checks.find((c) => c.text.includes('data dir'));
    assert.equal(perm.level, 'fail');
    assert.match(perm.fix, /chmod 700/);
    const daemon = checks.find((c) => c.text.includes('not answering'));
    assert.equal(daemon.level, 'fail');
    assert.match(daemon.fix, /wa start/);
  });
});

test('doctor: a foreign program on the port is named as such', async () => {
  await withHome(async (root) => {
    loadConfig(root);
    const foreign = createServer((s) => s.end());
    await new Promise((r) => foreign.listen(0, '127.0.0.1', r));
    process.env.WA_BRIDGE_PORT = String(foreign.address().port);
    try {
      const checks = await collectChecks({ agentChecks: async () => [] });
      const c = checks.find((x) => x.text.includes('another program'));
      assert.ok(c, JSON.stringify(checks));
      assert.match(c.fix, /"port"/);
    } finally { foreign.close(); }
  });
});
