// Thin API client shared by the CLI and the MCP server. Reads port + token from the data directory.

import { loadConfig, defaultDataDir } from './config.mjs';

export function clientConfig(root = defaultDataDir(), { requireToken = true } = {}) {
  const cfg = loadConfig(root, { create: false });
  if (!cfg.token && requireToken) {
    const err = new Error(`wa-bridge has never started with ${cfg.paths.root}; run: wa start (or wa connect)`);
    err.code = 'not_started';
    throw err;
  }
  return { base: `http://127.0.0.1:${cfg.port}`, port: cfg.port, token: cfg.token, paths: cfg.paths };
}

export async function call(method, path, body, { root } = {}) {
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
