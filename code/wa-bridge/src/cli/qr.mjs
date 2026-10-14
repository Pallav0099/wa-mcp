// Draw a QR code in the terminal with half-block characters (two modules per character row).
//
// Our own renderer instead of qrcode's terminal mode: that one leaves a 1-module quiet zone, and on a dark
// terminal everything past it is dark, which phone scanners dislike. Here the quiet zone is as wide as the
// terminal allows (4 modules per the QR spec, else 2, else 1), always drawn black-on-white so the theme
// does not matter.

import QRCode from 'qrcode';

const WHITE_BG_BLACK_FG = '\x1b[47m\x1b[30m';
const RESET = '\x1b[0m';
const MARGINS = [4, 2, 1];

export function qrMatrix(data) {
  const { modules } = QRCode.create(String(data), { errorCorrectionLevel: 'L' });
  return { size: modules.size, data: modules.data };
}

/** The rendered size for a margin: columns x rows. */
export function qrDimensions(size, margin) {
  const side = size + 2 * margin;
  return { cols: side, rows: Math.ceil(side / 2) };
}

/** The widest quiet zone that fits, or null when even a 1-module margin does not fit the terminal. */
export function pickMargin(size, { cols, rows, reserveRows = 0 }) {
  for (const m of MARGINS) {
    const d = qrDimensions(size, m);
    if (d.cols <= cols && d.rows + reserveRows <= rows) return m;
  }
  return null;
}

/** Render data as lines of half blocks. Dark module = black, so █ is dark-over-dark. */
export function renderQr(data, { margin = 4 } = {}) {
  const { size, data: bits } = qrMatrix(data);
  const dark = (x, y) => x >= 0 && y >= 0 && x < size && y < size && !!bits[y * size + x];
  const lines = [];
  for (let y = -margin; y < size + margin; y += 2) {
    let line = '';
    for (let x = -margin; x < size + margin; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < size + margin && dark(x, y + 1);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(WHITE_BG_BLACK_FG + line + RESET);
  }
  return { lines, size, margin, ...qrDimensions(size, margin) };
}

/** Inverse of renderQr, for tests: rendered lines back to the module matrix (margin removed). */
export function decodeRendered(lines, margin) {
  const rows = [];
  for (const raw of lines) {
    const chars = [...raw.replace(/\x1b\[[0-9;]*m/g, '')];
    rows.push(chars.map((c) => c === '█' || c === '▀'));
    rows.push(chars.map((c) => c === '█' || c === '▄'));
  }
  const side = rows[0].length;
  const size = side - 2 * margin;
  const out = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out.push(rows[y + margin][x + margin] ? 1 : 0);
  return { size, data: out };
}
