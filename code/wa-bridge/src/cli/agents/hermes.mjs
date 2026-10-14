// Hermes Agent: mcp_servers.wa in $HERMES_HOME/config.yaml (default ~/.hermes), edited through the `yaml`
// Document API so comments and layout survive; the skill in ~/.hermes/skills/messaging/wa-bridge.
// Hermes picks up new skills on its own; MCP config changes need a restart (or a new session).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, isMap } from 'yaml';
import { editFile, home, looksLikeWaBridge, readText, sameCommand, SERVER_NAME, SKILL_NAME, undoEdit, which } from './common.mjs';

const hermesHome = (env) => env.HERMES_HOME || join(home(env), '.hermes');
const configFile = (env) => join(hermesHome(env), 'config.yaml');

function parse(text) {
  const doc = parseDocument(text || '', { keepSourceTokens: false });
  if (doc.errors.length) throw new Error(doc.errors[0].message.split('\n')[0]);
  return doc;
}

function value(entry) {
  const v = { command: entry.command, args: [...entry.args] };
  if (Object.keys(entry.env).length) v.env = { ...entry.env };
  return v;
}

function currentEntry(doc) {
  const v = doc.getIn(['mcp_servers', SERVER_NAME]);
  const j = v && typeof v.toJSON === 'function' ? v.toJSON() : v;
  return j && typeof j === 'object' ? { command: j.command, args: j.args || [], env: j.env || {} } : null;
}

export default {
  id: 'hermes',
  name: 'Hermes Agent',
  restartHint: 'restart Hermes (or start a new session) to load it',

  detect({ env }) {
    const cli = which('hermes', env);
    return { found: !!cli || existsSync(hermesHome(env)), cli };
  },

  skillDir: ({ env }) => join(hermesHome(env), 'skills', 'messaging', SKILL_NAME),

  status({ env, entry }) {
    let doc;
    try { doc = parse(readText(configFile(env))); } catch (e) { return { mcp: 'broken', where: configFile(env), notes: [`${configFile(env)}: ${e.message}`] }; }
    const current = currentEntry(doc);
    let mcp = 'missing';
    if (current) mcp = sameCommand(current, entry) && JSON.stringify(current.env) === JSON.stringify(entry.env) ? 'ok' : looksLikeWaBridge(current) ? 'outdated' : 'conflict';
    return { mcp, where: `${configFile(env)} (mcp_servers.${SERVER_NAME})`, current, notes: [] };
  },

  add(ctx) {
    const { env, entry, force } = ctx;
    const st = this.status(ctx);
    if (st.mcp === 'broken') throw new Error(`${st.notes[0]}; fix it first`);
    if (st.mcp === 'ok') return { mcp: 'unchanged' };
    if (st.mcp === 'conflict' && !force) {
      throw Object.assign(new Error(`Hermes already has a different MCP server named "${SERVER_NAME}" (${st.current?.command}); remove it first, or re-run with --force to replace it`), { code: 'conflict' });
    }
    const want = value(entry);
    const { record } = editFile(configFile(env), (text) => {
      const doc = parse(text);
      if (doc.contents === null || doc.contents === undefined) doc.contents = doc.createNode({});
      const servers = doc.get('mcp_servers', true);
      if (!isMap(servers)) doc.set('mcp_servers', doc.createNode({ [SERVER_NAME]: want }));
      else servers.set(SERVER_NAME, doc.createNode(want));
      return String(doc);
    }, (t) => {
      if (!sameCommand(currentEntry(parse(t)), entry)) throw new Error('the written config.yaml does not contain the expected mcp_servers.wa entry');
    });
    return { mcp: st.mcp === 'missing' ? 'added' : 'updated', record };
  },

  remove(ctx) {
    const { env, manifest } = ctx;
    const st = this.status(ctx);
    if (st.mcp === 'broken') throw new Error(`${st.notes[0]}; fix it first`);
    if (st.mcp === 'missing') return { mcp: 'absent' };
    if (st.mcp === 'conflict') return { mcp: 'kept', notes: [`the "${SERVER_NAME}" server in Hermes is not wa-bridge's; left alone`] };
    const rec = manifest.agents.hermes?.mcp?.file ? manifest.agents.hermes.mcp : { file: configFile(env), sha256: null };
    const how = undoEdit(rec, (t) => {
      const doc = parse(t);
      doc.deleteIn(['mcp_servers', SERVER_NAME]);
      const servers = doc.get('mcp_servers', true);
      if (isMap(servers) && servers.items.length === 0) doc.delete('mcp_servers');
      return String(doc);
    }, (t) => parse(t));
    return { mcp: 'removed', how };
  },
};
