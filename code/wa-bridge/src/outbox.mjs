// Outbox: the ONLY path by which anything leaves this bridge.
//
// Every outbound action is two steps:
//   1. draft   -> validates, resolves the chat, stores a preview, returns a short token. Nothing is sent.
//   2. confirm -> re-checks everything (still pending, not expired, rate limits, connection), then sends.
// The pause between the two is where a human approves the exact preview. Drafts expire (default 15 min),
// can be cancelled, and every step is written to the audit table.
//
// Actions: text | media | react | delete (delete-for-everyone of one's OWN message) |
//          group_create (a new group: subject, participants, optional description, picture and admins) |
//          group_update (an existing group's subject, description and/or picture).

import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import { decodeRaw, storedKey } from './raw.mjs';
import { BridgeError, bareJid, formatTs, jidUser, mediaKindForPath, mimeForPath, nowSec, toNum, truncate } from './util.mjs';

const ACTIONS = new Set(['text', 'media', 'react', 'delete', 'group_create', 'group_update']);
const GROUP_MAX_PARTICIPANTS = 100; // WhatsApp allows far more; this guards against a mistyped list
const GROUP_PICTURE_EXT = new Set(['.jpg', '.jpeg', '.png']);
const GROUP_PICTURE_MAX_BYTES = 5 * 1024 * 1024;
const MEDIA_AS = new Set(['image', 'video', 'audio', 'voice', 'document']);
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const DELETE_WINDOW_SEC = 60 * 3600; // WhatsApp allows delete-for-everyone for roughly 60 hours

export class Outbox {
  constructor({ store, wa, ingest, cfg, log, convertVoice = toOpus }) {
    this.store = store;
    this.wa = wa;
    this.ingest = ingest;
    this.cfg = cfg;
    this.log = log;
    this.convertVoice = convertVoice;
  }

  newToken() {
    const bytes = randomBytes(6);
    let t = '';
    for (const b of bytes) t += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
    return t;
  }

  /** Step 1: validate and park. Returns { token, expiresAt, preview, summary }. Sends nothing. */
  draft(req = {}) {
    const s = this.cfg.sending;
    if (!s.enabled) throw new BridgeError('sending_disabled', 'sending is switched off (config.json: sending.enabled)');
    const action = req.action || 'text';
    if (!ACTIONS.has(action)) throw new BridgeError('bad_request', `unknown action "${action}"`);
    if (action === 'group_create') return this.draftGroup(req);
    if (action === 'group_update') return this.draftGroupUpdate(req);

    const target = this.store.resolveChat(req.to);
    let newChat = false;
    if (!target.known) {
      if (target.kind !== 'dm') throw new BridgeError('unknown_chat', `${target.jid} is not a chat this bridge knows`, { target });
      if (s.requireKnownChat && !req.allowNew) {
        throw new BridgeError('unknown_chat', `${target.name} (${target.jid}) has never appeared in this WhatsApp; pass allowNew to message a new number`, { target });
      }
      if (action !== 'text' && action !== 'media') throw new BridgeError('bad_request', 'reactions and deletes need an existing chat');
      newChat = true;
    }

    const payload = { action, jid: target.jid, newChat };
    const preview = { action, to: { jid: target.jid, name: target.name, kind: target.kind, new: newChat } };

    if (action === 'text') {
      const text = String(req.text ?? '');
      if (!text.trim()) throw new BridgeError('bad_request', 'text is empty');
      if (text.length > s.maxTextLength) throw new BridgeError('bad_request', `text is ${text.length} characters; the limit is ${s.maxTextLength}`);
      payload.text = text;
      preview.text = text;
    }

    if (action === 'media') {
      const path = req.path;
      if (!path || !existsSync(path)) throw new BridgeError('bad_request', `file not found: ${path}`);
      const st = statSync(path);
      if (!st.isFile()) throw new BridgeError('bad_request', `not a file: ${path}`);
      if (st.size > s.maxMediaBytes) throw new BridgeError('bad_request', `file is ${st.size} bytes; the limit is ${s.maxMediaBytes}`);
      const as = req.as || mediaKindForPath(path);
      if (!MEDIA_AS.has(as)) throw new BridgeError('bad_request', `"as" must be one of ${[...MEDIA_AS].join(', ')}`);
      payload.path = path;
      payload.as = as;
      payload.mime = mimeForPath(path);
      payload.fileName = req.fileName || basename(path);
      payload.caption = req.caption ? String(req.caption) : null;
      preview.media = { path, as, bytes: st.size, fileName: payload.fileName };
      if (payload.caption) preview.caption = payload.caption;
    }

    if ((action === 'text' || action === 'media') && req.replyTo) {
      const q = this.targetMessage(target.jid, req.replyTo);
      if (!q.raw) throw new BridgeError('bad_request', 'the message to reply to has no stored payload, so it cannot be quoted');
      payload.replyTo = q.id;
      preview.replyTo = this.describeTarget(q);
    }

    if (action === 'react' || action === 'delete') {
      const t = this.targetMessage(target.jid, req.messageId);
      if (action === 'delete') {
        if (!t.from_me) throw new BridgeError('bad_request', 'only your own messages can be deleted for everyone');
        if (nowSec() - t.ts > DELETE_WINDOW_SEC) throw new BridgeError('bad_request', 'this message is older than WhatsApp allows for delete-for-everyone');
      }
      payload.messageId = t.id;
      preview.target = this.describeTarget(t);
      if (action === 'react') {
        payload.emoji = String(req.emoji ?? '');
        preview.emoji = payload.emoji || '(remove my reaction)';
      }
    }

    const now = nowSec();
    const token = this.newToken();
    const expiresAt = now + s.draftTtlSec;
    this.store.insertDraft({ token, action, chat: target.jid, payload, preview, createdAt: now, expiresAt });
    this.store.audit('draft', { token, action, chat: target.jid, newChat });
    this.log.info('draft_created', { token, action, chat: target.jid });
    return { token, expiresAt, preview, summary: renderPreview(preview, token, expiresAt) };
  }

  /** Draft a new group. Validates everything, parks it, creates nothing. */
  draftGroup(req) {
    const s = this.cfg.sending;
    const subject = String(req.subject ?? '').trim();
    if (!subject) throw new BridgeError('bad_request', 'subject is empty');
    if ([...subject].length > 100) throw new BridgeError('bad_request', 'subject is over 100 characters');

    const me = jidUser(this.wa.status?.()?.me?.pn) || null;
    const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');
    const listOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','));
    const participants = [...new Set(listOf(req.participants).map(digitsOf).filter(Boolean))].filter((d) => d !== me);
    if (!participants.length) throw new BridgeError('bad_request', 'no participants');
    const bad = participants.filter((d) => d.length < 8 || d.length > 15);
    if (bad.length) throw new BridgeError('bad_request', `not phone numbers: ${bad.join(', ')}`);
    if (participants.length > GROUP_MAX_PARTICIPANTS) throw new BridgeError('bad_request', `${participants.length} participants; the limit is ${GROUP_MAX_PARTICIPANTS}`);
    const admins = [...new Set(listOf(req.admins).map(digitsOf).filter(Boolean))].filter((d) => d !== me);
    const stray = admins.filter((d) => !participants.includes(d));
    if (stray.length) throw new BridgeError('bad_request', `admins must also be participants: ${stray.join(', ')}`);

    const description = req.description ? String(req.description) : null;
    if (description && description.length > 2048) throw new BridgeError('bad_request', 'description is over 2048 characters');

    const picture = req.picture ? groupPicture(req.picture) : null;

    const people = participants.map((d) => {
      const t = this.store.resolveChat(d);
      return { number: d, jid: t.jid, name: t.name, new: !t.known, admin: admins.includes(d) };
    });
    const unseen = people.filter((p) => p.new);
    if (unseen.length && s.requireKnownChat && !req.allowNew) {
      throw new BridgeError('unknown_chat', `never seen in this WhatsApp: ${unseen.map((p) => p.number).join(', ')}; pass allowNew to add them`);
    }

    const payload = { action: 'group_create', subject, participants, admins, description, picture };
    const preview = {
      action: 'group_create',
      to: { jid: 'new group', name: subject, kind: 'group', new: true },
      group: { subject, description, picture, participants: people },
    };
    const now = nowSec();
    const token = this.newToken();
    const expiresAt = now + s.draftTtlSec;
    this.store.insertDraft({ token, action: 'group_create', chat: 'new-group', payload, preview, createdAt: now, expiresAt });
    this.store.audit('draft', { token, action: 'group_create', subject, participants: participants.length });
    this.log.info('draft_created', { token, action: 'group_create', participants: participants.length });
    return { token, expiresAt, preview, summary: renderPreview(preview, token, expiresAt) };
  }

  /** Draft a change to an existing group's subject, description and/or picture. Changes nothing yet. */
  draftGroupUpdate(req) {
    const s = this.cfg.sending;
    const target = this.store.resolveChat(req.to);
    if (target.kind !== 'group' || !target.known) throw new BridgeError('bad_request', `${target.name || req.to} is not a known group`);
    const update = {};
    if (req.subject !== undefined && req.subject !== null) {
      const subject = String(req.subject).trim();
      if (!subject) throw new BridgeError('bad_request', 'subject is empty');
      if ([...subject].length > 100) throw new BridgeError('bad_request', 'subject is over 100 characters');
      update.subject = subject;
    }
    if (req.description !== undefined && req.description !== null) {
      const description = String(req.description);
      if (description.length > 2048) throw new BridgeError('bad_request', 'description is over 2048 characters');
      update.description = description;
    }
    if (req.picture) update.picture = groupPicture(req.picture);
    if (!Object.keys(update).length) throw new BridgeError('bad_request', 'nothing to change: give subject, description and/or picture');

    const payload = { action: 'group_update', jid: target.jid, ...update };
    const preview = { action: 'group_update', to: { jid: target.jid, name: target.name, kind: 'group', new: false }, update };
    const now = nowSec();
    const token = this.newToken();
    const expiresAt = now + s.draftTtlSec;
    this.store.insertDraft({ token, action: 'group_update', chat: target.jid, payload, preview, createdAt: now, expiresAt });
    this.store.audit('draft', { token, action: 'group_update', chat: target.jid, fields: Object.keys(update) });
    this.log.info('draft_created', { token, action: 'group_update', chat: target.jid });
    return { token, expiresAt, preview, summary: renderPreview(preview, token, expiresAt) };
  }

  /** Apply a confirmed group_update. Every field is attempted; the draft fails only if none of them took. */
  async updateGroup(p) {
    const changed = [];
    const warnings = [];
    if (p.subject !== undefined) {
      try { await this.wa.groupSetSubject(p.jid, p.subject); changed.push('subject'); } catch (e) { warnings.push(`subject: ${e.message}`); }
    }
    if (p.description !== undefined) {
      try { await this.wa.groupSetDescription(p.jid, p.description); changed.push('description'); } catch (e) { warnings.push(`description: ${e.message}`); }
    }
    if (p.picture) {
      try { await this.wa.groupSetPicture(p.jid, p.picture.path); changed.push('picture'); } catch (e) { warnings.push(`picture: ${e.message}`); }
    }
    if (!changed.length) throw new BridgeError('send_failed', warnings.join('; ') || 'nothing changed');
    if (this.wa.refreshGroup) await this.wa.refreshGroup(p.jid);
    return { group: p.jid, changed, warnings };
  }

  /**
   * Create the group of a confirmed draft. The group itself must be created or the draft fails; the follow-up steps
   * (description, picture, admins, invite link for anyone WhatsApp would not let us add) report warnings instead,
   * because by then the group exists and a retry would create a second one.
   */
  async createGroup(p) {
    const jids = [];
    const notOnWhatsApp = [];
    for (const d of p.participants) {
      const r = await this.wa.onWhatsApp(d);
      if (r?.exists) jids.push(bareJid(r.jid) || `${d}@s.whatsapp.net`);
      else notOnWhatsApp.push(d);
    }
    if (!jids.length) throw new BridgeError('not_on_whatsapp', 'none of the participants is on WhatsApp');

    const created = await this.wa.groupCreate(p.subject, jids);
    const gid = created?.id;
    if (!gid) throw new BridgeError('send_failed', 'WhatsApp returned no group id');
    const warnings = [];
    const fresh = (this.wa.refreshGroup ? await this.wa.refreshGroup(gid) : null) || created;
    const inGroup = new Set((fresh.participants || []).flatMap((x) => [x.id, x.phoneNumber].filter(Boolean).map(jidUser)));
    const wanted = jids.map(jidUser);
    const added = wanted.filter((d) => inGroup.has(d));
    const notAdded = wanted.filter((d) => !inGroup.has(d));

    if (p.description) {
      try { await this.wa.groupSetDescription(gid, p.description); } catch (e) { warnings.push(`description: ${e.message}`); }
    }
    if (p.picture) {
      try { await this.wa.groupSetPicture(gid, p.picture.path); } catch (e) { warnings.push(`picture: ${e.message}`); }
    }
    let promoted = [];
    const toPromote = p.admins.filter((d) => added.includes(d));
    if (toPromote.length) {
      try {
        const res = await this.wa.groupPromote(gid, toPromote.map((d) => `${d}@s.whatsapp.net`));
        promoted = (res || []).map((x) => ({ number: jidUser(x.jid), status: x.status }));
      } catch (e) { warnings.push(`admins: ${e.message}`); }
    }
    let invite = null;
    if (notAdded.length) {
      try { invite = `https://chat.whatsapp.com/${await this.wa.groupInviteCode(gid)}`; } catch (e) { warnings.push(`invite link: ${e.message}`); }
    }
    if (this.wa.refreshGroup) await this.wa.refreshGroup(gid);
    return { group: gid, subject: p.subject, added, notAdded, notOnWhatsApp, promoted, invite, warnings };
  }

  targetMessage(chat, id) {
    if (!id) throw new BridgeError('bad_request', 'a message id is required');
    const row = this.store.getMessageRow(chat, id);
    if (!row || row.chat_jid !== this.store.canonical(chat)) throw new BridgeError('not_found', `message ${id} is not in this chat`);
    return row;
  }

  describeTarget(row) {
    return {
      id: row.id,
      ts: row.ts,
      from: row.from_me ? 'me' : this.store.displayName(row.sender_jid),
      excerpt: truncate(row.text || `<${row.kind}>`, 140),
    };
  }

  /** Step 2: send a pending draft. */
  async confirm(tokenIn) {
    const token = String(tokenIn || '').trim().toUpperCase();
    this.store.expireDrafts();
    const d = this.store.getDraft(token);
    if (!d) throw new BridgeError('not_found', `no draft ${token}`);
    if (d.status !== 'draft') throw new BridgeError('not_pending', `draft ${token} is ${d.status}`);
    const s = this.cfg.sending;
    if (!s.enabled) throw new BridgeError('sending_disabled', 'sending is switched off (config.json: sending.enabled)');
    const now = nowSec();
    if (this.store.countSentSince(now - 60) >= s.maxPerMinute) throw new BridgeError('rate_limited', `more than ${s.maxPerMinute} sends in the last minute`);
    if (this.store.countSentSince(now - 86400) >= s.maxPerDay) throw new BridgeError('rate_limited', `more than ${s.maxPerDay} sends in the last day`);
    this.wa.requireOpen();
    if (!this.store.transitionDraft(token, 'draft', 'sending')) throw new BridgeError('not_pending', `draft ${token} was already taken`);

    const p = d.payload;
    if (p.action === 'group_create' || p.action === 'group_update') {
      try {
        const creating = p.action === 'group_create';
        const res = creating ? await this.createGroup(p) : await this.updateGroup(p);
        this.store.transitionDraft(token, 'sending', 'sent', { doneAt: nowSec(), sentId: res.group });
        if (creating) this.store.audit('group_created', { token, group: res.group, added: res.added.length, notAdded: res.notAdded, notOnWhatsApp: res.notOnWhatsApp, warnings: res.warnings });
        else this.store.audit('group_updated', { token, group: res.group, changed: res.changed, warnings: res.warnings });
        this.log.info(creating ? 'group_created' : 'group_updated', { token, group: res.group });
        return { token, status: 'sent', action: p.action, chat: res.group, id: res.group, ...res };
      } catch (e) {
        this.store.transitionDraft(token, 'sending', 'failed', { doneAt: nowSec(), error: e.message });
        this.store.audit('send_failed', { token, action: p.action, error: e.message });
        this.log.error('send_failed', { token, action: p.action, error: e });
        if (e instanceof BridgeError) throw e;
        throw new BridgeError('send_failed', e.message);
      }
    }
    try {
      let jid = p.jid;
      if (p.newChat) {
        const r = await this.wa.onWhatsApp(jidUser(jid));
        if (!r?.exists) throw new BridgeError('not_on_whatsapp', `${jidUser(jid)} is not on WhatsApp`);
        jid = bareJid(r.jid) || jid;
      }
      const { content, options } = await this.build(p, token);
      const sent = await this.wa.send(jid, content, options);
      if (sent && this.ingest) this.ingest.message(sent, { live: true });
      const sentId = sent?.key?.id || null;
      this.store.transitionDraft(token, 'sending', 'sent', { doneAt: nowSec(), sentId });
      this.store.audit('sent', { token, action: p.action, chat: jid, id: sentId });
      this.log.info('sent', { token, action: p.action, chat: jid, id: sentId });
      return { token, status: 'sent', action: p.action, chat: jid, id: sentId, ts: toNum(sent?.messageTimestamp) };
    } catch (e) {
      this.store.transitionDraft(token, 'sending', 'failed', { doneAt: nowSec(), error: e.message });
      this.store.audit('send_failed', { token, action: p.action, chat: p.jid, error: e.message });
      this.log.error('send_failed', { token, action: p.action, chat: p.jid, error: e });
      if (e instanceof BridgeError) throw e;
      throw new BridgeError('send_failed', e.message);
    }
  }

  /**
   * The one unattended path (config: sending.selfUnattended; vault decision 2026-09-27-wa-self-alerts): text to
   * the linked account's OWN chat only. It never reads a recipient from the request, labels every message with its
   * source so an automated message is always recognisable, and goes through draft + confirm internally, so the
   * rate limits, the store record and the audit trail are the same as any other send.
   */
  async sendSelf(req = {}) {
    const s = this.cfg.sending;
    if (!s.selfUnattended) throw new BridgeError('forbidden', 'unattended self-chat sends are off (config.json: sending.selfUnattended)');
    const me = this.wa.status()?.me?.pn;
    if (!me) throw new BridgeError('not_connected', 'the linked account is not known yet (not linked, or not open)');
    const source = String(req.source ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(source)) throw new BridgeError('bad_request', 'source must be a short lowercase label such as vault-health');
    const body = String(req.text ?? '').trim();
    if (!body) throw new BridgeError('bad_request', 'text is empty');
    const d = this.draft({ action: 'text', to: me, text: `[${source}] ${body}` });
    this.store.audit('self_unattended', { token: d.token, source });
    return this.confirm(d.token);
  }

  cancel(tokenIn) {
    const token = String(tokenIn || '').trim().toUpperCase();
    if (!this.store.transitionDraft(token, 'draft', 'cancelled', { doneAt: nowSec() })) {
      const d = this.store.getDraft(token);
      throw new BridgeError(d ? 'not_pending' : 'not_found', d ? `draft ${token} is ${d.status}` : `no draft ${token}`);
    }
    this.store.audit('cancelled', { token });
    return { token, status: 'cancelled' };
  }

  list(status = 'draft') {
    this.store.expireDrafts();
    return this.store.listDrafts({ status: status === 'all' ? null : status });
  }

  async build(p, token) {
    const options = {};
    if (p.replyTo) {
      const q = decodeRaw(this.store.getMessageRow(p.jid, p.replyTo));
      if (!q) throw new BridgeError('send_failed', 'the quoted message disappeared from the store');
      options.quoted = q;
    }
    switch (p.action) {
      case 'text':
        return { content: { text: p.text }, options };
      case 'media': {
        const caption = p.caption || undefined;
        if (p.as === 'image') return { content: { image: { url: p.path }, caption, mimetype: p.mime }, options };
        if (p.as === 'video') return { content: { video: { url: p.path }, caption, mimetype: p.mime }, options };
        if (p.as === 'audio') return { content: { audio: { url: p.path }, mimetype: p.mime }, options };
        if (p.as === 'voice') {
          const opus = await this.convertVoice(p.path, join(this.cfg.paths.outgoing, `${token}.ogg`));
          return { content: { audio: { url: opus }, ptt: true, mimetype: 'audio/ogg; codecs=opus' }, options };
        }
        return { content: { document: { url: p.path }, mimetype: p.mime, fileName: p.fileName, caption }, options };
      }
      case 'react': {
        const t = this.store.getMessageRow(p.jid, p.messageId);
        return { content: { react: { text: p.emoji, key: storedKey(t) } }, options: {} };
      }
      case 'delete': {
        const t = this.store.getMessageRow(p.jid, p.messageId);
        return { content: { delete: storedKey(t) }, options: {} };
      }
      default:
        throw new BridgeError('bad_request', `unknown action ${p.action}`);
    }
  }
}

/** Voice notes must be Opus in Ogg. Convert with ffmpeg unless the file already is. */
export function toOpus(src, out) {
  const ext = extname(src).toLowerCase();
  if (ext === '.ogg' || ext === '.opus') return Promise.resolve(src);
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000', out],
      { windowsHide: true, timeout: 120_000 },
      (err) => (err ? reject(new BridgeError('send_failed', `voice conversion failed: ${err.message}`)) : resolve(out)));
  });
}

/** Validate a group icon: an existing .jpg/.jpeg/.png file within the size limit. */
export function groupPicture(pathIn) {
  const path = String(pathIn);
  if (!existsSync(path)) throw new BridgeError('bad_request', `picture not found: ${path}`);
  const st = statSync(path);
  if (!st.isFile()) throw new BridgeError('bad_request', `not a file: ${path}`);
  if (!GROUP_PICTURE_EXT.has(extname(path).toLowerCase())) throw new BridgeError('bad_request', 'picture must be .jpg, .jpeg or .png');
  if (st.size > GROUP_PICTURE_MAX_BYTES) throw new BridgeError('bad_request', `picture is ${st.size} bytes; the limit is ${GROUP_PICTURE_MAX_BYTES}`);
  return { path, bytes: st.size };
}

export function renderPreview(pv, token, expiresAt) {
  const lines = [];
  const to = pv.to;
  lines.push(`To:       ${to.name} (${to.kind}, ${to.jid})${to.new ? '  ⚠ NEW — never messaged before' : ''}`);
  const verb = { text: 'Send text', media: 'Send file', react: 'React', delete: 'Delete for everyone', group_create: 'Create group', group_update: 'Change group' }[pv.action] || pv.action;
  lines.push(`Action:   ${verb}`);
  if (pv.update) {
    const u = pv.update;
    if (u.subject !== undefined) lines.push(`New name: ${u.subject}`);
    if (u.description !== undefined) {
      lines.push('New about:');
      for (const l of String(u.description).split('\n')) lines.push(`  │ ${l}`);
    }
    if (u.picture) lines.push(`New icon: ${basename(u.picture.path)}, ${u.picture.bytes} bytes`);
  }
  if (pv.group) {
    const g = pv.group;
    lines.push(`Subject:  ${g.subject}`);
    if (g.description) {
      lines.push('About:');
      for (const l of String(g.description).split('\n')) lines.push(`  │ ${l}`);
    }
    if (g.picture) lines.push(`Picture:  ${basename(g.picture.path)}, ${g.picture.bytes} bytes`);
    lines.push(`Members:  ${g.participants.length} + you`);
    for (const m of g.participants) lines.push(`  · ${m.name} (+${m.number})${m.admin ? '  [admin]' : ''}${m.new ? '  ⚠ NEW' : ''}`);
  }
  if (pv.replyTo) lines.push(`Reply to: [${formatTs(pv.replyTo.ts)}] ${pv.replyTo.from}: ${pv.replyTo.excerpt}`);
  if (pv.target) lines.push(`Message:  [${formatTs(pv.target.ts)}] ${pv.target.from}: ${pv.target.excerpt}`);
  if (pv.emoji) lines.push(`Emoji:    ${pv.emoji}`);
  if (pv.media) lines.push(`File:     ${pv.media.fileName} as ${pv.media.as}, ${pv.media.bytes} bytes`);
  if (pv.caption) lines.push(`Caption:  ${pv.caption}`);
  if (pv.text !== undefined) {
    lines.push('Text:');
    for (const l of String(pv.text).split('\n')) lines.push(`  │ ${l}`);
  }
  if (token) lines.push(`Token:    ${token}  (expires ${formatTs(expiresAt)})`);
  return lines.join('\n');
}
