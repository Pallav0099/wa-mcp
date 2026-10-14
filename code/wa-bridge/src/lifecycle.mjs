// Daemon lifecycle: graceful shutdown and process-level handlers, kept apart from daemon.mjs so they can be tested.
//
// Exit codes are part of the contract with the service manager (systemd: Restart=on-failure,
// RestartPreventExitStatus=2):
//   0  stopped on purpose (SIGTERM/SIGINT, POST /shutdown)  -> stays stopped
//   1  crashed or failed to start                           -> restarted
//   2  another instance already serves this data directory  -> never restarted

import { readFileSync } from 'node:fs';

export const EXIT = Object.freeze({ OK: 0, FAILURE: 1, ALREADY_RUNNING: 2 });

const HARD_EXIT_MS = 10_000;

export function createShutdown({ wa, api, store, log, releaseLock, exit = (code) => process.exit(code) }) {
  let closing = false;
  return async function shutdown(reason, code = EXIT.OK) {
    if (closing) {
      if (code !== EXIT.OK) exit(code); // a crash while already closing must still fail loudly
      return;
    }
    closing = true;
    log.info('shutdown', { reason, code });
    // never hang on a stuck socket or connection: the service manager needs an exit (with the same intent)
    setTimeout(() => exit(code), HARD_EXIT_MS).unref();
    try { await wa?.stop(); } catch (e) { log.warn('wa_stop_failed', { error: e }); }
    try { await api?.close(); } catch { /* ignore */ }
    try { store?.audit('daemon_stopped', { reason }); store?.close(); } catch { /* ignore */ }
    try { releaseLock?.(); } catch { /* ignore */ }
    exit(code);
  };
}

export function installProcessHandlers(proc, shutdown, log) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) proc.on(sig, () => shutdown(sig, EXIT.OK));
  proc.on('unhandledRejection', (e) => log.error('unhandled_rejection', { error: e }));
  proc.on('uncaughtException', (e) => {
    log.error('uncaught_exception', { error: e });
    shutdown('crash', EXIT.FAILURE);
  });
}

/** True when a wa-bridge daemon for THIS data directory answers on the port (it accepts our token). */
export async function ourDaemonAnswers(port, token, timeoutMs = 1000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Linux only: does this PID belong to a wa-bridge daemon (and not to an unrelated process that reused the PID)?
 * Elsewhere we cannot tell cheaply and answer false, so a stale lock never blocks a start.
 */
export function pidIsDaemon(pid) {
  if (process.platform !== 'linux') return false;
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return argv.some((a) => a.endsWith('daemon.mjs')) || (argv.some((a) => a.endsWith('wa.mjs')) && argv.includes('daemon'));
  } catch {
    return false;
  }
}
