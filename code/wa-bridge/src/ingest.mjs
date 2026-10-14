// Ingest: WhatsApp events -> store. One method per event family, all idempotent.
//
// Nothing in this file ever talks back to WhatsApp. Ingest only records.

import { describe, REVOKE_STUB } from './normalize.mjs';
import { encodeRaw, keyJson } from './raw.mjs';
import { bareJid, isGroupJid, isLidJid, isPnJid, nowSec, toNum } from './util.mjs';

export class Ingest {
  constructor({ store, log }) {
    this.store = store;
    this.log = log;
    this.me = { pn: null, lid: null, name: null };
    this.counters = { messages: 0, history: 0, reactions: 0, edits: 0, deletes: 0 };
    // History sync progress since this daemon started (shown by `wa connect` / `wa status`).
    this.sync = { chunks: 0, messages: 0, lastChunkAt: null, syncType: null, progress: null, isLatest: false };
  }

  syncStatus() { return { ...this.sync }; }

  setMe({ pn, lid, name }) {
    this.me = { pn: pn ? bareJid(pn) : null, lid: lid ? bareJid(lid) : null, name: name || null };
    if (this.me.pn && this.me.lid) this.store.addLidMapping(this.me.lid, this.me.pn);
  }

  meJid() { return this.me.pn || this.me.lid; }

  /** Learn PN<->LID pairs that WhatsApp volunteers on message keys. */
  learnPair(a, b) {
    if (!a || !b) return;
    const A = bareJid(a);
    const B = bareJid(b);
    if (isLidJid(A) && isPnJid(B)) this.store.addLidMapping(A, B);
    else if (isPnJid(A) && isLidJid(B)) this.store.addLidMapping(B, A);
  }

  resolveKey(key) {
    this.learnPair(key.remoteJid, key.remoteJidAlt);
    this.learnPair(key.participant, key.participantAlt);
    const chat = this.store.canonical(key.remoteJid);
    const fromMe = !!key.fromMe;
    let sender;
    if (fromMe) sender = this.meJid();
    else if (isGroupJid(chat) || (chat && chat.endsWith('@broadcast'))) sender = key.participant ? this.store.canonical(key.participant) : null;
    else sender = chat;
    return { chat, sender, fromMe, id: key.id };
  }

  /** One message from history sync (live=false) or live delivery (live=true). */
  message(msg, { live = false } = {}) {
    if (!msg?.key?.id || !msg.key.remoteJid) return null;
    return this.store.tx(() => {
      const { chat, sender, fromMe, id } = this.resolveKey(msg.key);
      if (!chat) return null;
      const d = describe(msg);
      const ts = toNum(msg.messageTimestamp) || nowSec();

      if (d.reaction) {
        const targetId = d.reaction.targetKey?.id;
        if (targetId && sender) {
          this.store.setReaction(chat, targetId, sender, d.reaction.emoji, ts);
          this.counters.reactions++;
        }
        return null;
      }
      if (d.skip) return null;

      const row = {
        chat_jid: chat,
        id,
        from_me: fromMe ? 1 : 0,
        sender_jid: sender,
        push_name: !fromMe ? (msg.pushName || null) : null,
        ts,
        kind: d.kind,
        text: d.text,
        quoted_id: d.quotedId,
        media_mime: d.media?.mime ?? null,
        media_name: d.media?.name ?? null,
        media_size: d.media?.size ?? null,
        media_seconds: d.media?.seconds ?? null,
        status: typeof msg.status === 'number' ? msg.status : null,
        live: live ? 1 : 0,
        key_json: keyJson(msg.key),
        raw: encodeRaw(msg),
      };
      this.store.upsertMessage(row);
      this.store.upsertChat({ jid: chat, lastTs: ts });
      if (!fromMe && msg.pushName && sender && !isGroupJid(sender)) {
        this.store.upsertContact({ jid: sender, notify: msg.pushName });
      }
      this.counters[live ? 'messages' : 'history']++;
      return row;
    });
  }

  /** messaging-history.set: one chunk of the history the phone ships to a newly linked device. */
  history({ chats = [], contacts = [], messages = [], lidPnMappings = [], syncType, progress, isLatest } = {}) {
    let stored = 0;
    this.store.tx(() => {
      for (const m of lidPnMappings || []) this.store.addLidMapping(m.lid, m.pn);
      for (const c of contacts || []) this.contact(c);
      for (const c of chats || []) this.chat(c);
      for (const m of messages || []) if (this.message(m, { live: false })) stored++;
    });
    this.sync = {
      chunks: this.sync.chunks + 1,
      messages: this.sync.messages + stored,
      lastChunkAt: nowSec(),
      syncType: syncType ?? null,
      progress: progress ?? null,
      isLatest: !!isLatest,
    };
    this.log.info('history_chunk', {
      syncType, progress: progress ?? null, isLatest: !!isLatest,
      chats: chats?.length || 0, contacts: contacts?.length || 0, messages: messages?.length || 0, stored,
      mappings: lidPnMappings?.length || 0,
    });
    return stored;
  }

  /** messages.update: delivery/read status, edits, revokes. */
  messagesUpdate(updates = []) {
    for (const { key, update } of updates) {
      if (!key?.id || !update) continue;
      const { chat, id } = this.resolveKey(key);
      if (typeof update.status === 'number') this.store.setStatus(chat, id, update.status);
      if (update.messageStubType === REVOKE_STUB || (update.message === null && update.messageStubType)) {
        if (this.store.markDeleted(chat, id)) this.counters.deletes++;
      }
      const edited = update.message?.editedMessage?.message;
      if (edited) {
        const d = describe({ message: edited });
        const n = this.store.markEdited(chat, id, d.text, toNum(update.messageTimestamp));
        if (n) this.counters.edits++;
        else this.log.debug('edit_for_unknown_message', { chat, id });
      }
    }
  }

  /** messages.delete: specific keys, or a whole chat cleared on another device. */
  messagesDelete(evt) {
    if (!evt) return;
    if (Array.isArray(evt.keys)) {
      for (const key of evt.keys) {
        const { chat, id } = this.resolveKey(key);
        this.store.markDeleted(chat, id);
      }
    } else if (evt.jid && evt.all) {
      this.store.markChatCleared(evt.jid);
    }
  }

  /** messages.reaction: {key: reacted message, reaction: {text, key: reaction message key}}. */
  reactions(list = []) {
    for (const { key, reaction } of list) {
      if (!key?.id) continue;
      const { chat } = this.resolveKey(key);
      const rk = reaction?.key || {};
      let sender;
      if (rk.fromMe) sender = this.meJid();
      else if (isGroupJid(chat)) sender = rk.participant ? this.store.canonical(rk.participant) : null;
      else sender = rk.remoteJid ? this.store.canonical(rk.remoteJid) : chat;
      if (!sender) continue;
      this.store.setReaction(chat, key.id, sender, reaction?.text || '', toNum(reaction?.senderTimestampMs) ? Math.floor(toNum(reaction.senderTimestampMs) / 1000) : nowSec());
      this.counters.reactions++;
    }
  }

  chat(c) {
    if (!c?.id) return;
    if (c.pnJid) this.learnPair(c.id, c.pnJid);
    if (c.lidJid) this.learnPair(c.id, c.lidJid);
    const muted = toNum(c.muteEndTime);
    this.store.upsertChat({
      jid: c.id,
      name: c.name || undefined,
      unread: typeof c.unreadCount === 'number' ? Math.max(0, c.unreadCount) : undefined,
      archived: typeof c.archived === 'boolean' ? c.archived : undefined,
      pinned: c.pinned !== undefined && c.pinned !== null ? (toNum(c.pinned) ? 1 : 0) : undefined,
      mutedUntil: muted ? (muted > 1e12 ? Math.floor(muted / 1000) : muted) : undefined,
      lastTs: toNum(c.conversationTimestamp) || toNum(c.lastMessageRecvTimestamp) || undefined,
    });
  }

  chats(list = []) { this.store.tx(() => { for (const c of list) this.chat(c); }); }
  chatsDelete(ids = []) { for (const id of ids) this.store.deleteChat(id); }

  contact(c) {
    if (!c?.id) return;
    this.store.upsertContact({ jid: c.id, pn: c.phoneNumber, lid: c.lid, name: c.name, notify: c.notify, verifiedName: c.verifiedName });
  }

  contacts(list = []) { this.store.tx(() => { for (const c of list) this.contact(c); }); }

  groups(list = []) { this.store.tx(() => { for (const g of list) this.store.upsertGroup(g); }); }
  groupsPatch(list = []) { this.store.tx(() => { for (const g of list) this.store.patchGroup(g); }); }

  lidMapping(m) {
    if (m?.lid && m?.pn) this.store.addLidMapping(m.lid, m.pn);
  }
}
