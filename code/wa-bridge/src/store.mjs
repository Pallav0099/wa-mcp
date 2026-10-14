// The message store: one SQLite file (node:sqlite, no native build), WAL mode.
//
// Design rules
//  * A chat or person is keyed by ONE canonical jid. WhatsApp addresses the same person either by
//    phone number (…@s.whatsapp.net, "PN") or by a privacy id (…@lid). When the pairing becomes known
//    the LID rows are merged into the PN rows (mergeJid), so a person never splits into two chats.
//  * Writes are idempotent upserts: history sync, live delivery and retries may deliver the same
//    message several times in any order. Later facts never erase earlier ones (an edit survives a
//    re-delivered original; a read receipt never goes back to "delivered").
//  * rowid of `messages` is stable (no INSERT OR REPLACE), so it doubles as the event cursor.

import { DatabaseSync } from 'node:sqlite';
import { bareJid, chatKind, isLidJid, isPnJid, isGroupJid, jidUser, nowSec, phoneDigits, ftsQuery, BridgeError } from './util.mjs';

export const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER,
  last_ts INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_last ON chats(last_ts DESC);

CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  pn TEXT,
  lid TEXT,
  name TEXT,
  notify TEXT,
  verified_name TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lid_map (
  lid TEXT PRIMARY KEY,
  pn TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lid_map_pn ON lid_map(pn);

CREATE TABLE IF NOT EXISTS messages (
  chat_jid TEXT NOT NULL,
  id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  sender_jid TEXT,
  push_name TEXT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  quoted_id TEXT,
  media_mime TEXT,
  media_name TEXT,
  media_size INTEGER,
  media_seconds INTEGER,
  media_path TEXT,
  status INTEGER,
  edited_ts INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  live INTEGER NOT NULL DEFAULT 0,
  key_json TEXT NOT NULL,
  raw BLOB,
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_jid, ts DESC);
CREATE INDEX IF NOT EXISTS messages_id ON messages(id);
CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender_jid);
CREATE INDEX IF NOT EXISTS messages_live ON messages(live); -- rowid is implicit, so this orders by (live, rowid)

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS reactions (
  chat_jid TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  emoji TEXT NOT NULL,
  ts INTEGER,
  PRIMARY KEY (chat_jid, msg_id, sender_jid)
);

CREATE TABLE IF NOT EXISTS groups (
  jid TEXT PRIMARY KEY,
  subject TEXT,
  description TEXT,
  owner TEXT,
  created INTEGER,
  size INTEGER,
  announce INTEGER,
  restrict_info INTEGER,
  participants_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  token TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  done_at INTEGER,
  sent_id TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status, done_at);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

const MSG_COLS = `m.rowid AS rowid, m.chat_jid, m.id, m.from_me, m.sender_jid, m.ts, m.kind, m.text, m.quoted_id,
  m.media_mime, m.media_name, m.media_size, m.media_seconds, m.media_path, m.status, m.edited_ts, m.deleted, m.live,
  COALESCE(c.name, c.notify, m.push_name, c.verified_name) AS sender_name`;

const CHAT_NAME = `COALESCE(g.subject, ch.name, c.name, c.notify, c.verified_name)`;

/** node:sqlite cannot bind undefined or booleans. */
function bind(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) out[k] = null;
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.stmts = new Map();
    this.txDepth = 0;
    this.migrate();
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  migrate() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    // A store written by a newer release (e.g. after `wa update --rollback`) is never opened by older code.
    if (v > SCHEMA_VERSION) {
      throw new BridgeError('schema_too_new', `wa.sqlite uses schema v${v}, newer than this release supports (v${SCHEMA_VERSION}); run \`wa update\` or restore a backup`);
    }
    if (v < 1) {
      this.db.exec(SCHEMA_V1);
      this.db.exec('PRAGMA user_version = 1');
    }
  }

  q(sql) {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  /** Run fn in a transaction; nested calls join the outer one. */
  tx(fn) {
    if (this.txDepth > 0) return fn();
    this.txDepth++;
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  // ---------------------------------------------------------------- key/value

  getKV(k) { return this.q('SELECT v FROM kv WHERE k = ?').get(k)?.v ?? null; }
  setKV(k, v) { this.q('INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v === null ? null : String(v)); }

  // ---------------------------------------------------------------- identity (PN <-> LID)

  /** The canonical form of any jid: device suffix stripped, LID replaced by its phone jid when known. */
  canonical(jid) {
    const b = bareJid(jid);
    if (isLidJid(b)) return this.q('SELECT pn FROM lid_map WHERE lid = ?').get(b)?.pn || b;
    return b;
  }

  lidForPn(pn) { return this.q('SELECT lid FROM lid_map WHERE pn = ?').get(bareJid(pn))?.lid || null; }

  /** Record lid <-> pn and fold everything stored under the lid into the pn. Returns true if new. */
  addLidMapping(lid, pn) {
    lid = bareJid(lid);
    pn = bareJid(pn);
    if (!isLidJid(lid) || !isPnJid(pn)) return false;
    const existing = this.q('SELECT pn FROM lid_map WHERE lid = ?').get(lid);
    if (existing?.pn === pn) return false;
    this.tx(() => {
      this.q(`INSERT INTO lid_map(lid, pn, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn, updated_at = excluded.updated_at`).run(lid, pn, nowSec());
      this.mergeJid(lid, pn);
    });
    return true;
  }

  /** Move every row stored under `from` to `to` (chat rows, message chat/sender, reactions, contact). */
  mergeJid(from, to) {
    if (!from || !to || from === to) return;
    this.tx(() => {
      // messages: drop duplicates that already exist under `to`, then re-key the rest
      this.q('DELETE FROM messages WHERE chat_jid = ? AND id IN (SELECT id FROM messages WHERE chat_jid = ?)').run(from, to);
      this.q('UPDATE messages SET chat_jid = ? WHERE chat_jid = ?').run(to, from);
      this.q('UPDATE messages SET sender_jid = ? WHERE sender_jid = ?').run(to, from);
      // reactions
      this.q('UPDATE OR IGNORE reactions SET chat_jid = ? WHERE chat_jid = ?').run(to, from);
      this.q('DELETE FROM reactions WHERE chat_jid = ?').run(from);
      this.q('UPDATE OR IGNORE reactions SET sender_jid = ? WHERE sender_jid = ?').run(to, from);
      this.q('DELETE FROM reactions WHERE sender_jid = ?').run(from);
      // chat row
      const src = this.q('SELECT * FROM chats WHERE jid = ?').get(from);
      if (src) {
        this.upsertChat({
          jid: to, name: src.name, unread: src.unread, archived: src.archived, pinned: src.pinned,
          mutedUntil: src.muted_until, lastTs: src.last_ts,
        }, { onlyFill: true });
        this.q('DELETE FROM chats WHERE jid = ?').run(from);
      }
      // contact row
      const c = this.q('SELECT * FROM contacts WHERE jid = ?').get(from);
      if (c) {
        this.upsertContact({ jid: to, pn: to, lid: from, name: c.name, notify: c.notify, verifiedName: c.verified_name });
        this.q('DELETE FROM contacts WHERE jid = ?').run(from);
      } else {
        this.q('UPDATE contacts SET lid = COALESCE(lid, ?) WHERE jid = ?').run(from, to);
      }
      this.q('UPDATE outbox SET chat_jid = ? WHERE chat_jid = ?').run(to, from);
    });
  }

  // ---------------------------------------------------------------- contacts & chats

  upsertContact({ jid, pn, lid, name, notify, verifiedName }) {
    pn = pn ? bareJid(pn) : (isPnJid(bareJid(jid)) ? bareJid(jid) : null);
    lid = lid ? bareJid(lid) : (isLidJid(bareJid(jid)) ? bareJid(jid) : null);
    if (pn && lid) this.addLidMapping(lid, pn);
    const key = pn || this.canonical(lid || jid);
    if (!key || isGroupJid(key)) return null;
    this.q(`INSERT INTO contacts(jid, pn, lid, name, notify, verified_name, updated_at)
            VALUES (@jid, @pn, @lid, @name, @notify, @verified, @now)
            ON CONFLICT(jid) DO UPDATE SET
              pn = COALESCE(excluded.pn, contacts.pn),
              lid = COALESCE(excluded.lid, contacts.lid),
              name = COALESCE(excluded.name, contacts.name),
              notify = COALESCE(excluded.notify, contacts.notify),
              verified_name = COALESCE(excluded.verified_name, contacts.verified_name),
              updated_at = excluded.updated_at`)
      .run(bind({ jid: key, pn, lid, name: name || null, notify: notify || null, verified: verifiedName || null, now: nowSec() }));
    return key;
  }

  /**
   * Upsert a chat. Undefined fields keep their stored value. With onlyFill, stored non-null values win
   * (used when merging a LID chat into an existing PN chat).
   */
  upsertChat({ jid, name, unread, archived, pinned, mutedUntil, lastTs }, { onlyFill = false } = {}) {
    const key = this.canonical(jid);
    if (!key) return null;
    const pick = onlyFill ? 'COALESCE(chats.%c, @%p)' : 'COALESCE(@%p, chats.%c)';
    const f = (col, param) => pick.replace('%c', col).replace('%p', param);
    this.q(`INSERT INTO chats(jid, kind, name, unread, archived, pinned, muted_until, last_ts, updated_at)
            VALUES (@jid, @kind, @name, COALESCE(@unread, 0), COALESCE(@archived, 0), COALESCE(@pinned, 0), @muted, @last, @now)
            ON CONFLICT(jid) DO UPDATE SET
              name = ${f('name', 'name')},
              unread = ${f('unread', 'unread')},
              archived = ${f('archived', 'archived')},
              pinned = ${f('pinned', 'pinned')},
              muted_until = ${f('muted_until', 'muted')},
              last_ts = MAX(COALESCE(chats.last_ts, 0), COALESCE(@last, 0)),
              updated_at = @now`)
      .run(bind({
        jid: key, kind: chatKind(key), name: name || null,
        unread: unread ?? null, archived: archived ?? null, pinned: pinned ?? null,
        muted: mutedUntil ?? null, last: lastTs ?? null, now: nowSec(),
      }));
    return key;
  }

  deleteChat(jid) {
    const key = this.canonical(jid);
    this.q('DELETE FROM chats WHERE jid = ?').run(key);
  }

  // ---------------------------------------------------------------- messages

  /** Idempotent upsert of one normalised message row. */
  upsertMessage(row) {
    this.q(`INSERT INTO messages(chat_jid, id, from_me, sender_jid, push_name, ts, kind, text, quoted_id,
              media_mime, media_name, media_size, media_seconds, status, live, key_json, raw)
            VALUES (@chat_jid, @id, @from_me, @sender_jid, @push_name, @ts, @kind, @text, @quoted_id,
              @media_mime, @media_name, @media_size, @media_seconds, @status, @live, @key_json, @raw)
            ON CONFLICT(chat_jid, id) DO UPDATE SET
              sender_jid = COALESCE(excluded.sender_jid, messages.sender_jid),
              push_name = COALESCE(excluded.push_name, messages.push_name),
              ts = CASE WHEN messages.ts > 0 THEN messages.ts ELSE excluded.ts END,
              kind = CASE WHEN excluded.kind IN ('undecrypted', 'unknown') THEN messages.kind ELSE excluded.kind END,
              text = CASE
                       WHEN messages.edited_ts IS NOT NULL THEN messages.text
                       WHEN excluded.kind IN ('undecrypted', 'unknown') THEN messages.text
                       ELSE excluded.text END,
              quoted_id = COALESCE(excluded.quoted_id, messages.quoted_id),
              media_mime = COALESCE(excluded.media_mime, messages.media_mime),
              media_name = COALESCE(excluded.media_name, messages.media_name),
              media_size = COALESCE(excluded.media_size, messages.media_size),
              media_seconds = COALESCE(excluded.media_seconds, messages.media_seconds),
              status = MAX(COALESCE(messages.status, 0), COALESCE(excluded.status, 0)),
              live = MAX(messages.live, excluded.live),
              key_json = excluded.key_json,
              raw = CASE WHEN excluded.kind IN ('undecrypted', 'unknown') THEN COALESCE(messages.raw, excluded.raw)
                         ELSE COALESCE(excluded.raw, messages.raw) END`)
      .run(bind(row));
  }

  setStatus(chat, id, status) {
    this.q('UPDATE messages SET status = MAX(COALESCE(status, 0), ?) WHERE chat_jid = ? AND id = ?').run(status, this.canonical(chat), id);
  }

  markEdited(chat, id, text, ts) {
    return this.q('UPDATE messages SET text = ?, edited_ts = ? WHERE chat_jid = ? AND id = ?').run(text ?? null, ts ?? nowSec(), this.canonical(chat), id).changes;
  }

  markDeleted(chat, id) {
    return this.q('UPDATE messages SET deleted = 1 WHERE chat_jid = ? AND id = ?').run(this.canonical(chat), id).changes;
  }

  markChatCleared(chat) {
    return this.q('UPDATE messages SET deleted = 1 WHERE chat_jid = ?').run(this.canonical(chat)).changes;
  }

  setMediaPath(chat, id, path) {
    this.q('UPDATE messages SET media_path = ? WHERE chat_jid = ? AND id = ?').run(path, this.canonical(chat), id);
  }

  /** Full row including raw proto, or null. Falls back to an id-only lookup (ids are near-unique). */
  getMessageRow(chat, id) {
    if (chat) {
      const r = this.q('SELECT rowid, * FROM messages WHERE chat_jid = ? AND id = ?').get(this.canonical(chat), id);
      if (r) return r;
    }
    return this.q('SELECT rowid, * FROM messages WHERE id = ? ORDER BY ts DESC LIMIT 1').get(id) || null;
  }

  getMessage(chat, id) {
    const r = this.q(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN contacts c ON c.jid = m.sender_jid
                      WHERE m.chat_jid = ? AND m.id = ?`).get(this.canonical(chat), id);
    return r ? this.decorate([r])[0] : null;
  }

  chatMessages(chat, { limit = 30, before = null, after = null } = {}) {
    const key = this.canonical(chat);
    const rows = this.q(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN contacts c ON c.jid = m.sender_jid
                         WHERE m.chat_jid = @chat AND (@before IS NULL OR m.ts < @before) AND (@after IS NULL OR m.ts > @after)
                         ORDER BY m.ts DESC, m.rowid DESC LIMIT @limit`)
      .all(bind({ chat: key, before, after, limit: clampLimit(limit) }));
    return this.decorate(rows.reverse());
  }

  search({ q = null, chat = null, sender = null, since = null, until = null, limit = 30 } = {}) {
    const fts = ftsQuery(q);
    const params = bind({
      q: fts, chat: chat ? this.canonical(chat) : null, sender: sender ? this.canonical(sender) : null,
      since, until, limit: clampLimit(limit),
    });
    const filters = `(@chat IS NULL OR m.chat_jid = @chat) AND (@sender IS NULL OR m.sender_jid = @sender)
                     AND (@since IS NULL OR m.ts >= @since) AND (@until IS NULL OR m.ts <= @until)`;
    let rows;
    if (fts) {
      rows = this.q(`SELECT ${MSG_COLS} FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
                     LEFT JOIN contacts c ON c.jid = m.sender_jid
                     WHERE messages_fts MATCH @q AND ${filters}
                     ORDER BY m.ts DESC LIMIT @limit`).all(params);
    } else {
      rows = this.q(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN contacts c ON c.jid = m.sender_jid
                     WHERE @q IS NULL AND ${filters} ORDER BY m.ts DESC LIMIT @limit`).all(params);
    }
    return this.decorate(rows);
  }

  /** Messages that arrived live, after the given cursor (rowid). */
  events({ after = 0, limit = 100 } = {}) {
    const rows = this.q(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN contacts c ON c.jid = m.sender_jid
                         WHERE m.live = 1 AND m.rowid > ? ORDER BY m.rowid ASC LIMIT ?`).all(after, clampLimit(limit, 500));
    return this.decorate(rows);
  }

  latestCursor() {
    return this.q('SELECT COALESCE(MAX(rowid), 0) AS c FROM messages WHERE live = 1').get().c;
  }

  oldestMessage(chat) {
    return this.q('SELECT rowid, * FROM messages WHERE chat_jid = ? ORDER BY ts ASC LIMIT 1').get(this.canonical(chat)) || null;
  }

  recentInbound(chat, limit = 20) {
    return this.q('SELECT rowid, * FROM messages WHERE chat_jid = ? AND from_me = 0 ORDER BY ts DESC LIMIT ?').all(this.canonical(chat), limit);
  }

  /** Attach chat names and reactions to message rows. */
  decorate(rows) {
    if (!rows.length) return rows;
    const names = new Map();
    const reactions = new Map();
    for (const r of rows) {
      if (!names.has(r.chat_jid)) names.set(r.chat_jid, this.displayName(r.chat_jid));
      r.chat_name = names.get(r.chat_jid);
      r.from_me = !!r.from_me;
      r.deleted = !!r.deleted;
      r.live = !!r.live;
      const key = `${r.chat_jid}\u0000${r.id}`;
      if (!reactions.has(key)) reactions.set(key, this.reactionsFor(r.chat_jid, r.id));
      r.reactions = reactions.get(key);
    }
    return rows;
  }

  // ---------------------------------------------------------------- reactions

  setReaction(chat, msgId, sender, emoji, ts) {
    chat = this.canonical(chat);
    sender = this.canonical(sender);
    if (!chat || !msgId || !sender) return;
    if (!emoji) {
      this.q('DELETE FROM reactions WHERE chat_jid = ? AND msg_id = ? AND sender_jid = ?').run(chat, msgId, sender);
      return;
    }
    this.q(`INSERT INTO reactions(chat_jid, msg_id, sender_jid, emoji, ts) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(chat_jid, msg_id, sender_jid) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts`)
      .run(chat, msgId, sender, emoji, ts ?? nowSec());
  }

  reactionsFor(chat, msgId) {
    return this.q(`SELECT r.emoji, r.sender_jid, COALESCE(c.name, c.notify) AS sender_name
                   FROM reactions r LEFT JOIN contacts c ON c.jid = r.sender_jid
                   WHERE r.chat_jid = ? AND r.msg_id = ? ORDER BY r.ts`).all(chat, msgId);
  }

  // ---------------------------------------------------------------- groups

  upsertGroup(meta) {
    const jid = bareJid(meta.id);
    if (!isGroupJid(jid)) return null;
    const participants = (meta.participants || []).map((p) => {
      const pn = p.phoneNumber ? bareJid(p.phoneNumber) : (isPnJid(bareJid(p.id)) ? bareJid(p.id) : null);
      const lid = p.lid ? bareJid(p.lid) : (isLidJid(bareJid(p.id)) ? bareJid(p.id) : null);
      if (pn && lid) this.addLidMapping(lid, pn);
      return { jid: pn || this.canonical(p.id), admin: p.admin || (p.isSuperAdmin ? 'superadmin' : p.isAdmin ? 'admin' : null) };
    });
    this.q(`INSERT INTO groups(jid, subject, description, owner, created, size, announce, restrict_info, participants_json, updated_at)
            VALUES (@jid, @subject, @desc, @owner, @created, @size, @announce, @restrict, @participants, @now)
            ON CONFLICT(jid) DO UPDATE SET
              subject = COALESCE(excluded.subject, groups.subject),
              description = COALESCE(excluded.description, groups.description),
              owner = COALESCE(excluded.owner, groups.owner),
              created = COALESCE(excluded.created, groups.created),
              size = COALESCE(excluded.size, groups.size),
              announce = COALESCE(excluded.announce, groups.announce),
              restrict_info = COALESCE(excluded.restrict_info, groups.restrict_info),
              participants_json = COALESCE(excluded.participants_json, groups.participants_json),
              updated_at = excluded.updated_at`)
      .run(bind({
        jid, subject: meta.subject ?? null, desc: meta.desc ?? null,
        owner: meta.ownerPn ? bareJid(meta.ownerPn) : (meta.owner ? this.canonical(meta.owner) : null),
        created: meta.creation ?? null, size: meta.size ?? (meta.participants ? meta.participants.length : null),
        announce: meta.announce ?? null, restrict: meta.restrict ?? null,
        participants: meta.participants ? JSON.stringify(participants) : null, now: nowSec(),
      }));
    this.upsertChat({ jid, name: meta.subject ?? undefined });
    return jid;
  }

  /** Partial group update (subject change, settings) without touching participants. */
  patchGroup(patch) {
    const jid = bareJid(patch.id);
    if (!isGroupJid(jid)) return;
    this.upsertGroup({ id: jid, subject: patch.subject, desc: patch.desc, announce: patch.announce, restrict: patch.restrict });
  }

  listGroups({ q = null, limit = 100 } = {}) {
    return this.q(`SELECT jid, subject, size, announce, owner, created FROM groups
                   WHERE @q IS NULL OR subject LIKE @q ORDER BY subject COLLATE NOCASE LIMIT @limit`)
      .all(bind({ q: q ? `%${q}%` : null, limit: clampLimit(limit, 1000) }));
  }

  getGroup(jid) {
    const g = this.q('SELECT * FROM groups WHERE jid = ?').get(bareJid(jid));
    if (!g) return null;
    const participants = g.participants_json ? JSON.parse(g.participants_json) : [];
    delete g.participants_json;
    g.participants = participants.map((p) => ({ ...p, name: this.displayName(p.jid) }));
    return g;
  }

  // ---------------------------------------------------------------- lookup & naming

  displayName(jid) {
    const key = this.canonical(jid);
    if (!key) return null;
    if (isGroupJid(key)) {
      const g = this.q('SELECT subject FROM groups WHERE jid = ?').get(key);
      return g?.subject || this.q('SELECT name FROM chats WHERE jid = ?').get(key)?.name || key;
    }
    const c = this.q('SELECT name, notify, verified_name FROM contacts WHERE jid = ?').get(key);
    const chatName = this.q('SELECT name FROM chats WHERE jid = ?').get(key)?.name;
    return c?.name || chatName || c?.notify || c?.verified_name || (isPnJid(key) ? '+' + jidUser(key) : key);
  }

  listChats({ limit = 30, q = null, unread = false, kind = null, includeArchived = true } = {}) {
    return this.q(`SELECT ch.jid, ch.kind, ch.unread, ch.archived, ch.pinned, ch.muted_until, ch.last_ts, ${CHAT_NAME} AS name,
                     (SELECT CASE WHEN m.text IS NOT NULL THEN m.text ELSE '<' || m.kind || '>' END
                        FROM messages m WHERE m.chat_jid = ch.jid ORDER BY m.ts DESC LIMIT 1) AS last_text
                   FROM chats ch
                   LEFT JOIN contacts c ON c.jid = ch.jid
                   LEFT JOIN groups g ON g.jid = ch.jid
                   WHERE ch.kind NOT IN ('status', 'channel')
                     AND (@kind IS NULL OR ch.kind = @kind)
                     AND (@unread = 0 OR ch.unread > 0)
                     AND (@arch = 1 OR ch.archived = 0)
                     AND (@q IS NULL OR ${CHAT_NAME} LIKE @q OR ch.jid LIKE @q)
                   ORDER BY ch.pinned DESC, ch.last_ts DESC NULLS LAST
                   LIMIT @limit`)
      .all(bind({ kind, unread: unread ? 1 : 0, arch: includeArchived ? 1 : 0, q: q ? `%${q}%` : null, limit: clampLimit(limit, 1000) }));
  }

  searchContacts(q, limit = 20) {
    const like = `%${q}%`;
    const digits = phoneDigits(q);
    return this.q(`SELECT jid, pn, lid, name, notify, verified_name FROM contacts
                   WHERE name LIKE @like OR notify LIKE @like OR verified_name LIKE @like OR (@digits IS NOT NULL AND jid LIKE @dlike)
                   ORDER BY name IS NULL, name COLLATE NOCASE LIMIT @limit`)
      .all(bind({ like, digits, dlike: digits ? `%${digits}%` : null, limit: clampLimit(limit, 200) }));
  }

  isKnown(jid) {
    const key = this.canonical(jid);
    if (this.q('SELECT 1 FROM chats WHERE jid = ?').get(key)) return true;
    if (this.q('SELECT 1 FROM messages WHERE chat_jid = ? LIMIT 1').get(key)) return true;
    return !!this.q('SELECT 1 FROM contacts WHERE jid = ? AND name IS NOT NULL').get(key);
  }

  /**
   * Resolve what a human or Claude typed ('+1 555…', a jid, 'Lex', 'Project Group B') to one chat.
   * Returns { jid, name, kind, known }. Throws BridgeError('ambiguous', …, { candidates }) or ('not_found').
   */
  resolveChat(input) {
    const raw = String(input ?? '').trim();
    if (!raw) throw new BridgeError('bad_request', 'empty chat reference');
    const found = (jid) => ({ jid, name: this.displayName(jid), kind: chatKind(jid), known: this.isKnown(jid) });

    if (raw.includes('@')) return found(this.canonical(raw));

    const digits = phoneDigits(raw);
    if (digits) {
      const exact = this.canonical(`${digits}@s.whatsapp.net`);
      if (this.isKnown(exact)) return found(exact);
      // a local number without country code: accept only a UNIQUE known match on the suffix
      const sfx = this.q(`SELECT jid FROM chats WHERE jid LIKE ? AND kind = 'dm'
                          UNION SELECT jid FROM contacts WHERE jid LIKE ?`).all(`%${digits}@s.whatsapp.net`, `%${digits}@s.whatsapp.net`);
      if (sfx.length === 1) return found(sfx[0].jid);
      if (sfx.length > 1) throw new BridgeError('ambiguous', `${sfx.length} chats end in ${digits}`, { candidates: sfx.map((r) => found(r.jid)) });
      return found(exact); // unknown number; callers decide whether that is allowed
    }

    const lower = raw.toLowerCase();
    const pool = this.q(`SELECT ch.jid, ${CHAT_NAME} AS name FROM chats ch
                         LEFT JOIN contacts c ON c.jid = ch.jid LEFT JOIN groups g ON g.jid = ch.jid
                         WHERE ch.kind IN ('dm', 'group')
                         UNION
                         SELECT c.jid, COALESCE(c.name, c.notify) AS name FROM contacts c WHERE c.name IS NOT NULL`).all();
    const exact = uniqueByJid(pool.filter((r) => r.name && r.name.toLowerCase() === lower));
    if (exact.length === 1) return found(exact[0].jid);
    if (exact.length > 1) throw new BridgeError('ambiguous', `${exact.length} chats are named "${raw}"`, { candidates: exact.slice(0, 10).map((r) => found(r.jid)) });
    const partial = uniqueByJid(pool.filter((r) => r.name && r.name.toLowerCase().includes(lower)));
    if (partial.length === 1) return found(partial[0].jid);
    if (partial.length > 1) throw new BridgeError('ambiguous', `${partial.length} chats match "${raw}"`, { candidates: partial.slice(0, 10).map((r) => found(r.jid)) });
    throw new BridgeError('not_found', `no chat or contact matches "${raw}"`);
  }

  // ---------------------------------------------------------------- outbox & audit

  insertDraft(d) {
    this.q(`INSERT INTO outbox(token, action, chat_jid, payload_json, preview_json, status, created_at, expires_at)
            VALUES (@token, @action, @chat, @payload, @preview, 'draft', @created, @expires)`)
      .run(bind({ token: d.token, action: d.action, chat: d.chat, payload: JSON.stringify(d.payload), preview: JSON.stringify(d.preview), created: d.createdAt, expires: d.expiresAt }));
  }

  getDraft(token) {
    const r = this.q('SELECT * FROM outbox WHERE token = ?').get(token);
    if (!r) return null;
    return { ...r, payload: JSON.parse(r.payload_json), preview: JSON.parse(r.preview_json) };
  }

  /** Atomic status transition; returns true only for the caller that won the race. */
  transitionDraft(token, from, to, fields = {}) {
    return this.q(`UPDATE outbox SET status = @to, done_at = COALESCE(@done, done_at), sent_id = COALESCE(@sent, sent_id), error = COALESCE(@error, error)
                   WHERE token = @token AND status = @from`)
      .run(bind({ token, from, to, done: fields.doneAt ?? null, sent: fields.sentId ?? null, error: fields.error ?? null })).changes === 1;
  }

  expireDrafts(now = nowSec()) {
    return this.q("UPDATE outbox SET status = 'expired', done_at = ? WHERE status = 'draft' AND expires_at < ?").run(now, now).changes;
  }

  listDrafts({ status = 'draft', limit = 50 } = {}) {
    return this.q('SELECT token, action, chat_jid, preview_json, status, created_at, expires_at, done_at, sent_id, error FROM outbox WHERE (@status IS NULL OR status = @status) ORDER BY created_at DESC LIMIT @limit')
      .all(bind({ status, limit: clampLimit(limit, 500) }))
      .map((r) => ({ ...r, preview: JSON.parse(r.preview_json), preview_json: undefined }));
  }

  /** Sends that count against the rate limits: finished ones in the window plus any still in flight. */
  countSentSince(sec) {
    return this.q("SELECT COUNT(*) AS n FROM outbox WHERE (status = 'sent' AND done_at >= ?) OR status = 'sending'").get(sec).n;
  }

  /** At startup: a draft left in 'sending' was interrupted by a crash or kill; its delivery is unknown. */
  failInterruptedSends(now = nowSec()) {
    return this.q("UPDATE outbox SET status = 'failed', done_at = ?, error = 'interrupted: the daemon stopped while sending; delivery unknown' WHERE status = 'sending'")
      .run(now).changes;
  }

  audit(action, detail = {}) {
    this.q('INSERT INTO audit(ts, action, detail_json) VALUES (?, ?, ?)').run(nowSec(), action, JSON.stringify(detail));
  }

  listAudit(limit = 50) {
    return this.q('SELECT id, ts, action, detail_json FROM audit ORDER BY id DESC LIMIT ?').all(clampLimit(limit, 1000))
      .map((r) => ({ id: r.id, ts: r.ts, action: r.action, detail: JSON.parse(r.detail_json || '{}') }));
  }

  // ---------------------------------------------------------------- stats

  stats() {
    const one = (sql) => this.q(sql).get().n;
    return {
      chats: one("SELECT COUNT(*) AS n FROM chats WHERE kind NOT IN ('status', 'channel')"),
      groups: one('SELECT COUNT(*) AS n FROM groups'),
      contacts: one('SELECT COUNT(*) AS n FROM contacts'),
      messages: one('SELECT COUNT(*) AS n FROM messages'),
      liveMessages: one('SELECT COUNT(*) AS n FROM messages WHERE live = 1'),
      oldestTs: this.q('SELECT MIN(ts) AS n FROM messages WHERE ts > 0').get().n,
      newestTs: this.q('SELECT MAX(ts) AS n FROM messages').get().n,
      lidMappings: one('SELECT COUNT(*) AS n FROM lid_map'),
      draftsOpen: one("SELECT COUNT(*) AS n FROM outbox WHERE status = 'draft'"),
      sentToday: this.countSentSince(nowSec() - 86400),
    };
  }
}

function clampLimit(n, max = 200) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 30;
  return Math.min(Math.floor(v), max);
}

function uniqueByJid(rows) {
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.jid) ? false : seen.add(r.jid)));
}
