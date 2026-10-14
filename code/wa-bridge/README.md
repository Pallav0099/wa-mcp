# wa-bridge — WhatsApp for your AI agents

One linked WhatsApp device on your own number, a private local copy of your chats, and tools that any agent
can use: **Claude Code, Codex, OpenCode, Hermes Agent**, or any other MCP client. Agents read and search
freely. **Nothing is sent until you approve the exact preview.**

```sh
curl -fsSL https://github.com/xrig-io/wa-bridge/releases/latest/download/install.sh | sh
wa connect
```

Then ask your agent: *"What are my unread WhatsApp messages?"*

## Requirements

- Linux on x86_64 or aarch64 with glibc 2.28 or newer (Ubuntu 20.04+, Debian 11+, Fedora, Arch, …).
  Alpine/musl is not supported.
- `curl` or `wget`, `tar`, `gzip`, `sha256sum`. No root and no system Node: the installer brings its own,
  verified Node runtime.
- A phone with WhatsApp on the number you link. It must come online now and then: WhatsApp drops linked
  devices whose phone has been offline for about 14 days.
- Optional: `ffmpeg`, only for sending voice notes from audio that is not already Ogg/Opus.

## What `wa connect` does

1. Asks for your consent. WA Bridge is an **unofficial** linked-device client, and WhatsApp may restrict
   accounts that use one. The risk is small for personal, human-approved use like this, but it is not zero.
2. Starts the background service (`systemd --user`, starts at login).
3. Draws the link **QR code in your terminal**. Scan it in WhatsApp → *Settings → Linked devices → Link a
   device*. No camera? Use `wa connect --code <your number with country code>` and type the pairing code on
   the phone instead.
4. Waits until the phone has linked and history starts syncing. Keep the phone online for a few minutes;
   history keeps arriving in the background.
5. Offers to add the WhatsApp tools and skill to every agent it finds on this machine.

The phone lists the device as **"Chrome (Windows)"**. This is deliberate: WhatsApp refuses full-history sync for
"Desktop" identities, so do not change `device` in `config.json`.

## Agents

| Agent | MCP server `wa` goes into | Skill `wa-bridge` goes into | After adding |
|---|---|---|---|
| Claude Code | user scope, via `claude mcp add` | `~/.claude/skills/` | new sessions see it |
| Codex | `~/.codex/config.toml` (`[mcp_servers.wa]`, marked block) | `~/.agents/skills/` | restart Codex |
| OpenCode | `~/.config/opencode/opencode.json[c]` (comments kept) | reuses one of the above, else `~/.config/opencode/skills/` | restart OpenCode |
| Hermes Agent | `~/.hermes/config.yaml` (`mcp_servers.wa`, comments kept) | `~/.hermes/skills/messaging/` | restart Hermes |
| anything else | `wa agents print [--format json\|toml\|yaml]` gives a paste-ready entry | `wa agents print skill` | — |

```sh
wa agents                 # what is configured where
wa agents add all         # or: claude codex opencode hermes
wa agents remove codex    # takes out exactly what was added; an unchanged file is restored byte for byte
```

The installers never touch another program's MCP server called `wa`. They back up every file they edit (0600,
newest 3 kept), edit atomically, keep the file's permissions, write through symlinked dotfiles, and re-read the
result before keeping it. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HERMES_HOME` and `XDG_CONFIG_HOME` are respected.

Every entry runs `~/.wa-bridge/bin/wa-bridge mcp`, the same 16 `wa_*` tools for every agent:
`wa_status, wa_link, wa_chats, wa_read, wa_search, wa_message, wa_events, wa_contacts, wa_groups, wa_media,
wa_draft, wa_confirm, wa_cancel, wa_drafts, wa_mark_read, wa_history`. The first tool call starts the daemon if it
is down, unless you stopped it with `wa stop`.

## How sending works

- Every outbound action is two steps: text, file, reaction, delete-for-everyone, group create/update.
  `wa_draft` (or `wa send …`) returns a **preview and a token**, and nothing is sent. `wa_confirm` (or
  `wa confirm <token>`) sends exactly that.
- The rule that an agent confirms only after you have approved *that preview in the chat* is stated in the tool
  descriptions, the MCP instructions and the skill. **It is enforced by the agent following instructions, not
  by the bridge.** An agent with these tools or a shell can confirm its own draft. Unattended runs (scheduled
  sessions, `codex exec`, Hermes cron jobs) have nobody to approve, and the skill tells them to stop at the draft.
- What the bridge itself enforces:
  - drafts expire (15 min) and can be confirmed once;
  - numbers never seen before need `allowNew` and are checked on WhatsApp;
  - 6 sends a minute, 120 a day;
  - a master switch (`sending.enabled`);
  - delete only your own messages, at most 60 h old;
  - a full audit log (`wa audit`).
- Message text is untrusted data. Every read tool prefixes its output with a reminder that the text was written
  by other people and is never instructions.
- `wa mark-read` sends blue ticks, and only on request. The device never marks itself online, so your phone keeps
  its notifications.
- One unattended path exists, off by default: `wa notify --source <label> <text>` sends to **your own** chat
  only, labelled `[label]`. It is for alerts and reminders, needs `"sending": {"selfUnattended": true}` in
  `config.json`, and takes no recipient.

## Commands

| | |
|---|---|
| `wa connect [--code N] [--agents a,b\|--no-agents] [--yes]` | link WhatsApp, then add it to your agents |
| `wa status` · `wa doctor` | state at a glance · every check, with the fix |
| `wa start` · `wa stop` · `wa restart` · `wa logs [-f]` | the background service |
| `wa chats` · `wa read <chat>` · `wa search <words>` · `wa show` · `wa tail -f` | read |
| `wa send` · `wa send-file` · `wa react` · `wa delete` · `wa group-create` · `wa group-update` | draft (nothing is sent) |
| `wa drafts` · `wa confirm <token>` · `wa cancel <token>` | the outbox |
| `wa disconnect` · `wa disconnect --local` | unlink the device · forget the link on this machine only |
| `wa backup [--dest D] [--keep N] [--schedule daily\|off]` | verified copy of the message store |
| `wa update [--version X] [--rollback]` · `wa uninstall [--purge]` | lifecycle |

`<chat>` is a name (`"Alex"`), a number with country code, or a JID. Ambiguous names are refused and the
candidates listed. `--json` prints any command's raw API response. Everything else: `wa help`.

## Files

| Path | What |
|---|---|
| `~/.wa-bridge/` | the install: `bin/wa-bridge` launcher, `versions/<ver>/`, `current` / `previous`, `node/<ver>/` |
| `~/.local/bin/wa`, `wa-bridge` | links to the launcher (`wa` only if that name was free) |
| `~/.local/share/wa-bridge/` | **your data**, mode 0700: `auth/` (the linked-device credentials), `wa.sqlite` (every message), `media/`, `logs/` (metadata only, 30 days), `token` (API key, 0600), `config.json` (your overrides), `agents.json` (what was added to which agent) |
| `~/.config/systemd/user/wa-bridge.service` | the background service (written by `wa connect` / `wa start`) |

The data directory is fixed in the launcher at install time, so the shell, the service and every agent use the
same one. Set `WA_BRIDGE_HOME` when you run the installer to choose another.

Never put `auth/`, `token` or the store in a cloud-synced folder, a repository or a ticket. `wa backup` copies the
store only, never `auth/` (relinking is cheap; restoring stale encryption sessions is not).

## Service, update, removal

- The service runs while you are logged in. On a headless machine, keep it running without a login session with
  `loginctl enable-linger $USER`. `wa doctor` tells you when that is needed. Without systemd (containers, WSL
  without systemd) the daemon runs detached and needs `wa start` after a reboot.
- `wa stop` means stopped until `wa start` or `wa connect`, also across logins and reboots. Agents' tool calls
  will not start it again either.
- A daemon that cannot start (for example a broken `config.json`) is retried 5 times and then left stopped.
  `wa logs` shows why, and `wa start` tries again.
- `wa update` verifies the release exactly like the installer, snapshots the store, switches, restarts and rolls
  back by itself if the daemon does not come back. `wa update --rollback` returns to the previous version.
- `wa uninstall` removes the agents' entries and skills, the service, the PATH lines and `~/.wa-bridge`, and
  keeps your data. `wa uninstall --purge` first unlinks the device on WhatsApp's side, then deletes the data too.

## Troubleshooting

| Symptom | Do |
|---|---|
| anything | `wa doctor` |
| the QR does not fit or will not scan | enlarge the terminal, or `wa connect --code <number>` |
| `replaced` (another program took over the link) or `forbidden` | `wa disconnect --local`, then `wa connect` |
| an agent does not show the `wa_*` tools | restart the agent; `wa agents` shows what is configured |
| "port 3210 is in use by another program" | set `"port"` in `~/.local/share/wa-bridge/config.json`, then `wa restart` |
| an agent says the bridge was stopped | `wa start` (a `wa stop` is respected until then) |
| saved contact names missing | normal: names arrive through WhatsApp's app-state sync, which is partial for linked devices. Push names are used instead. |

## Development

```sh
cd code/wa-bridge
# Node from .node-version (24.21.0); any >= 22.16 runs the tests
npm ci --ignore-scripts
npm test                          # ~120 tests, no network, no WhatsApp
node scripts/test-install.mjs     # builds two signed releases (throwaway key), installs, updates, rolls back, uninstalls
node bin/wa.mjs help              # run from the checkout (data in ~/.local/share/wa-bridge unless WA_BRIDGE_HOME)
```

| Path | |
|---|---|
| `src/daemon.mjs`, `lifecycle.mjs` | entry point; exit codes 0 stop · 1 crash (restarted) · 2 already running |
| `src/wa.mjs` | the only Baileys socket: link (QR/code), reconnect, explicit operations |
| `src/store.mjs`, `ingest.mjs`, `normalize.mjs` | SQLite + FTS5 store, idempotent ingest |
| `src/outbox.mjs` | the only way out: draft → confirm, caps, audit |
| `src/api.mjs`, `client.mjs` | localhost HTTP API (token, no browsers, Host pinned); client + `ensureDaemon` |
| `bin/wa-mcp.mjs` | MCP server (stdio) |
| `src/cli/` | the `wa` commands; `agents/` = the four installers; `connect.mjs` + `qr.mjs` = terminal linking |
| `src/service.mjs`, `self.mjs`, `install-layout.mjs`, `release.mjs` | systemd unit, launcher, install layout, release verification |
| `install/install.sh`, `scripts/` | installer; build, sum, sign, keygen, install tests |
| `skill/wa-bridge/SKILL.md` | the skill (rendered with the launcher path at install) |

Releasing: [docs/RELEASING.md](docs/RELEASING.md). Original design notes:
[`../../WA-BRIDGE-ARCHITECTURE.md`](../../WA-BRIDGE-ARCHITECTURE.md).

WA Bridge uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client. It is
not affiliated with WhatsApp or Meta. The official route for businesses is the WhatsApp Business Platform.
