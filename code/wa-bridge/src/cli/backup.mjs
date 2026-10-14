// `wa backup [--dest <dir>] [--keep N]` and `wa backup --schedule daily|off`.
//
// A consistent copy of the MESSAGE STORE ONLY (wa.sqlite) made with SQLite's online backup API, which is safe
// while the daemon writes in WAL mode (a plain file copy of a live WAL database can be torn). Each copy is
// verified (PRAGMA quick_check + a message count) before it replaces anything; the newest N are kept.
//
// Never backed up: auth/ (the linked-device credentials: relinking is cheap, and restoring stale Signal session
// keys can break decryption) and the API token. Keep backups local; never in a cloud-synced folder.

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { clientConfig } from '../client.mjs';
import { selfCommand } from '../self.mjs';
import { runQuiet, systemdAvailable, unitPath } from '../service.mjs';
import { usage } from './args.mjs';

export const TIMER = 'wa-bridge-backup.timer';
export const TIMER_SERVICE = 'wa-bridge-backup.service';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

/** Make one verified backup into `dest`, keep the newest `keep`. Returns { file, bytes, messages, pruned }. */
export async function backupStore({ db, dest, keep = 7, now = new Date() }) {
  if (!existsSync(db)) throw new Error(`no message store at ${db} yet`);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  let target = join(dest, `wa-${stamp(now)}.sqlite`);
  for (let i = 1; existsSync(target); i++) target = join(dest, `wa-${stamp(now)}-${i}.sqlite`);
  const partial = `${target}.partial`;
  const { DatabaseSync, backup } = await import('node:sqlite');
  const clean = () => { for (const s of ['', '-wal', '-shm']) rmSync(partial + s, { force: true }); };
  try {
    const src = new DatabaseSync(db, { readOnly: true });
    try { await backup(src, partial); } finally { src.close(); }
    const chk = new DatabaseSync(partial, { readOnly: true });
    let ok;
    let messages;
    try {
      ok = Object.values(chk.prepare('PRAGMA quick_check').get())[0];
      messages = chk.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    } finally { chk.close(); }
    if (ok !== 'ok') throw new Error(`the copy failed its integrity check: ${ok}`);
    renameSync(partial, target);
    for (const s of ['-wal', '-shm']) rmSync(partial + s, { force: true });
    const copies = readdirSync(dest).filter((f) => /^wa-\d{8}-\d{4}(-\d+)?\.sqlite$/.test(f)).sort().reverse();
    const pruned = copies.slice(Math.max(1, keep));
    for (const f of pruned) for (const s of ['', '-wal', '-shm']) rmSync(join(dest, f + s), { force: true });
    return { file: target, bytes: statSync(target).size, messages, pruned };
  } catch (e) {
    clean();
    throw e;
  }
}

function timerUnits({ dest, keep, command = selfCommand() }) {
  const q = (s) => (/^[A-Za-z0-9_\-./=:@+,%]+$/.test(s) ? s.replace(/%/g, '%%') : `"${String(s).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  const service = [
    '# Written by `wa backup --schedule daily`. Remove with: wa backup --schedule off',
    '[Unit]',
    'Description=WA Bridge — daily backup of the message store',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${[...command, 'backup', '--dest', dest, '--keep', String(keep)].map(q).join(' ')}`,
    'UMask=0077',
    '',
  ].join('\n');
  const timer = [
    '# Written by `wa backup --schedule daily`. Remove with: wa backup --schedule off',
    '[Unit]',
    'Description=WA Bridge — daily backup of the message store',
    '',
    '[Timer]',
    'OnCalendar=*-*-* 03:45',
    'Persistent=true',
    'RandomizedDelaySec=10m',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
  return { service, timer };
}

export function scheduleBackups({ dest, keep, env = process.env, run = runQuiet }) {
  const dir = join(unitPath(env), '..');
  const u = timerUnits({ dest, keep });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, TIMER_SERVICE), u.service, { mode: 0o644 });
  writeFileSync(join(dir, TIMER), u.timer, { mode: 0o644 });
  for (const args of [['daemon-reload'], ['enable', '--now', TIMER]]) {
    const r = run('systemctl', ['--user', ...args]);
    if (r.status !== 0) throw new Error(`systemctl --user ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return dir;
}

export function unscheduleBackups({ env = process.env, run = runQuiet } = {}) {
  const dir = join(unitPath(env), '..');
  if (!existsSync(join(dir, TIMER))) return false;
  run('systemctl', ['--user', 'disable', '--now', TIMER]);
  rmSync(join(dir, TIMER), { force: true });
  rmSync(join(dir, TIMER_SERVICE), { force: true });
  run('systemctl', ['--user', 'daemon-reload']);
  return true;
}

export async function backupCommand(pos, flags) {
  const { paths } = clientConfig(undefined, { requireToken: false });
  const dest = resolve(flags.dest || join(paths.root, 'backups'));
  const keep = flags.keep === undefined ? 7 : Number(flags.keep);
  if (!Number.isInteger(keep) || keep < 1) throw usage('wa backup [--dest <dir>] [--keep N]   (N >= 1)');

  if (flags.schedule) {
    if (flags.schedule === 'off') {
      console.log(unscheduleBackups() ? 'daily backups switched off' : 'no backup schedule was set');
      return 0;
    }
    if (flags.schedule !== 'daily') throw usage('wa backup --schedule daily|off [--dest <dir>] [--keep N]');
    if (!systemdAvailable()) {
      console.log('No systemd user session here. Add this line with `crontab -e` instead:');
      console.log(`45 3 * * * ${selfCommand().join(' ')} backup --dest '${dest}' --keep ${keep}`);
      return 1;
    }
    scheduleBackups({ dest, keep });
    console.log(`daily backups at 03:45 into ${dest} (newest ${keep} kept) · systemd --user ${TIMER}`);
    return 0;
  }

  const log = join(dest, 'backup.log');
  try {
    const r = await backupStore({ db: paths.db, dest, keep });
    const line = `ok ${r.file} ${(r.bytes / 1048576).toFixed(1)} MB ${r.messages} messages${r.pruned.length ? ` (pruned ${r.pruned.length})` : ''}`;
    appendFileSync(log, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    console.log(line);
    return 0;
  } catch (e) {
    try { mkdirSync(dest, { recursive: true, mode: 0o700 }); appendFileSync(log, `${new Date().toISOString()} FAILED ${e.message}\n`, { mode: 0o600 }); } catch { /* the error below is what matters */ }
    throw e;
  }
}
