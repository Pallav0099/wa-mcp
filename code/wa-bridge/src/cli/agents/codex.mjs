// Codex: an [mcp_servers.wa] table in $CODEX_HOME/config.toml (default ~/.codex), written as one marked block so
// it can be found and removed exactly; the skill in ~/.agents/skills/wa-bridge (Codex's user skill directory).
//
// The table is edited directly instead of through `codex mcp add` so that tool_timeout_sec can be raised for
// media downloads (Codex's default is 60 s) and so the result is validated by re-parsing the TOML.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { editFile, home, looksLikeWaBridge, readText, sameCommand, SERVER_NAME, SKILL_NAME, undoEdit, which } from './common.mjs';

const BEGIN = '# >>> wa-bridge: WhatsApp MCP server (managed by `wa agents`; remove with: wa agents remove codex) >>>';
const END = '# <<< wa-bridge <<<';
const TOOL_TIMEOUT_SEC = 180;

/** Line range [start, end] of our block, start including the one blank separator line we add; or null. */
function blockRange(text) {
  const lines = String(text || '').split('\n');
  const i = lines.findIndex((l) => l.startsWith('# >>> wa-bridge:'));
  if (i < 0) return null;
  const j = lines.findIndex((l, k) => k > i && l === END);
  if (j < 0) return null; // an incomplete block is someone's edit: leave it alone
  return { lines, start: i > 0 && lines[i - 1] === '' ? i - 1 : i, begin: i, end: j };
}

const hasBlock = (text) => !!blockRange(text);

export function stripBlock(text) {
  const r = blockRange(text);
  if (!r) return text;
  r.lines.splice(r.start, r.end - r.start + 1);
  return r.lines.join('\n');
}

function replaceBlock(text, newBlock) {
  const r = blockRange(text);
  r.lines.splice(r.begin, r.end - r.begin + 1, ...newBlock.replace(/\n$/, '').split('\n'));
  return r.lines.join('\n');
}

const codexHome = (env) => env.CODEX_HOME || join(home(env), '.codex');
const configFile = (env) => join(codexHome(env), 'config.toml');
const tomlString = (s) => JSON.stringify(String(s)); // a JSON string is a valid TOML basic string

function block(entry) {
  const lines = [
    BEGIN,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
    `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
  ];
  if (Object.keys(entry.env).length) {
    lines.push(`[mcp_servers.${SERVER_NAME}.env]`, ...Object.entries(entry.env).map(([k, v]) => `${k} = ${tomlString(v)}`));
  }
  lines.push(END);
  return lines.join('\n') + '\n';
}

function parse(text) {
  try { return parseToml(text || ''); } catch (e) { throw new Error(`${e.message.split('\n')[0]}`); }
}

function currentEntry(text) {
  const t = parse(text).mcp_servers?.[SERVER_NAME];
  return t ? { command: t.command, args: t.args || [], env: t.env || {} } : null;
}

const validateFor = (entry) => (text) => {
  const got = currentEntry(text);
  if (!sameCommand(got, entry)) throw new Error('the written config.toml does not contain the expected [mcp_servers.wa] table');
};

export default {
  id: 'codex',
  name: 'Codex',
  restartHint: 'restart Codex to load it',

  detect({ env }) {
    const cli = which('codex', env);
    return { found: !!cli || existsSync(codexHome(env)), cli };
  },

  skillDir: ({ env }) => join(home(env), '.agents', 'skills', SKILL_NAME),

  status({ env, entry }) {
    const text = readText(configFile(env));
    let current;
    try { current = currentEntry(text); } catch (e) { return { mcp: 'broken', where: configFile(env), notes: [`config.toml does not parse: ${e.message}`] }; }
    const managed = hasBlock(text);
    let mcp = 'missing';
    if (current) mcp = sameCommand(current, entry) ? 'ok' : managed || looksLikeWaBridge(current) ? 'outdated' : 'conflict';
    return { mcp, where: configFile(env), current, managed, notes: [] };
  },

  add(ctx) {
    const { env, entry, force } = ctx;
    const st = this.status(ctx);
    if (st.mcp === 'broken') throw new Error(`${configFile(env)}: ${st.notes[0]}; fix it first`);
    if (st.mcp === 'ok') return { mcp: 'unchanged', notes: st.managed ? [] : ['configured by hand; left as is'] };
    if (st.mcp !== 'missing' && !st.managed) {
      throw Object.assign(new Error(`${configFile(env)} already defines [mcp_servers.${SERVER_NAME}] (${st.current.command}); remove that table first${force ? ' (--force does not edit hand-written TOML)' : ''}`), { code: 'conflict' });
    }
    const { record } = editFile(configFile(env), (text) => {
      const t = text || '';
      if (hasBlock(t)) return replaceBlock(t, block(entry));
      return t + (t && !t.endsWith('\n') ? '\n' : '') + (t ? '\n' : '') + block(entry);
    }, validateFor(entry));
    return { mcp: st.mcp === 'missing' ? 'added' : 'updated', record };
  },

  remove(ctx) {
    const { env, manifest } = ctx;
    const text = readText(configFile(env));
    if (!text || !hasBlock(text)) {
      const st = this.status(ctx);
      return st.mcp === 'missing' ? { mcp: 'absent' } : { mcp: 'kept', notes: ['the [mcp_servers.wa] table was not written by wa-bridge; left alone'] };
    }
    const rec = manifest.agents.codex?.mcp?.file ? manifest.agents.codex.mcp : { file: configFile(env), sha256: null };
    const how = undoEdit(rec, stripBlock, (t) => parse(t));
    return { mcp: 'removed', how };
  },
};
