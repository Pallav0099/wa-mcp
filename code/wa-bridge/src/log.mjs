// Structured JSON-lines logging, one file per day.
//
// RULE: log metadata only (ids, counts, states, errors). Never log message text, captions, names
// typed by people, or media. The message store holds content; the log must stay safe to share.

import { appendFileSync } from 'node:fs';
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

/** A logger that discards everything (tests). */
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function replacer(_key, value) {
  if (value instanceof Error) {
    return { message: value.message, code: value.code, status: value.output?.statusCode, stack: value.stack?.split('\n').slice(0, 4).join(' | ') };
  }
  if (typeof value === 'bigint') return String(value);
  return value;
}
