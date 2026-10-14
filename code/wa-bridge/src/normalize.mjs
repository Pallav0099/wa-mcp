// Turn one Baileys WAMessage into a flat, storable description.
//
// Pure function of the message: no store, no socket. Everything WhatsApp-shaped is unwrapped here
// (ephemeral / view-once / edited / document-with-caption wrappers) so the rest of the bridge sees
// one uniform record.

import { normalizeMessageContent, getContentType, WAMessageStubType } from '@whiskeysockets/baileys';
import { toNum } from './util.mjs';

const MEDIA = {
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

// Content types that are pure signalling: never stored as a visible message.
const SIGNALLING = new Set([
  'protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'keepInChatMessage',
  'pollUpdateMessage', 'encReactionMessage', 'albumMessage', 'pinInChatMessage', 'encEventResponseMessage',
]);

/**
 * @returns {{
 *   kind: string, text: string|null, quotedId: string|null, quotedSender: string|null,
 *   mentions: string[], media: null|{mime:string|null,name:string|null,size:number|null,seconds:number|null,ptt:boolean},
 *   reaction: null|{targetKey:object, emoji:string},
 *   protocol: null|{type:number, targetId:string|null},
 *   skip: boolean
 * }}
 */
export function describe(msg) {
  const out = {
    kind: 'unknown', text: null, quotedId: null, quotedSender: null, mentions: [],
    media: null, reaction: null, protocol: null, skip: false,
  };
  const content = normalizeMessageContent(msg?.message);

  if (!content) {
    if (msg?.messageStubType) {
      out.kind = 'system';
      out.text = stubText(msg.messageStubType, msg.messageStubParameters);
    } else {
      // No payload and no stub: an undecryptable placeholder or an empty retry shell.
      out.kind = 'undecrypted';
    }
    return out;
  }

  const type = getContentType(content);
  if (!type) { out.skip = true; return out; }
  const body = content[type];

  if (type === 'reactionMessage') {
    out.kind = 'reaction';
    out.reaction = { targetKey: body?.key || null, emoji: body?.text || '' };
    out.skip = true; // stored in the reactions table, not as a message row
    return out;
  }
  if (type === 'protocolMessage') {
    out.kind = 'protocol';
    out.protocol = { type: body?.type ?? null, targetId: body?.key?.id || null };
    out.skip = true; // edits and revokes arrive separately as messages.update
    return out;
  }
  if (SIGNALLING.has(type)) { out.kind = type; out.skip = true; return out; }

  const ctx = body?.contextInfo;
  if (ctx) {
    out.quotedId = ctx.stanzaId || null;
    out.quotedSender = ctx.participant || null;
    out.mentions = Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid.filter(Boolean) : [];
  }

  if (type === 'conversation') {
    out.kind = 'text';
    out.text = typeof body === 'string' ? body : String(body ?? '');
    return out;
  }
  if (type === 'extendedTextMessage') {
    out.kind = 'text';
    out.text = body?.text ?? '';
    return out;
  }
  if (MEDIA[type]) {
    out.kind = MEDIA[type];
    out.text = body?.caption || null;
    out.media = {
      mime: body?.mimetype || null,
      name: body?.fileName || null,
      size: toNum(body?.fileLength),
      seconds: toNum(body?.seconds),
      ptt: !!body?.ptt,
    };
    if (type === 'audioMessage' && body?.ptt) out.kind = 'voice';
    if (type === 'ptvMessage') out.kind = 'video_note';
    return out;
  }
  switch (type) {
    case 'locationMessage':
    case 'liveLocationMessage': {
      out.kind = 'location';
      const label = [body?.name, body?.address].filter(Boolean).join(', ');
      out.text = `📍 ${label ? label + ' ' : ''}(${body?.degreesLatitude}, ${body?.degreesLongitude})`;
      return out;
    }
    case 'contactMessage':
      out.kind = 'contact';
      out.text = `👤 ${body?.displayName || 'contact'}`;
      return out;
    case 'contactsArrayMessage': {
      out.kind = 'contact';
      const names = (body?.contacts || []).map((c) => c?.displayName).filter(Boolean);
      out.text = `👥 ${names.length} contacts: ${names.join(', ')}`;
      return out;
    }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
    case 'pollCreationMessageV5': {
      out.kind = 'poll';
      const opts = (body?.options || []).map((o) => o?.optionName).filter(Boolean);
      out.text = `📊 ${body?.name || 'poll'} — ${opts.join(' / ')}`;
      return out;
    }
    case 'eventMessage':
      out.kind = 'event';
      out.text = `📅 ${body?.name || 'event'}${body?.description ? ' — ' + body.description : ''}`;
      return out;
    case 'buttonsResponseMessage':
      out.kind = 'text';
      out.text = body?.selectedDisplayText || body?.selectedButtonId || '';
      return out;
    case 'listResponseMessage':
      out.kind = 'text';
      out.text = body?.title || body?.singleSelectReply?.selectedRowId || '';
      return out;
    case 'templateButtonReplyMessage':
      out.kind = 'text';
      out.text = body?.selectedDisplayText || '';
      return out;
    case 'groupInviteMessage':
      out.kind = 'invite';
      out.text = `🔗 invite to ${body?.groupName || 'a group'}`;
      return out;
    case 'call':
      out.kind = 'call';
      out.text = '📞 call';
      return out;
    default:
      out.kind = type.replace(/Message$/, '') || 'unknown';
      out.text = typeof body?.text === 'string' ? body.text : (typeof body?.caption === 'string' ? body.caption : null);
      return out;
  }
}

/** Human text for a system (stub) message, e.g. 'group participant add: 1555…@s.whatsapp.net'. */
export function stubText(stubType, params) {
  let name = null;
  if (typeof stubType === 'number') {
    name = WAMessageStubType[stubType];
    if (typeof name !== 'string') {
      name = Object.keys(WAMessageStubType).find((k) => WAMessageStubType[k] === stubType) || null;
    }
  }
  const label = (name || `stub ${stubType}`).toLowerCase().replace(/_/g, ' ');
  const p = Array.isArray(params) && params.length ? `: ${params.join(', ')}` : '';
  return `⚙ ${label}${p}`;
}

export const REVOKE_STUB = WAMessageStubType.REVOKE;
