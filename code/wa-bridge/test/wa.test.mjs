// Connection state machine, driven by a fake Baileys socket (no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { Boom } from '@hapi/boom';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { setup } from './helpers.mjs';
import { WhatsApp } from '../src/wa.mjs';
import { silentLogger } from '../src/log.mjs';

function rig() {
  const t = setup();
  const sockets = [];
  const factory = (opts) => {
    const ev = new EventEmitter();
    const sock = {
      opts, ev, ended: false, pairingRequests: [],
      user: { id: '15550100001:7@s.whatsapp.net', lid: '100000000000001:7@lid', name: 'Owner' },
      end() { this.ended = true; },
      async requestPairingCode(phone) { this.pairingRequests.push(phone); return 'ABCD1234'; },
      async groupFetchAllParticipating() { return {}; },
    };
    sockets.push(sock);
    return sock;
  };
  const wa = new WhatsApp({ cfg: t.cfg, store: t.store, ingest: t.ingest, log: silentLogger, socketFactory: factory });
  wa.waVersion = null; // no network lookup in tests
  const close = (sock, code) => sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Boom('x', { statusCode: code }), date: new Date() } });
  return { ...t, wa, sockets, close, stop: async () => { await wa.stop(); t.cleanup(); } };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('no credentials: stays unlinked and opens no socket', async () => {
  const r = rig();
  try {
    await r.wa.init();
    assert.equal(r.wa.state, 'unlinked');
    assert.equal(r.sockets.length, 0);
    assert.throws(() => r.wa.requireOpen(), (e) => e.code === 'not_connected');
  } finally { await r.stop(); }
});

test('QR link: image written, pairing restart, then open with identity', async () => {
  const r = rig();
  try {
    await r.wa.init();
    const linking = r.wa.startLink({ method: 'qr' });
    await tick();
    assert.equal(r.wa.state, 'linking');
    const s1 = r.sockets[0];
    assert.equal(s1.opts.markOnlineOnConnect, false);
    assert.deepEqual(s1.opts.browser.slice(0, 2), ['Windows', 'Chrome'], 'Desktop + full sync is rejected by WhatsApp (428)');
    assert.equal(s1.opts.syncFullHistory, true);
    s1.ev.emit('connection.update', { qr: '2@fake-qr-payload' });
    const status = await linking;
    assert.ok(status.qr?.path && existsSync(status.qr.path), 'QR png written');

    // the phone scanned: creds now carry "me", then WhatsApp asks for a restart
    r.wa.auth.state.creds.me = { id: '15550100001:7@s.whatsapp.net', lid: '100000000000001:7@lid', name: 'Owner' };
    r.wa.auth.state.creds.account = { details: 'paired' };
    r.close(s1, DisconnectReason.restartRequired);
    await tick();
    assert.equal(r.sockets.length, 2, 'reconnected immediately after the pairing restart');
    r.sockets[1].ev.emit('connection.update', { connection: 'open', isNewLogin: true });
    assert.equal(r.wa.state, 'open');
    assert.equal(r.wa.me.pn, '15550100001@s.whatsapp.net');
    assert.equal(r.wa.link, null);
    assert.ok(r.store.listAudit().some((a) => a.action === 'linked'));
  } finally { await r.stop(); }
});

test('pairing-code link asks WhatsApp for a code for the given number', async () => {
  const r = rig();
  try {
    await r.wa.init();
    await assert.rejects(r.wa.startLink({ method: 'code', phone: '55501' }), (e) => e.code === 'bad_request');
    const p = r.wa.startLink({ method: 'code', phone: '+1 555-010-0001' });
    await tick();
    r.sockets.at(-1).ev.emit('connection.update', { qr: 'ignored-for-code' });
    const st = await p;
    assert.deepEqual(r.sockets.at(-1).pairingRequests, ['15550100001']);
    assert.equal(st.pairingCode.code, 'ABCD1234');
  } finally { await r.stop(); }
});

test('a QR nobody asked for closes the socket instead of leaving a pairing window open', async () => {
  const r = rig();
  try {
    r.wa.auth = { state: { creds: { me: { id: '9@s.whatsapp.net' }, account: { details: 'paired' } } }, saveCreds: async () => {} };
    await r.wa.connect('test');
    const s = r.sockets[0];
    r.wa.auth.state.creds.me = undefined; // credentials invalidated
    s.ev.emit('connection.update', { qr: 'unexpected' });
    assert.equal(r.wa.state, 'unlinked');
    assert.equal(s.ended, true);
  } finally { await r.stop(); }
});

test('drop -> reconnecting with backoff; replaced -> stop; logged out -> credentials archived', async () => {
  const r = rig();
  try {
    await r.wa.init();
    r.wa.auth.state.creds.me = { id: '15550100001:7@s.whatsapp.net' };
    r.wa.auth.state.creds.account = { details: 'paired' };
    await r.wa.connect('test');
    r.sockets[0].ev.emit('connection.update', { connection: 'open' });
    assert.equal(r.wa.state, 'open');

    r.close(r.sockets[0], DisconnectReason.connectionLost);
    assert.equal(r.wa.state, 'reconnecting');
    assert.equal(r.wa.attempt, 1);

    await r.wa.connect('manual');
    r.close(r.sockets.at(-1), DisconnectReason.connectionReplaced);
    assert.equal(r.wa.state, 'replaced');
    const before = r.sockets.length;
    await tick();
    assert.equal(r.sockets.length, before, 'no reconnect after being replaced');

    await r.wa.connect('manual');
    r.close(r.sockets.at(-1), DisconnectReason.loggedOut);
    await tick();
    assert.equal(r.wa.state, 'logged_out');
    assert.ok(readdirSync(r.dir).some((n) => n.startsWith('auth.revoked-')), 'credentials archived, not deleted');
    assert.equal(r.wa.isLinked(), false);
  } finally { await r.stop(); }
});

test('a link that WhatsApp keeps hanging up on is reported, not retried forever', async () => {
  const r = rig();
  try {
    await r.wa.init();
    const pending = r.wa.startLink({ method: 'qr' });
    for (let i = 0; i < 3; i++) {
      await tick();
      r.close(r.sockets.at(-1), DisconnectReason.connectionClosed);
      if (r.wa.state === 'reconnecting') await r.wa.connect('link'); // skip the backoff timer
    }
    const st = await pending;
    assert.equal(r.wa.state, 'unlinked');
    assert.match(st.error, /closed the connection before issuing a QR or code \(code 428\), 3 times/);
  } finally { await r.stop(); }
});

test('pause keeps the link; resume reconnects', async () => {
  const r = rig();
  try {
    await r.wa.init();
    r.wa.auth.state.creds.me = { id: '15550100001:7@s.whatsapp.net' };
    r.wa.auth.state.creds.account = { details: 'paired' };
    await r.wa.connect('test');
    r.sockets[0].ev.emit('connection.update', { connection: 'open' });
    await r.wa.pause();
    assert.equal(r.wa.state, 'paused');
    assert.equal(r.sockets[0].ended, true);
    await r.wa.resume();
    assert.equal(r.sockets.length, 2);
    assert.equal(r.wa.state, 'connecting');
  } finally { await r.stop(); }
});
