import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, msg, PN, LID, ME_PN } from './helpers.mjs';

test('a DM is stored once, named from the push name, and listed', () => {
  const t = setup();
  try {
    const m = msg({ chat: PN('15550100002'), text: 'hi there', pushName: 'Lex' });
    t.ingest.message(m, { live: true });
    t.ingest.message(m, { live: false }); // re-delivery is idempotent
    const chats = t.store.listChats();
    assert.equal(chats.length, 1);
    assert.equal(chats[0].name, 'Lex');
    assert.equal(chats[0].last_text, 'hi there');
    const msgs = t.store.chatMessages(PN('15550100002'));
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].sender_name, 'Lex');
    assert.equal(msgs[0].live, true, 'live flag survives a later history copy');
  } finally { t.cleanup(); }
});

test('own messages: sender is me; status only moves forward', () => {
  const t = setup();
  try {
    const m = msg({ chat: PN('911'), fromMe: true, text: 'sent', status: 2 });
    t.ingest.message(m, { live: true });
    t.ingest.messagesUpdate([{ key: m.key, update: { status: 4 } }]);
    t.ingest.messagesUpdate([{ key: m.key, update: { status: 3 } }]);
    const [row] = t.store.chatMessages(PN('911'));
    assert.equal(row.from_me, true);
    assert.equal(row.sender_jid, ME_PN);
    assert.equal(row.status, 4);
  } finally { t.cleanup(); }
});

test('a person seen first by LID and later with their phone number becomes ONE chat', () => {
  const t = setup();
  try {
    t.ingest.message(msg({ chat: LID('555'), text: 'first, lid only', pushName: 'Jordan' }), { live: true });
    assert.equal(t.store.listChats()[0].jid, LID('555'));
    t.ingest.message(msg({ chat: LID('555'), remoteJidAlt: PN('15550100003'), text: 'second, with alt' }), { live: true });
    const chats = t.store.listChats();
    assert.equal(chats.length, 1, 'no split chat');
    assert.equal(chats[0].jid, PN('15550100003'));
    assert.equal(t.store.chatMessages(PN('15550100003')).length, 2);
    assert.equal(t.store.chatMessages(LID('555')).length, 2, 'the lid resolves to the same chat');
    assert.equal(t.store.displayName(LID('555')), 'Jordan');
  } finally { t.cleanup(); }
});

test('group sender is canonicalised from participantAlt', () => {
  const t = setup();
  try {
    t.ingest.message(msg({ chat: '120363@g.us', participant: LID('777'), participantAlt: PN('15550100004'), text: 'hello group', pushName: 'Sam' }), { live: true });
    const [row] = t.store.chatMessages('120363@g.us');
    assert.equal(row.sender_jid, PN('15550100004'));
    assert.equal(row.sender_name, 'Sam');
  } finally { t.cleanup(); }
});

test('full-text search: words, prefix, chat filter, date filter', () => {
  const t = setup();
  try {
    t.ingest.message(msg({ chat: PN('1'), text: 'the invoice for the widgets', ts: 1_700_000_000 }), { live: true });
    t.ingest.message(msg({ chat: PN('2'), text: 'invoice pending from Acme', ts: 1_800_000_000 }), { live: true });
    assert.equal(t.store.search({ q: 'invoice' }).length, 2);
    assert.equal(t.store.search({ q: 'invoice acme' }).length, 1);
    assert.equal(t.store.search({ q: 'widg*' }).length, 1);
    assert.equal(t.store.search({ q: 'invoice', chat: PN('1') }).length, 1);
    assert.equal(t.store.search({ q: 'invoice', since: 1_750_000_000 }).length, 1);
    assert.equal(t.store.search({ q: 'a "quoted" (weird) query' }).length, 0, 'odd input does not throw');
  } finally { t.cleanup(); }
});

test('edits replace text and survive a re-delivered original; revokes mark deleted', () => {
  const t = setup();
  try {
    const m = msg({ chat: PN('3'), text: 'teh typo' });
    t.ingest.message(m, { live: true });
    t.ingest.messagesUpdate([{ key: m.key, update: { message: { editedMessage: { message: { conversation: 'the fix' } } }, messageTimestamp: 1_790_000_999 } }]);
    t.ingest.message(m, { live: false });
    let [row] = t.store.chatMessages(PN('3'));
    assert.equal(row.text, 'the fix');
    assert.ok(row.edited_ts);
    assert.equal(t.store.search({ q: 'fix' }).length, 1, 'search index follows the edit');
    assert.equal(t.store.search({ q: 'typo' }).length, 0);
    t.ingest.messagesUpdate([{ key: m.key, update: { message: null, messageStubType: 1 } }]);
    [row] = t.store.chatMessages(PN('3'));
    assert.equal(row.deleted, true);
  } finally { t.cleanup(); }
});

test('reactions: added, replaced, removed', () => {
  const t = setup();
  try {
    const target = msg({ chat: PN('4'), text: 'nice?' });
    t.ingest.message(target, { live: true });
    t.ingest.message(msg({ chat: PN('4'), message: { reactionMessage: { key: target.key, text: '👍' } } }), { live: true });
    t.ingest.message(msg({ chat: PN('4'), message: { reactionMessage: { key: target.key, text: '❤️' } } }), { live: true });
    assert.deepEqual(t.store.reactionsFor(PN('4'), target.key.id).map((r) => r.emoji), ['❤️']);
    t.ingest.message(msg({ chat: PN('4'), message: { reactionMessage: { key: target.key, text: '' } } }), { live: true });
    assert.equal(t.store.reactionsFor(PN('4'), target.key.id).length, 0);
    assert.equal(t.store.chatMessages(PN('4')).length, 1, 'reactions are not message rows');
  } finally { t.cleanup(); }
});

test('events cursor returns only live messages, in order', () => {
  const t = setup();
  try {
    t.ingest.message(msg({ chat: PN('5'), text: 'old history' }), { live: false });
    const c0 = t.store.latestCursor();
    t.ingest.message(msg({ chat: PN('5'), text: 'new 1' }), { live: true });
    t.ingest.message(msg({ chat: PN('5'), text: 'new 2' }), { live: true });
    const ev = t.store.events({ after: c0 });
    assert.deepEqual(ev.map((e) => e.text), ['new 1', 'new 2']);
    assert.equal(t.store.events({ after: ev[1].rowid }).length, 0);
  } finally { t.cleanup(); }
});

test('resolveChat: jid, number, exact name, partial name, ambiguity, not found', () => {
  const t = setup();
  try {
    t.store.upsertContact({ jid: PN('15550100002'), name: 'Alex Example' });
    t.store.upsertContact({ jid: PN('15550100004'), name: 'Sam Sample' });
    t.store.upsertContact({ jid: PN('15550100005'), name: 'Pat Placeholder' });
    t.ingest.message(msg({ chat: PN('15550100002'), text: 'x' }), { live: true });
    assert.equal(t.store.resolveChat('15550100002').jid, PN('15550100002'));
    assert.equal(t.store.resolveChat('+1 555 010 0002').jid, PN('15550100002'));
    assert.equal(t.store.resolveChat('5550100002').jid, PN('15550100002'), 'unique local-number suffix');
    assert.equal(t.store.resolveChat('alex example').jid, PN('15550100002'));
    assert.equal(t.store.resolveChat('Sam').jid, PN('15550100004'));
    assert.throws(() => t.store.resolveChat('a'), (e) => e.code === 'ambiguous' && e.candidates.length >= 2);
    assert.throws(() => t.store.resolveChat('Nobody Here'), (e) => e.code === 'not_found');
    const unknown = t.store.resolveChat('447700900123');
    assert.equal(unknown.known, false);
    assert.equal(t.store.resolveChat(PN('15550100002')).known, true);
  } finally { t.cleanup(); }
});

test('history chunk: mappings, contacts, chats and messages in one transaction', () => {
  const t = setup();
  try {
    const n = t.ingest.history({
      lidPnMappings: [{ lid: LID('900'), pn: PN('15550100008') }],
      contacts: [{ id: PN('15550100008'), name: 'Saved Name' }],
      chats: [{ id: LID('900'), unreadCount: 3, conversationTimestamp: 1_790_000_500 }],
      messages: [msg({ chat: LID('900'), text: 'from history' })],
      syncType: 2,
    });
    assert.equal(n, 1);
    const [c] = t.store.listChats();
    assert.equal(c.jid, PN('15550100008'));
    assert.equal(c.unread, 3);
    assert.equal(c.name, 'Saved Name');
    assert.equal(t.store.events({ after: 0 }).length, 0, 'history is not "live"');
  } finally { t.cleanup(); }
});

test('groups: participants resolved through their LID/PN pairs', () => {
  const t = setup();
  try {
    t.ingest.groups([{ id: '120363000000000101@g.us', subject: "Team Group A", participants: [
      { id: LID('11'), phoneNumber: PN('15550100006'), admin: null },
      { id: PN('15550100001'), admin: 'superadmin' },
    ] }]);
    const g = t.store.getGroup('120363000000000101@g.us');
    assert.equal(g.subject, "Team Group A");
    assert.equal(g.participants.length, 2);
    assert.equal(g.participants[0].jid, PN('15550100006'));
    assert.equal(t.store.resolveChat('team group a').kind, 'group');
    assert.equal(t.store.canonical(LID('11')), PN('15550100006'));
  } finally { t.cleanup(); }
});
