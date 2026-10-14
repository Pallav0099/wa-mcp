// Starts the REAL daemon on an empty data directory. With no credentials it must stay "unlinked" and make
// no connection to WhatsApp at all; then it must shut down cleanly through the API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMON = fileURLToPath(new URL('../src/daemon.mjs', import.meta.url));

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test('daemon: starts unlinked, answers health, refuses a second instance, stops on request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wab-daemon-'));
  const port = await freePort();
  const env = { ...process.env, WA_BRIDGE_HOME: dir, WA_BRIDGE_PORT: String(port) };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const token = await waitFor(() => (existsSync(join(dir, 'token')) ? readFileSync(join(dir, 'token'), 'utf8').trim() : null));
    const get = (path, method = 'GET') => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
    const health = await waitFor(async () => { try { const h = await get('/health'); return h.state === 'unlinked' ? h : null; } catch { return null; } });
    assert.equal(health.linked, false);
    assert.equal(health.stats.messages, 0);

    const second = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON], { env, stdio: 'ignore' });
    const secondCode = await new Promise((resolve) => second.on('exit', resolve));
    assert.equal(secondCode, 2, 'second instance exits with code 2');

    const stop = await get('/shutdown', 'POST');
    assert.equal(stop.stopping, true);
    assert.equal(await exited, 0);
    assert.equal(existsSync(join(dir, 'daemon.lock')), false, 'lock released');
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon: a foreign program on the port is a failure (exit 1), not "already running" (exit 2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wab-daemon-'));
  const foreign = createServer((s) => s.end());
  await new Promise((r) => foreign.listen(0, '127.0.0.1', r));
  const port = foreign.address().port;
  try {
    const env = { ...process.env, WA_BRIDGE_HOME: dir, WA_BRIDGE_PORT: String(port) };
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 1);
    assert.match(stderr, /in use by another program/);
    assert.equal(existsSync(join(dir, 'daemon.lock')), false, 'no stale lock left behind');
  } finally {
    foreign.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon: a draft left "sending" by a crash is marked failed on the next start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wab-daemon-'));
  const port = await freePort();
  const { Store } = await import('../src/store.mjs');
  const s = new Store(join(dir, 'wa.sqlite'));
  s.insertDraft({ token: 'K7QX2M', action: 'text', chat: '15550100002@s.whatsapp.net', payload: {}, preview: { to: { name: 'x' } }, createdAt: 1, expiresAt: 9_999_999_999 });
  s.transitionDraft('K7QX2M', 'draft', 'sending');
  s.close();
  const env = { ...process.env, WA_BRIDGE_HOME: dir, WA_BRIDGE_PORT: String(port) };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    const token = await waitFor(() => (existsSync(join(dir, 'token')) ? readFileSync(join(dir, 'token'), 'utf8').trim() : null));
    const get = (path, method = 'GET') => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
    const drafts = await waitFor(async () => { try { return (await get('/send/drafts?status=failed')).drafts; } catch { return null; } });
    assert.equal(drafts.length, 1);
    assert.match(drafts[0].error, /interrupted/);
    await get('/shutdown', 'POST');
    assert.equal(await exited, 0);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor(fn, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
}
