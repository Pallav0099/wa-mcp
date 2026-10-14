import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, msg, fakeWa, PN } from './helpers.mjs';
import { Outbox } from '../src/outbox.mjs';
import { silentLogger } from '../src/log.mjs';
import { nowSec } from '../src/util.mjs';

function rig(waExtra = {}, sendingExtra = {}) {
  const t = setup();
  Object.assign(t.cfg.sending, sendingExtra);
  const wa = fakeWa(waExtra);
  const outbox = new Outbox({ store: t.store, wa, ingest: t.ingest, cfg: t.cfg, log: silentLogger, convertVoice: async (src) => src + '.ogg' });
  t.store.upsertContact({ jid: PN('15550100002'), name: 'Alex Example' });
  const inbound = msg({ chat: PN('15550100002'), text: 'can you send the deck?', pushName: 'Lex' });
  t.ingest.message(inbound, { live: true });
  return { ...t, wa, outbox, inbound };
}

test('a draft sends nothing; confirm sends exactly once', async () => {
  const r = rig();
  try {
    const d = r.outbox.draft({ to: 'Alex', text: 'Sending it now' });
    assert.match(d.token, /^[A-Z2-9]{6}$/);
    assert.match(d.summary, /Alex Example/);
    assert.equal(r.wa.sent.length, 0, 'drafting must not send');
    const res = await r.outbox.confirm(d.token.toLowerCase()); // tokens are case-insensitive
    assert.equal(res.status, 'sent');
    assert.equal(r.wa.sent.length, 1);
    assert.deepEqual(r.wa.sent[0].content, { text: 'Sending it now' });
    await assert.rejects(r.outbox.confirm(d.token), (e) => e.code === 'not_pending');
    assert.equal(r.wa.sent.length, 1, 'a second confirm never re-sends');
    const mine = r.store.chatMessages(PN('15550100002')).filter((m) => m.from_me);
    assert.equal(mine.length, 1, 'the sent message is recorded in the store');
    assert.ok(r.store.listAudit().some((a) => a.action === 'sent'));
  } finally { r.cleanup(); }
});

test('unknown numbers are refused unless allowNew; then verified on WhatsApp at confirm', async () => {
  const r = rig();
  try {
    assert.throws(() => r.outbox.draft({ to: '447700900123', text: 'hello' }), (e) => e.code === 'unknown_chat');
    const d = r.outbox.draft({ to: '447700900123', text: 'hello', allowNew: true });
    assert.equal(d.preview.to.new, true);
    assert.match(d.summary, /NEW/);
    await r.outbox.confirm(d.token);
    assert.equal(r.wa.sent[0].jid, PN('447700900123'));
  } finally { r.cleanup(); }
});

test('a new number that is not on WhatsApp fails cleanly', async () => {
  const r = rig({ async onWhatsApp() { return { exists: false }; } });
  try {
    const d = r.outbox.draft({ to: '447700900999', text: 'hello', allowNew: true });
    await assert.rejects(r.outbox.confirm(d.token), (e) => e.code === 'not_on_whatsapp');
    assert.equal(r.wa.sent.length, 0);
    assert.equal(r.store.getDraft(d.token).status, 'failed');
  } finally { r.cleanup(); }
});

test('expired and cancelled drafts cannot be sent', async () => {
  const r = rig();
  try {
    const a = r.outbox.draft({ to: 'Alex', text: 'one' });
    r.store.db.prepare('UPDATE outbox SET expires_at = ? WHERE token = ?').run(nowSec() - 1, a.token);
    await assert.rejects(r.outbox.confirm(a.token), (e) => e.code === 'not_pending');
    const b = r.outbox.draft({ to: 'Alex', text: 'two' });
    r.outbox.cancel(b.token);
    await assert.rejects(r.outbox.confirm(b.token), (e) => e.code === 'not_pending');
    assert.equal(r.wa.sent.length, 0);
  } finally { r.cleanup(); }
});

test('rate limit per minute', async () => {
  const r = rig({}, { maxPerMinute: 1 });
  try {
    const a = r.outbox.draft({ to: 'Alex', text: 'one' });
    const b = r.outbox.draft({ to: 'Alex', text: 'two' });
    await r.outbox.confirm(a.token);
    await assert.rejects(r.outbox.confirm(b.token), (e) => e.code === 'rate_limited');
    assert.equal(r.store.getDraft(b.token).status, 'draft', 'a rate-limited draft stays pending');
  } finally { r.cleanup(); }
});

test('not connected: confirm refuses and the draft stays pending', async () => {
  const r = rig({ state: 'reconnecting' });
  try {
    const d = r.outbox.draft({ to: 'Alex', text: 'later' });
    await assert.rejects(r.outbox.confirm(d.token), (e) => e.code === 'not_connected');
    assert.equal(r.store.getDraft(d.token).status, 'draft');
  } finally { r.cleanup(); }
});

test('sending switched off in config blocks drafts', () => {
  const r = rig({}, { enabled: false });
  try {
    assert.throws(() => r.outbox.draft({ to: 'Alex', text: 'x' }), (e) => e.code === 'sending_disabled');
  } finally { r.cleanup(); }
});

test('reply quotes the stored original', async () => {
  const r = rig();
  try {
    const d = r.outbox.draft({ to: 'Alex', text: 'here it is', replyTo: r.inbound.key.id });
    assert.equal(d.preview.replyTo.id, r.inbound.key.id);
    await r.outbox.confirm(d.token);
    assert.equal(r.wa.sent[0].options.quoted.key.id, r.inbound.key.id);
    assert.equal(r.wa.sent[0].options.quoted.message.conversation, 'can you send the deck?');
  } finally { r.cleanup(); }
});

test('react uses the stored key; delete is only for own recent messages', async () => {
  const r = rig();
  try {
    const d = r.outbox.draft({ action: 'react', to: 'Alex', messageId: r.inbound.key.id, emoji: '👍' });
    await r.outbox.confirm(d.token);
    assert.equal(r.wa.sent[0].content.react.text, '👍');
    assert.equal(r.wa.sent[0].content.react.key.id, r.inbound.key.id);
    assert.throws(() => r.outbox.draft({ action: 'delete', to: 'Alex', messageId: r.inbound.key.id }), (e) => e.code === 'bad_request');
    const own = r.store.chatMessages(PN('15550100002')).find((m) => m.from_me);
    assert.equal(own, undefined, 'a reaction is not a message row');
    const t1 = r.outbox.draft({ to: 'Alex', text: 'oops' });
    const sent = await r.outbox.confirm(t1.token);
    const del = r.outbox.draft({ action: 'delete', to: 'Alex', messageId: sent.id });
    await r.outbox.confirm(del.token);
    assert.equal(r.wa.sent.at(-1).content.delete.id, sent.id);
  } finally { r.cleanup(); }
});

test('media: kind inferred from the file; voice goes through conversion', async () => {
  const r = rig();
  try {
    const jpg = join(r.dir, 'photo.jpg');
    writeFileSync(jpg, Buffer.alloc(1024, 1));
    const a = r.outbox.draft({ action: 'media', to: 'Alex', path: jpg, caption: 'the box' });
    assert.equal(a.preview.media.as, 'image');
    await r.outbox.confirm(a.token);
    assert.equal(r.wa.sent[0].content.image.url, jpg);
    assert.equal(r.wa.sent[0].content.caption, 'the box');
    const m4a = join(r.dir, 'note.m4a');
    writeFileSync(m4a, Buffer.alloc(512, 2));
    const v = r.outbox.draft({ action: 'media', to: 'Alex', path: m4a, as: 'voice' });
    await r.outbox.confirm(v.token);
    assert.equal(r.wa.sent[1].content.ptt, true);
    assert.equal(r.wa.sent[1].content.audio.url, m4a + '.ogg');
    assert.throws(() => r.outbox.draft({ action: 'media', to: 'Alex', path: join(r.dir, 'missing.pdf') }), (e) => e.code === 'bad_request');
  } finally { r.cleanup(); }
});

// ------------------------------------------------------------ group_create
function groupWa(opts = {}) {
  const calls = { create: [], desc: [], pic: [], promote: [], invite: 0 };
  const blocked = new Set(opts.blocked || []);
  let members = [];
  return {
    calls,
    async groupCreate(subject, jids) {
      calls.create.push({ subject, jids });
      members = jids.filter((j) => !blocked.has(j.split('@')[0]));
      return { id: '120363000000000001@g.us', subject, participants: members.map((id) => ({ id })) };
    },
    async refreshGroup(jid) { return { id: jid, participants: members.map((id) => ({ id })) }; },
    async groupSetDescription(jid, text) { calls.desc.push({ jid, text }); },
    async groupSetPicture(jid, path) { calls.pic.push({ jid, path }); },
    async groupPromote(jid, jids) { calls.promote.push({ jid, jids }); return jids.map((j) => ({ jid: j, status: '200' })); },
    async groupInviteCode() { calls.invite++; return 'AbCdEf123'; },
  };
}

test('group_create: the draft creates nothing; confirm creates once, then description, picture, admins', async () => {
  const g = groupWa();
  const r = rig(g);
  try {
    const pic = join(r.dir, 'dp.jpg');
    writeFileSync(pic, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const d = r.outbox.draft({ action: 'group_create', subject: 'Party Group', participants: ['15550100002', '+1 555 010 0007'], admins: ['15550100002'], description: 'Sun 18 Oct', picture: pic, allowNew: true });
    assert.equal(g.calls.create.length, 0, 'drafting must not create');
    assert.match(d.summary, /Create group/);
    assert.match(d.summary, /Party Group/);
    assert.match(d.summary, /\[admin\]/);
    const res = await r.outbox.confirm(d.token);
    assert.equal(res.status, 'sent');
    assert.equal(g.calls.create.length, 1);
    assert.deepEqual(g.calls.create[0].jids, [PN('15550100002'), PN('15550100007')]);
    assert.deepEqual(res.added, ['15550100002', '15550100007']);
    assert.equal(g.calls.desc[0].text, 'Sun 18 Oct');
    assert.equal(g.calls.pic[0].path, pic);
    assert.deepEqual(g.calls.promote[0].jids, [PN('15550100002')]);
    assert.equal(res.invite, null, 'no invite link when everyone was added');
    await assert.rejects(r.outbox.confirm(d.token), (e) => e.code === 'not_pending');
    assert.equal(g.calls.create.length, 1, 'a second confirm never creates a second group');
    assert.ok(r.store.listAudit().some((a) => a.action === 'group_created'));
  } finally { r.cleanup(); }
});

test('group_create: someone WhatsApp will not let us add is reported, with an invite link', async () => {
  const g = groupWa({ blocked: ['15550100007'] });
  const r = rig(g);
  try {
    const d = r.outbox.draft({ action: 'group_create', subject: 'Party Group', participants: ['15550100002', '15550100007'], admins: ['15550100007'], allowNew: true });
    const res = await r.outbox.confirm(d.token);
    assert.deepEqual(res.added, ['15550100002']);
    assert.deepEqual(res.notAdded, ['15550100007']);
    assert.equal(res.invite, 'https://chat.whatsapp.com/AbCdEf123');
    assert.equal(g.calls.promote.length, 0, 'an admin who was not added cannot be promoted');
  } finally { r.cleanup(); }
});

test('group_create: bad requests are refused at draft time', async () => {
  const r = rig(groupWa());
  try {
    assert.throws(() => r.outbox.draft({ action: 'group_create', subject: '', participants: ['15550100002'] }), (e) => e.code === 'bad_request');
    assert.throws(() => r.outbox.draft({ action: 'group_create', subject: 'X', participants: [] }), (e) => e.code === 'bad_request');
    assert.throws(() => r.outbox.draft({ action: 'group_create', subject: 'X', participants: ['12345'] }), (e) => e.code === 'bad_request');
    assert.throws(() => r.outbox.draft({ action: 'group_create', subject: 'X', participants: ['15550100002'], admins: ['15550100007'] }), (e) => e.code === 'bad_request');
    assert.throws(() => r.outbox.draft({ action: 'group_create', subject: 'X', participants: ['15550100007'] }), (e) => e.code === 'unknown_chat', 'unseen numbers need allowNew');
    assert.throws(() => r.outbox.draft({ action: 'group_create', subject: 'X', participants: ['15550100002'], picture: 'C:/nope.jpg' }), (e) => e.code === 'bad_request');
    // the linked account itself is never added as a participant
    const d = r.outbox.draft({ action: 'group_create', subject: 'X', participants: ['15550100002', '15550100001'] });
    assert.equal(d.preview.group.participants.length, 1);
  } finally { r.cleanup(); }
});

// ------------------------------------------------------------ group_update
test('group_update: draft changes nothing; confirm sets name, description and icon of a known group', async () => {
  const calls = { subject: [], desc: [], pic: [] };
  const r = rig({
    async groupSetSubject(jid, s) { calls.subject.push({ jid, s }); },
    async groupSetDescription(jid, t) { calls.desc.push({ jid, t }); },
    async groupSetPicture(jid, p) { calls.pic.push({ jid, p }); },
    async refreshGroup() { return null; },
  });
  try {
    const gid = '120363000000000002@g.us';
    r.ingest.groups([{ id: gid, subject: 'Party Group', participants: [{ id: PN('15550100002') }] }]);
    const pic = join(r.dir, 'dp.png');
    writeFileSync(pic, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.throws(() => r.outbox.draft({ action: 'group_update', to: gid }), (e) => e.code === 'bad_request', 'nothing to change');
    assert.throws(() => r.outbox.draft({ action: 'group_update', to: '15550100002', subject: 'X' }), (e) => e.code === 'bad_request', 'a DM is not a group');
    const d = r.outbox.draft({ action: 'group_update', to: gid, subject: 'Renamed Group', picture: pic });
    assert.match(d.summary, /Change group/);
    assert.match(d.summary, /New name: Renamed Group/);
    assert.equal(calls.subject.length + calls.pic.length, 0, 'drafting must not change the group');
    const res = await r.outbox.confirm(d.token);
    assert.deepEqual(res.changed, ['subject', 'picture']);
    assert.equal(calls.subject[0].s, 'Renamed Group');
    assert.equal(calls.pic[0].p, pic);
    assert.equal(calls.desc.length, 0, 'fields not given are left alone');
    assert.ok(r.store.listAudit().some((a) => a.action === 'group_updated'));
  } finally { r.cleanup(); }
});

test('group_update: it fails only when no field could be changed', async () => {
  const r = rig({
    async groupSetSubject() { throw new Error('not an admin'); },
    async groupSetDescription() {},
    async refreshGroup() { return null; },
  });
  try {
    const gid = '120363000000000003@g.us';
    r.ingest.groups([{ id: gid, subject: 'G', participants: [] }]);
    const partial = await r.outbox.confirm(r.outbox.draft({ action: 'group_update', to: gid, subject: 'New', description: 'About' }).token);
    assert.deepEqual(partial.changed, ['description']);
    assert.match(partial.warnings[0], /subject: not an admin/);
    const d = r.outbox.draft({ action: 'group_update', to: gid, subject: 'Newer' });
    await assert.rejects(r.outbox.confirm(d.token), (e) => e.code === 'send_failed');
    assert.equal(r.store.getDraft(d.token).status, 'failed');
  } finally { r.cleanup(); }
});
