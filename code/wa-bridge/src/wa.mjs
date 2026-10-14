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
import { rename, rm } from 'node:fs/promises';
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

  /**
   * Linked = the phone completed pairing. `me` alone is not enough: Baileys writes creds.me as soon as a pairing
   * code is REQUESTED (before the user typed it anywhere); only a successful pair-success also writes `account`.
   */
  isLinked() {
    const c = this.auth?.state?.creds;
    return !!(c?.me?.id && c?.account);
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
      this.removeQrImage();
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
    const link = this.link; // the window this QR belongs to; it may be cancelled before the promises below settle
    if (link.method === 'code') {
      if (link.codeRequested) return;
      link.codeRequested = true;
      sock.requestPairingCode(link.phone)
        .then((code) => {
          if (this.link !== link) return;
          this.pairingCode = { code, at: nowSec() };
          this.log.info('pairing_code_issued');
          this.emit('pairing_code', code);
        })
        .catch((e) => {
          link.error = e.message;
          this.log.error('pairing_code_failed', { error: e });
        });
      return;
    }
    // `data` is the raw QR payload: `wa connect` draws it in the terminal. It is only ever served to holders of
    // the API token and lives for one QR rotation (~20 s) inside a link window the user opened.
    const at = nowSec();
    QRCode.toFile(this.cfg.paths.qr, qr, { width: 512, margin: 2 })
      .then(() => {
        if (!this.link) return; // the window closed while the image was being written
        this.qr = { at, path: this.cfg.paths.qr, data: qr };
        this.log.info('qr_issued');
        this.emit('qr', this.qr);
      })
      .catch((e) => {
        this.log.error('qr_write_failed', { error: e });
        if (this.link) this.qr = { at, path: null, data: qr }; // the terminal can still show it
      });
  }

  removeQrImage() {
    rm(this.cfg.paths.qr, { force: true }).catch(() => { /* nothing to remove */ });
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
    try { await this.archiveAuth(); } catch { /* logged; a fresh auth state is loaded either way */ }
    await this.loadAuth();
  }

  /**
   * An unfinished pairing-code attempt leaves creds.me without creds.account (Baileys writes `me` when the code
   * is requested). With `me` set, Baileys would try to LOG IN instead of registering, and never issue a QR or code
   * again. Those are not credentials (nothing was ever paired), so start from a fresh auth state.
   */
  async resetUnregisteredAuth() {
    const c = this.auth?.state?.creds;
    if (!c?.me || c?.account) return false;
    this.teardown();
    await rm(this.cfg.paths.auth, { recursive: true, force: true });
    await this.loadAuth();
    this.log.info('auth_reset_unregistered');
    return true;
  }

  /** Move the credentials aside (never delete them) so a fresh, empty auth state can be linked. */
  async archiveAuth() {
    try {
      if (existsSync(this.cfg.paths.auth)) {
        const archived = `${this.cfg.paths.auth}.revoked-${nowSec()}`;
        await rename(this.cfg.paths.auth, archived);
        this.log.warn('auth_archived', { archived });
        return archived;
      }
    } catch (e) {
      this.log.error('auth_archive_failed', { error: e });
      throw new BridgeError('internal', `could not archive the credentials: ${e.message}`);
    }
    return null;
  }

  /**
   * Forget the link on THIS machine only: close the socket, archive the credentials, back to `unlinked`.
   * The way out of `replaced`, `forbidden` or broken credentials, where a remote logout is impossible because
   * it needs an open connection. If the device was still linked, it stays listed on the phone until removed there.
   */
  async unlinkLocal() {
    const wasOpen = this.state === 'open';
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.stableTimer);
    clearTimeout(this.linkTimer);
    this.link = null;
    this.qr = null;
    this.pairingCode = null;
    this.paused = false;
    this.teardown();
    this.me = null;
    const archived = await this.archiveAuth();
    await this.loadAuth();
    this.store.audit('unlinked_local', { wasOpen, archived: !!archived });
    this.setState('unlinked', { reason: 'unlinked_local' });
    return { unlinked: true, archived, stillListedOnPhone: wasOpen };
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
    // Idempotent: a second caller (another terminal, an agent, a retry) joins the open window instead of
    // tearing down the socket the phone may be scanning right now.
    if (this.link && !this.linkExpired() && !this.link.error && this.link.method === method && this.link.phone === digits) {
      await waitFor(() => this.qr || this.pairingCode || this.link?.error || this.linkError || this.state === 'open', 30_000);
      return this.linkStatus();
    }
    await this.resetUnregisteredAuth();
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
    clearTimeout(this.reconnectTimer); // a reconnect scheduled during the window must not reopen it
    this.link = null;
    this.qr = null;
    this.pairingCode = null;
    this.removeQrImage();
    this.teardown();
    if (!this.isLinked()) this.setState('unlinked', { reason });
  }

  /** Close an open link window on request (Ctrl-C in `wa connect`). A no-op when none is open. */
  cancelLink() {
    if (this.link && !this.isLinked()) {
      this.store.audit('link_cancelled', { method: this.link.method });
      this.endLink('cancelled');
    }
    return this.linkStatus();
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
      sync: this.ingest.syncStatus(),
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
