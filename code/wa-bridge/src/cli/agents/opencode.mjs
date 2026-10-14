// OpenCode: the server in ~/.config/opencode/opencode.json[c], edited with jsonc-parser so comments and
// formatting survive. OpenCode 2 nests servers under "mcp.servers" (what `opencode mcp add --global` writes);
// OpenCode 1 uses "mcp.<name>" with "enabled". The skill: OpenCode also reads ~/.claude/skills and
// ~/.agents/skills, so it reuses a copy there when one exists instead of adding a duplicate of its own.
//
// OpenCode's own CLI is not used to validate: `opencode mcp list` / `debug config` start its background server.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import jsonc from 'jsonc-parser';
import { editFile, home, looksLikeWaBridge, readText, SERVER_NAME, SKILL_NAME, skillState, undoEdit, which } from './common.mjs';

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };

const configDir = (env) => join(env.XDG_CONFIG_HOME || join(home(env), '.config'), 'opencode');
function configFile(env) {
  for (const n of ['opencode.jsonc', 'opencode.json']) {
    const p = join(configDir(env), n);
    if (readText(p) !== null) return p;
  }
  return join(configDir(env), 'opencode.json');
}

function parse(text) {
  const errors = [];
  const value = jsonc.parse(text || '{}', errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`syntax error at offset ${errors[0].offset} (${jsonc.printParseErrorCode(errors[0].error)})`);
  return value ?? {};
}

/** Major version of the installed OpenCode, else inferred from the config's shape; 2 when nothing says otherwise. */
function majorVersion({ env, run }, cfg) {
  const cli = which('opencode', env);
  if (cli) {
    const m = /(\d+)\.\d+/.exec(run(cli, ['--version']).stdout || '');
    if (m) return Number(m[1]);
  }
  if (cfg?.mcp?.servers) return 2;
  if (cfg?.mcp && Object.values(cfg.mcp).some((v) => v && typeof v === 'object' && v.type)) return 1;
  return 2;
}

const keyPath = (major) => (major >= 2 ? ['mcp', 'servers', SERVER_NAME] : ['mcp', SERVER_NAME]);

function value(entry, major) {
  const v = { type: 'local', command: [entry.command, ...entry.args] };
  if (major < 2) v.enabled = true;
  if (Object.keys(entry.env).length) v.environment = { ...entry.env };
  return v;
}

function getPath(obj, path) {
  return path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

const asEntry = (v) => (v && Array.isArray(v.command) ? { command: v.command[0], args: v.command.slice(1), env: v.environment || {} } : null);

export default {
  id: 'opencode',
  name: 'OpenCode',
  restartHint: 'restart OpenCode (or run: opencode reload) to load it',

  detect({ env }) {
    const cli = which('opencode', env);
    return { found: !!cli || existsSync(configDir(env)), cli };
  },

  /** Prefer a shared copy OpenCode already reads; otherwise its own skills dir. */
  skillDir({ env }, skillText) {
    for (const d of [join(home(env), '.agents', 'skills', SKILL_NAME), join(home(env), '.claude', 'skills', SKILL_NAME)]) {
      if (skillState(d, skillText) !== 'missing') return d;
    }
    return join(configDir(env), 'skills', SKILL_NAME);
  },
  ownSkillDir: ({ env }) => join(configDir(env), 'skills', SKILL_NAME),

  status(ctx) {
    const { env, entry } = ctx;
    const file = configFile(env);
    let cfg;
    try { cfg = parse(readText(file)); } catch (e) { return { mcp: 'broken', where: file, notes: [`${file}: ${e.message}`] }; }
    const major = majorVersion(ctx, cfg);
    const want = value(entry, major);
    const current = getPath(cfg, keyPath(major));
    const other = getPath(cfg, keyPath(major >= 2 ? 1 : 2));
    let mcp = 'missing';
    if (current) mcp = JSON.stringify(current) === JSON.stringify(want) ? 'ok' : looksLikeWaBridge(asEntry(current)) ? 'outdated' : 'conflict';
    const notes = other && looksLikeWaBridge(asEntry(other)) ? [`an entry in the OpenCode ${major >= 2 ? '1' : '2'} format is also present (${keyPath(major >= 2 ? 1 : 2).join('.')})`] : [];
    return { mcp, where: `${file} (${keyPath(major).join('.')})`, current: asEntry(current), notes, major };
  },

  add(ctx) {
    const { env, entry, force } = ctx;
    const st = this.status(ctx);
    if (st.mcp === 'broken') throw new Error(`${st.notes[0]}; fix it first`);
    if (st.mcp === 'ok') return { mcp: 'unchanged', notes: st.notes };
    if (st.mcp === 'conflict' && !force) {
      throw Object.assign(new Error(`OpenCode already has a different MCP server named "${SERVER_NAME}" (${st.current?.command}); remove it first, or re-run with --force to replace it`), { code: 'conflict' });
    }
    const path = keyPath(st.major);
    const want = value(entry, st.major);
    const { record } = editFile(configFile(env), (text) => {
      const t = text ?? '{}\n';
      return jsonc.applyEdits(t, jsonc.modify(t, path, want, FORMAT));
    }, (t) => {
      if (JSON.stringify(getPath(parse(t), path)) !== JSON.stringify(want)) throw new Error('the written OpenCode config does not contain the expected server entry');
    });
    return { mcp: st.mcp === 'missing' ? 'added' : 'updated', notes: st.notes, record };
  },

  remove(ctx) {
    const { env, manifest } = ctx;
    const st = this.status(ctx);
    if (st.mcp === 'broken') throw new Error(`${st.notes[0]}; fix it first`);
    if (st.mcp === 'missing') return { mcp: 'absent' };
    if (st.mcp === 'conflict') return { mcp: 'kept', notes: [`the "${SERVER_NAME}" server in OpenCode is not wa-bridge's; left alone`] };
    const path = keyPath(st.major);
    const rec = manifest.agents.opencode?.mcp?.file ? manifest.agents.opencode.mcp : { file: configFile(env), sha256: null };
    const how = undoEdit(rec, (t) => {
      let out = jsonc.applyEdits(t, jsonc.modify(t, path, undefined, FORMAT));
      // drop containers we may have created and that are now empty
      for (const p of st.major >= 2 ? [['mcp', 'servers'], ['mcp']] : [['mcp']]) {
        const v = getPath(parse(out), p);
        if (v && typeof v === 'object' && !Object.keys(v).length) out = jsonc.applyEdits(out, jsonc.modify(out, p, undefined, FORMAT));
      }
      return out;
    }, (t) => parse(t));
    return { mcp: 'removed', how };
  },
};
