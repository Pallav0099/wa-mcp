// Connection manager: owns the single Baileys socket and its lifecycle.
//
// States
//   unlinked      no credentials; nothing runs until someone asks to link
//   linking       a link window is open (QR or pairing code), bounded by linkTimeoutSec
//   connecting    credentials present, socket opening
//   open          connected; the only state in which anything can be sent
//   reconnecting  dropped; exponential backoff (1s .. 60s) is running
//   paused        disconnected on purpose, still linked
//   replaced      another client took over these credentials; we stop instead of fighting it
//   logged_out    the phone unlinked this device; credentials archived, relink needed
//   forbidden     WhatsApp refused the account (403); stop
//   stopped       daemon shutting down
//
// This class never sends anything by itself. The only outbound calls are the explicit operations at the
// bottom, each invoked by the API on behalf of a caller.

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { decodeRaw } from './raw.mjs';
import { BridgeError, bareJid, nowSec, phoneDigits } from './util.mjs';

const OS_RELEASE = { Windows: '10.0.22631', 'Mac OS': '14.4.1' };

export class WhatsApp extends EventEmitter {
  constructor({ cfg, store, ingest, log, socketFactory = makeWASocket }) {
    super();
    this.cfg = cfg;
    this.store = store;
    this.ingest = ingest;
    this.log = log;
    this.socketFactory = socketFactory;
    this.state = 'starting';
    this.sock = null;
    this.auth = null;
    this.me = null;
    this.link = null;          // { method, phone, startedAt, codeRequested, error }
    this.qr = null;            // { at, path }
    this.pairingCode = null;   // { code, at }
    this.linkError = null;     // why the last link attempt failed (survives endLink)
    this.attempt = 0;
    this.reconnectTimer = null;
    this.linkTimer = null;
    this.stableTimer = null;
    this.connectedAt = null;
    this.lastEventAt = null;
    this.lastDisconnect = null;
    this.paused = false;
    this.stopping = false;
    this.waVersion = undefined;
    this.baileysLogger = null; // created with the first socket; an unlinked daemon opens no log stream
    this.baileysDest = null;
  }

  getBaileysLogger() {
    if (!this.baileysLogger) {
      // synchronous destination: Baileys logs rarely at "warn", and sync avoids a not-ready race on shutdown
      this.baileysDest = pino.destination({ dest: join(this.cfg.paths.logs, 'baileys.log'), sync: true, mkdir: true });
      this.baileysLogger = pino({ level: this.cfg.log?.baileysLevel || 'warn' }, this.baileysDest);
    }
    return this.baileysLogger;
  }

  // ---------------------------------------------------------------- lifecycle

  async init() {
    await this.loadAuth();
    if (this.isLinked()) {
      this.adoptMeFromCreds();
      await this.connect('startup');
    } else {
      this.setState('unlinked');
    }
  }

  async loadAuth() {
    this.auth = await useMultiFileAuthState(this.cfg.paths.auth);
  }

  isLinked() {
    return !!this.auth?.state?.creds?.me?.id;
  }

  adoptMeFromCreds() {
    const me = this.auth.state.creds.me;
    this.me = { pn: bareJid(me.id), lid: me.lid ? bareJid(me.lid) : null, name: me.name || me.notify || null };
    this.ingest.setMe(this.me);
  }

  setState(state, detail = {}) {
    if (this.state === state) return;
    this.log.info('state', { from: this.state, to: state, ...detail });
    this.state = state;
    this.emit('state', state);
  }

  async resolveVersion() {
    if (this.waVersion !== undefined) return this.waVersion;
    try {
      const r = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ]);
      this.waVersion = r?.version || null;
    } catch (e) {
      this.log.warn('wa_version_fetch_failed', { error: e.message });
      this.waVersion = null; // Baileys falls back to its bundled version
    }
    return this.waVersion;
  }

  async connect(reason) {
    clearTimeout(this.reconnectTimer);
    this.teardown();
    this.setState(this.isLinked() ? 'connecting' : 'linking', { reason });
    const version = await this.resolveVersion();
    if (this.stopping || this.paused) return;
    const { os, browser } = this.cfg.device;
    const ignore = this.cfg.ignoreStatusAndChannels
      ? { shouldIgnoreJid: (jid) => jid === 'status@broadcast' || String(jid).endsWith('@newsletter') }
      : {};
    let sock;
    try {
      sock = this.createSocket(version, os, browser, ignore);
    } catch (e) {
      this.log.error('socket_create_failed', { error: e });
      return this.scheduleReconnect(null, reason === 'link' ? 'link' : 'reconnect');
    }
    this.sock = sock;
    this.bind(sock);
  }

  createSocket(version, os, browser, ignore) {
    return this.socketFactory({
      ...(version ? { version } : {}),
      auth: this.auth.state,
      logger: this.getBaileysLogger(),
      printQRInTerminal: false,
      browser: [os, browser, OS_RELEASE[os] || '10.0'],
      syncFullHistory: !!this.cfg.syncFullHistory,
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false, // the phone keeps receiving notifications as usual
      emitOwnEvents: true,
      getMessage: async (key) => this.lookupContent(key),
      ...ignore,
    });
  }

  bind(sock) {
    const on = (event, handler) => sock.ev.on(event, (payload) => {
      if (sock !== this.sock) return; // events from a socket we already replaced
      this.lastEventAt = nowSec();
      try {
        const r = handler(payload);
        if (r && typeof r.catch === 'function') r.catch((e) => this.log.error('handler_failed', { event, error: e }));
      } catch (e) {
        this.log.error('handler_failed', { event, error: e });
      }
    });

    on('creds.update', () => this.auth.saveCreds());
    on('connection.update', (u) => this.onConnectionUpdate(sock, u));
    on('messaging-history.set', (h) => this.ingest.history(h));
    on('messages.upsert', ({ messages, type }) => {
      let n = 0;
      for (const m of messages || []) if (this.ingest.message(m, { live: true })) n++;
      if (n) this.emit('messages', { count: n, type });
    });
    on('messages.update', (u) => this.ingest.messagesUpdate(u));
    on('messages.delete', (d) => this.ingest.messagesDelete(d));
    on('messages.reaction', (r) => this.ingest.reactions(r));
    on('chats.upsert', (c) => this.ingest.chats(c));
    on('chats.update', (c) => this.ingest.chats(c));
    on('chats.delete', (ids) => this.ingest.chatsDelete(ids));
    on('contacts.upsert', (c) => this.ingest.contacts(c));
    on('contacts.update', (c) => this.ingest.contacts(c));
    on('groups.upsert', (g) => this.ingest.groups(g));
    on('groups.update', (g) => this.ingest.groupsPatch(g));
    on('group-participants.update', (e) => this.refreshGroup(e.id));
    on('lid-mapping.update', (m) => this.ingest.lidMapping(m));
  }

  onConnectionUpdate(sock, { connection, lastDisconnect, qr, isNewLogin }) {
    if (qr) this.onQr(sock, qr);

    if (connection === 'open') {
      this.connectedAt = nowSec();
      clearTimeout(this.linkTimer);
      const u = sock.user || {};
      this.me = { pn: bareJid(u.id), lid: u.lid ? bareJid(u.lid) : null, name: u.name || u.notify || null };
      this.ingest.setMe(this.me);
      if (this.link || isNewLogin) {
        this.store.setKV('linked_at', String(nowSec()));
        this.store.audit('linked', { method: this.link?.method || 'restore' });
      }
      this.link = null;
      this.qr = null;
      this.pairingCode = null;
      clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => { this.attempt = 0; }, 60_000); // only a stable minute resets backoff
      this.setState('open');
      this.refreshGroups().catch((e) => this.log.warn('groups_refresh_failed', { error: e }));
      return;
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error;
      const code = err?.output?.statusCode ?? null;
      this.lastDisconnect = { code, message: err?.message || null, at: nowSec() };
      if (sock !== this.sock) return;
      this.sock = null;
      clearTimeout(this.stableTimer);
      if (this.stopping) return this.setState('stopped');
      if (this.paused) return this.setState('paused');

      switch (code) {
        case DisconnectReason.loggedOut:
          return this.onLoggedOut();
        case DisconnectReason.connectionReplaced:
          this.log.error('connection_replaced', { note: 'another client is using these credentials; not reconnecting' });
          return this.setState('replaced');
        case DisconnectReason.forbidden:
          this.log.error('forbidden', { note: 'WhatsApp refused this account' });
          return this.setState('forbidden');
        case DisconnectReason.restartRequired:
          return void this.connect('restart_required'); // normal right after a successful link
        default:
          break;
      }
      if (!this.isLinked()) {
        if (this.link && !this.qr && !this.pairingCode && this.attempt >= 2) {
          // WhatsApp keeps hanging up before it issues a QR: report it instead of retrying quietly
          this.linkError = `WhatsApp closed the connection before issuing a QR or code (code ${code}), ${this.attempt + 1} times`;
          this.log.error('link_rejected', { code, attempts: this.attempt + 1 });
          return this.endLink('rejected');
        }
        if (this.link && !this.linkExpired()) return this.scheduleReconnect(code, 'link');
        return this.endLink('closed');
      }
      return this.scheduleReconnect(code, 'reconnect');
    }
  }

  onQr(sock, qr) {
    if (!this.link) {
      // Credentials are gone and nobody asked to link: do not leave a pairing window open by accident.
      this.log.warn('qr_without_link_request');
      this.teardown();
      this.setState('unlinked');
      return;
    }
    if (this.link.method === 'code') {
      if (this.link.codeRequested) return;
      this.link.codeRequested = true;
      sock.requestPairingCode(this.link.phone)
        .then((code) => {
          this.pairingCode = { code, at: nowSec() };
          this.log.info('pairing_code_issued');
          this.emit('pairing_code', code);
        })
        .catch((e) => {
          this.link.error = e.message;
          this.log.error('pairing_code_failed', { error: e });
        });
      return;
    }
    const at = nowSec();
    QRCode.toFile(this.cfg.paths.qr, qr, { width: 512, margin: 2 })
      .then(() => {
        this.qr = { at, path: this.cfg.paths.qr };
        this.log.info('qr_issued');
        this.emit('qr', this.qr);
      })
      .catch((e) => this.log.error('qr_write_failed', { error: e }));
  }

  scheduleReconnect(code, why) {
    this.attempt++;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempt - 1, 6)) + Math.floor(Math.random() * 500);
    this.setState('reconnecting', { code, attempt: this.attempt, delayMs: delay, why });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(why).catch((e) => this.log.error('connect_failed', { error: e })), delay);
  }

  async onLoggedOut() {
    this.setState('logged_out');
    this.store.audit('logged_out', {});
    this.me = null;
    try {
      if (existsSync(this.cfg.paths.auth)) {
        const archived = `${this.cfg.paths.auth}.revoked-${nowSec()}`;
        await rename(this.cfg.paths.auth, archived);
        this.log.warn('auth_archived', { archived });
      }
    } catch (e) {
      this.log.error('auth_archive_failed', { error: e });
    }
    await this.loadAuth();
  }

  teardown() {
    const s = this.sock;
    this.sock = null;
    if (!s) return;
    try { s.ev.removeAllListeners(); } catch { /* ignore */ }
    try { s.end(undefined); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- linking

  linkExpired() {
    return !this.link || nowSec() - this.link.startedAt > this.cfg.linkTimeoutSec;
  }

  async startLink({ method = 'qr', phone } = {}) {
    if (this.isLinked()) throw new BridgeError('already_linked', 'this bridge is already linked; unlink first to link again');
    if (!['qr', 'code'].includes(method)) throw new BridgeError('bad_request', 'method must be "qr" or "code"');
    let digits = null;
    if (method === 'code') {
      digits = phoneDigits(phone);
      if (!digits || digits.length < 11) throw new BridgeError('bad_request', 'pairing by code needs the full international number, e.g. 15550100001');
    }
    this.link = { method, phone: digits, startedAt: nowSec(), codeRequested: false, error: null };
    this.qr = null;
    this.pairingCode = null;
    this.linkError = null;
    this.attempt = 0;
    clearTimeout(this.linkTimer);
    this.linkTimer = setTimeout(() => { if (!this.isLinked()) this.endLink('timeout'); }, this.cfg.linkTimeoutSec * 1000);
    this.store.audit('link_started', { method });
    await this.connect('link');
    await waitFor(() => this.qr || this.pairingCode || this.link?.error || this.linkError || this.state === 'open', 30_000);
    return this.linkStatus();
  }

  endLink(reason) {
    clearTimeout(this.linkTimer);
    this.link = null;
    this.qr = null;
    this.pairingCode = null;
    this.teardown();
    if (!this.isLinked()) this.setState('unlinked', { reason });
  }

  linkStatus() {
    return {
      state: this.state,
      linked: this.isLinked(),
      method: this.link?.method || null,
      startedAt: this.link?.startedAt || null,
      expiresAt: this.link ? this.link.startedAt + this.cfg.linkTimeoutSec : null,
      qr: this.qr,
      pairingCode: this.pairingCode,
      error: this.link?.error || this.linkError || null,
    };
  }

  // ---------------------------------------------------------------- control

  async pause() {
    this.paused = true;
    clearTimeout(this.reconnectTimer);
    this.teardown();
    this.setState('paused');
  }

  async resume() {
    this.paused = false;
    if (!this.isLinked()) return this.setState('unlinked');
    await this.connect('resume');
  }

  async logout() {
    this.requireOpen();
    this.store.audit('logout_requested', {});
    await this.sock.logout(); // the close handler archives the credentials
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.linkTimer);
    clearTimeout(this.stableTimer);
    this.teardown();
    this.setState('stopped');
    try { this.baileysDest?.end(); } catch { /* ignore */ }
    this.baileysDest = null;
    this.baileysLogger = null;
  }

  requireOpen() {
    if (this.state !== 'open' || !this.sock) {
      throw new BridgeError('not_connected', `WhatsApp is ${this.state}; this needs an open connection`);
    }
  }

  status() {
    return {
      state: this.state,
      linked: this.isLinked(),
      me: this.me,
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventAt,
      lastDisconnect: this.lastDisconnect,
      reconnectAttempt: this.attempt,
      link: this.link ? this.linkStatus() : null,
    };
  }

  // ---------------------------------------------------------------- explicit operations (API only)

  async send(jid, content, options = {}) {
    this.requireOpen();
    return this.sock.sendMessage(jid, content, options);
  }

  async readMessages(keys) {
    this.requireOpen();
    await this.sock.readMessages(keys);
  }

  async markChatRead(jid, lastRow) {
    this.requireOpen();
    const key = JSON.parse(lastRow.key_json);
    await this.sock.chatModify({ markRead: true, lastMessages: [{ key, messageTimestamp: lastRow.ts }] }, jid);
  }

  // ---- group creation: only ever reached through a confirmed outbox draft (action group_create)
  async groupCreate(subject, jids) {
    this.requireOpen();
    return this.sock.groupCreate(subject, jids);
  }

  async groupSetSubject(jid, subject) {
    this.requireOpen();
    return this.sock.groupUpdateSubject(jid, subject);
  }

  async groupSetDescription(jid, text) {
    this.requireOpen();
    return this.sock.groupUpdateDescription(jid, text);
  }

  async groupSetPicture(jid, path) {
    this.requireOpen();
    return this.sock.updateProfilePicture(jid, { url: path });
  }

  async groupPromote(jid, jids) {
    this.requireOpen();
    return this.sock.groupParticipantsUpdate(jid, jids, 'promote');
  }

  async groupInviteCode(jid) {
    this.requireOpen();
    return this.sock.groupInviteCode(jid);
  }

  async onWhatsApp(digits) {
    this.requireOpen();
    const res = await this.sock.onWhatsApp(digits);
    return Array.isArray(res) ? res[0] || null : null;
  }

  async downloadMedia(row) {
    this.requireOpen();
    const msg = decodeRaw(row);
    if (!msg) throw new BridgeError('no_payload', 'this message has no stored payload to download from');
    return downloadMediaMessage(msg, 'buffer', {}, { logger: this.getBaileysLogger(), reuploadRequest: this.sock.updateMediaMessage });
  }

  async fetchHistory(count, key, ts) {
    this.requireOpen();
    return this.sock.fetchMessageHistory(count, key, ts);
  }

  async refreshGroups() {
    if (!this.sock) return 0;
    const all = await this.sock.groupFetchAllParticipating();
    const list = Object.values(all || {});
    this.ingest.groups(list);
    this.log.info('groups_refreshed', { count: list.length });
    return list.length;
  }

  async refreshGroup(jid) {
    if (!this.sock || !jid) return null;
    try {
      const meta = await this.sock.groupMetadata(jid);
      this.ingest.groups([meta]);
      return meta;
    } catch (e) {
      this.log.warn('group_refresh_failed', { jid, error: e });
      return null;
    }
  }

  /** Baileys asks for our own sent content when a recipient requests a retry. */
  async lookupContent(key) {
    try {
      const row = this.store.getMessageRow(key?.remoteJid, key?.id);
      return decodeRaw(row)?.message || undefined;
    } catch {
      return undefined;
    }
  }
}

function waitFor(pred, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (pred() || Date.now() - start > timeoutMs) return resolve();
      setTimeout(tick, 250);
    };
    tick();
  });
}
