// Productization hardening: exit codes, schema guard, interrupted sends, in-flight rate limits, data-dir
// privacy, config errors, log retention.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, msg, fakeWa, PN } from './helpers.mjs';
import { createShutdown, installProcessHandlers, EXIT } from '../src/lifecycle.mjs';
import { Store, SCHEMA_VERSION } from '../src/store.mjs';
import { Outbox } from '../src/outbox.mjs';
import { loadConfig, defaultDataDir } from '../src/config.mjs';
import { pruneLogs, rotateIfLarge, silentLogger } from '../src/log.mjs';
import { nowSec } from '../src/util.mjs';

function lifecycleRig() {
  const calls = [];
  const exits = [];
  const shutdown = createShutdown({
    wa: { stop: async () => calls.push('wa.stop') },
    api: { close: async () => calls.push('api.close') },
    store: { audit: (a) => calls.push(`audit:${a}`), close: () => calls.push('store.close') },
    log: silentLogger,
    releaseLock: () => calls.push('releaseLock'),
    exit: (code) => exits.push(code),
  });
  return { shutdown, calls, exits };
}

test('lifecycle: a signal stops cleanly with exit 0; a crash exits 1 so the service manager restarts it', async () => {
  const sig = lifecycleRig();
  const proc = new EventEmitter();
  installProcessHandlers(proc, sig.shutdown, silentLogger);
  proc.emit('SIGTERM');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sig.exits, [EXIT.OK]);
  assert.deepEqual(sig.calls, ['wa.stop', 'api.close', 'audit:daemon_stopped', 'store.close', 'releaseLock']);

  const crash = lifecycleRig();
  const proc2 = new EventEmitter();
  installProcessHandlers(proc2, crash.shutdown, silentLogger);
  proc2.emit('uncaughtException', new Error('boom'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(crash.exits, [EXIT.FAILURE], 'a crash must never look like a deliberate stop');
});

test('lifecycle: shutdown runs once; a crash during shutdown still exits non-zero', async () => {
  const r = lifecycleRig();
  const first = r.shutdown('SIGTERM', EXIT.OK);
  await r.shutdown('SIGINT', EXIT.OK); // ignored
  await r.shutdown('crash', EXIT.FAILURE); // forces the failure code immediately
  await first;
  assert.equal(r.calls.filter((c) => c === 'wa.stop').length, 1);
  assert.ok(r.exits.includes(EXIT.FAILURE));
});

test('store: refuses a database written by a newer schema (protects rollbacks)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wab-schema-'));
  try {
    const file = join(dir, 'wa.sqlite');
    const s = new Store(file);
    s.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    s.close();
    assert.throws(() => new Store(file), (e) => e.code === 'schema_too_new' && /wa update/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('store: a send interrupted mid-flight is marked failed at startup, never left pending', () => {
  const t = setup();
  try {
    const now = nowSec();
    t.store.insertDraft({ token: 'AAAAAA', action: 'text', chat: PN('15550100002'), payload: {}, preview: {}, createdAt: now, expiresAt: now + 900 });
    t.store.insertDraft({ token: 'BBBBBB', action: 'text', chat: PN('15550100002'), payload: {}, preview: {}, createdAt: now, expiresAt: now + 900 });
    assert.ok(t.store.transitionDraft('AAAAAA', 'draft', 'sending'));
    assert.equal(t.store.failInterruptedSends(), 1);
    const a = t.store.getDraft('AAAAAA');
    assert.equal(a.status, 'failed');
    assert.match(a.error, /delivery unknown/);
    assert.equal(t.store.getDraft('BBBBBB').status, 'draft', 'ordinary drafts are untouched');
  } finally { t.cleanup(); }
});

test('rate limit: sends still in flight count against the per-minute cap', async () => {
  const t = setup();
  let release;
  const gate = new Promise((r) => { release = r; });
  const wa = fakeWa();
  const realSend = wa.send.bind(wa);
  wa.send = async (...args) => { await gate; return realSend(...args); };
  Object.assign(t.cfg.sending, { maxPerMinute: 1 });
  const outbox = new Outbox({ store: t.store, wa, ingest: t.ingest, cfg: t.cfg, log: silentLogger });
  t.store.upsertContact({ jid: PN('15550100002'), name: 'Alex Example' });
  t.ingest.message(msg({ chat: PN('15550100002'), text: 'hi', pushName: 'Lex' }), { live: true });
  try {
    const a = outbox.draft({ to: 'Alex', text: 'one' });
    const b = outbox.draft({ to: 'Alex', text: 'two' });
    const first = outbox.confirm(a.token); // parked inside wa.send
    await assert.rejects(outbox.confirm(b.token), (e) => e.code === 'rate_limited');
    release();
    assert.equal((await first).status, 'sent');
    assert.equal(wa.sent.length, 1);
  } finally { t.cleanup(); }
});

test('data dir: created private (0700), token 0600; XDG_DATA_HOME is honoured', { skip: process.platform === 'win32' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'wab-perm-'));
  const saved = { WA_BRIDGE_HOME: process.env.WA_BRIDGE_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  try {
    const root = join(base, 'data');
    const cfg = loadConfig(root);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(cfg.paths.token).mode & 0o777, 0o600);

    delete process.env.WA_BRIDGE_HOME;
    process.env.XDG_DATA_HOME = join(base, 'xdg');
    assert.equal(defaultDataDir(), join(base, 'xdg', 'wa-bridge'));
    process.env.WA_BRIDGE_HOME = join(base, 'explicit');
    assert.equal(defaultDataDir(), join(base, 'explicit'), 'WA_BRIDGE_HOME wins');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(base, { recursive: true, force: true });
  }
});

test('config: a malformed config.json is reported with its path, not a bare JSON error', () => {
  const root = mkdtempSync(join(tmpdir(), 'wab-cfg-'));
  try {
    writeFileSync(join(root, 'config.json'), '{ "sending": { "enabled": false, } }');
    assert.throws(() => loadConfig(root), (e) => e.message.includes('config.json is not valid JSON'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('logs: daily files past keepDays are pruned; baileys.log rotates when large', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wab-logs-'));
  try {
    for (const d of ['2026-08-01', '2026-09-13', '2026-09-15', '2026-10-14']) writeFileSync(join(dir, `wa-bridge-${d}.log`), 'x\n');
    writeFileSync(join(dir, 'daemon-stderr.log'), 'kept\n');
    const removed = pruneLogs(dir, 30, new Date('2026-10-14T12:00:00Z'));
    assert.deepEqual(removed.sort(), ['wa-bridge-2026-08-01.log', 'wa-bridge-2026-09-13.log']);
    assert.deepEqual(readdirSync(dir).sort(), ['daemon-stderr.log', 'wa-bridge-2026-09-15.log', 'wa-bridge-2026-10-14.log']);

    const b = join(dir, 'baileys.log');
    writeFileSync(b, 'y'.repeat(2048));
    assert.equal(rotateIfLarge(b, 4096), false);
    assert.equal(rotateIfLarge(b, 1024), true);
    assert.equal(existsSync(b + '.1'), true);
    assert.equal(existsSync(b), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
