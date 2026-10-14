import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setup, msg, fakeWa, PN } from './helpers.mjs';
import { Outbox } from '../src/outbox.mjs';
import { createApi } from '../src/api.mjs';
import { silentLogger } from '../src/log.mjs';

async function rig() {
  const t = setup();
  const wa = fakeWa();
  const outbox = new Outbox({ store: t.store, wa, ingest: t.ingest, cfg: t.cfg, log: silentLogger });
  const api = createApi({ cfg: t.cfg, store: t.store, wa, outbox, log: silentLogger });
  const port = await api.listen();
  t.store.upsertContact({ jid: PN('15550100002'), name: 'Alex Example' });
  t.ingest.message(msg({ chat: PN('15550100002'), text: 'status on the site?', pushName: 'Lex' }), { live: true });
  const call = (method, path, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, method, path,
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${t.cfg.token}`, 'content-type': 'application/json', ...headers },
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  return { ...t, wa, api, port, call, stop: async () => { await api.close(); t.cleanup(); } };
}

test('auth: token required; browsers and foreign Host headers refused', async () => {
  const r = await rig();
  try {
    assert.equal((await r.call('GET', '/health', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await r.call('GET', '/health', { headers: { authorization: '' } })).status, 401);
    assert.equal((await r.call('GET', '/health', { headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await r.call('GET', '/health', { headers: { host: 'evil.example' } })).status, 403);
    const ok = await r.call('GET', '/health');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.sending.confirmRequired, true);
    assert.equal(ok.json.stats.messages, 1);
  } finally { await r.stop(); }
});

test('read routes resolve chats by name', async () => {
  const r = await rig();
  try {
    const chats = await r.call('GET', '/chats');
    assert.equal(chats.json.chats[0].name, 'Alex Example');
    const read = await r.call('GET', `/chats/${encodeURIComponent('alex')}/messages`);
    assert.equal(read.json.messages[0].text, 'status on the site?');
    const search = await r.call('GET', '/search?q=site');
    assert.equal(search.json.messages.length, 1);
    const missing = await r.call('GET', `/chats/${encodeURIComponent('nobody at all')}/messages`);
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'not_found');
    assert.equal((await r.call('GET', '/nope')).status, 404);
  } finally { await r.stop(); }
});

test('draft -> confirm over HTTP; bad JSON rejected', async () => {
  const r = await rig();
  try {
    const d = await r.call('POST', '/send/draft', { body: { to: 'Alex', text: 'Live next month' } });
    assert.equal(d.status, 200);
    assert.equal(r.wa.sent.length, 0);
    const c = await r.call('POST', '/send/confirm', { body: { token: d.json.token } });
    assert.equal(c.json.status, 'sent');
    assert.equal(r.wa.sent.length, 1);
    const again = await r.call('POST', '/send/confirm', { body: { token: d.json.token } });
    assert.equal(again.status, 409);
    const amb = await r.call('POST', '/send/draft', { body: { to: '', text: 'x' } });
    assert.equal(amb.status, 400);
  } finally { await r.stop(); }
});

test('logout demands an explicit confirmation word', async () => {
  const r = await rig();
  try {
    const res = await r.call('POST', '/logout', { body: {} });
    assert.equal(res.status, 400);
  } finally { await r.stop(); }
});
