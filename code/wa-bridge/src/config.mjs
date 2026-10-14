// Configuration and on-disk layout.
//
// Everything the bridge owns lives in ONE data directory, outside any synced or mirrored folder:
//   Linux/macOS: $XDG_DATA_HOME/wa-bridge, default ~/.local/share/wa-bridge
//   Windows:     %LOCALAPPDATA%\wa-bridge
//   Override:    WA_BRIDGE_HOME (the installed launcher always sets it, so every process agrees)
// The directory is private to the user (0700): it holds the WhatsApp credentials and every message.
// Code lives in the install directory or the git repo; data never does.

import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
    // The ONE exception to draft -> confirm: POST /send/self (`wa notify`) sends text to the linked account's OWN
    // chat, unattended, for automated alerts and reminders. It takes no recipient, so it cannot reach anyone
    // else. Off unless config.json turns it on.
    selfUnattended: false,
    maxTextLength: 4096,
    maxMediaBytes: 100 * 1024 * 1024,
  },
  // keepDays: daily log files older than this are deleted by the daemon
  log: { level: 'info', baileysLevel: 'warn', keepDays: 30 },
});

export function defaultDataDir(env = process.env) {
  if (env.WA_BRIDGE_HOME) return env.WA_BRIDGE_HOME;
  if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'wa-bridge');
  const home = env.HOME || env.USERPROFILE || '.';
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'wa-bridge');
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
  if (create) {
    for (const d of [paths.root, paths.media, paths.outgoing, paths.logs]) mkdirSync(d, { recursive: true, mode: 0o700 });
    secureDataDir(paths);
  }
  // config.json holds OVERRIDES only, so changed defaults reach existing installs.
  // config.defaults.json is rewritten on every start as a reference of what can be overridden.
  let user = {};
  if (existsSync(paths.config)) {
    try {
      user = JSON.parse(readFileSync(paths.config, 'utf8'));
    } catch (e) {
      throw new Error(`${paths.config} is not valid JSON (${e.message}); fix it or move it away to use the defaults`);
    }
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

/**
 * Make the data directory private to the user. A 0700 directory keeps everything below it (credentials,
 * wa.sqlite, media, logs) unreadable by other local users even if a file inside was created 0644.
 * No-op where POSIX modes do not apply (Windows relies on the user-profile ACL).
 */
export function secureDataDir(paths) {
  if (process.platform === 'win32') return;
  try { chmodSync(paths.root, 0o700); } catch { /* best effort; wa doctor reports it */ }
  try { if (existsSync(paths.token)) chmodSync(paths.token, 0o600); } catch { /* best effort */ }
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
