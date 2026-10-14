// Agent integrations against throwaway homes: real config formats (with comments), stub CLIs that behave like
// the real ones, exact removal, shared skills, and the safety rules (never touch someone else's "wa").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parseDocument } from 'yaml';
import { addAgents, removeAgents, listAgents, makeContext, offerAgents, resolveIds, snippet, AGENTS } from '../src/cli/agents/index.mjs';
import { runQuiet } from '../src/service.mjs';

const byId = (id) => AGENTS.find((a) => a.id === id);

// A stub `claude` with the real CLI's observable behaviour: writes ~/.claude.json, refuses duplicates.
const CLAUDE_STUB = `
const fs = require('fs'); const path = require('path');
// defence in depth: never touch a real home directory
if (!/wab-agents-/.test(process.env.HOME || '')) { console.error('stub claude: refusing HOME=' + process.env.HOME); process.exit(99); }
const file = path.join(process.env.HOME, '.claude.json');
const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
fs.appendFileSync(path.join(process.env.HOME, 'claude-calls.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
const a = process.argv.slice(2);
if (a[0] === 'mcp' && a[1] === 'add') {
  const name = a[4]; const dd = a.indexOf('--'); const env = {};
  for (let i = 5; i < dd; i++) if (a[i] === '-e') { const [k, v] = a[++i].split('='); env[k] = v; }
  cfg.mcpServers = cfg.mcpServers || {};
  if (cfg.mcpServers[name]) { console.log('MCP server ' + name + ' already exists in user config'); process.exit(1); }
  cfg.mcpServers[name] = { type: 'stdio', command: a[dd + 1], args: a.slice(dd + 2), env };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
} else if (a[0] === 'mcp' && a[1] === 'remove') {
  const name = a[4];
  if (!cfg.mcpServers || !cfg.mcpServers[name]) { console.log('No MCP server named "' + name + '" in user scope'); process.exit(1); }
  delete cfg.mcpServers[name];
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
} else process.exit(2);
`;

function sandbox({ claude = false, opencode = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wab-agents-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  const launcher = join(root, 'install', 'bin', 'wa-bridge');
  mkdirSync(join(root, 'install', 'bin'), { recursive: true });
  writeFileSync(launcher, '#!/bin/sh\n');
  chmodSync(launcher, 0o755);
  const stub = (name, js) => { writeFileSync(join(bin, name), `#!${process.execPath}\n${js}`); chmodSync(join(bin, name), 0o755); };
  if (claude) stub('claude', CLAUDE_STUB);
  if (opencode) stub('opencode', `if (!/wab-agents-/.test(process.env.HOME || '')) process.exit(99); console.log('opencode v${opencode}')`);
  const env = { HOME: home, PATH: bin, WA_BRIDGE_HOME: join(home, '.local', 'share', 'wa-bridge'), WA_BRIDGE_LAUNCHER: launcher };
  const ctx = (extra = {}) => makeContext({ env, run: runQuiet, ...extra });
  return { root, home, env, launcher, ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const skillOf = (dir) => readFileSync(join(dir, 'SKILL.md'), 'utf8');

test('Claude Code: user-scope server through the CLI, idempotent, outdated entries replaced, skill rendered with the launcher', () => {
  const s = sandbox({ claude: true });
  try {
    const [r] = addAgents([byId('claude')], s.ctx());
    assert.equal(r.mcp, 'added', JSON.stringify(r));
    const cfg = JSON.parse(readFileSync(join(s.home, '.claude.json'), 'utf8'));
    assert.deepEqual(cfg.mcpServers.wa, { type: 'stdio', command: s.launcher, args: ['mcp'], env: {} });
    const skill = skillOf(join(s.home, '.claude', 'skills', 'wa-bridge'));
    assert.match(skill, /^---\nname: wa-bridge\n/);
    assert.ok(skill.includes(`${s.launcher} confirm K7QX2M`), 'CLI fallback uses the absolute launcher');
    assert.ok(!skill.includes('{{'), 'no unrendered placeholders');

    assert.equal(addAgents([byId('claude')], s.ctx())[0].mcp, 'unchanged');
    const calls = readFileSync(join(s.home, 'claude-calls.log'), 'utf8').trim().split('\n');
    assert.equal(calls.length, 1, 'no CLI call when already configured');

    // an older wa-bridge entry (e.g. a source checkout) is replaced
    cfg.mcpServers.wa = { type: 'stdio', command: 'node', args: ['/old/wa-bridge/bin/wa-mcp.mjs'], env: {} };
    writeFileSync(join(s.home, '.claude.json'), JSON.stringify(cfg));
    assert.equal(addAgents([byId('claude')], s.ctx())[0].mcp, 'updated');
    assert.equal(JSON.parse(readFileSync(join(s.home, '.claude.json'), 'utf8')).mcpServers.wa.command, s.launcher);

    const [rm] = removeAgents([byId('claude')], s.ctx());
    assert.equal(rm.mcp, 'removed');
    assert.equal(rm.skill, 'removed');
    assert.equal(JSON.parse(readFileSync(join(s.home, '.claude.json'), 'utf8')).mcpServers.wa, undefined);
    assert.equal(existsSync(join(s.home, '.claude', 'skills', 'wa-bridge')), false);
  } finally { s.cleanup(); }
});

test('Claude Code: somebody else\'s "wa" server is never replaced or removed', () => {
  const s = sandbox({ claude: true });
  try {
    writeFileSync(join(s.home, '.claude.json'), JSON.stringify({ mcpServers: { wa: { type: 'stdio', command: 'whatsapp-other', args: [] } } }));
    const [r] = addAgents([byId('claude')], s.ctx());
    assert.match(r.error, /different MCP server named "wa".*--force/);
    const [rm] = removeAgents([byId('claude')], s.ctx());
    assert.equal(rm.mcp, 'kept');
    assert.equal(JSON.parse(readFileSync(join(s.home, '.claude.json'), 'utf8')).mcpServers.wa.command, 'whatsapp-other');
  } finally { s.cleanup(); }
});

const CODEX_TOML = `# my codex settings
model = "gpt-6"

[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"] # keep me

[profiles.fast]
model = "gpt-6-mini"
`;

test('Codex: a marked, validated block in config.toml; removed byte for byte; comments and tables untouched', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, '.codex'));
    const file = join(s.home, '.codex', 'config.toml');
    writeFileSync(file, CODEX_TOML, { mode: 0o600 });
    const [r] = addAgents([byId('codex')], s.ctx());
    assert.equal(r.mcp, 'added', JSON.stringify(r));
    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith(CODEX_TOML), 'the original content is kept verbatim');
    const t = parseToml(text);
    assert.deepEqual({ command: t.mcp_servers.wa.command, args: t.mcp_servers.wa.args }, { command: s.launcher, args: ['mcp'] });
    assert.equal(t.mcp_servers.wa.tool_timeout_sec, 180, 'media downloads get more than the 60 s default');
    assert.equal(t.mcp_servers.github.command, 'npx');
    assert.equal(statSync(file).mode & 0o777, 0o600, 'permissions kept');
    assert.ok(readdirSync(join(s.home, '.codex')).some((f) => f.startsWith('config.toml.wa-bridge-bak-')), 'backup written');
    assert.equal(addAgents([byId('codex')], s.ctx())[0].mcp, 'unchanged');
    assert.ok(existsSync(join(s.home, '.agents', 'skills', 'wa-bridge', 'SKILL.md')));

    const [rm] = removeAgents([byId('codex')], s.ctx());
    assert.equal(rm.how, 'restored');
    assert.equal(readFileSync(file, 'utf8'), CODEX_TOML, 'byte for byte');
  } finally { s.cleanup(); }
});

test('Codex: edits made after ours survive removal; the block goes, nothing else', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, '.codex'));
    const file = join(s.home, '.codex', 'config.toml');
    writeFileSync(file, CODEX_TOML);
    addAgents([byId('codex')], s.ctx());
    writeFileSync(file, readFileSync(file, 'utf8') + '\n[mcp_servers.later]\ncommand = "later"\n');
    const [rm] = removeAgents([byId('codex')], s.ctx());
    assert.equal(rm.how, 'edited');
    assert.equal(readFileSync(file, 'utf8'), CODEX_TOML + '\n[mcp_servers.later]\ncommand = "later"\n');
  } finally { s.cleanup(); }
});

test('Codex: a hand-written [mcp_servers.wa] is a conflict and the file is not touched', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, '.codex'));
    const file = join(s.home, '.codex', 'config.toml');
    const mine = '[mcp_servers.wa]\ncommand = "someone-else"\n';
    writeFileSync(file, mine);
    const [r] = addAgents([byId('codex')], s.ctx());
    assert.match(r.error, /already defines \[mcp_servers\.wa\]/);
    assert.equal(readFileSync(file, 'utf8'), mine);
    assert.equal(removeAgents([byId('codex')], s.ctx())[0].mcp, 'kept');
    assert.equal(readFileSync(file, 'utf8'), mine);
  } finally { s.cleanup(); }
});

test('Codex: a config that cannot take the table is restored, not left broken', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, '.codex'));
    const file = join(s.home, '.codex', 'config.toml');
    const inline = 'mcp_servers = { github = { command = "npx" } }\n'; // inline table: [mcp_servers.wa] would be invalid
    writeFileSync(file, inline);
    const [r] = addAgents([byId('codex')], s.ctx());
    assert.ok(r.error, 'reported');
    assert.equal(readFileSync(file, 'utf8'), inline, 'untouched');
  } finally { s.cleanup(); }
});

const OPENCODE_JSONC = `{
  // my opencode config
  "$schema": "https://opencode.ai/config.json",
  "theme": "tokyonight", // dark
  "mcp": {
    "servers": {
      "github": { "type": "remote", "url": "https://api.example.com/mcp" }
    }
  }
}
`;

test('OpenCode 2: mcp.servers entry in a commented config, comments kept, restored byte for byte', () => {
  const s = sandbox({ opencode: '2.0.27' });
  try {
    const dir = join(s.home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'opencode.jsonc');
    writeFileSync(file, OPENCODE_JSONC);
    const [r] = addAgents([byId('opencode')], s.ctx());
    assert.equal(r.mcp, 'added', JSON.stringify(r));
    const text = readFileSync(file, 'utf8');
    assert.match(text, /\/\/ my opencode config/);
    assert.match(text, /"theme": "tokyonight", \/\/ dark/);
    assert.match(text, /"github"/);
    assert.match(text, new RegExp(`"wa": \\{\\s*"type": "local",\\s*"command": \\[\\s*"${s.launcher.replace(/[/.]/g, '\\$&')}",\\s*"mcp"\\s*\\]\\s*\\}`));
    assert.equal(addAgents([byId('opencode')], s.ctx())[0].mcp, 'unchanged');
    assert.equal(removeAgents([byId('opencode')], s.ctx())[0].how, 'restored');
    assert.equal(readFileSync(file, 'utf8'), OPENCODE_JSONC);
  } finally { s.cleanup(); }
});

test('OpenCode 1 uses mcp.<name> with enabled; a fresh config is created and deleted again', () => {
  const s = sandbox({ opencode: '1.4.0' });
  try {
    mkdirSync(join(s.home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(s.home, '.config', 'opencode', 'service.json'), '{}'); // installed, no config yet
    addAgents([byId('opencode')], s.ctx());
    const file = join(s.home, '.config', 'opencode', 'opencode.json');
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(cfg.mcp.wa, { type: 'local', command: [s.launcher, 'mcp'], enabled: true });
    assert.equal(removeAgents([byId('opencode')], s.ctx())[0].how, 'deleted');
    assert.equal(existsSync(file), false);
  } finally { s.cleanup(); }
});

test('OpenCode: a config with a syntax error is refused, never rewritten', () => {
  const s = sandbox({ opencode: '2.0.27' });
  try {
    mkdirSync(join(s.home, '.config', 'opencode'), { recursive: true });
    const file = join(s.home, '.config', 'opencode', 'opencode.json');
    writeFileSync(file, '{ "theme": "x" ');
    const [r] = addAgents([byId('opencode')], s.ctx());
    assert.match(r.error, /syntax error/);
    assert.equal(readFileSync(file, 'utf8'), '{ "theme": "x" ');
  } finally { s.cleanup(); }
});

const HERMES_YAML = `# Hermes config
model:
  default: hermes-5   # pinned
mcp_servers:
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
`;

test('Hermes: mcp_servers.wa added next to existing servers with comments kept; removed byte for byte', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, '.hermes'));
    const file = join(s.home, '.hermes', 'config.yaml');
    writeFileSync(file, HERMES_YAML);
    const [r] = addAgents([byId('hermes')], s.ctx());
    assert.equal(r.mcp, 'added', JSON.stringify(r));
    const text = readFileSync(file, 'utf8');
    assert.match(text, /# Hermes config/);
    assert.match(text, /default: hermes-5 +# pinned/);
    const cfg = parseDocument(text).toJSON();
    assert.deepEqual(cfg.mcp_servers.wa, { command: s.launcher, args: ['mcp'] });
    assert.equal(cfg.mcp_servers.github.command, 'npx');
    assert.ok(existsSync(join(s.home, '.hermes', 'skills', 'messaging', 'wa-bridge', 'SKILL.md')));
    assert.equal(removeAgents([byId('hermes')], s.ctx())[0].how, 'restored');
    assert.equal(readFileSync(file, 'utf8'), HERMES_YAML);
  } finally { s.cleanup(); }
});

test('skills: one shared copy per directory, reference-counted; OpenCode reuses ~/.agents/skills; foreign skills untouched', () => {
  const s = sandbox({ opencode: '2.0.27' });
  try {
    mkdirSync(join(s.home, '.codex'));
    mkdirSync(join(s.home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(s.home, '.config', 'opencode', 'opencode.json'), '{}\n');
    // OpenCode first: it gets its own copy …
    addAgents([byId('opencode')], s.ctx());
    assert.ok(existsSync(join(s.home, '.config', 'opencode', 'skills', 'wa-bridge', 'SKILL.md')));
    // … then Codex puts one in ~/.agents/skills, which OpenCode also reads: the duplicate goes
    addAgents([byId('codex')], s.ctx());
    const shared = join(s.home, '.agents', 'skills', 'wa-bridge');
    assert.ok(existsSync(join(shared, 'SKILL.md')));
    assert.equal(existsSync(join(s.home, '.config', 'opencode', 'skills', 'wa-bridge')), false, 'no duplicate for OpenCode');
    // removing Codex keeps the copy OpenCode still uses
    assert.equal(removeAgents([byId('codex')], s.ctx())[0].skill, 'kept');
    assert.ok(existsSync(join(shared, 'SKILL.md')));
    assert.equal(removeAgents([byId('opencode')], s.ctx())[0].skill, 'removed');
    assert.equal(existsSync(shared), false);

    // a wa-bridge skill dir somebody made by hand is never overwritten or deleted
    const hand = join(s.home, '.agents', 'skills', 'wa-bridge');
    mkdirSync(hand, { recursive: true });
    writeFileSync(join(hand, 'SKILL.md'), 'my own notes');
    const [r] = addAgents([byId('codex')], s.ctx());
    assert.match(r.skill, /not created by wa-bridge/);
    removeAgents([byId('codex')], s.ctx());
    assert.equal(readFileSync(join(hand, 'SKILL.md'), 'utf8'), 'my own notes');
  } finally { s.cleanup(); }
});

test('an update keeps the ORIGINAL backup, so a later remove still restores the untouched file', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, '.hermes'));
    const file = join(s.home, '.hermes', 'config.yaml');
    writeFileSync(file, HERMES_YAML);
    addAgents([byId('hermes')], s.ctx());
    // a new install location: the entry is updated in place
    const moved = join(s.root, 'moved-wa-bridge');
    writeFileSync(moved, '#!/bin/sh\n');
    const env2 = { ...s.env, WA_BRIDGE_LAUNCHER: moved };
    const [u] = addAgents([byId('hermes')], makeContext({ env: env2, run: runQuiet }));
    assert.equal(u.mcp, 'updated');
    assert.equal(removeAgents([byId('hermes')], makeContext({ env: env2, run: runQuiet }))[0].how, 'restored');
    assert.equal(readFileSync(file, 'utf8'), HERMES_YAML);
  } finally { s.cleanup(); }
});

test('a symlinked config (dotfile manager) is edited through the link, which survives', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, 'dotfiles'));
    mkdirSync(join(s.home, '.codex'));
    const real = join(s.home, 'dotfiles', 'codex.toml');
    writeFileSync(real, CODEX_TOML);
    symlinkSync(real, join(s.home, '.codex', 'config.toml'));
    addAgents([byId('codex')], s.ctx());
    assert.ok(statSync(join(s.home, '.codex', 'config.toml')).isFile());
    assert.match(readFileSync(real, 'utf8'), /\[mcp_servers\.wa\]/, 'the target got the edit');
    removeAgents([byId('codex')], s.ctx());
    assert.equal(readFileSync(real, 'utf8'), CODEX_TOML);
  } finally { s.cleanup(); }
});

test('selection: "all" means agents found here; unknown names are refused; list reports state', () => {
  const s = sandbox({ claude: true });
  try {
    mkdirSync(join(s.home, '.hermes'));
    const ctx = s.ctx();
    assert.deepEqual(resolveIds(['all'], ctx, { forAdd: true }).map((a) => a.id), ['claude', 'hermes']);
    assert.deepEqual(resolveIds(['hermes,claude-code'], ctx, { forAdd: true }).map((a) => a.id), ['claude', 'hermes']);
    assert.throws(() => resolveIds(['cursor'], ctx, { forAdd: true }), /unknown agent "cursor"/);
    addAgents(resolveIds(['all'], ctx, { forAdd: true }), ctx);
    const rows = Object.fromEntries(listAgents(s.ctx()).map((r) => [r.id, r]));
    assert.equal(rows.claude.mcp, 'ok');
    assert.equal(rows.hermes.skill, 'ok');
    assert.equal(rows.codex.found, false);
    const manifest = JSON.parse(readFileSync(join(s.env.WA_BRIDGE_HOME, 'agents.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.agents).sort(), ['claude', 'hermes']);
    assert.equal(statSync(join(s.env.WA_BRIDGE_HOME, 'agents.json')).mode & 0o777, 0o600);
  } finally { s.cleanup(); }
});

test('wa connect hand-off: asks once for the agents found, honours --agents and a "no"', async () => {
  const s = sandbox({ claude: true });
  try {
    mkdirSync(join(s.home, '.hermes'));
    const out = [];
    const line = (x = '') => out.push(x);
    let asked = null;
    assert.equal(await offerAgents({}, { line, env: s.env, run: runQuiet, confirm: async (q) => { asked = q; return false; } }), 0);
    assert.match(asked, /Claude Code, Hermes Agent/);
    assert.match(out.join('\n'), /Skipped/);
    assert.equal(existsSync(join(s.home, '.claude.json')), false, 'a "no" changes nothing');

    out.length = 0;
    assert.equal(await offerAgents({ agents: 'hermes' }, { line, env: s.env, run: runQuiet, confirm: async () => { throw new Error('must not ask'); } }), 0);
    assert.match(out.join('\n'), /Hermes Agent: MCP server "wa" added/);
    assert.match(out.join('\n'), /nothing is sent until you approve/);
    assert.equal(existsSync(join(s.home, '.claude.json')), false, 'only the chosen agent');
  } finally { s.cleanup(); }
});

test('print: ready-to-paste snippets for any other MCP client', () => {
  const env = { WA_BRIDGE_LAUNCHER: process.execPath }; // any existing file stands in for the launcher
  assert.deepEqual(JSON.parse(snippet('json', env)), { mcpServers: { wa: { command: process.execPath, args: ['mcp'] } } });
  assert.deepEqual(JSON.parse(JSON.stringify(parseToml(snippet('toml', env)).mcp_servers.wa)), { command: process.execPath, args: ['mcp'] });
  assert.deepEqual(parseDocument(snippet('yaml', env)).toJSON().mcp_servers.wa, { command: process.execPath, args: ['mcp'] });
  assert.throws(() => snippet('xml', env), /usage/);
});

test('a file the user edited after our add is never deleted or reverted by a later update + remove', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, '.codex'));
    const file = join(s.home, '.codex', 'config.toml');
    addAgents([byId('codex')], s.ctx()); // creates config.toml
    writeFileSync(file, readFileSync(file, 'utf8') + '\nmodel = "o3"\n'); // the user's own setting
    const moved = join(s.root, 'moved-wa-bridge');
    writeFileSync(moved, '#!/bin/sh\n');
    const env2 = { ...s.env, WA_BRIDGE_LAUNCHER: moved };
    assert.equal(addAgents([byId('codex')], makeContext({ env: env2, run: runQuiet }))[0].mcp, 'updated');
    const [rm] = removeAgents([byId('codex')], makeContext({ env: env2, run: runQuiet }));
    assert.notEqual(rm.how, 'deleted');
    assert.ok(existsSync(file), 'the file survives');
    const text = readFileSync(file, 'utf8');
    assert.match(text, /model = "o3"/, "the user's setting survives");
    assert.doesNotMatch(text, /mcp_servers\.wa/, 'our entry is gone');
  } finally { s.cleanup(); }
});
