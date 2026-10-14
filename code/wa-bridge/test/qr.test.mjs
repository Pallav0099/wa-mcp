// The terminal QR must be a faithful picture of the code: render, read it back, compare module by module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { qrMatrix, renderQr, decodeRendered, pickMargin, qrDimensions } from '../src/cli/qr.mjs';

// shaped like WhatsApp's multi-device payload: ref,noiseKey,identityKey,advSecret
const b64 = (n) => randomBytes(n).toString('base64');
const PAYLOAD = ['2@' + b64(66).replace(/[+/=]/g, 'A'), b64(32), b64(32), b64(32)].join(',');

test('rendered half blocks decode back to the exact QR matrix, for every margin', () => {
  const want = qrMatrix(PAYLOAD);
  for (const margin of [4, 2, 1]) {
    const r = renderQr(PAYLOAD, { margin });
    assert.equal(r.lines.length, r.rows);
    const got = decodeRendered(r.lines, margin);
    assert.equal(got.size, want.size, `margin ${margin}: size`);
    assert.deepEqual(got.data, Array.from(want.data, (b) => (b ? 1 : 0)), `margin ${margin}: modules`);
  }
});

test('the quiet zone is as wide as the terminal allows, or null when it does not fit', () => {
  const { size } = qrMatrix(PAYLOAD); // 53 modules at ECC L
  assert.equal(size, 53);
  assert.equal(pickMargin(size, { cols: 80, rows: 40, reserveRows: 6 }), 4);
  const m2 = qrDimensions(size, 2);
  assert.equal(pickMargin(size, { cols: m2.cols, rows: m2.rows + 6, reserveRows: 6 }), 2);
  assert.equal(pickMargin(size, { cols: 40, rows: 60, reserveRows: 6 }), null, 'too narrow');
  assert.equal(pickMargin(size, { cols: 120, rows: 20, reserveRows: 6 }), null, 'too short');
});

test('every line is drawn black-on-white so dark terminal themes do not invert it', () => {
  for (const l of renderQr(PAYLOAD, { margin: 2 }).lines) assert.match(l, /^\x1b\[47m\x1b\[30m.*\x1b\[0m$/);
});
