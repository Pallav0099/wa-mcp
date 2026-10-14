# M0 spike notes (2026-10-14)

Run on Linux x86_64 (glibc 2.44) with the official nodejs.org tarballs, SHA-256 verified.

## Baseline

- `npm ci` + `npm test`: **53 pass, 0 fail** on Node **v24.21.0** and on **v22.23.2**.
- Node pin for the product: **v24.21.0** (Krypton LTS, released 2026-09-07; v24.22.0 was a same-day
  release at the time and was skipped). Node 22 stays in the CI matrix until it is dropped.

## Native code

- `find node_modules -name '*.node'` → only `@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.4.node`.
  sharp is a required peer of Baileys and is kept, so release tarballs are built per CPU architecture
  (linux-x64, linux-arm64) on matching runners. CI fails if any other `.node` file appears.
- `whatsapp-rust-bridge` 0.5.4: Rust compiled to WebAssembly, bytes inlined in `dist/index.js`
  (wasm-bindgen output). Platform-independent.
- Install scripts (`@whiskeysockets/baileys` preinstall = engine check, `protobufjs` postinstall) run
  only at build time; users receive a prebuilt `node_modules`.
- `node_modules` size: 51 MB (19 MB of it sharp/libvips). The Node 24 binary alone is 121 MB.

## Terminal QR

Payload shaped like WhatsApp's (ref + three base64 keys, 225 chars), rendered with
`QRCode.toString(data, { type: 'terminal', small: true, errorCorrectionLevel })` from qrcode 1.5.4:

| ECC | QR version | Modules | Terminal size |
|---|---|---|---|
| L | 9 | 53 | 29 rows × 55 cols |
| M | 11 | 61 | 33 rows × 63 cols |

ECC **L** is used. The renderer wraps every line in ANSI white background / black foreground, so it
works in dark themes. `wa connect` needs about 57 columns × 35 rows (QR plus instructions) and falls
back to the PNG path and the `--code` hint in smaller terminals.

The product draws the QR with its own renderer (`src/cli/qr.mjs`), using `QRCode.create()`'s module matrix,
because qrcode's terminal mode leaves only a 1-module quiet zone. The quiet zone is 4 modules when the terminal
allows (else 2, else 1), and every line is black on white.

**Live check (2026-10-14).** A real daemon on Node v24.21.0 opened a link window. WhatsApp issued a QR about
1 s later. `wa connect` drew it in a 100×50 PTY with the 4-module margin, and Ctrl-C closed the window
(`state linking → unlinked, reason cancelled`). Nothing was linked.

**Pending (needs a phone):** an actual scan in kitty, GNOME Terminal, Konsole and tmux.
