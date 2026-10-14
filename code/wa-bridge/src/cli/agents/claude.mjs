// Claude Code: the MCP server at user scope (every session of this user) through the official CLI, which owns
// ~/.claude.json and its locking; the skill in ~/.claude/skills/wa-bridge.

import { join } from 'node:path';
import { home, looksLikeWaBridge, readText, sameCommand, SERVER_NAME, SKILL_NAME, which } from './common.mjs';

const configDir = (env) => env.CLAUDE_CONFIG_DIR || join(home(env), '.claude');
const configFile = (env) => (env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home(env), '.claude.json'));

function readConfig(env) {
  const t = readText(configFile(env));
  if (!t) return {};
  try { return JSON.parse(t); } catch { return {}; }
}

export default {
  id: 'claude',
  name: 'Claude Code',
  restartHint: 'new Claude Code sessions pick it up; restart open ones',

  detect({ env }) {
    const cli = which('claude', env);
    return { found: !!cli || !!readText(configFile(env)), cli };
  },

  skillDir: ({ env }) => join(configDir(env), 'skills', SKILL_NAME),

  status({ env, entry }) {
    const cfg = readConfig(env);
    const current = cfg.mcpServers?.[SERVER_NAME] || null;
    const shadowedIn = Object.entries(cfg.projects || {}).filter(([, p]) => p?.mcpServers?.[SERVER_NAME]).map(([dir]) => dir);
    let mcp = 'missing';
    if (current) mcp = sameCommand(current, entry) && sameEnv(current.env, entry.env) ? 'ok' : looksLikeWaBridge(current) ? 'outdated' : 'conflict';
    return { mcp, where: `${configFile(env)} (user scope)`, current, notes: shadowedIn.length ? [`a project-scoped "${SERVER_NAME}" server overrides it in: ${shadowedIn.join(', ')}`] : [] };
  },

  add(ctx) {
    const { env, entry, run, force } = ctx;
    const st = this.status(ctx);
    if (st.mcp === 'ok') return { mcp: 'unchanged', notes: st.notes };
    if (st.mcp === 'conflict' && !force) throw conflict(`Claude Code already has a different MCP server named "${SERVER_NAME}" (${st.current.command})`);
    const cli = which('claude', env);
    if (!cli) throw new Error('the `claude` command is not on PATH; add the server by hand (see: wa agents print)');
    if (st.mcp !== 'missing') mustRun(run(cli, ['mcp', 'remove', '-s', 'user', SERVER_NAME]), 'claude mcp remove');
    const envFlags = Object.entries(entry.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    mustRun(run(cli, ['mcp', 'add', '-s', 'user', SERVER_NAME, ...envFlags, '--', entry.command, ...entry.args]), 'claude mcp add');
    if (this.status(ctx).mcp !== 'ok') throw new Error(`claude mcp add reported success but ${configFile(env)} does not show the server`);
    return { mcp: st.mcp === 'missing' ? 'added' : 'updated', notes: st.notes, record: { via: 'cli', scope: 'user' } };
  },

  remove(ctx) {
    const { env, run } = ctx;
    const st = this.status(ctx);
    if (st.mcp === 'missing') return { mcp: 'absent' };
    if (st.mcp === 'conflict') return { mcp: 'kept', notes: [`the "${SERVER_NAME}" server in Claude Code is not wa-bridge's; left alone`] };
    const cli = which('claude', env);
    if (!cli) throw new Error('the `claude` command is not on PATH; remove the server with: claude mcp remove -s user wa');
    mustRun(run(cli, ['mcp', 'remove', '-s', 'user', SERVER_NAME]), 'claude mcp remove');
    return { mcp: 'removed' };
  },
};

function sameEnv(a = {}, b = {}) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

function mustRun(r, what) {
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
}

function conflict(message) {
  return Object.assign(new Error(`${message}; remove it first, or re-run with --force to replace it`), { code: 'conflict' });
}
