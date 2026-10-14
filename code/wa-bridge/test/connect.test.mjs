// `wa connect` end to end against a scripted fake API: QR drawing and rotation, pairing codes, the non-terminal
// paths agents hit, consent, recovery hints, and the hand-off to the agents step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectCommand } from '../src/cli/connect.mjs';

const P1 = '2@' + 'A'.repeat(88) + ',' + 'B'.repeat(44) + ',' + 'C'.repeat(44) + ',' + 'D'.repeat(44);
const P2 = '2@' + 'E'.repeat(88) + ',' + 'F'.repeat(44) + ',' + 'G'.repeat(44) + ',' + 'H'.repeat(44);
const exp = Math.floor(Date.now() / 1000) + 300;
const ME = { pn: '15550100001@s.whatsapp.net', lid: null, name: 'Owner' };
const UNLINKED = { state: 'unlinked', linked: false, me: null, sync: { chunks: 0 } };
const OPEN = { state: 'open', linked: true, me: ME, sync: { chunks: 1, messages: 12 }, stats: { messages: 12 } };

function harness({ health = UNLINKED, postLink, linkSeq = [], tty = true, cols = 100, rows = 50, consent = true } = {}) {
  const calls = [];
  const out = [];
  const offered = [];
  let hi = 0;
  let li = 0;
  const deps = {
    startDaemon: async () => { calls.push('startDaemon'); },
    call: async (method, path, body) => {
      calls.push(`${method} ${path}`);
      if (path === '/health') return Array.isArray(health) ? health[Math.min(hi++, health.length - 1)] : health;
      if (method === 'POST' && path === '/link') { calls.push(body); return postLink; }
      if (method === 'GET' && path === '/link') return linkSeq[Math.min(li++, linkSeq.length - 1)];
      if (path === '/resume' || path === '/link/cancel') return {};
      throw new Error(`unexpected ${method} ${path}`);
    },
    out: (s) => out.push(s),
    isTTY: tty,
    size: () => ({ cols, rows }),
    confirm: async () => consent,
    offerAgents: async (flags, ctx) => { offered.push(flags); ctx.line('AGENTS STEP'); return 0; },
    onInterrupt: () => () => {},
    sleep: async () => {},
    pollMs: 0,
    syncWaitMs: 0,
  };
  return { deps, calls, offered, text: () => out.join('') };
}

const linking = (extra) => ({ state: 'linking', linked: false, method: 'qr', expiresAt: exp, ...extra });

test('QR: drawn in the terminal, redrawn when WhatsApp rotates it, then linked and handed to the agents step', async () => {
  const h = harness({
    health: [UNLINKED, OPEN],
    postLink: linking({ qr: { at: 1, data: P1, path: '/x/link-qr.png' } }),
    linkSeq: [
      linking({ qr: { at: 1, data: P1 } }),
      linking({ qr: { at: 2, data: P2 } }),
      { ...linking({ qr: { at: 2, data: P2 } }), linked: true, state: 'connecting' },
      { state: 'open', linked: true, method: null },
    ],
  });
  const code = await connectCommand([], {}, h.deps);
  const text = h.text();
  assert.equal(code, 0);
  assert.equal(text.split('Scan with WhatsApp on your phone').length - 1, 2, 'one draw per QR rotation');
  assert.match(text, /\x1b\[47m\x1b\[30m/, 'the QR itself is in the output');
  assert.match(text, /Scanned — finishing the link/);
  assert.match(text, /✓ Linked as \+15550100001 \(Owner\)/);
  assert.match(text, /History sync started: 12 messages/);
  assert.match(text, /AGENTS STEP/);
  assert.match(text, /WA Bridge links an unofficial WhatsApp client/, 'consent was shown');
});

test('the link window closing before the scan is reported, exit 1', async () => {
  const h = harness({ postLink: linking({ qr: { at: 1, data: P1 } }), linkSeq: [{ state: 'unlinked', linked: false, method: null }] });
  assert.equal(await connectCommand([], {}, h.deps), 1);
  assert.match(h.text(), /link window closed before the phone finished/);
  assert.equal(h.offered.length, 0);
});

test('WhatsApp refusing to issue a code is reported with its reason', async () => {
  const h = harness({ postLink: { state: 'unlinked', linked: false, method: null, error: 'WhatsApp closed the connection before issuing a QR or code (code 428), 3 times' } });
  assert.equal(await connectCommand([], {}, h.deps), 1);
  assert.match(h.text(), /Link failed: WhatsApp closed the connection .* 3 times/);
});

test('no terminal (an agent ran it): no QR, no link window, a clear way forward', async () => {
  const h = harness({ tty: false });
  assert.equal(await connectCommand([], {}, h.deps), 1);
  assert.match(h.text(), /needs a terminal/);
  assert.match(h.text(), /! wa connect/);
  assert.match(h.text(), /wa connect --code/);
  assert.ok(!h.calls.includes('POST /link'));
});

test('pairing code without a terminal: prints the code and returns, the window stays open', async () => {
  const h = harness({ tty: false, postLink: { state: 'linking', linked: false, method: 'code', expiresAt: exp, pairingCode: { code: 'ABCD1234', at: 1 } } });
  assert.equal(await connectCommand([], { code: '+1 555 010 0001', yes: true }, h.deps), 0);
  assert.match(h.text(), /Pairing code: ABCD-1234/);
  assert.match(h.text(), /Link with phone number instead/);
  assert.deepEqual(h.calls.find((c) => typeof c === 'object'), { method: 'code', phone: '+1 555 010 0001' });
});

test('already linked: skips straight to the agents step', async () => {
  const h = harness({ health: OPEN });
  assert.equal(await connectCommand([], {}, h.deps), 0);
  assert.match(h.text(), /Already linked as \+15550100001/);
  assert.ok(!h.calls.includes('POST /link'));
  assert.equal(h.offered.length, 1);
});

test('consent declined: nothing is linked', async () => {
  const h = harness({ consent: false });
  assert.equal(await connectCommand([], {}, h.deps), 1);
  assert.match(h.text(), /Cancelled; nothing was linked/);
  assert.ok(!h.calls.includes('POST /link'));
});

test('linked but replaced by another client: explains and points at the local reset', async () => {
  const h = harness({ health: { state: 'replaced', linked: true, me: ME } });
  assert.equal(await connectCommand([], {}, h.deps), 1);
  assert.match(h.text(), /another program took over/);
  assert.match(h.text(), /wa disconnect --local/);
});

test('a terminal too small for the QR gets the image path and the pairing-code alternative', async () => {
  const h = harness({
    cols: 40,
    health: [UNLINKED, OPEN],
    postLink: linking({ qr: { at: 1, data: P1, path: '/data/link-qr.png' } }),
    linkSeq: [{ state: 'open', linked: true, method: null }],
  });
  assert.equal(await connectCommand([], { 'no-agents': true }, h.deps), 0);
  assert.match(h.text(), /too small for the QR/);
  assert.match(h.text(), /\/data\/link-qr\.png/);
  assert.ok(!h.text().includes('Scan with WhatsApp on your phone'));
  assert.match(h.text(), /wa agents add all/, '--no-agents prints the follow-up instead');
  assert.equal(h.offered.length, 0);
});
