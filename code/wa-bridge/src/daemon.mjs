#!/usr/bin/env node
// wa-bridge daemon: wires config -> store -> ingest -> WhatsApp connection -> outbox -> API.
// Start it hidden with scripts/start.ps1; stop it with `wa shutdown` (graceful) or scripts/stop.ps1.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { loadConfig } from './config.mjs';
import { createLogger } from './log.mjs';
import { Store } from './store.mjs';
import { Ingest } from './ingest.mjs';
import { WhatsApp } from './wa.mjs';
import { Outbox } from './outbox.mjs';
import { createApi } from './api.mjs';

const cfg = loadConfig();
const log = createLogger(cfg.paths.logs, cfg.log.level, { echo: !!process.stdout.isTTY });

await acquireLock();
const store = new Store(cfg.paths.db);
const ingest = new Ingest({ store, log });
const wa = new WhatsApp({ cfg, store, ingest, log });
const outbox = new Outbox({ store, wa, ingest, cfg, log });
const api = createApi({ cfg, store, wa, outbox, log, onShutdown: () => shutdown('api') });

try {
  await api.listen();
} catch (e) {
  log.error('api_listen_failed', { port: cfg.port, error: e });
  releaseLock();
  process.exit(1);
}
log.info('started', { pid: process.pid, host: cfg.host, port: api.port, data: cfg.paths.root });
store.audit('daemon_started', { pid: process.pid });

setInterval(() => {
  try { store.expireDrafts(); } catch (e) { log.warn('expire_drafts_failed', { error: e }); }
}, 60_000).unref();

await wa.init();

let closing = false;
async function shutdown(reason) {
  if (closing) return;
  closing = true;
  log.info('shutdown', { reason });
  try { await wa.stop(); } catch (e) { log.warn('wa_stop_failed', { error: e }); }
  try { await api.close(); } catch { /* ignore */ }
  try { store.audit('daemon_stopped', { reason }); store.close(); } catch { /* ignore */ }
  releaseLock();
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
process.on('unhandledRejection', (e) => log.error('unhandled_rejection', { error: e }));
process.on('uncaughtException', (e) => {
  log.error('uncaught_exception', { error: e });
  shutdown('crash').finally(() => process.exit(1));
});

// ---------------------------------------------------------------- single-instance lock

async function acquireLock() {
  if (existsSync(cfg.paths.lock)) {
    const pid = Number(readFileSync(cfg.paths.lock, 'utf8').trim());
    if (pid && pid !== process.pid && pidAlive(pid) && (await portAnswers(cfg.port))) {
      console.error(`wa-bridge is already running (pid ${pid}, port ${cfg.port})`);
      process.exit(2);
    }
  }
  writeFileSync(cfg.paths.lock, String(process.pid));
}

function releaseLock() {
  try {
    if (existsSync(cfg.paths.lock) && Number(readFileSync(cfg.paths.lock, 'utf8').trim()) === process.pid) rmSync(cfg.paths.lock);
  } catch { /* ignore */ }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function portAnswers(port) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}
