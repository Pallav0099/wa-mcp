import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Ingest } from '../src/ingest.mjs';
import { silentLogger } from '../src/log.mjs';
import { BridgeError } from '../src/util.mjs';

export const PN = (n) => `${n}@s.whatsapp.net`;
export const LID = (n) => `${n}@lid`;
export const ME_PN = PN('15550100001');
export const ME_LID = LID('100000000000001');

export function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wab-'));
  const cfg = loadConfig(dir);
  cfg.port = 0;
  const store = new Store(cfg.paths.db);
  const ingest = new Ingest({ store, log: silentLogger });
  ingest.setMe({ pn: ME_PN, lid: ME_LID, name: 'Owner' });
  return {
    dir, cfg, store, ingest,
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

let seq = 0;
/** Build a WAMessage-shaped object. */
export function msg({ chat, id, fromMe = false, participant, participantAlt, remoteJidAlt, ts, text, message, pushName, stub, stubParams, status } = {}) {
  seq++;
  const key = { remoteJid: chat, fromMe, id: id || `M${seq}` };
  if (participant) key.participant = participant;
  if (participantAlt) key.participantAlt = participantAlt;
  if (remoteJidAlt) key.remoteJidAlt = remoteJidAlt;
  const m = { key, messageTimestamp: ts ?? 1_790_000_000 + seq };
  if (message !== undefined) m.message = message;
  else if (text !== undefined) m.message = { conversation: text };
  if (pushName) m.pushName = pushName;
  if (stub) { m.messageStubType = stub; m.messageStubParameters = stubParams || []; }
  if (status !== undefined) m.status = status;
  return m;
}

export function fakeWa(extra = {}) {
  const sent = [];
  return {
    state: 'open',
    sent,
    requireOpen() {
      if (this.state !== 'open') throw new BridgeError('not_connected', `WhatsApp is ${this.state}`);
    },
    async send(jid, content, options) {
      sent.push({ jid, content, options });
      // mirror what Baileys returns for each kind of content
      let message;
      if (content.react) message = { reactionMessage: { key: content.react.key, text: content.react.text } };
      else if (content.delete) message = { protocolMessage: { type: 0, key: content.delete } };
      else if (content.image) message = { imageMessage: { caption: content.caption, mimetype: content.mimetype } };
      else if (content.audio) message = { audioMessage: { ptt: !!content.ptt, mimetype: content.mimetype } };
      else if (content.video) message = { videoMessage: { caption: content.caption } };
      else if (content.document) message = { documentMessage: { fileName: content.fileName, mimetype: content.mimetype } };
      else message = { conversation: content.text };
      return { key: { remoteJid: jid, fromMe: true, id: `SENT${sent.length}` }, messageTimestamp: Math.floor(Date.now() / 1000), message };
    },
    async onWhatsApp(digits) { return { exists: true, jid: `${digits}@s.whatsapp.net` }; },
    status() { return { state: this.state, linked: true, me: { pn: ME_PN, lid: ME_LID, name: 'Owner' } }; },
    linkStatus() { return { state: this.state, linked: true }; },
    ...extra,
  };
}
