// `wa agents`: put the WhatsApp MCP server + skill into the agents on this machine, check them, take them out.
// Also the step `wa connect` ends with, and the agent section of `wa doctor`.

import { mkdirSync } from 'node:fs';
import { defaultDataDir } from '../../config.mjs';
import { runQuiet } from '../../service.mjs';
import { VERSION } from '../../version.mjs';
import { usage } from '../args.mjs';
import { confirm as askConfirm } from '../prompt.mjs';
import claude from './claude.mjs';
import codex from './codex.mjs';
import hermes from './hermes.mjs';
import opencode from './opencode.mjs';
import {
  installSkill, loadManifest, mcpCommand, releaseSkills, removeSkill, renderSkill, saveManifest, SERVER_NAME, skillState, useSkill,
} from './common.mjs';

// OpenCode last: it reuses a skill copy the others put where it also looks.
export const AGENTS = [claude, codex, hermes, opencode];
const BY_ID = new Map(AGENTS.map((a) => [a.id, a]));
const ALIASES = { 'claude-code': 'claude', cc: 'claude', 'open-code': 'opencode', 'hermes-agent': 'hermes' };

export function makeContext({ env = process.env, run = runQuiet, force = false } = {}) {
  const dataDir = defaultDataDir(env);
  // Agent CLIs (claude, opencode) read HOME and their config dirs from the environment: they must see exactly
  // the environment this context describes, never the ambient one.
  const runIn = (cmd, args) => run(cmd, args, env);
  return { env, run: runIn, force, dataDir, entry: mcpCommand(env), skillText: renderSkill(env), manifest: loadManifest(dataDir) };
}

function persist(ctx) {
  mkdirSync(ctx.dataDir, { recursive: true, mode: 0o700 });
  saveManifest(ctx.dataDir, ctx.manifest);
}

export function resolveIds(ids, ctx, { forAdd }) {
  const list = ids.flatMap((s) => String(s).split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) throw usage(`wa agents ${forAdd ? 'add' : 'remove'} <${AGENTS.map((a) => a.id).join('|')}|all>`);
  if (list.includes('all')) {
    return forAdd ? AGENTS.filter((a) => a.detect(ctx).found) : AGENTS.filter((a) => ctx.manifest.agents[a.id] || a.status(ctx).mcp !== 'missing');
  }
  const out = [];
  for (const id of list) {
    const a = BY_ID.get(ALIASES[id] || id);
    if (!a) throw usage(`unknown agent "${id}"; known: ${AGENTS.map((x) => x.id).join(', ')}, all`);
    if (!out.includes(a)) out.push(a);
  }
  return AGENTS.filter((a) => out.includes(a)); // canonical order
}

/** Keep the original pre-wa-bridge backup across updates, so `remove` can still restore the untouched file. */
function mergeRecord(prev, rec) {
  if (prev?.file && rec?.file && prev.file === rec.file) return { ...rec, backup: prev.backup, created: prev.created };
  return rec;
}

export function addAgent(agent, ctx) {
  if (!agent.detect(ctx).found && !ctx.force) return { id: agent.id, name: agent.name, skipped: 'not found on this machine (--force to configure it anyway)' };
  const res = agent.add(ctx);
  const dir = agent.skillDir(ctx, ctx.skillText);
  const before = installSkill(dir, ctx.skillText);
  useSkill(ctx.manifest, dir, agent.id);
  const prev = ctx.manifest.agents[agent.id] || {};
  ctx.manifest.agents[agent.id] = {
    mcp: res.record ? mergeRecord(prev.mcp, res.record) : prev.mcp || { via: 'existing' },
    skill: dir,
    addedAt: prev.addedAt || new Date().toISOString(),
    version: VERSION,
  };
  const skill = { missing: 'installed', outdated: 'updated', ok: 'unchanged', foreign: 'kept (not created by wa-bridge)' }[before];
  return { id: agent.id, name: agent.name, mcp: res.mcp, skill, skillDir: dir, notes: res.notes || [], restartHint: agent.restartHint };
}

export function removeAgent(agent, ctx) {
  const res = agent.remove(ctx);
  const freed = releaseSkills(ctx.manifest, agent.id);
  const removedSkills = freed.filter((d) => removeSkill(d));
  delete ctx.manifest.agents[agent.id];
  return { id: agent.id, name: agent.name, mcp: res.mcp, how: res.how, skill: removedSkills.length ? 'removed' : 'kept', notes: res.notes || [] };
}

/** If OpenCode got its own skill copy and a shared one now exists where it also looks, drop the duplicate. */
function rehomeOpencodeSkill(ctx) {
  const cur = ctx.manifest.agents.opencode?.skill;
  if (!cur) return;
  const want = opencode.skillDir(ctx, ctx.skillText);
  if (want === cur) return;
  useSkill(ctx.manifest, want, 'opencode');
  ctx.manifest.skills[cur] = { users: (ctx.manifest.skills[cur]?.users || []).filter((u) => u !== 'opencode') };
  if (!ctx.manifest.skills[cur].users.length) { delete ctx.manifest.skills[cur]; removeSkill(cur); }
  ctx.manifest.agents.opencode.skill = want;
}

/** Add to several agents; each one independently (one failure does not stop the others). */
export function addAgents(agents, ctx) {
  const results = [];
  for (const a of agents) {
    try { results.push(addAgent(a, ctx)); } catch (e) { results.push({ id: a.id, name: a.name, error: e.message }); }
  }
  rehomeOpencodeSkill(ctx);
  persist(ctx);
  return results;
}

export function removeAgents(agents, ctx) {
  const results = [];
  for (const a of agents) {
    try { results.push(removeAgent(a, ctx)); } catch (e) { results.push({ id: a.id, name: a.name, error: e.message }); }
  }
  persist(ctx);
  return results;
}

export function listAgents(ctx) {
  return AGENTS.map((a) => {
    const det = a.detect(ctx);
    const st = a.status(ctx);
    const dir = ctx.manifest.agents[a.id]?.skill || a.skillDir(ctx, ctx.skillText);
    return { id: a.id, name: a.name, found: det.found, mcp: st.mcp, where: st.where, notes: st.notes || [], skillDir: dir, skill: skillState(dir, ctx.skillText) };
  });
}

// ---------------------------------------------------------------- output

const MCP_TEXT = { ok: '✓ configured', missing: '— not configured', outdated: '! outdated', conflict: '✗ another "wa" server', broken: '✗ config does not parse' };
const SKILL_TEXT = { ok: '✓ installed', missing: '— missing', outdated: '! outdated', foreign: '· present (not ours)' };

function printAdd(results, line) {
  for (const r of results) {
    if (r.skipped) line(`  · ${r.name}: skipped, ${r.skipped}`);
    else if (r.error) line(`  ✗ ${r.name}: ${r.error}`);
    else {
      line(`  ✓ ${r.name}: MCP server "${SERVER_NAME}" ${r.mcp} · skill ${r.skill} (${r.skillDir})`);
      for (const n of r.notes) line(`      note: ${n}`);
    }
  }
}

function printRemove(results, line) {
  for (const r of results) {
    if (r.error) line(`  ✗ ${r.name}: ${r.error}`);
    else {
      line(`  ✓ ${r.name}: MCP server ${r.mcp}${r.how ? ` (${r.how})` : ''} · skill ${r.skill}`);
      for (const n of r.notes) line(`      note: ${n}`);
    }
  }
}

export function snippet(format, env = process.env) {
  const e = mcpCommand(env);
  const hasEnv = Object.keys(e.env).length > 0;
  if (format === 'toml') {
    const q = (s) => JSON.stringify(s);
    return [`[mcp_servers.${SERVER_NAME}]`, `command = ${q(e.command)}`, `args = [${e.args.map(q).join(', ')}]`,
      ...(hasEnv ? [`[mcp_servers.${SERVER_NAME}.env]`, ...Object.entries(e.env).map(([k, v]) => `${k} = ${q(v)}`)] : [])].join('\n');
  }
  if (format === 'yaml') {
    const q = (s) => JSON.stringify(s);
    return ['mcp_servers:', `  ${SERVER_NAME}:`, `    command: ${q(e.command)}`, `    args: [${e.args.map(q).join(', ')}]`,
      ...(hasEnv ? ['    env:', ...Object.entries(e.env).map(([k, v]) => `      ${k}: ${q(v)}`)] : [])].join('\n');
  }
  if (format !== 'json') throw usage('wa agents print [--format json|toml|yaml] | wa agents print skill');
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: e.command, args: e.args, ...(hasEnv ? { env: e.env } : {}) } } }, null, 2);
}

export async function agentsCommand(pos, flags, { env = process.env, run = runQuiet, line = (s = '') => console.log(s) } = {}) {
  const sub = pos[0] || 'list';
  if (sub === 'print') {
    if (pos[1] === 'skill') { process.stdout.write(renderSkill(env)); return 0; }
    line(snippet(flags.format || 'json', env));
    return 0;
  }
  const ctx = makeContext({ env, run, force: !!flags.force });
  if (sub === 'list') {
    const rows = listAgents(ctx);
    if (flags.json) { line(JSON.stringify(rows, null, 2)); return 0; }
    for (const r of rows) {
      if (!r.found && r.mcp === 'missing') { line(`  · ${r.name.padEnd(13)} not found on this machine`); continue; }
      line(`  ${r.name.padEnd(15)} MCP ${MCP_TEXT[r.mcp] || r.mcp}   skill ${SKILL_TEXT[r.skill] || r.skill}`);
      for (const n of r.notes) line(`      note: ${n}`);
    }
    line('\nAdd: wa agents add <claude|codex|opencode|hermes|all> · any other MCP client: wa agents print');
    return 0;
  }
  if (sub === 'add') {
    const agents = resolveIds(pos.slice(1), ctx, { forAdd: true });
    if (!agents.length) { line('No supported agent found on this machine. For any other MCP client: wa agents print'); return 1; }
    const results = addAgents(agents, ctx);
    printAdd(results, line);
    const done = results.filter((r) => !r.error && !r.skipped);
    if (done.length) line(`\n${done.map((r) => `${r.name}: ${r.restartHint}`).join('\n')}`);
    return results.some((r) => r.error) ? 1 : 0;
  }
  if (sub === 'remove') {
    const results = removeAgents(resolveIds(pos.slice(1), ctx, { forAdd: false }), ctx);
    if (!results.length) line('wa-bridge is not configured in any agent.');
    printRemove(results, line);
    return results.some((r) => r.error) ? 1 : 0;
  }
  throw usage('wa agents [list] | add <agent…|all> | remove <agent…|all> | print [--format json|toml|yaml] | print skill');
}

/** The last step of `wa connect`. Returns an exit code. */
export async function offerAgents(flags, { line, confirm = askConfirm, env = process.env, run = runQuiet } = {}) {
  const ctx = makeContext({ env, run, force: !!flags.force });
  let chosen;
  if (flags.agents) {
    chosen = resolveIds([flags.agents], ctx, { forAdd: true });
  } else {
    const found = AGENTS.filter((a) => a.detect(ctx).found);
    if (!found.length) {
      line('No supported agent found here (Claude Code, Codex, OpenCode, Hermes Agent).');
      line('For any other MCP client, paste the output of: wa agents print');
      return 0;
    }
    const ok = await confirm(`Add the WhatsApp tools + skill to ${found.map((a) => a.name).join(', ')}?`, { yes: flags.yes });
    if (!ok) { line('Skipped. Add them any time with: wa agents add all'); return 0; }
    chosen = found;
  }
  const results = addAgents(chosen, ctx);
  printAdd(results, line);
  const done = results.filter((r) => !r.error && !r.skipped);
  if (done.length) {
    line('');
    for (const r of done) line(`${r.name}: ${r.restartHint}.`);
    line('Then ask your agent: "what are my unread WhatsApp messages?"');
    line('Agents draft messages; nothing is sent until you approve the exact preview in the chat.');
  }
  return results.some((r) => r.error) ? 1 : 0;
}

export async function doctorChecks({ env = process.env, run = runQuiet } = {}) {
  const ctx = makeContext({ env, run });
  const checks = [];
  for (const r of listAgents(ctx)) {
    if (!r.found && r.mcp === 'missing') continue;
    const fine = r.mcp === 'ok' && (r.skill === 'ok' || r.skill === 'foreign');
    const bad = r.mcp === 'conflict' || r.mcp === 'broken';
    checks.push({
      level: fine ? 'ok' : bad ? 'fail' : 'warn',
      text: `${r.name}: MCP ${MCP_TEXT[r.mcp] || r.mcp}, skill ${SKILL_TEXT[r.skill] || r.skill}`,
      fix: bad ? (r.notes[0] || `check ${r.where}`) : `run: wa agents add ${r.id}`,
    });
  }
  if (!checks.length) checks.push({ level: 'info', text: 'no supported agent found (Claude Code, Codex, OpenCode, Hermes); any MCP client: wa agents print' });
  return checks;
}
