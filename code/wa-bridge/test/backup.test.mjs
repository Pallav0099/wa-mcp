// wa backup: a verified online copy of the store only, retention, and the optional daily timer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup, msg, PN } from './helpers.mjs';
import { backupStore, scheduleBackups, unscheduleBackups, TIMER, TIMER_SERVICE } from '../src/cli/backup.mjs';

test('a backup is a consistent, verified copy of the store, taken while it is open', async () => {
  const t = setup();
  const dest = mkdtempSync(join(tmpdir(), 'wab-bk-'));
  try {
    for (let i = 0; i < 25; i++) t.ingest.message(msg({ chat: PN('15550100002'), text: `m${i}` }), { live: true });
    const r = await backupStore({ db: t.cfg.paths.db, dest, keep: 7, now: new Date(2026, 9, 14, 3, 45) });
    assert.match(r.file, /wa-20261014-0345\.sqlite$/, 'local-time stamp');
    assert.equal(r.messages, 25);
    const copy = new DatabaseSync(r.file, { readOnly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 25);
    copy.close();
    assert.equal(statSync(dest).mode & 0o077, 0, 'backup dir private');
    assert.ok(!readdirSync(dest).some((f) => f.endsWith('.partial')), 'no partial file left');
    assert.ok(!readdirSync(dest).some((f) => f === 'auth'), 'credentials are never part of a backup');
  } finally { t.cleanup(); rmSync(dest, { recursive: true, force: true }); }
});

test('retention keeps the newest N copies; two backups in the same minute do not collide', async () => {
  const t = setup();
  const dest = mkdtempSync(join(tmpdir(), 'wab-bk-'));
  try {
    for (const d of [10, 11, 12, 13]) await backupStore({ db: t.cfg.paths.db, dest, keep: 2, now: new Date(2026, 9, d, 3, 45) });
    assert.deepEqual(readdirSync(dest).sort(), ['wa-20261012-0345.sqlite', 'wa-20261013-0345.sqlite']);
    const again = await backupStore({ db: t.cfg.paths.db, dest, keep: 5, now: new Date(2026, 9, 13, 3, 45) });
    assert.match(again.file, /wa-20261013-0345-1\.sqlite$/);
  } finally { t.cleanup(); rmSync(dest, { recursive: true, force: true }); }
});

test('no store yet: a clear error, nothing created', async () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'wab-bk-')), 'out');
  await assert.rejects(backupStore({ db: '/nonexistent/wa.sqlite', dest }), /no message store/);
  assert.equal(existsSync(dest), false);
});

test('the daily timer runs `wa-bridge backup` with the chosen destination; off removes it', () => {
  const home = mkdtempSync(join(tmpdir(), 'wab-bk-home-'));
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' }; };
  const env = { HOME: home, WA_BRIDGE_LAUNCHER: '' };
  try {
    const dir = scheduleBackups({ dest: '/backups/wa bridge', keep: 5, env, run });
    const svc = readFileSync(join(dir, TIMER_SERVICE), 'utf8');
    assert.match(svc, /^ExecStart=.* backup --dest "\/backups\/wa bridge" --keep 5$/m);
    assert.match(readFileSync(join(dir, TIMER), 'utf8'), /^OnCalendar=\*-\*-\* 03:45$/m);
    assert.deepEqual(calls, ['systemctl --user daemon-reload', `systemctl --user enable --now ${TIMER}`]);
    assert.equal(unscheduleBackups({ env, run }), true);
    assert.equal(existsSync(join(dir, TIMER)), false);
    assert.equal(unscheduleBackups({ env, run }), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
