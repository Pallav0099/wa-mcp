# Releasing wa-bridge

A release is a GitHub release `vX.Y.Z` with these files:

| File | |
|---|---|
| `wa-bridge-X.Y.Z-linux-x64.tar.gz`, `…-linux-arm64.tar.gz` | the app with production `node_modules` for that CPU |
| `install.sh` | the installer (`curl …/releases/latest/download/install.sh \| sh`) |
| `SHA256SUMS` | sha256 of the files above **and** of the Node tarballs the release runs on |
| `SHA256SUMS.sig` | Ed25519 signature of `SHA256SUMS`, base64 |

The installer and `wa update` accept a release only when `SHA256SUMS.sig` verifies against a key in
`src/release.mjs` (`TRUSTED_KEYS`) / `install/install.sh` (`PUBKEYS`, the same list). Node is downloaded from nodejs.org and must
match both nodejs.org's `SHASUMS256.txt` and the signed list, so a compromised download location cannot substitute
code.

## One-time setup

1. **The signing key.** The key pair in use was generated on 2026-10-14. Its public key is
   `hjEXz90rJ8GyNNoCePO3a9Usd4xGcKMxDRkZOKo71EU=`; the private key was written to `.dev/release-signing-key.pem`
   (git-ignored). Store the PEM in your password manager **and** as the repository secret
   `WA_BRIDGE_SIGNING_KEY` (Settings → Secrets and variables → Actions), then delete the local file.
   To start over with your own key: `node scripts/keygen.mjs <file>`, and put the printed public key into
   `TRUSTED_KEYS` and `PUBKEYS`. `scripts/build-release.mjs` refuses to build when the two lists differ, and
   `scripts/sign.mjs` refuses a key that either list lacks.
2. **The repository name.** Downloads default to `github.com/xrig-io/wa-bridge`. If the repository lives
   elsewhere, change `DEFAULT_REPO` in `src/release.mjs`, `REPO_DEFAULT` in `install/install.sh`, and the URLs in
   `README.md`. The installer has to be downloadable anonymously, so either make the repository (or a releases-only
   mirror) public, or serve the files from your own HTTPS location and use `WA_BRIDGE_DOWNLOAD_URL`.

## Cutting a release

```sh
cd code/wa-bridge
npm version 0.3.0 --no-git-tag-version   # bumps package.json + lock
npm test && node scripts/test-install.mjs
git commit -am "wa-bridge 0.3.0" && git tag v0.3.0 && git push --follow-tags
```

`.github/workflows/release.yml` then does the following:
1. Checks that the tag matches `package.json`.
2. On native x64 and arm64 runners: tests, runs the end-to-end install test, and builds each tarball
   (reproducible).
3. Writes `SHA256SUMS` (with the Node hashes for `.node-version`) and signs it with `WA_BRIDGE_SIGNING_KEY`.
4. Publishes the GitHub release.

## Building and checking by hand

```sh
node scripts/build-release.mjs --arch x64 --out dist        # and --arch arm64
cp install/install.sh dist/
node scripts/make-sums.mjs dist                             # fetches Node's SHASUMS256.txt from nodejs.org
node scripts/sign.mjs dist --key /path/to/signing-key.pem   # refuses a key the code does not trust
```

Rehearse an install from that directory without publishing (serve `dist/` and a Node mirror over HTTP, e.g. with
`scripts/test-install.mjs --serve-only` for a throwaway-key build):

```sh
WA_BRIDGE_DOWNLOAD_URL=http://127.0.0.1:8000 WA_BRIDGE_NODE_MIRROR=https://nodejs.org/dist sh dist/install.sh
```

## Changing the Node version

Edit `.node-version`, run the tests on the new Node, and release. Installs pick up the new runtime on their next
update (both runtimes stay until the previous release is pruned). Node 22 reaches end of life on 2027-04-30;
releases ship Node 24 LTS.

## Rotating the key

1. Add the new public key to both `TRUSTED_KEYS` and `PUBKEYS`, keeping the old key, and release once,
   signed with the **old** key. Installed copies and fresh installs then trust both keys.
2. Sign the following releases with the new key.
3. Once you no longer care about copies older than step 1, remove the old key from both lists.
