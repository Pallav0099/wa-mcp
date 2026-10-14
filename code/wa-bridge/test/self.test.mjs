// The one unattended send path: the linked account's own chat, nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, msg, fakeWa, PN, ME_PN } from './helpers.mjs';
import { Outbox } from '../src/outbox.mjs';
import { silentLogger } from '../src/log.mjs';

function rig(sendingExtra = {}) {
  const t = setup();
  Object.assign(t.cfg.sending, sendingExtra);
  const wa = fakeWa();
  const outbox = new Outbox({ store: t.store, wa, ingest: t.ingest, cfg: t.cfg, log: silentLogger });
  // his own chat exists in the store (he writes to himself), as does another contact
  t.ingest.message(msg({ chat: ME_PN, text: 'note to self', fromMe: true }), { live: true });
  t.store.upsertContact({ jid: PN('15550100002'), name: 'Alex Example' });
  t.ingest.message(msg({ chat: PN('15550100002'), text: 'hi', pushName: 'Lex' }), { live: true });
  return { ...t, wa, outbox };
}

test('off by default: an unattended self send is refused and nothing leaves', async () => {
  const r = rig();
  try {
    await assert.rejects(r.outbox.sendSelf({ source: 'vault-health', text: 'x' }), (e) => e.code === 'forbidden');
    assert.equal(r.wa.sent.length, 0);
  } finally { r.cleanup(); }
});

test('when on: sends at once, to his own chat only, labelled with its source, audited', async () => {
  const r = rig({ selfUnattended: true });
  try {
    const res = await r.outbox.sendSelf({ source: 'vault-health', text: 'FAIL backup: state error' });
    assert.equal(res.status, 'sent');
    assert.equal(r.wa.sent.length, 1);
    assert.equal(r.wa.sent[0].jid, ME_PN, 'the only possible recipient is the linked account itself');
    assert.deepEqual(r.wa.sent[0].content, { text: '[vault-health] FAIL backup: state error' });
    const audit = r.store.listAudit().map((a) => a.action);
    assert.ok(audit.includes('self_unattended') && audit.includes('sent'));
  } finally { r.cleanup(); }
});

test('a recipient in the request is ignored: it can never reach anyone else', async () => {
  const r = rig({ selfUnattended: true });
  try {
    await r.outbox.sendSelf({ source: 'vault-health', text: 'hello', to: 'Alex', jid: PN('15550100002') });
    assert.equal(r.wa.sent[0].jid, ME_PN);
  } finally { r.cleanup(); }
});

test('a fresh install whose own chat is not in the store yet can still send to itself', async () => {
  const t = setup();
  Object.assign(t.cfg.sending, { selfUnattended: true });
  const wa = fakeWa();
  const outbox = new Outbox({ store: t.store, wa, ingest: t.ingest, cfg: t.cfg, log: silentLogger });
  try {
    const res = await outbox.sendSelf({ source: 'health-check', text: 'first alert' });
    assert.equal(res.status, 'sent');
    assert.equal(wa.sent[0].jid, ME_PN);
  } finally { t.cleanup(); }
});

test('bad source labels and empty text are refused', async () => {
  const r = rig({ selfUnattended: true });
  try {
    for (const source of ['', 'X', 'Vault Health', 'a'.repeat(41), 'vault_health']) {
      await assert.rejects(r.outbox.sendSelf({ source, text: 'x' }), (e) => e.code === 'bad_request', `source ${JSON.stringify(source)}`);
    }
    await assert.rejects(r.outbox.sendSelf({ source: 'vault-health', text: '   ' }), (e) => e.code === 'bad_request');
    assert.equal(r.wa.sent.length, 0);
  } finally { r.cleanup(); }
});

test('the ordinary rate limits still apply to the self path', async () => {
  const r = rig({ selfUnattended: true, maxPerMinute: 1 });
  try {
    await r.outbox.sendSelf({ source: 'vault-health', text: 'one' });
    await assert.rejects(r.outbox.sendSelf({ source: 'vault-health', text: 'two' }), (e) => e.code === 'rate_limited');
    assert.equal(r.wa.sent.length, 1);
  } finally { r.cleanup(); }
});
