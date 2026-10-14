#!/usr/bin/env node
// Create a release signing key pair.
//   node scripts/keygen.mjs <private-key-file>
// Writes the PEM private key to <private-key-file> (mode 0600, refuses to overwrite) and prints the public key
// (base64, raw 32 bytes) to put into src/release.mjs TRUSTED_KEYS and install/install.sh PUBKEY.
// Keep the private key out of the repo: store it as the GitHub Actions secret WA_BRIDGE_SIGNING_KEY.

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { rawPublicKey } from '../src/release.mjs';

const out = process.argv[2];
if (!out) { console.error('usage: node scripts/keygen.mjs <private-key-file>'); process.exit(2); }
if (existsSync(out)) { console.error(`${out} exists; refusing to overwrite a signing key`); process.exit(1); }
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(out, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
console.log(rawPublicKey(publicKey));
