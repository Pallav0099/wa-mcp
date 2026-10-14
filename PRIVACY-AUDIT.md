# Privacy Audit of This Package

Final run 2026-10-10 over every file in this folder except this report, after the scope was reduced to
WA Bridge only. Method: a scripted regex scan of each line, then a manual review of every distinct
match.

## 1. Scope and what was never copied

- The package covers **WA Bridge only** (and its API client `code/wa_self.py`). All material about a
  separate agent-platform WhatsApp lane was removed (its document and its whole code folder deleted;
  references removed from README, security, architecture and setup docs, the copied wa-bridge
  `README.md` and a comment in `scripts/start.ps1`).
- `%LOCALAPPDATA%\wa-bridge\` (credentials, `wa.sqlite`, media, logs, token, `config.json`) — not read,
  not copied. The database was never opened; the daemon, its API and MCP tools were not called.
- `node_modules\`, `.git\`, any `.env` / token / config file with secrets — not copied. A `find` for
  `node_modules`, `.git`, `*.env`, `token`, `*.sqlite*`, `auth`, `config.json` returns **nothing**.

## 2. Scrubbing applied to copied files

| Category | Original kind | Replaced with |
|---|---|---|
| Owner's number / LID | real phone number and privacy ID | `15550100001`, `100000000000001` (fictional) |
| Contacts' numbers in tests | real numbers of contacts | `15550100002` … `15550100008` (NANP 555-01xx fiction range) |
| Group JIDs in tests | a real group ID | `120363000000000101@g.us` (fictional) |
| People, groups, suppliers, product words in tests and examples | real names and chat subjects | `Owner`, `Alex Example`/`Alex`/`Lex`, `Sam Sample`/`Sam`, `Pat Placeholder`, `Jordan`, `Chris`, `Team Group A`, `Project Group B`, `Party Group`, `Renamed Group`, `Acme`, `widgets` |
| Paths | the owner's user-profile path | `<USER_HOME>` |
| References to another product | comments naming the other WhatsApp lane / agent product | neutral wording ("another product's bundled Node", "any other client's session") |

Five test fixtures were adjusted because they referenced the original names in lower case or by
substring (now `'alex example'`, `'team group a'`, `/Chris/`, `'widg*'`, and the ambiguity probe `'a'`).
After the final edits (README and a comment only) the suite was re-run on a scratch copy with the
pinned Node v22.23.2: **53 tests, 53 pass, 0 fail**.

## 3. Final scan results

Patterns: phone numbers `\+?\d{10,13}`; `@s.whatsapp.net`; `@g.us`; `@lid`; e-mail addresses; the
owner's first name, the family surname, the spouse's first name and the home locality (the four words
named in the audit brief, case-insensitive); `estate`; `₹`; hex strings ≥ 32 chars; base64-like strings
≥ 40 chars; the owner's user-profile path in all forms; Tailscale CGNAT addresses `100.64–127.x.x`; ~20
real names of contacts from the source material; and the other-lane terms `Hermes`, `Kai`,
`hermes-lane`, `group-lane`, `SOUL`, `delegate` (case-insensitive). The literal personal search terms
are kept out of this report on purpose.

| Pattern | Final hits | Disposition |
|---|---|---|
| Owner's first name, family surname, spouse's name, home locality | **0** | — |
| `estate` | **0** | — |
| `₹` | **0** | — |
| Owner's user-profile path | **0** | — |
| Tailscale IPs | **0** | — |
| Real contact names | **0** | — |
| `Hermes`, `Kai`, `hermes-lane`, `group-lane`, `SOUL`, `delegate` | **0** | — |
| Phone-number pattern | 90 | All fictional: `15550100001`–`15550100009` and `5550100002` (examples, test fixtures, README legend); `447700900123` / `447700900999` (UK Ofcom drama range, original test fixtures); `1000000000000…` / `1203630000000…` prefixes (fictional LIDs and group JIDs); `4294967296` (2^32 in `util.mjs`). **No real number remains.** |
| `@s.whatsapp.net` | 28 | Protocol suffix in code logic and docs, and fictional fixtures (`1@…`, `7@…`, `x@…`, `15550100001@…`). |
| `@g.us` | 9 | Protocol suffix in code and fictional test JIDs. |
| `@lid` | 8 | Protocol suffix in code/docs and fictional fixtures. |
| E-mail pattern | 23 | All are JIDs matched by the e-mail regex. **No e-mail address remains.** |
| Hex ≥ 32 | 1 | The public SHA-256 of the official Node v22.23.2 zip in `WA-BRIDGE-SETUP.md`. Not a secret. |
| Base64-like ≥ 40 | 125 | npm `integrity` (sha512) values in `package-lock.json` (public package hashes) plus the Node checksum above. Not secrets. |

Counts exclude this report, which mentions the search terms and some fictional values only as
descriptions.

Other manual checks:
- No API tokens, keys, passwords or session credentials anywhere (the bridge token is generated at
  runtime and lives only in the data dir).
- No message text from real chats (test fixtures use invented text; the prompt-injection string in
  `mcp.test.mjs` is a test input).
- No amounts, legal, family, estate or business details.
- Kept on purpose (non-personal): "Claude Code", the default backup path `E:\wa-bridge-backup`, and an
  IST timestamp offset hard-coded in `backup.mjs` (documented as a gap).

## 4. How to re-run

`rg -n -i "<name1>|<name2>|<name3>|<place>|estate|₹|hermes|\bkai\b|soul|delegate" .` and
`rg -n "\+?\d{10,13}" .`, then review each distinct match against §3. Re-run after any edit.
