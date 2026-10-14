# WA Bridge — 1:1 Setup on a New Windows Machine

Reproduces the reference deployment exactly. Target: Windows 10/11, one interactive user, PowerShell
5.1. Paths assume the repo at `<USER_HOME>\Documents\wa-bridge` (any path works; keep it out of
synced folders). Commands are PowerShell unless marked otherwise.

> **Human gates.** Linking (step 5), the autostart task (step 6), MCP registration (step 7) and
> enabling `selfUnattended` (step 4) are persistent changes to a person's WhatsApp and machine. In the
> reference deployment each was done by the owner or on the owner's explicit order.

## 0. Prerequisites

| Item | Version / note |
|---|---|
| Windows | 10/11 x64; the user's PowerShell policy may stay `Restricted` (all scripts are invoked with `-ExecutionPolicy Bypass` per call) |
| Node.js | **v22.23.2 win-x64 portable zip** (pinned; any ≥ 22.13 works technically, but pin one version and use absolute paths) |
| ffmpeg | optional, on PATH — only needed to send voice notes from non-Ogg audio |
| Claude Code CLI | for MCP registration (`claude` on PATH) |
| A phone with WhatsApp | on the account to link; it must stay in use (linked devices drop after ~14 days without the phone online) |
| A local backup volume | e.g. a second internal disk; **not** a cloud-synced folder |

## 1. Install the pinned Node (private, not on PATH)

```powershell
$v = 'v22.23.2'
$dest = Join-Path $env:LOCALAPPDATA 'Programs\wa-bridge-node'
$zip = Join-Path $env:TEMP "node-$v-win-x64.zip"
Invoke-WebRequest "https://nodejs.org/dist/$v/node-$v-win-x64.zip" -OutFile $zip
Invoke-WebRequest "https://nodejs.org/dist/$v/SHASUMS256.txt" -OutFile "$env:TEMP\SHASUMS256.txt"
$expected = (Select-String "$env:TEMP\SHASUMS256.txt" -Pattern "node-$v-win-x64.zip").Line.Split(' ')[0]
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "SHA256 mismatch" }   # reference value 2026-09-27: 1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97
Expand-Archive $zip -DestinationPath $env:TEMP -Force
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item "$env:TEMP\node-$v-win-x64\*" $dest -Recurse -Force
"node $v win-x64, from https://nodejs.org/dist/$v/ (SHA256 verified $(Get-Date -Format yyyy-MM-dd)). Runtime for wa-bridge only. Not on PATH by design." |
  Set-Content (Join-Path $dest 'VERSION-PIN.txt') -Encoding utf8
& (Join-Path $dest 'node.exe') --version      # v22.23.2
```

Why a private Node: in the reference box `node` on PATH belonged to another product's bundled
runtime; uninstalling that product would have silently killed the bridge, its MCP
tool and its backup. The zip needs no admin and changes no PATH. Do **not** use the MSI (it adds Node
to the machine PATH ahead of the user PATH and changes what every other program resolves).

## 2. Get the code and install dependencies

```powershell
$repo = Join-Path $env:USERPROFILE 'Documents\wa-bridge'
# copy this package's code\wa-bridge\ to $repo (or clone your product repo there)
$node = Join-Path $env:LOCALAPPDATA 'Programs\wa-bridge-node\node.exe'
$npm  = Join-Path $env:LOCALAPPDATA 'Programs\wa-bridge-node\npm.cmd'   # .cmd, not npm.ps1 (Restricted policy)
Push-Location $repo
& $npm ci                    # exact versions from package-lock.json: baileys 7.0.0-rc13, pino 9.14.0, qrcode 1.5.4
& $npm test                  # 53 tests, no network, no WhatsApp contact; expect "pass 53, fail 0"
Pop-Location
```

`npm test` runs `node --disable-warning=ExperimentalWarning --test --test-reporter=spec "test/*.test.mjs"`
(the `node:sqlite` module is still flagged experimental in Node 22). If `npm` picks up a different
`node`, run the tests with the pinned binary directly:
`& $node --disable-warning=ExperimentalWarning --test --test-reporter=spec test/*.test.mjs`.

## 3. First start (creates the data dir; stays unlinked)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$repo\scripts\start.ps1"
# -> "wa-bridge started (wrapper pid N) on 127.0.0.1:3210"
& $node "$repo\bin\wa.mjs" status
# state: unlinked  (not linked — run: wa link)
```

This creates `%LOCALAPPDATA%\wa-bridge\` with `config.json` (`{}`), `config.defaults.json`, `token`,
`logs\`, `media\`, `outgoing\`, `wa.sqlite`. With no credentials the daemon opens **no** WhatsApp
connection. Tip: define a shell alias so the CLI always uses the pinned Node:
`function wa { & "$env:LOCALAPPDATA\Programs\wa-bridge-node\node.exe" "$env:USERPROFILE\Documents\wa-bridge\bin\wa.mjs" @args }`.

## 4. `config.json` overrides

Put **only overrides** in `%LOCALAPPDATA%\wa-bridge\config.json` (defaults are merged under them;
`config.defaults.json` lists everything). The reference deployment uses:

```json
{ "sending": { "draftTtlSec": 2700, "selfUnattended": true } }
```

- `draftTtlSec: 2700` — drafts live 45 minutes instead of 15 (the human often approves later than 15
  minutes in practice).
- `selfUnattended: true` — enables `POST /send/self` (unattended text to the owner's own chat only).
  Leave `false` unless an automated alerting caller needs it.
- Other useful keys: `port`, `sending.enabled` (master switch), `sending.maxPerMinute` /
  `maxPerDay`, `log.level`. **Never** set `device.browser` to `Desktop` (see step 5).

Restart to apply: `wa shutdown`, then `start.ps1` (or wait for the watchdog). Keep a backup copy of
the file before editing.

## 5. Link the device (QR or pairing code) — the Chrome-identity fix

The bridge identifies as **Chrome on Windows** (`device: {os: "Windows", browser: "Chrome"}`, release
`10.0.22631`) while requesting **full history**. This is the fix for the "428" failure: WhatsApp
closes the connection with status 428 before issuing any QR when a *Desktop* identity asks for full
history; any browser identity is accepted (tested on Baileys 7.0.0-rc13, 2026-09-24). It is the
default — do nothing, just don't change it.

Pairing code (recommended — no image to transfer):
```powershell
wa link --code <OWNER_NUMBER>      # full international number, digits only, e.g. 15550100001
# Pairing code: ABCD-1234
# On the phone: WhatsApp → Linked devices → Link a device → "Link with phone number instead" → enter the code.
```
QR:
```powershell
wa link                            # writes %LOCALAPPDATA%\wa-bridge\link-qr.png (refreshes ~every 20 s)
# On the phone: WhatsApp → Linked devices → Link a device → scan it.
```
The window closes after 5 minutes. Check progress with `wa link-status`, then `wa status`:
expect a brief `connecting` (WhatsApp's normal post-link restart, code 515), then `open` with the
account number. History sync starts immediately (`logs\wa-bridge-*.log`: `history_chunk` lines);
`wa status` shows the message count growing. The phone lists the device as **"Chrome (Windows)"**.

If WhatsApp keeps hanging up before a QR/code is issued, the bridge reports
`link failed: WhatsApp closed the connection before issuing a QR or code (code N), K times` instead of
retrying forever. Check `device` in `config.json` first.

## 6. Autostart + 10-minute watchdog (scheduled task `wa-bridge`)

Exact reproduction of the deployed task (per-user, interactive, not elevated). Note: this differs from
the repo's `scripts/install-autostart.ps1`, whose repetition sits on the logon trigger and therefore
never ran on a machine that was not logged off and on — the deployed task uses a separate time
trigger.

```powershell
$start = Join-Path $env:USERPROFILE 'Documents\wa-bridge\scripts\start.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Delay = 'PT45S'                                            # logon + 45 s
$every10 = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
  -RepetitionInterval (New-TimeSpan -Minutes 10)                  # no duration = indefinitely
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'wa-bridge' -Action $action -Trigger @($logon, $every10) -Settings $settings `
  -Description 'Start the wa-bridge WhatsApp daemon (idempotent; repeats every 10 min as a watchdog).' -Force
```

Resulting task (as read back with `schtasks /query /tn wa-bridge /fo LIST /v`): run as the user,
*Interactive only*, *Limited* run level; action `powershell.exe -NoProfile -WindowStyle Hidden
-ExecutionPolicy Bypass -File "<repo>\scripts\start.ps1"`; triggers *At logon (delay 45 s)* and
*One time, repeat every 10 minutes, indefinitely*; stop if running > 2 minutes; start when available;
ignore new instances; runs on battery. `start.ps1` exits immediately when the port answers, so the
repetition only acts when the daemon has died. Gap to close in a product: it only runs while the
user is logged on (no at-boot S4U variant).

`start.ps1` launches through WMI with a hidden window: nothing to close by accident, no parent
terminal or agent session that could take the process down with it.

## 7. Register the MCP server for Claude Code (user scope)

```powershell
$node = Join-Path $env:LOCALAPPDATA 'Programs\wa-bridge-node\node.exe'
$mcp  = Join-Path $env:USERPROFILE 'Documents\wa-bridge\bin\wa-mcp.mjs'
claude mcp add wa -s user -- $node $mcp
claude mcp get wa          # Status: Connected; command = the pinned node.exe
```

User scope makes the 16 `wa_*` tools available in **every** Claude Code session of that user,
including scheduled/unattended ones — which is why the confirm rule matters (see
`SECURITY-AND-PRIVACY.md`). Sessions already open keep their old MCP process until they end. The MCP
server reads the port and token from the data dir; it needs the daemon running.

## 8. Nightly backup of the message store (task `wa-bridge-backup`)

```powershell
$node = Join-Path $env:LOCALAPPDATA 'Programs\wa-bridge-node\node.exe'
$bk   = Join-Path $env:USERPROFILE 'Documents\wa-bridge\scripts\backup.mjs'
$destArg = ''   # default destination is E:\wa-bridge-backup; otherwise: $destArg = " '--dest' 'D:\wa-bridge-backup'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$node' --disable-warning=ExperimentalWarning '$bk'$destArg`""
$trigger = New-ScheduledTaskTrigger -Daily -At '03:45'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)             # default battery behaviour: no start / stop on battery
Register-ScheduledTask -TaskName 'wa-bridge-backup' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Nightly consistent backup of the wa-bridge message store (not the auth keys), keep 7. Local only, never cloud.' -Force
Start-ScheduledTask -TaskName 'wa-bridge-backup'; Start-Sleep 10
Get-Content E:\wa-bridge-backup\backup.log -Tail 1    # "ok E:\wa-bridge-backup\wa-YYYYMMDD-HHMM.sqlite N MB M messages ..."
```

Never add the `auth\` folder, the `token`, or the backup folder to any cloud sync. If the backup disk
is not encrypted (BitLocker), the backups are as exposed as the live store.

Restore: stop the daemon, copy a backup to `%LOCALAPPDATA%\wa-bridge\wa.sqlite` (delete stale
`-wal`/`-shm`), start. If the credentials were lost too, relink (step 5); history sync re-fills what
the phone still has, and the idempotent store merges it with the restored rows.

## 9. Verification checklist

```powershell
wa status                       # state: open; account = the linked number; sending: on · always draft → confirm
Get-NetTCPConnection -LocalPort 3210 -State Listen | Select LocalAddress   # 127.0.0.1 only
wa chats --limit 5              # recent chats with names
wa search <a word you know exists> --limit 3
wa send <your own number> "test" ; wa drafts ; wa cancel <TOKEN>   # draft shows the preview; nothing is sent
schtasks /query /tn wa-bridge /fo LIST /v | findstr /i "Status Last"      # Last Result: 0
Get-Content "$env:LOCALAPPDATA\wa-bridge\logs\daemon-stderr.log" -Tail 5   # empty or benign
claude mcp get wa               # Connected
```
Optional (only if `selfUnattended` is on): `python code\wa_self.py --source setup-test --text "hello"`
→ `SENT <id>`; the message arrives in the owner's own chat as `[setup-test] hello`.

Health of the store (read-only): `wa status` shows `chats · groups · contacts · messages (live)` and
the time span; the daily log has no `api_error`/`handler_failed` lines.

## 10. Operations

| Task | Command |
|---|---|
| Stop gracefully | `wa shutdown` (or `scripts\stop.ps1`; fix its PATH `node` call to the pinned Node) |
| Drop the connection, stay linked | `wa pause` / `wa resume` |
| Apply config changes | `wa shutdown`, then `start.ps1` (or wait ≤ 10 min for the watchdog) |
| Pause the watchdog during maintenance | `Disable-ScheduledTask wa-bridge` … `Enable-ScheduledTask wa-bridge` |
| Upgrade Baileys | deliberately: bump the exact pin, `npm ci`, `npm test`, restart, one live `wa status` + `wa read` |
| Upgrade Node | as its own change: new pinned folder, tests on the new binary first, then switch start.ps1 / backup task / MCP registration (watchdog disabled during the switch) |
| Log hygiene | logs are not rotated by the bridge; prune `logs\` and `media\` periodically |

## 11. Removal

```powershell
wa logout --yes                  # unlinks the device (or on the phone: Linked devices → "Chrome (Windows)" → Log out)
wa shutdown
Unregister-ScheduledTask -TaskName 'wa-bridge' -Confirm:$false
Unregister-ScheduledTask -TaskName 'wa-bridge-backup' -Confirm:$false
claude mcp remove wa -s user
# Then, deliberately and only if the owner wants the data gone:
#   %LOCALAPPDATA%\wa-bridge\   (credentials, every stored message, media, token)
#   the backup folder (e.g. E:\wa-bridge-backup\)
#   %LOCALAPPDATA%\Programs\wa-bridge-node\ (the private Node)
```
Deleting the data dir does not unlink the device on WhatsApp's side; always log out first.
