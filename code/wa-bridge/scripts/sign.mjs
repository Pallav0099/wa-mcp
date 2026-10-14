#!/usr/bin/env node
// Sign a release:  node scripts/sign.mjs <dir>  (key: env WA_BRIDGE_SIGNING_KEY = PEM, or --key <file>)
// Writes <dir>/SHA256SUMS.sig and checks it against src/release.mjs TRUSTED_KEYS before reporting success.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { signSums, verifySums } from '../src/release.mjs';

const dir = resolve(process.argv[2] || 'dist');
const k = process.argv.indexOf('--key');
const pem = k > 0 ? readFileSync(process.argv[k + 1], 'utf8') : process.env.WA_BRIDGE_SIGNING_KEY;
if (!pem) { console.error('no signing key: set WA_BRIDGE_SIGNING_KEY or pass --key <file>'); process.exit(2); }

const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8');
const sig = signSums(sums, pem);
if (!verifySums(sums, sig)) { console.error('the signing key is not one of TRUSTED_KEYS in src/release.mjs; refusing to publish'); process.exit(1); }
writeFileSync(join(dir, 'SHA256SUMS.sig'), sig + '\n');
console.log(`signed ${join(dir, 'SHA256SUMS')}`);
