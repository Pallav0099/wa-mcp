import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, stubText } from '../src/normalize.mjs';
import { WAMessageStubType } from '@whiskeysockets/baileys';

const m = (message, extra = {}) => ({ key: { remoteJid: 'x@s.whatsapp.net', id: 'A' }, message, ...extra });

test('plain conversation text', () => {
  const d = describe(m({ conversation: 'hello' }));
  assert.equal(d.kind, 'text');
  assert.equal(d.text, 'hello');
  assert.equal(d.skip, false);
});

test('extended text keeps the quoted id, sender and mentions', () => {
  const d = describe(m({ extendedTextMessage: { text: 'yes', contextInfo: { stanzaId: 'Q1', participant: '1@s.whatsapp.net', mentionedJid: ['2@s.whatsapp.net'] } } }));
  assert.equal(d.text, 'yes');
  assert.equal(d.quotedId, 'Q1');
  assert.equal(d.quotedSender, '1@s.whatsapp.net');
  assert.deepEqual(d.mentions, ['2@s.whatsapp.net']);
});

test('image with caption and a protobuf Long file length', () => {
  const d = describe(m({ imageMessage: { caption: 'look', mimetype: 'image/jpeg', fileLength: { low: 2048, high: 0 } } }));
  assert.equal(d.kind, 'image');
  assert.equal(d.text, 'look');
  assert.equal(d.media.size, 2048);
  assert.equal(d.media.mime, 'image/jpeg');
});

test('voice note is distinguished from audio', () => {
  assert.equal(describe(m({ audioMessage: { ptt: true, seconds: 7 } })).kind, 'voice');
  assert.equal(describe(m({ audioMessage: { ptt: false } })).kind, 'audio');
});

test('document keeps its file name', () => {
  const d = describe(m({ documentMessage: { fileName: 'invoice.pdf', mimetype: 'application/pdf' } }));
  assert.equal(d.kind, 'document');
  assert.equal(d.media.name, 'invoice.pdf');
});

test('ephemeral, view-once and edited wrappers are unwrapped', () => {
  assert.equal(describe(m({ ephemeralMessage: { message: { conversation: 'secret' } } })).text, 'secret');
  assert.equal(describe(m({ viewOnceMessageV2: { message: { imageMessage: { caption: 'once' } } } })).kind, 'image');
  assert.equal(describe(m({ editedMessage: { message: { conversation: 'fixed' } } })).text, 'fixed');
});

test('reactions and protocol messages are not stored as messages', () => {
  const r = describe(m({ reactionMessage: { key: { id: 'T1' }, text: '👍' } }));
  assert.equal(r.skip, true);
  assert.equal(r.reaction.emoji, '👍');
  assert.equal(r.reaction.targetKey.id, 'T1');
  const p = describe(m({ protocolMessage: { type: 0, key: { id: 'T2' } } }));
  assert.equal(p.skip, true);
  assert.equal(p.protocol.targetId, 'T2');
});

test('location, poll and contact become readable text', () => {
  assert.match(describe(m({ locationMessage: { degreesLatitude: 22.5, degreesLongitude: 88.3, name: 'Office' } })).text, /Office/);
  assert.match(describe(m({ pollCreationMessageV3: { name: 'Lunch?', options: [{ optionName: 'Yes' }, { optionName: 'No' }] } })).text, /Lunch\? — Yes \/ No/);
  assert.match(describe(m({ contactMessage: { displayName: 'Chris' } })).text, /Chris/);
});

test('system (stub) messages and undecryptable shells', () => {
  const s = describe({ key: { id: 'S' }, messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD, messageStubParameters: ['9@s.whatsapp.net'] });
  assert.equal(s.kind, 'system');
  assert.match(s.text, /group participant add: 9@s.whatsapp.net/);
  assert.equal(describe({ key: { id: 'U' } }).kind, 'undecrypted');
  assert.match(stubText(99999, []), /stub 99999/);
});
