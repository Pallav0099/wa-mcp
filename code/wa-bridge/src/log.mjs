// Structured JSON-lines logging, one file per day.
//
// RULE: log metadata only (ids, counts, states, errors). Never log message text, captions, names
// typed by people, or media. The message store holds content; the log must stay safe to share.

import { appendFileSync, existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(dir, level = 'info', { echo = true } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  function write(lvl, event, fields) {
    if (LEVELS[lvl] < min) return;
    const t = new Date().toISOString();
    const line = JSON.stringify({ t, lvl, event, ...(fields || {}) }, replacer);
    if (dir) {
      try { appendFileSync(join(dir, `wa-bridge-${t.slice(0, 10)}.log`), line + '\n'); } catch { /* disk issues must not kill the bridge */ }
    }
    if (echo) (LEVELS[lvl] >= LEVELS.warn ? console.error : console.log)(line);
  }
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

/** Delete daily log files (wa-bridge-YYYY-MM-DD.log) older than keepDays. Returns the names removed. */
export function pruneLogs(dir, keepDays, now = new Date()) {
  if (!keepDays || keepDays <= 0 || !existsSync(dir)) return [];
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000).toISOString().slice(0, 10);
  const removed = [];
  for (const f of readdirSync(dir)) {
    const m = /^wa-bridge-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
    if (m && m[1] < cutoff) {
      try { unlinkSync(join(dir, f)); removed.push(f); } catch { /* in use or gone */ }
    }
  }
  return removed;
}

/** Keep one previous generation of a log that is appended forever (baileys.log): file -> file.1 when too big. */
export function rotateIfLarge(file, maxBytes = 10 * 1024 * 1024) {
  try {
    if (existsSync(file) && statSync(file).size > maxBytes) { renameSync(file, file + '.1'); return true; }
  } catch { /* rotation must never stop the daemon */ }
  return false;
}

/** A logger that discards everything (tests). */
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function replacer(_key, value) {
  if (value instanceof Error) {
    return { message: value.message, code: value.code, status: value.output?.statusCode, stack: value.stack?.split('\n').slice(0, 4).join(' | ') };
  }
  if (typeof value === 'bigint') return String(value);
  return value;
}
