// Link lifecycle for `wa connect`: raw QR data, idempotent link windows, cancel, local unlink (recovery).

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
  let wa;
  const sockets = [];
  const factory = (opts) => {
    const ev = new EventEmitter();
    const sock = {
      opts, ev, ended: false,
      user: { id: '15550100001:7@s.whatsapp.net', lid: '100000000000001:7@lid', name: 'Owner' },
      end() { this.ended = true; },
      // like Baileys: requesting a code already writes creds.me (but not creds.account)
      async requestPairingCode(phone) { wa.auth.state.creds.me = { id: `${phone}@s.whatsapp.net`, name: '~' }; return 'ABCD1234'; },
      async groupFetchAllParticipating() { return {}; },
    };
    sockets.push(sock);
    return sock;
  };
  wa = new WhatsApp({ cfg: t.cfg, store: t.store, ingest: t.ingest, log: silentLogger, socketFactory: factory });
  wa.waVersion = null;
  const close = (sock, code) => sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Boom('x', { statusCode: code }), date: new Date() } });
  return { ...t, wa, sockets, close, stop: async () => { await wa.stop(); t.cleanup(); } };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function openLinked(r) {
  await r.wa.init();
  r.wa.auth.state.creds.me = { id: '15550100001:7@s.whatsapp.net' };
  r.wa.auth.state.creds.account = { details: 'paired' };
  await r.wa.connect('test');
  r.sockets.at(-1).ev.emit('connection.update', { connection: 'open' });
}

test('link status carries the raw QR payload for the terminal; the image is removed once linked', async () => {
  const r = rig();
  try {
    await r.wa.init();
    const p = r.wa.startLink({ method: 'qr' });
    await tick();
    r.sockets[0].ev.emit('connection.update', { qr: '2@payload-one' });
    const st = await p;
    assert.equal(st.qr.data, '2@payload-one');
    assert.ok(existsSync(st.qr.path));
    assert.equal(r.wa.status().link.qr.data, '2@payload-one', '/health carries it too (token holders only)');

    r.wa.auth.state.creds.me = { id: '15550100001:7@s.whatsapp.net' };

    r.wa.auth.state.creds.account = { details: 'paired' };
    r.close(r.sockets[0], DisconnectReason.restartRequired);
    await tick();
    r.sockets[1].ev.emit('connection.update', { connection: 'open', isNewLogin: true });
    await tick();
    assert.equal(existsSync(st.qr.path), false, 'no stale QR image left in the data dir');
  } finally { await r.stop(); }
});

test('a second link request joins the open window instead of tearing down the socket', async () => {
  const r = rig();
  try {
    await r.wa.init();
    const first = r.wa.startLink({ method: 'qr' });
    await tick();
    r.sockets[0].ev.emit('connection.update', { qr: '2@payload' });
    await first;
    const second = await r.wa.startLink({ method: 'qr' });
    assert.equal(r.sockets.length, 1, 'same socket, same window');
    assert.equal(r.sockets[0].ended, false);
    assert.equal(second.qr.data, '2@payload');
  } finally { await r.stop(); }
});

test('cancelLink closes the window: socket ended, back to unlinked, audited', async () => {
  const r = rig();
  try {
    await r.wa.init();
    const p = r.wa.startLink({ method: 'qr' });
    await tick();
    r.sockets[0].ev.emit('connection.update', { qr: '2@payload' });
    await p;
    const st = r.wa.cancelLink();
    assert.equal(st.state, 'unlinked');
    assert.equal(st.method, null);
    assert.equal(r.sockets[0].ended, true);
    assert.ok(r.store.listAudit().some((a) => a.action === 'link_cancelled'));
    assert.equal(r.wa.cancelLink().state, 'unlinked', 'cancelling twice is harmless');
  } finally { await r.stop(); }
});

test('unlinkLocal recovers from "replaced": credentials archived, a new link can start', async () => {
  const r = rig();
  try {
    await openLinked(r);
    r.close(r.sockets.at(-1), DisconnectReason.connectionReplaced);
    assert.equal(r.wa.state, 'replaced');
    await assert.rejects(r.wa.logout(), (e) => e.code === 'not_connected', 'a remote logout is impossible here');
    await assert.rejects(r.wa.startLink({ method: 'qr' }), (e) => e.code === 'already_linked');

    const res = await r.wa.unlinkLocal();
    assert.equal(res.unlinked, true);
    assert.ok(res.archived);
    assert.equal(r.wa.state, 'unlinked');
    assert.equal(r.wa.isLinked(), false);
    assert.ok(readdirSync(r.dir).some((n) => n.startsWith('auth.revoked-')), 'archived, never deleted');
    assert.ok(r.store.listAudit().some((a) => a.action === 'unlinked_local'));

    const p = r.wa.startLink({ method: 'qr' });
    await tick();
    r.sockets.at(-1).ev.emit('connection.update', { qr: '2@fresh' });
    assert.equal((await p).qr.data, '2@fresh');
  } finally { await r.stop(); }
});

test('history sync progress is visible in status', async () => {
  const r = rig();
  try {
    await r.wa.init();
    assert.equal(r.wa.status().sync.chunks, 0);
    r.ingest.history({ messages: [], chats: [], contacts: [], syncType: 2, progress: 40, isLatest: false });
    const s = r.wa.status().sync;
    assert.equal(s.chunks, 1);
    assert.equal(s.progress, 40);
    assert.ok(s.lastChunkAt > 0);
  } finally { await r.stop(); }
});

test('requesting a pairing code is not being linked: cancel works and a retry starts a fresh window', async () => {
  const r = rig();
  try {
    await r.wa.init();
    const p = r.wa.startLink({ method: 'code', phone: '15550100001' });
    await tick();
    r.sockets[0].ev.emit('connection.update', { qr: 'ignored-for-code' });
    const st = await p;
    assert.equal(st.pairingCode.code, 'ABCD1234');
    assert.ok(r.wa.auth.state.creds.me, 'Baileys wrote creds.me');
    assert.equal(r.wa.isLinked(), false, 'but nothing is linked until pair-success');
    assert.equal(r.wa.cancelLink().state, 'unlinked', 'so the window can be cancelled');
    assert.equal(r.sockets[0].ended, true);
    const again = r.wa.startLink({ method: 'qr' });
    await tick();
    assert.equal(r.sockets.at(-1).opts.auth.creds.me, undefined, 'the leftover `me` is gone: Baileys registers again instead of trying to log in');
    r.sockets.at(-1).ev.emit('connection.update', { qr: '2@fresh' });
    assert.equal((await again).qr.data, '2@fresh', 'and a new link can start, no already_linked');
  } finally { await r.stop(); }
});
