// Thin API client shared by the CLI and the MCP server. Reads port + token from the data directory, and can
// start the daemon on demand (ensureDaemon) so that a command or an agent's first tool call just works.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, defaultDataDir } from './config.mjs';
import { ourDaemonAnswers } from './lifecycle.mjs';
import { startDetached } from './service.mjs';

let autoStart = false;
/** CLI and MCP turn this on: a call that finds the daemon down starts it once, then retries. */
export function setAutoStart(on) { autoStart = !!on; }

export function clientConfig(root = defaultDataDir(), { requireToken = true } = {}) {
  const cfg = loadConfig(root, { create: false });
  if (!cfg.token && requireToken) {
    const err = new Error(`wa-bridge has never started with ${cfg.paths.root}; run: wa start (or wa connect)`);
    err.code = 'not_started';
    throw err;
  }
  return { base: `http://127.0.0.1:${cfg.port}`, port: cfg.port, token: cfg.token, paths: cfg.paths };
}

/** `wa stop` leaves this flag so nothing (an agent's tool call, another command) silently restarts the daemon. */
export const stoppedFlag = (paths) => join(paths.root, 'stopped');

/**
 * Make sure the daemon for this data directory is answering. Starts it if needed and waits for it.
 * Resolves { started: false } if it was already up, { started: true, via } after starting it.
 * Refuses (code 'stopped') when the user stopped it with `wa stop`, unless `ignoreStopped` is set.
 */
export async function ensureDaemon({ root = defaultDataDir(), timeoutMs = 15_000, ignoreStopped = false, starter = defaultStarter } = {}) {
  const first = clientConfig(root, { requireToken: false });
  if (first.token && (await ourDaemonAnswers(first.port, first.token))) return { started: false };
  if (!ignoreStopped && existsSync(stoppedFlag(first.paths))) {
    const err = new Error('wa-bridge was stopped with `wa stop`; run: wa start');
    err.code = 'stopped';
    throw err;
  }
  const via = await starter(first.paths);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const c = clientConfig(root, { requireToken: false }); // the token appears on the daemon's first start
    if (c.token && (await ourDaemonAnswers(c.port, c.token, 500))) return { started: true, via };
  }
  const err = new Error(`wa-bridge did not start within ${Math.round(timeoutMs / 1000)} s; see ${join(first.paths.logs, 'daemon-stderr.log')} or run: wa doctor`);
  err.code = 'start_failed';
  throw err;
}

async function defaultStarter(paths) {
  startDetached(paths);
  return 'detached';
}

export async function call(method, path, body, { root } = {}) {
  try {
    return await rawCall(method, path, body, { root });
  } catch (e) {
    if (!autoStart || (e.code !== 'unreachable' && e.code !== 'not_started')) throw e;
    await ensureDaemon({ root });
    return rawCall(method, path, body, { root });
  }
}

async function rawCall(method, path, body, { root } = {}) {
  const { base, token } = clientConfig(root);
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    const err = new Error(`wa-bridge is not running at ${base} (${e.cause?.code || e.message}); run: wa start`);
    err.code = 'unreachable';
    throw err;
  }
  let json;
  try { json = await res.json(); } catch { json = { ok: false, error: { code: 'bad_response', message: `HTTP ${res.status}` } }; }
  if (!json.ok) {
    const err = new Error(json.error?.message || `HTTP ${res.status}`);
    err.code = json.error?.code;
    err.detail = json.error;
    throw err;
  }
  return json;
}

export const enc = (s) => encodeURIComponent(String(s));

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== false && v !== '') p.set(k, v === true ? '1' : String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
