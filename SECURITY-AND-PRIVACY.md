# Security and Privacy

Scope: WA Bridge as deployed on a single-user Windows workstation, and its clients (the `wa` CLI, the
MCP server, `code/wa_self.py`). Read together with `WA-BRIDGE-ARCHITECTURE.md` §9 and §17.

## 0. The Linux product (v0.2, 2026-10-14)

Sections 1–7 below still hold. In the installable product, these properties were added or changed:

- **Approval: unchanged by decision.** Confirming a draft is still enforced by the agent following
  instructions, not by the bridge. The decision of 2026-10-14 keeps today's behaviour for every agent.
  - The rule is repeated in the tool descriptions, the MCP server instructions and the skill installed into
    each agent.
  - The skill tells unattended runs (scheduled sessions, `codex exec`, Hermes cron) to stop at the draft.
  - Any agent with the tools or a shell *can* confirm its own draft. Phone approval and per-agent policy are the
    planned next step. When built, approvals must ignore message ids in `outbox.sent_id` and messages from the
    bridge's own device, so `wa notify` cannot approve itself.
- **Consent.** `wa connect` states before linking that this is an unofficial client with a small risk to the
  account, and that agents can read the chats.
- **File privacy.**
  - The data directory is created and kept at 0700, and the daemon runs with umask 077 (files that v0.1 left
    0644 are no longer readable by other local users).
  - The token stays 0600, is read at call time, and is never written into an agent's config.
  - The launcher pins the data directory, so the service, the shell and all agents use the same one.
- **Supply chain.**
  - Releases are reproducible tarballs per CPU architecture. Dependencies are exact pins, and install scripts are
    denied (`allowScripts`) and never run on users' machines.
  - The installer verifies Node against nodejs.org's `SHASUMS256.txt` **and** the release's signed list *before
    running it*. It then uses that Node to verify the Ed25519 signature of `SHA256SUMS`, then the app tarball.
  - `wa update` does the same.
  - The signing key's public half is in `src/release.mjs` / `install.sh`. The private half belongs in the CI
    secret `WA_BRIDGE_SIGNING_KEY` and a password manager only (see `code/wa-bridge/docs/RELEASING.md`).
- **Other programs' configs.** Agent installers edit Claude Code, Codex, OpenCode and Hermes configuration.
  They back up first (0600: those files hold API keys), write atomically, keep modes and symlinks, re-parse the
  result, and never touch another program's `wa` server. Removal restores an unchanged file byte for byte.
- **Lifecycle.**
  - Crash → exit 1 → systemd restarts it.
  - `wa stop` is respected: agents' tool calls do not restart a stopped daemon.
  - A send interrupted by a crash is marked failed ("delivery unknown") rather than left pending.
  - A store written by a newer schema is never opened by older code.
- **Removal.** `wa uninstall --purge` unlinks the device on WhatsApp's side before deleting the data. Deleting
  files alone never removes the device from the phone's list.
- **Backups.** `wa backup` copies only the store, verified, into a 0700 directory. Never `auth/` or the token.

## 1. Assets

| Asset | Where | Why it matters |
|---|---|---|
| WhatsApp linked-device credentials | `%LOCALAPPDATA%\wa-bridge\auth\` (and any `auth.revoked-*`) | Full read/send access to the owner's WhatsApp as a linked device, until the phone unlinks it. |
| Message store | `%LOCALAPPDATA%\wa-bridge\wa.sqlite` (+ WAL), nightly copies on the backup volume | Every private chat, including messages later deleted for everyone and disappearing messages (kept, marked deleted). |
| Media | `%LOCALAPPDATA%\wa-bridge\media\`, `outgoing\` | Private photos, documents, voice notes. |
| API token | `%LOCALAPPDATA%\wa-bridge\token` | Whoever holds it can read everything and draft/confirm sends via the API. |
| Config | `%LOCALAPPDATA%\wa-bridge\config.json` | Sending policy (master switch, caps, self-alert switch). |
| Logs | `%LOCALAPPDATA%\wa-bridge\logs\` | Metadata only, but contain JIDs (phone numbers). |
| Operator exports | e.g. plaintext review/scan files made from the store | Unencrypted extracts of chats; must be deleted when done. |

## 2. Threat model

| Threat | Mitigation in place | Residual / product advice |
|---|---|---|
| **AI agent sends something the human did not approve** (hallucinated recipient, prompt injection from a message, unattended session) | Draft → confirm with a 6-char token; preview shows recipient, NEW-number warning and exact text; drafts expire; one confirm per draft; caps 6/min, 120/day; unknown numbers refused unless `allowNew`, then verified; master switch `sending.enabled`; full audit; MCP instructions and tool descriptions state the rule; message text framed as untrusted data. | The confirm gate is a **model-enforced rule**, not a hard gate: any session with the MCP tool (user scope = every Claude Code session, incl. scheduled ones) or with shell access to the token could confirm. A permission prompt on `wa_confirm` was implemented and withdrawn at the owner's request (§5). For a product: a separate confirm channel (phone push / UI click) bound to the draft token. |
| **Unattended automation messages third parties** | `/send/self` takes no recipient (target = the linked account's own number), off by default, labelled `[source]`, same rate limits and audit; not exposed as an MCP tool. Every other path requires confirm. | Treat any automated message reaching anyone but the owner as a security incident. |
| **Local process abuse of the API** | 127.0.0.1 only; bearer token compared timing-safe; requests with an `Origin` header refused (browsers); `Host` pinned to `127.0.0.1:<port>`/`localhost:<port>` (DNS rebinding). | Any process running as the same Windows user can read the token file. Single-user design; a product needs per-client credentials. |
| **Credential theft / device takeover** | Credentials only in the user profile; never backed up or copied; archived (not deleted) when revoked; no auto-linking; link windows close after 5 minutes; a QR nobody requested closes the socket. | Disk encryption (BitLocker) on C: and the backup volume; screen lock; periodic check of *Linked devices* on the phone. |
| **Two clients on one session** | Lock file + port probe (second instance exits 2); stops on `replaced` instead of fighting. | Never run two processes on the same auth folder. |
| **Silent outage** | 10-minute watchdog task; state machine logs every transition; `/send/self` available for alerts. | Watchdog runs only while the user is logged on (no at-boot task). |
| **Supply chain** | Exact dependency pins + lockfile + `npm ci`; private pinned Node with verified SHA-256, not on PATH. | Baileys is an unofficial reverse-engineered client and a release candidate; review upgrades, run tests, then one live check. |
| **Operational gaps** (see architecture §17) | — | `stop.ps1` calls `node` from PATH; `backup.mjs` ignores `WA_BRIDGE_HOME`, hard-codes an IST timestamp and an `E:` default; no log rotation or media eviction; the repo README still says "no group administration"; the repo's `install-autostart.ps1` differs from the deployed task (its repetition never ran). |

## 3. Never back up, never share, never commit

- `auth\`, any `auth.revoked-*` folder — **credentials**. A restored stale Signal session can also
  break decryption; relinking is cheap (pairing code).
- `token`.
- `wa.sqlite`, its backups, `media\`, `outgoing\`, plaintext exports — **local backup only, never
  cloud**, never in a synced folder, never in a repo, never attached to tickets.
- `logs\*.log` contain JIDs even though they never contain message text: scrub before sharing.
- This package contains **none** of the above (see `PRIVACY-AUDIT.md`).

## 4. Token handling

- Generated on first start: `crypto.randomBytes(24).toString('hex')` → 48 hex chars, written to
  `<data>\token` with mode 0600 (on Windows the user-profile ACL is what actually protects it; the
  reference audit found it readable by the user, SYSTEM and administrators only).
- Clients (`wa` CLI, MCP server, `wa_self.py`) read it from the data dir at call time; it is never put
  in config files, command lines, environment variables or URLs.
- Sent as `Authorization: Bearer <token>`; compared with `timingSafeEqual`.
- Rotation: stop the daemon, delete `token`, start (a new one is generated); clients re-read it on
  every call.
- Never log it; never paste it into a chat with an AI model.

## 5. The human-approval rule (and its history)

**Rule:** every outbound WhatsApp action by an AI agent is drafted, the **exact preview** (recipient,
action, full text/file) is shown to the human in the conversation, and it is confirmed only after the
human's explicit yes to *that* preview. Changing the text means a new draft and a new approval. It is
the same discipline the owner applies to e-mail (drafts are prepared; the human sends).

History: on 2026-09-25 a Claude Code permission rule (`permissions.ask: ["mcp__wa__wa_confirm"]`) was
added so that every confirm raised a click-to-approve prompt and unattended sessions could not send at
all. The owner had it **removed the same evening**, preferring the model asking in chat before
sending, and explicitly accepted the residual risk of unattended sessions. The single sanctioned
exception is `/send/self` (2026-09-27): automated alerts and reminders to the owner's own chat only,
via `wa_self.py`.

For a product, keep the rule and make it enforceable: confirm should require a second factor the model
cannot produce (a click in a UI, a reply from the owner's phone).

## 6. WhatsApp Terms of Service and ban risk (from our records)

- WA Bridge is an **unofficial linked-device client** (Baileys reverse-engineers the WhatsApp Web
  multi-device protocol). This is against WhatsApp's terms; the owner accepted a small ban risk. The
  official alternative is the WhatsApp Business Platform (Cloud API) on a separate business number.
- Risk grows with automated, bulk or unsolicited sending. The design rules out all three (no bot,
  human-approved sends, 6/min and 120/day caps).
- Observed limits: WhatsApp rejects a *Desktop* identity requesting full history (428 before any QR);
  rapid repeated sends hit the per-minute cap (rejected attempts appear to extend the window; a clean
  ~75 s pause cleared it); linked devices drop after ~14 days without the phone online; history depth
  is the phone's decision; saved-contact names may never sync without app-state keys.
- No warning or restriction had been received on the reference account as of 2026-10-10. Revisit the
  design if one arrives.

## 7. Privacy properties worth telling users

- The bridge keeps its own copy of everything it receives, including messages the sender later
  deletes for everyone and disappearing messages. Whether to purge those was left open in the
  reference deployment — a product should offer a setting.
- Read receipts are never sent automatically, and the device never marks itself online.
- Status updates (stories) and channels are dropped before decryption; media is downloaded only on
  request.
