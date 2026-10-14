# WA Bridge — Blueprint and Code Package

> **Product status (2026-10-14): `code/wa-bridge/` is now the installable Linux product, v0.2.0.**
>
> - **Install:** `curl … | sh` installs it.
> - **Link:** `wa connect` links WhatsApp with a QR code drawn in the terminal.
> - **Agents:** `wa agents add all` adds the MCP server and skill to Claude Code, Codex, OpenCode or Hermes Agent.
> - **Unchanged:** the functionality, the 16 tools and the draft → approval → confirm rule are the same as below.
>
> Start with [`code/wa-bridge/README.md`](code/wa-bridge/README.md); releasing:
> [`code/wa-bridge/docs/RELEASING.md`](code/wa-bridge/docs/RELEASING.md). The documents in this folder describe
> the original Windows reference deployment (v0.1) and remain the design reference. Their known gaps (architecture
> §17) are resolved in the product, except Windows and macOS support, which are not shipped yet. Git history: the
> first commit is this package exactly as handed over.

A rebuild-grade description of **WA Bridge** (`wa-bridge`), the local WhatsApp gateway that Claude
Code uses to read, search and send WhatsApp messages on the reference workstation (a single Windows 11
PC), plus its scrubbed source. Audience: the team that will productize it. Everything personal
(numbers, WhatsApp IDs, names, paths, message content, business details) has been replaced with
placeholders; see `PRIVACY-AUDIT.md`.

**What it is:** one WhatsApp linked device on the owner's number, a local SQLite + FTS5 message store,
a token-protected HTTP API on `127.0.0.1:3210`, a `wa` CLI and an MCP server (`wa`, 16 tools).

**What it never does:** send on its own. It has no bot, no auto-reply and no inbound handler that talks
back. Every outbound action (text, file, reaction, delete, group create/update) is
**draft → human approval of the exact preview → confirm**. The single opt-in exception is
`POST /send/self`: unattended text to the owner's *own* chat only, used for automated health alerts
and reminders (`code/wa_self.py`).

A separate agent-platform WhatsApp lane existed on the same machine; it is out of scope for this
package.

## Component diagram

```
                        WhatsApp servers (multi-device)
                                   │  linked device "Chrome (Windows)"
 ┌─────────────────────────────────▼───────────────────────────────────────────────┐
 │ wa-bridge daemon  (node src/daemon.mjs, one instance, private pinned Node 22)   │
 │   wa.mjs       Baileys 7.0.0-rc13 socket: link (QR / pairing code), reconnect   │
 │                with backoff, stop on replaced / logged out / forbidden           │
 │   ingest.mjs   history sync + live events → store (idempotent, PN↔LID merge)    │
 │   store.mjs    SQLite (node:sqlite, WAL) + FTS5 search, outbox + audit tables    │
 │   outbox.mjs   the ONLY path out: draft → confirm, expiry, caps, audit           │
 │   api.mjs      HTTP 127.0.0.1:3210, bearer token, no Origin, Host pinned         │
 └───────▲──────────────────────▲──────────────────────▲───────────────────────────┘
         │                      │                      │
   bin/wa.mjs (CLI)      bin/wa-mcp.mjs (MCP,      code/wa_self.py
   operator terminal     stdio, 16 tools)          POST /send/self (own chat only,
                         ← Claude Code sessions    off unless enabled) ← health check,
                                                   reminder tasks
 Data: %LOCALAPPDATA%\wa-bridge\ (auth, wa.sqlite, media, logs, token, config.json)
 Ops:  task "wa-bridge" (logon + 10-min watchdog) · task "wa-bridge-backup" (03:45, keep 7, local only)
```

## Index

| File | Contents |
|---|---|
| `WA-BRIDGE-ARCHITECTURE.md` | Daemon design, Baileys session and linking, storage schema (tables, FTS5, triggers), every HTTP endpoint, every CLI command, all 16 MCP tools with schemas, safety model (incl. `/send/self`), media, history sync, reconnect/watchdog, logging, backups, tests, known gaps. |
| `WA-BRIDGE-SETUP.md` | Exact 1:1 setup on a new Windows machine: pinned Node, `npm ci`, `config.json` overrides, linking (QR / pairing code), the Chrome-identity fix, the autostart/watchdog task, MCP registration at user scope, the backup task, verification, removal. |
| `SECURITY-AND-PRIVACY.md` | Threat model, never-back-up / never-share list, token handling, the human-approval rule, ToS / ban-risk notes. |
| `PRIVACY-AUDIT.md` | The final scan of this folder: patterns searched, every hit, how each was resolved. |
| `code/wa-bridge/` | The product (v0.2.0, Linux): source, installer, release scripts, skill, 120+ tests. Started from the scrubbed v0.1 source, on which 53/53 tests passed. |
| `.github/workflows/` | CI (tests on x64/arm64 × Node 22/24, end-to-end install, distro matrix) and the signed release pipeline. |
| `code/wa_self.py` | A client of the bridge API: sends a labelled text to the owner's own chat via `POST /send/self` (exit 0 = sent). |

## Placeholders used throughout

| Placeholder | Meaning |
|---|---|
| `<USER_HOME>` | The Windows user profile (e.g. `C:\Users\<name>`) |
| `%LOCALAPPDATA%` | `<USER_HOME>\AppData\Local` |
| `<OWNER_NUMBER>` | The owner's WhatsApp number, digits with country code |
| `15550100001` … `15550100009`, `100000000000001` | Fictional numbers / LIDs used in examples and unit tests (NANP 555-01xx fiction range) |
| `120363000000000001` … `…102` | Fictional group JIDs used where code needs a syntactically valid example |

## Status of the reference deployment (2026-10-10)

Live: linked, autostart + 10-minute watchdog task, nightly local store backup, MCP registered at user
scope, self-alert path enabled (`sending.selfUnattended: true`), drafts living 45 minutes
(`sending.draftTtlSec: 2700`). Group create/update actions added 2026-10-04.
