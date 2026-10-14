// The original WAMessage is kept as protobuf bytes (+ the key as JSON, because Baileys adds key fields
// such as remoteJidAlt that are not part of the proto). It is what lets the bridge later quote a message,
// react to it, delete it, answer a retry request, or download its media.

import { proto } from '@whiskeysockets/baileys';

export function encodeRaw(msg) {
  try {
    return proto.WebMessageInfo.encode(msg).finish();
  } catch {
    return null;
  }
}

export function keyJson(key) {
  const k = {};
  for (const f of ['remoteJid', 'remoteJidAlt', 'fromMe', 'id', 'participant', 'participantAlt', 'addressingMode']) {
    if (key?.[f] !== undefined && key[f] !== null) k[f] = key[f];
  }
  return JSON.stringify(k);
}

/** Rebuild a WAMessage from a stored row (needs row.raw and row.key_json). */
export function decodeRaw(row) {
  if (!row?.raw) return null;
  const msg = proto.WebMessageInfo.decode(row.raw instanceof Uint8Array ? row.raw : new Uint8Array(row.raw));
  msg.key = { ...(msg.key || {}), ...JSON.parse(row.key_json || '{}') };
  return msg;
}

export function storedKey(row) {
  return JSON.parse(row.key_json || '{}');
}
