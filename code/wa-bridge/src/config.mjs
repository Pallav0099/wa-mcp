// Configuration and on-disk layout.
//
// Everything the bridge owns lives in ONE data directory, outside any synced or mirrored folder:
//   %LOCALAPPDATA%\wa-bridge   (override with WA_BRIDGE_HOME)
// Code lives in the git repo; data never does.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 3210,
  // Shown on the phone as "Chrome (Windows)". Tested 2026-09-24 on Baileys 7.0.0-rc13: WhatsApp closes the
  // connection (428) when a *Desktop* identity (Windows/Mac + 'Desktop') asks for full history, while a browser
  // identity with the same full-history request is accepted. Do not switch to 'Desktop' without re-testing.
  device: { os: 'Windows', browser: 'Chrome' },
  syncFullHistory: true,
  // Status updates (stories) and channels are noise for this tool; they are dropped before decryption.
  ignoreStatusAndChannels: true,
  linkTimeoutSec: 300,
  sending: {
    enabled: true,          // master switch; even when on, every send is a two-step draft -> confirm
    draftTtlSec: 900,       // an unconfirmed draft dies after 15 minutes
    maxPerMinute: 6,
    maxPerDay: 120,
    requireKnownChat: true, // refuse chats the store has never seen unless the draft says allowNew
    // The ONE exception to draft -> confirm (vault decision 2026-09-27-wa-self-alerts, his grant): POST /send/self
    // sends text to the linked account's OWN chat, unattended, for the vault's automated alerts. It takes no
    // recipient, so it cannot reach anyone else. Off unless config.json turns it on.
    selfUnattended: false,
    maxTextLength: 4096,
    maxMediaBytes: 100 * 1024 * 1024,
  },
  log: { level: 'info', baileysLevel: 'warn' },
});

export function defaultDataDir() {
  if (process.env.WA_BRIDGE_HOME) return process.env.WA_BRIDGE_HOME;
  const base = process.env.LOCALAPPDATA || join(process.env.HOME || process.env.USERPROFILE || '.', '.local', 'share');
  return join(base, 'wa-bridge');
}

export function pathsFor(root) {
  return {
    root,
    auth: join(root, 'auth'),
    db: join(root, 'wa.sqlite'),
    media: join(root, 'media'),
    outgoing: join(root, 'outgoing'),
    logs: join(root, 'logs'),
    token: join(root, 'token'),
    config: join(root, 'config.json'),
    defaults: join(root, 'config.defaults.json'),
    lock: join(root, 'daemon.lock'),
    qr: join(root, 'link-qr.png'),
  };
}

/** Load (and on first run create) the data directory, config file and API token. */
export function loadConfig(root = defaultDataDir(), { create = true } = {}) {
  const paths = pathsFor(root);
  if (create) for (const d of [paths.root, paths.media, paths.outgoing, paths.logs]) mkdirSync(d, { recursive: true });
  // config.json holds OVERRIDES only, so changed defaults reach existing installs.
  // config.defaults.json is rewritten on every start as a reference of what can be overridden.
  let user = {};
  if (existsSync(paths.config)) {
    user = JSON.parse(readFileSync(paths.config, 'utf8'));
  } else if (create) {
    writeFileSync(paths.config, '{}\n');
  }
  if (create) {
    try { writeFileSync(paths.defaults, JSON.stringify(DEFAULTS, null, 2) + '\n'); } catch { /* informational only */ }
  }
  const cfg = deepMerge(structuredClone(DEFAULTS), user);
  if (process.env.WA_BRIDGE_PORT) cfg.port = Number(process.env.WA_BRIDGE_PORT);
  cfg.paths = paths;
  cfg.token = readOrCreateToken(paths.token, create);
  return cfg;
}

function readOrCreateToken(file, create) {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  if (!create) return null;
  const token = randomBytes(24).toString('hex');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}
