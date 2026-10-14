// Local HTTP API. Every client (the `wa` CLI, the MCP server, scripts) goes through here.
//
// Security: bound to 127.0.0.1 only; every request needs the bearer token from the data directory;
// requests carrying an Origin header (browsers) or a foreign Host header (DNS rebinding) are refused.
// Responses are JSON: { ok: true, ... } or { ok: false, error: { code, message, ... } }.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeError, extForMime, parseWhen } from './util.mjs';
import { VERSION } from './version.mjs';

const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker', 'video_note']);
const STATUS_BY_CODE = {
  bad_request: 400, unauthorized: 401, forbidden: 403, sending_disabled: 403, not_found: 404, not_on_whatsapp: 404,
  no_payload: 404, ambiguous: 409, unknown_chat: 409, not_pending: 409, already_linked: 409, payload_too_large: 413,
  rate_limited: 429, not_connected: 503,
};

export function createApi({ cfg, store, wa, outbox, log, onShutdown = () => {} }) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };
  const tokenBuf = Buffer.from(String(cfg.token));
  let port = cfg.port;

  const chatParam = (p) => store.resolveChat(p).jid;
  const optChat = (v) => (v ? store.resolveChat(v).jid : null);
  const int = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));

  // ------------------------------------------------------------ status & control
  route('GET', '/health', () => ({
    version: VERSION, ...wa.status(), stats: store.stats(),
    sending: { enabled: !!cfg.sending.enabled, confirmRequired: true, selfUnattended: !!cfg.sending.selfUnattended, maxPerMinute: cfg.sending.maxPerMinute, maxPerDay: cfg.sending.maxPerDay },
  }));
  route('GET', '/link', () => wa.linkStatus());
  route('POST', '/link', ({ body }) => wa.startLink({ method: body.method || 'qr', phone: body.phone }));
  route('POST', '/pause', async () => { await wa.pause(); store.audit('paused', {}); return wa.status(); });
  route('POST', '/resume', async () => { await wa.resume(); store.audit('resumed', {}); return wa.status(); });
  route('POST', '/logout', async ({ body }) => {
    if (body.confirm !== 'LOGOUT') throw new BridgeError('bad_request', 'logout unlinks this device; send {"confirm":"LOGOUT"}');
    await wa.logout();
    return { requested: true };
  });
  route('POST', '/shutdown', () => { setTimeout(onShutdown, 50); return { stopping: true }; });

  // ------------------------------------------------------------ reading
  route('GET', '/chats', ({ query }) => ({
    chats: store.listChats({ limit: int(query.limit, 30), q: query.q || null, unread: query.unread === '1', kind: query.kind || null, includeArchived: query.archived !== '0' }),
  }));
  route('GET', '/chats/:chat', ({ params }) => {
    const r = store.resolveChat(params.chat);
    return { chat: { ...r, group: r.kind === 'group' ? store.getGroup(r.jid) : null } };
  });
  route('GET', '/chats/:chat/messages', ({ params, query }) => {
    const jid = chatParam(params.chat);
    return { chat: { jid, name: store.displayName(jid) }, messages: store.chatMessages(jid, { limit: int(query.limit, 30), before: parseWhen(query.before), after: parseWhen(query.after) }) };
  });
  route('GET', '/search', ({ query }) => ({
    messages: store.search({
      q: query.q || null, chat: optChat(query.chat), sender: optChat(query.from),
      since: parseWhen(query.since), until: parseWhen(query.until), limit: int(query.limit, 30),
    }),
  }));
  route('GET', '/messages/:chat/:id', ({ params }) => {
    const jid = chatParam(params.chat);
    const m = store.getMessage(jid, params.id);
    if (!m) throw new BridgeError('not_found', `message ${params.id} not found in ${jid}`);
    const quoted = m.quoted_id ? store.getMessage(jid, m.quoted_id) : null;
    return { message: m, quoted };
  });
  route('GET', '/events', ({ query }) => {
    if (query.latest === '1') return { cursor: store.latestCursor(), messages: [] };
    const messages = store.events({ after: int(query.after, 0), limit: int(query.limit, 100) });
    const cursor = messages.length ? messages[messages.length - 1].rowid : int(query.after, 0);
    return { cursor, messages };
  });
  route('GET', '/contacts', ({ query }) => ({ contacts: store.searchContacts(query.q || '', int(query.limit, 20)) }));
  route('GET', '/groups', ({ query }) => ({ groups: store.listGroups({ q: query.q || null, limit: int(query.limit, 100) }) }));
  route('GET', '/groups/:chat', async ({ params, query }) => {
    const jid = chatParam(params.chat);
    if (query.refresh === '1') await wa.refreshGroup(jid);
    const g = store.getGroup(jid);
    if (!g) throw new BridgeError('not_found', `${jid} is not a known group`);
    return { group: g };
  });
  route('GET', '/audit', ({ query }) => ({ audit: store.listAudit(int(query.limit, 50)) }));

  // ------------------------------------------------------------ explicit actions on the account
  route('POST', '/messages/:chat/:id/media', async ({ params }) => {
    const jid = chatParam(params.chat);
    const row = store.getMessageRow(jid, params.id);
    if (!row || row.chat_jid !== jid) throw new BridgeError('not_found', `message ${params.id} not found in ${jid}`);
    if (!MEDIA_KINDS.has(row.kind)) throw new BridgeError('bad_request', `message ${params.id} is ${row.kind}, not media`);
    if (row.media_path && existsSync(row.media_path)) return { path: row.media_path, mime: row.media_mime, cached: true };
    const buf = await wa.downloadMedia(row);
    const dir = join(cfg.paths.media, safeName(jid));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, safeName(row.id) + extForMime(row.media_mime, row.media_name));
    await writeFile(file, buf);
    store.setMediaPath(jid, row.id, file);
    log.info('media_downloaded', { chat: jid, id: row.id, bytes: buf.length });
    return { path: file, mime: row.media_mime, bytes: buf.length, name: row.media_name, cached: false };
  });
  route('POST', '/chats/:chat/read', async ({ params }) => {
    const jid = chatParam(params.chat);
    const rows = store.recentInbound(jid, 20);
    if (!rows.length) return { chat: jid, marked: 0 };
    await wa.readMessages(rows.map((r) => JSON.parse(r.key_json)));
    try { await wa.markChatRead(jid, rows[0]); } catch (e) { log.warn('chat_mark_read_failed', { chat: jid, error: e }); }
    store.upsertChat({ jid, unread: 0 });
    store.audit('mark_read', { chat: jid, count: rows.length });
    return { chat: jid, marked: rows.length };
  });
  route('POST', '/chats/:chat/history', async ({ params, body }) => {
    const jid = chatParam(params.chat);
    const oldest = store.oldestMessage(jid);
    if (!oldest) throw new BridgeError('bad_request', 'no stored message in this chat to anchor a history request');
    const count = Math.min(Math.max(int(body.count, 50), 1), 50);
    const requestId = await wa.fetchHistory(count, JSON.parse(oldest.key_json), oldest.ts);
    store.audit('history_requested', { chat: jid, count });
    return { chat: jid, requested: count, requestId, note: 'older messages arrive asynchronously through history sync' };
  });

  // ------------------------------------------------------------ sending: draft -> confirm
  route('POST', '/send/draft', ({ body }) => outbox.draft(body));
  route('POST', '/send/confirm', ({ body }) => outbox.confirm(body.token));
  route('POST', '/send/cancel', ({ body }) => outbox.cancel(body.token));
  route('GET', '/send/drafts', ({ query }) => ({ drafts: outbox.list(query.status || 'draft') }));
  // The one unattended exception: the linked account's own chat only, no recipient accepted (outbox.sendSelf).
  route('POST', '/send/self', ({ body }) => outbox.sendSelf({ text: body.text, source: body.source }));

  // ------------------------------------------------------------ server
  const server = createServer(async (req, res) => {
    const started = Date.now();
    let status = 200;
    let payload;
    try {
      guard(req);
      const url = new URL(req.url, 'http://localhost');
      const match = matchRoute(req.method, url.pathname);
      if (!match) throw new BridgeError('not_found', `no route ${req.method} ${url.pathname}`);
      const body = req.method === 'POST' ? await readJson(req) : {};
      const result = await match.route.handler({ params: match.params, query: Object.fromEntries(url.searchParams), body });
      payload = { ok: true, ...result };
    } catch (e) {
      const code = e instanceof BridgeError ? e.code : 'internal';
      status = STATUS_BY_CODE[code] || 500;
      const error = { code, message: e.message };
      if (e.candidates) error.candidates = e.candidates;
      if (e.target) error.target = e.target;
      payload = { ok: false, error };
      if (status >= 500) log.error('api_error', { method: req.method, path: req.url?.split('?')[0], error: e });
    }
    const json = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(json);
    log.debug('api', { method: req.method, path: req.url?.split('?')[0], status, ms: Date.now() - started });
  });

  function guard(req) {
    if (req.headers.origin) throw new BridgeError('forbidden', 'browser requests are not accepted');
    const host = String(req.headers.host || '').toLowerCase();
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(host)) throw new BridgeError('forbidden', 'unexpected Host header');
    const auth = String(req.headers.authorization || '');
    const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
    if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) throw new BridgeError('unauthorized', 'missing or wrong API token');
  }

  function matchRoute(method, path) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host || '127.0.0.1', () => {
        port = server.address().port;
        resolve(port);
      });
    }),
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections(); // keep-alive clients must not hold a graceful stop open
    }),
    get port() { return port; },
  };
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new BridgeError('payload_too_large', 'request body over 1 MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new BridgeError('bad_request', 'body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 120);
}
