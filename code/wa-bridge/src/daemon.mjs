#!/usr/bin/env node
// wa-bridge daemon: wires config -> store -> ingest -> WhatsApp connection -> outbox -> API.
// Run in the foreground by the service manager (`wa-bridge daemon` under systemd --user), or detached by
// `wa start` where there is no service manager. Exit codes: see lifecycle.mjs.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { createLogger, pruneLogs, rotateIfLarge } from './log.mjs';
import { Store } from './store.mjs';
import { Ingest } from './ingest.mjs';
import { WhatsApp } from './wa.mjs';
import { Outbox } from './outbox.mjs';
import { createApi } from './api.mjs';
import { EXIT, createShutdown, installProcessHandlers, ourDaemonAnswers, pidIsDaemon } from './lifecycle.mjs';

// Everything this process creates (credentials, database, media, logs) is private to the user.
if (process.platform !== 'win32') process.umask(0o077);

const cfg = loadConfig();
rotateIfLarge(join(cfg.paths.logs, 'baileys.log')); // before Baileys opens it with the first socket
const log = createLogger(cfg.paths.logs, cfg.log.level, { echo: !!process.stdout.isTTY });

await acquireLock();

let store;
try {
  store = new Store(cfg.paths.db);
} catch (e) {
  log.error('store_open_failed', { error: e });
  console.error(`wa-bridge: ${e.message}`);
  releaseLock();
  process.exit(EXIT.FAILURE);
}
const interrupted = store.failInterruptedSends();
if (interrupted) {
  log.warn('interrupted_sends_failed', { count: interrupted });
  store.audit('send_interrupted', { count: interrupted });
}

const ingest = new Ingest({ store, log });
const wa = new WhatsApp({ cfg, store, ingest, log });
const outbox = new Outbox({ store, wa, ingest, cfg, log });
let shutdown = null;
const api = createApi({ cfg, store, wa, outbox, log, onShutdown: () => shutdown('api', EXIT.OK) });
shutdown = createShutdown({ wa, api, store, log, releaseLock });
installProcessHandlers(process, shutdown, log);

try {
  await api.listen();
} catch (e) {
  log.error('api_listen_failed', { port: cfg.port, error: e });
  console.error(e.code === 'EADDRINUSE'
    ? `wa-bridge: port ${cfg.port} is in use by another program; set "port" in ${cfg.paths.config}`
    : `wa-bridge: cannot listen on 127.0.0.1:${cfg.port}: ${e.message}`);
  releaseLock();
  process.exit(EXIT.FAILURE);
}
log.info('started', { pid: process.pid, host: cfg.host, port: api.port, data: cfg.paths.root });
store.audit('daemon_started', { pid: process.pid });

setInterval(() => {
  try { store.expireDrafts(); } catch (e) { log.warn('expire_drafts_failed', { error: e }); }
}, 60_000).unref();

const prune = () => {
  const removed = pruneLogs(cfg.paths.logs, cfg.log.keepDays);
  if (removed.length) log.info('logs_pruned', { count: removed.length });
};
prune();
setInterval(prune, 86_400_000).unref();

await wa.init();

// ---------------------------------------------------------------- single-instance lock

async function acquireLock() {
  // Already served? Only a daemon holding THIS data directory's token counts, not whatever owns the port.
  if (await ourDaemonAnswers(cfg.port, cfg.token)) {
    console.error(`wa-bridge is already running (port ${cfg.port})`);
    process.exit(EXIT.ALREADY_RUNNING);
  }
  if (existsSync(cfg.paths.lock)) {
    const pid = Number(readFileSync(cfg.paths.lock, 'utf8').trim());
    // still starting up, or listening elsewhere: never run two sockets on one set of credentials
    if (pid && pid !== process.pid && pidAlive(pid) && pidIsDaemon(pid)) {
      console.error(`wa-bridge is already running (pid ${pid})`);
      process.exit(EXIT.ALREADY_RUNNING);
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
