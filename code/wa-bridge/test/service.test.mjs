// The systemd user unit and how the CLI drives systemctl (recorded, never executed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unitText, installUnit, uninstallUnit, unitPath, unitStatus, lingerEnabled, startDaemonProcess, UNIT_NAME } from '../src/service.mjs';
import { selfCommand, BIN_SCRIPT } from '../src/self.mjs';

function fakeRun(responses = {}) {
  const calls = [];
  const run = (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    for (const [prefix, res] of Object.entries(responses)) if (key.startsWith(prefix)) return { status: 0, stdout: '', stderr: '', ...res };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('unit: runs the launcher in daemon mode, pins the data dir, restarts crashes only', () => {
  const text = unitText({ command: ['/home/u/.wa-bridge/bin/wa-bridge'], dataDir: '/home/u/.local/share/wa-bridge' });
  assert.match(text, /^ExecStart=\/home\/u\/\.wa-bridge\/bin\/wa-bridge daemon$/m);
  assert.match(text, /^Environment=WA_BRIDGE_HOME=\/home\/u\/\.local\/share\/wa-bridge$/m);
  assert.match(text, /^Restart=on-failure$/m);
  assert.match(text, /^RestartPreventExitStatus=2$/m, 'a second instance is never restarted');
  assert.match(text, /^UMask=0077$/m);
  assert.match(text, /^WantedBy=default\.target$/m);
});

test('unit: paths with spaces, % and $ are quoted and escaped for systemd', () => {
  const text = unitText({ command: ['/opt/My Tools/node', '--flag', '/srv/50%/wa.mjs'], dataDir: '/data/$HOME dir' });
  assert.match(text, /^ExecStart="\/opt\/My Tools\/node" --flag \/srv\/50%%\/wa\.mjs daemon$/m);
  assert.match(text, /^Environment="WA_BRIDGE_HOME=\/data\/\$\$HOME dir"$/m);
});

test('install: writes the unit once, reloads systemd only when it changed, always enables it', () => {
  const home = mkdtempSync(join(tmpdir(), 'wab-svc-'));
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
  try {
    const a = fakeRun();
    const r1 = installUnit({ dataDir: '/d', command: ['/l'], run: a.run, env });
    assert.equal(r1.changed, true);
    assert.equal(r1.path, join(home, '.config', 'systemd', 'user', UNIT_NAME));
    assert.ok(existsSync(r1.path));
    assert.deepEqual(a.calls, ['systemctl --user daemon-reload', `systemctl --user enable ${UNIT_NAME}`]);

    const b = fakeRun();
    assert.equal(installUnit({ dataDir: '/d', command: ['/l'], run: b.run, env }).changed, false);
    assert.deepEqual(b.calls, [`systemctl --user enable ${UNIT_NAME}`], 'no reload for an identical unit');

    const c = fakeRun();
    assert.equal(uninstallUnit({ run: c.run, env }), true);
    assert.equal(existsSync(r1.path), false);
    assert.deepEqual(c.calls, [`systemctl --user disable --now ${UNIT_NAME}`, 'systemctl --user daemon-reload']);
    assert.equal(uninstallUnit({ run: c.run, env }), false, 'nothing to remove twice');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a failing systemctl surfaces its message', () => {
  const home = mkdtempSync(join(tmpdir(), 'wab-svc-'));
  try {
    const { run } = fakeRun({ 'systemctl --user enable': { status: 1, stderr: 'Failed to connect to bus' } });
    assert.throws(() => installUnit({ dataDir: '/d', command: ['/l'], run, env: { HOME: home } }), /enable wa-bridge\.service failed: Failed to connect to bus/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('with an installed unit the daemon is started through systemd, never spawned beside it', () => {
  const home = mkdtempSync(join(tmpdir(), 'wab-svc-'));
  const env = { HOME: home };
  try {
    writeFileSync(join(home, 'x'), '');
    installUnit({ dataDir: '/d', command: ['/l'], run: fakeRun().run, env });
    const { run, calls } = fakeRun();
    assert.equal(startDaemonProcess({ root: '/d', logs: join(home, 'logs') }, { run, env }), 'systemd');
    assert.ok(calls.includes(`systemctl --user start ${UNIT_NAME}`));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('status and linger are parsed from systemctl / loginctl', () => {
  const { run } = fakeRun({
    'systemctl --user show': { stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=4242\nNRestarts=3\n' },
    'loginctl show-user': { stdout: 'Linger=no\n' },
  });
  assert.deepEqual(unitStatus(run), { active: 'active', sub: 'running', enabled: 'enabled', pid: 4242, restarts: 3 });
  assert.equal(lingerEnabled(run, 'u'), false);
  assert.equal(unitPath({ HOME: '/home/u' }), '/home/u/.config/systemd/user/wa-bridge.service');
});

test('self command: the installed launcher when present, else node + bin/wa.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wab-self-'));
  try {
    const launcher = join(dir, 'wa-bridge');
    writeFileSync(launcher, '#!/bin/sh\n');
    chmodSync(launcher, 0o755);
    assert.deepEqual(selfCommand({ WA_BRIDGE_LAUNCHER: launcher }), [launcher]);
    assert.deepEqual(selfCommand({ WA_BRIDGE_LAUNCHER: join(dir, 'missing') }), [process.execPath, '--disable-warning=ExperimentalWarning', BIN_SCRIPT]);
    assert.deepEqual(selfCommand({}), [process.execPath, '--disable-warning=ExperimentalWarning', BIN_SCRIPT]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
