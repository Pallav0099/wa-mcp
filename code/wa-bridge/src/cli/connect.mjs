// `wa connect`: get from "installed" to "linked and usable by my agents" in one command.
//
//   consent → daemon running → link window → QR drawn in the terminal (or a pairing code) → linked
//   → first history chunk → offer to add the MCP server + skill to the agents found on this machine.
//
// Every dependency is injectable so the whole flow runs in tests against a fake API.

import { call as apiCall } from '../client.mjs';
import { formatTs, jidUser } from '../util.mjs';
import { UNIT_NAME } from '../service.mjs';
import { bringUp } from './servicecmd.mjs';
import { confirm as askConfirm } from './prompt.mjs';
import { pickMargin, qrMatrix, qrDimensions, renderQr } from './qr.mjs';

const CONSENT = [
  'WA Bridge links an unofficial WhatsApp client to your number as a linked device (WhatsApp may restrict',
  'accounts that use unofficial clients; the risk is small for personal, human-approved use).',
  'Agents you connect can read your chats. Nothing is sent until you approve the exact preview.',
].join('\n');
const HEADER_ROWS = 2;
const FOOTER_ROWS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const who = (me) => (me ? `+${jidUser(me.pn) || jidUser(me.lid)}${me.name ? ` (${me.name})` : ''}` : 'this account');

function defaults() {
  return {
    call: apiCall,
    startDaemon: (flags) => bringUp({ service: !flags['no-service'] }),
    out: (s) => process.stdout.write(s),
    isTTY: !!process.stdout.isTTY,
    size: () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
    confirm: askConfirm,
    offerAgents: async (flags, ctx) => (await import('./agents/index.mjs')).offerAgents(flags, ctx),
    onInterrupt: (fn) => { process.once('SIGINT', fn); return () => process.off('SIGINT', fn); },
    sleep,
    pollMs: 1000,
    syncWaitMs: 30_000,
  };
}

/** Returns the process exit code. */
export async function connectCommand(pos, flags, deps = {}) {
  const d = { ...defaults(), ...deps };
  const line = (s = '') => d.out(s + '\n');
  const method = flags.code ? 'code' : 'qr';

  const up = await d.startDaemon(flags);
  if (up?.via === 'systemd') line(`✓ Background service running (systemd --user: ${UNIT_NAME}${up.unitCreated ? ', starts at login' : ''})`);
  else if (up?.via === 'detached') line(`✓ Running in the background (${flags['no-service'] ? 'not as a service' : 'no systemd user session'}: after a reboot run wa start)`);
  let h = await d.call('GET', '/health');

  if (h.linked) {
    if (h.state === 'paused') { await d.call('POST', '/resume'); h = await waitForOpen(d, 20_000); }
    else if (h.state !== 'open') h = await waitForOpen(d, 20_000);
    if (h.state === 'open') {
      line(`✓ Already linked as ${who(h.me)}`);
      return afterLinked(d, flags, line, h);
    }
    return explainStuck(h, line);
  }

  if (!d.isTTY && method === 'qr') {
    line('wa connect shows a QR code, which needs a terminal. Run it yourself in a terminal');
    line('(in Claude Code: type  ! wa connect ), or link with a pairing code instead:');
    line('  wa connect --code <your number with country code, e.g. 15550100001>');
    return 1;
  }

  if (!flags.yes) {
    line(CONSENT);
    const ok = await d.confirm('Continue?');
    if (ok === null) {
      line('Cannot ask for consent without a terminal; re-run with --yes to accept.');
      return 1;
    }
    if (!ok) { line('Cancelled; nothing was linked.'); return 1; }
  }

  let cancelled = false;
  const stopListening = d.onInterrupt(() => { // before POST /link: it can wait up to 30 s for the first QR
    cancelled = true;
    d.call('POST', '/link/cancel').catch(() => {}).finally(() => { line('\nCancelled; the link window is closed.'); process.exit(130); });
  });

  try {
    let st = await d.call('POST', '/link', method === 'code' ? { method, phone: flags.code } : { method });
    if (method === 'code' && !d.isTTY && !flags.wait) {
      // An agent or script: hand over the code and return; the daemon keeps the window open.
      if (st.error) { line(`link failed: ${st.error}`); return 1; }
      if (!st.pairingCode) { line(`state ${st.state}; no pairing code yet — check with: wa link-status`); return 1; }
      line(pairingText(st));
      line('Check progress with: wa status');
      return 0;
    }

    let shownQrAt = null;
    let shownCode = false;
    let tooSmallNoted = false;
    let saidLinking = false;
    const deadline = (st.expiresAt ? st.expiresAt * 1000 : Date.now() + 300_000) + 30_000;
    for (;;) {
      if (cancelled) return 130;
      if (st.linked && st.state === 'open') break;
      if (st.error) { line(`\n✗ Link failed: ${st.error}`); line('Try again with: wa connect   (or: wa connect --code <number>)'); return 1; }
      if (!st.method && !st.linked) {
        line('\n✗ The link window closed before the phone finished linking. Run wa connect again.');
        return 1;
      }
      if (st.pairingCode && !shownCode) { line(pairingText(st)); shownCode = true; }
      if (method === 'qr' && st.qr?.data && st.qr.at !== shownQrAt) {
        shownQrAt = st.qr.at;
        const drawn = drawQr(d, st);
        if (!drawn && !tooSmallNoted) {
          const need = qrDimensions(qrMatrix(st.qr.data).size, 1);
          line(`This terminal is too small for the QR (needs about ${need.cols}×${need.rows + HEADER_ROWS + FOOTER_ROWS}).`);
          line(`Enlarge it${st.qr.path ? `, open the image ${st.qr.path},` : ''} or use: wa connect --code <number>`);
          tooSmallNoted = true;
        }
      }
      if (st.linked && !saidLinking) { line('Scanned — finishing the link…'); saidLinking = true; }
      if (Date.now() > deadline) { line('\n✗ Timed out waiting for the phone.'); return 1; }
      await d.sleep(d.pollMs);
      st = await d.call('GET', '/link');
    }
  } finally {
    stopListening();
  }

  h = await d.call('GET', '/health');
  if (d.isTTY && method === 'qr') d.out('\x1b[2J\x1b[H');
  line(`✓ Linked as ${who(h.me)}`);
  await waitForFirstSync(d, line);
  return afterLinked(d, flags, line, h);
}

function drawQr(d, st) {
  const { cols, rows } = d.size();
  const { size } = qrMatrix(st.qr.data);
  const margin = pickMargin(size, { cols, rows, reserveRows: HEADER_ROWS + FOOTER_ROWS });
  if (margin === null) return false;
  const { lines } = renderQr(st.qr.data, { margin });
  d.out('\x1b[2J\x1b[H');
  d.out('Scan with WhatsApp on your phone: Settings → Linked devices → Link a device\n\n');
  d.out(lines.join('\n') + '\n\n');
  d.out(`The code refreshes about every 20 s · window closes ${formatTs(st.expiresAt)} · Ctrl-C to cancel\n`);
  d.out('No camera? Use a pairing code instead: wa connect --code <your number with country code>\n');
  return true;
}

function pairingText(st) {
  const c = st.pairingCode.code;
  return [
    `Pairing code: ${c.slice(0, 4)}-${c.slice(4)}`,
    'On the phone: WhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead" → enter the code.',
    `Window closes ${formatTs(st.expiresAt)} · Ctrl-C to cancel`,
  ].join('\n');
}

async function waitForOpen(d, ms) {
  const until = Date.now() + ms;
  let h = await d.call('GET', '/health');
  while (h.state !== 'open' && ['starting', 'connecting', 'reconnecting'].includes(h.state) && Date.now() < until) {
    await d.sleep(d.pollMs);
    h = await d.call('GET', '/health');
  }
  return h;
}

function explainStuck(h, line) {
  const why = {
    replaced: 'another program took over these WhatsApp credentials (two clients on one link).',
    forbidden: 'WhatsApp refused this account (403).',
    logged_out: 'the phone unlinked this device.',
  }[h.state] || `the connection is "${h.state}"${h.lastDisconnect?.code ? ` (last close code ${h.lastDisconnect.code})` : ''}.`;
  line(`✗ Linked, but not connected: ${why}`);
  if (h.state === 'replaced' || h.state === 'forbidden') {
    line('To start over on this machine: wa disconnect --local, then wa connect');
  } else {
    line('Check with: wa doctor   (the daemon keeps retrying in the background)');
  }
  return 1;
}

async function waitForFirstSync(d, line) {
  const until = Date.now() + d.syncWaitMs;
  let h = await d.call('GET', '/health');
  while (!(h.sync?.chunks > 0) && Date.now() < until) {
    await d.sleep(d.pollMs);
    h = await d.call('GET', '/health');
  }
  if (h.sync?.chunks > 0) {
    line(`✓ History sync started: ${h.stats?.messages ?? h.sync.messages} messages so far. It continues in the background;`);
    line('  keep your phone online with WhatsApp open for a few minutes.');
  } else {
    line('History sync has not started yet; it continues in the background once the phone sends it.');
  }
}

async function afterLinked(d, flags, line, h) {
  if (flags['no-agents']) {
    line('Add WhatsApp to your agents any time with: wa agents add all');
    return 0;
  }
  return (await d.offerAgents(flags, { line, health: h, confirm: d.confirm })) ?? 0;
}
