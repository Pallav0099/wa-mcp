// Nightly backup of the wa-bridge MESSAGE STORE ONLY (wa.sqlite) to E:\wa-bridge-backup.
// - Consistent: uses SQLite's online backup API (node:sqlite `backup`), safe while the daemon is writing in WAL mode.
//   A raw file copy of a live WAL database can be torn.
// - The auth folder is deliberately NOT backed up: relinking is cheap (pairing code), and restoring stale Signal
//   session keys can break decryption.
// - Local only (never cloud): the store holds every private chat. Keeps the newest KEEP copies.
// Usage: node scripts/backup.mjs [--dest E:\wa-bridge-backup] [--keep 7]
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const dataDir = join(process.env.LOCALAPPDATA, 'wa-bridge');
const src = join(dataDir, 'wa.sqlite');
const dest = arg('--dest', 'E:\\wa-bridge-backup');
const keep = Number(arg('--keep', '7'));
const stamp = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
const logFile = join(dest, 'backup.log');
const log = (msg) => { const line = `${new Date().toISOString()} ${msg}\n`; process.stdout.write(line); try { appendFileSync(logFile, line); } catch { } };

mkdirSync(dest, { recursive: true });
const target = join(dest, `wa-${stamp}.sqlite`);
const partial = target + '.partial';
const t0 = Date.now();
try {
  const db = new DatabaseSync(src, { readOnly: true });
  const pages = await backup(db, partial);
  db.close();
  // verify the copy opens and is internally consistent before it replaces anything
  const chk = new DatabaseSync(partial, { readOnly: true });
  const ok = chk.prepare('PRAGMA quick_check').get();
  const n = chk.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  chk.close();
  if (Object.values(ok)[0] !== 'ok') throw new Error('quick_check failed: ' + JSON.stringify(ok));
  renameSync(partial, target);
  for (const s of ['-wal', '-shm']) { try { unlinkSync(partial + s); } catch { } }   // the check's SQLite sidecars
  const mb = (statSync(target).size / 1048576).toFixed(1);
  log(`ok ${target} ${mb} MB ${n} messages ${pages} pages ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  for (const s of ['', '-wal', '-shm']) { try { unlinkSync(partial + s); } catch { } }
  log(`FAILED ${e.message}`);
  process.exit(1);
}
// retention: keep the newest `keep` completed copies
const copies = readdirSync(dest).filter((f) => /^wa-\d{8}-\d{4}\.sqlite$/.test(f)).sort().reverse();
for (const f of copies.slice(keep)) {
  for (const s of ['', '-wal', '-shm']) { try { unlinkSync(join(dest, f + s)); } catch { } }
  log(`pruned ${f}`);
}
