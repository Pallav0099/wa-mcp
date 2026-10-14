// Small pure helpers shared by every module. No I/O here.

import { extname } from 'node:path';

/** Coerce protobuf Long / bigint / string / number timestamps to a JS number (or null). */
export function toNum(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'bigint') return Number(x);
  if (typeof x === 'object') {
    if (typeof x.toNumber === 'function') return x.toNumber();
    if ('low' in x && 'high' in x) return (x.high >>> 0) * 4294967296 + (x.low >>> 0);
  }
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

/** '1555…:12@s.whatsapp.net' -> '1555…@s.whatsapp.net'; 'x@c.us' -> 'x@s.whatsapp.net'. */
export function bareJid(jid) {
  if (!jid || typeof jid !== 'string') return jid ?? null;
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  let user = jid.slice(0, at);
  let server = jid.slice(at + 1);
  const colon = user.indexOf(':');
  if (colon >= 0) user = user.slice(0, colon);
  const underscore = user.indexOf('_'); // agent suffix on some device jids
  if (underscore >= 0 && server !== 'g.us') user = user.slice(0, underscore);
  if (server === 'c.us') server = 's.whatsapp.net';
  return `${user}@${server}`;
}

export const jidUser = (jid) => (jid ? String(jid).split('@')[0].split(':')[0] : null);
export const isGroupJid = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');
export const isLidJid = (jid) => typeof jid === 'string' && jid.endsWith('@lid');
export const isPnJid = (jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');

export function chatKind(jid) {
  if (!jid) return 'other';
  if (jid.endsWith('@g.us')) return 'group';
  if (jid === 'status@broadcast') return 'status';
  if (jid.endsWith('@broadcast')) return 'broadcast';
  if (jid.endsWith('@newsletter')) return 'channel';
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) return 'dm';
  return 'other';
}

/** Digits-only form of a phone number, or null. '+1 555-010-0001' -> '15550100001'. */
export function phoneDigits(s) {
  if (s === null || s === undefined) return null;
  const str = String(s).trim();
  if (!/^[+\d][\d\s().-]*$/.test(str)) return null;
  const d = str.replace(/\D/g, '');
  return d.length >= 7 ? d : null;
}

export function truncate(s, n) {
  if (s === null || s === undefined) return s;
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.3gp': 'video/3gpp', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([e, m]) => [m, e]));
Object.assign(EXT_BY_MIME, { 'image/jpeg': '.jpg', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'video/mp4': '.mp4' });

export function mimeForPath(path) {
  return MIME_BY_EXT[extname(path).toLowerCase()] || 'application/octet-stream';
}

export function extForMime(mime, fallbackName) {
  if (fallbackName && extname(fallbackName)) return extname(fallbackName).toLowerCase();
  if (!mime) return '.bin';
  const base = mime.split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[base] || '.' + (base.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '').slice(0, 8);
}

/** Which WhatsApp media kind a local file should be sent as, when the caller does not say. */
export function mediaKindForPath(path) {
  const mime = mimeForPath(path);
  if (mime.startsWith('image/') && mime !== 'image/gif') return 'image';
  if (mime.startsWith('video/') || mime === 'image/gif') return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/** Parse '2026-09-24', '2026-09-24T10:00', or epoch seconds into epoch seconds. */
export function parseWhen(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^\d{9,11}$/.test(s)) return Number(s);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Build a safe FTS5 query: every term quoted (AND semantics); a trailing * keeps prefix search. */
export function ftsQuery(q) {
  const terms = String(q || '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t) => {
    const prefix = t.endsWith('*');
    const core = (prefix ? t.slice(0, -1) : t).replace(/"/g, '""');
    return core ? `"${core}"${prefix ? '*' : ''}` : null;
  }).filter(Boolean).join(' ');
}

export function formatTs(sec, { withYear = false } = {}) {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const date = withYear ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class BridgeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}
