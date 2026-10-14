// Shared pieces of the agent integrations: the MCP command line, the skill, safe file edits, the manifest.
//
// Safety rules for touching another program's config:
//  * back up first (<file>.wa-bridge-bak-<ts>, 0600: these files often hold API keys), keep the last 3
//  * write atomically (temp file + rename) and keep the file's original permissions
//  * re-parse what we wrote; on any doubt restore the backup and report
//  * record what we did in <data>/agents.json, so `remove` reverses exactly that: when the file is unchanged
//    since our edit we restore the backup byte for byte, otherwise we remove only our entry
//  * never overwrite or delete a skill directory we did not create (marker file .wa-bridge-managed)

import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { defaultDataDir } from '../../config.mjs';
import { launcherPath, selfCommand } from '../../self.mjs';
import { VERSION } from '../../version.mjs';

export const SERVER_NAME = 'wa';
export const SKILL_NAME = 'wa-bridge';
const SKILL_MARKER = '.wa-bridge-managed';
const SKILL_TEMPLATE = new URL('../../../skill/wa-bridge/SKILL.md', import.meta.url);

export const home = (env) => env.HOME || homedir();
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** First executable named `cmd` on env.PATH, or null. */
export function which(cmd, env = process.env) {
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}

/** Looks like a wa-bridge MCP entry (this install, an older one, or a source checkout), not someone else's "wa". */
export const looksLikeWaBridge = (e) => !!e && /wa-bridge|wa-mcp\.mjs|[\\/]bin[\\/]wa\.mjs/.test([e.command, ...(e.args || [])].join(' '));

/** The MCP server entry every agent gets: an absolute command, plus env only when running from a checkout. */
export function mcpCommand(env = process.env) {
  const [command, ...prefix] = selfCommand(env);
  const extraEnv = {};
  if (!launcherPath(env)) { // the installed launcher pins the data dir itself
    if (env.WA_BRIDGE_HOME) extraEnv.WA_BRIDGE_HOME = env.WA_BRIDGE_HOME;
    if (env.WA_BRIDGE_PORT) extraEnv.WA_BRIDGE_PORT = env.WA_BRIDGE_PORT;
  }
  return { command, args: [...prefix, 'mcp'], env: extraEnv };
}

export const sameCommand = (a, b) => !!a && !!b && a.command === b.command && JSON.stringify(a.args || []) === JSON.stringify(b.args || []);

const shellQuote = (s) => (/^[A-Za-z0-9_\-./=:@+%]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

export function renderSkill(env = process.env) {
  const [command, ...prefix] = selfCommand(env);
  const launcher = [command, ...prefix].map(shellQuote).join(' ');
  return readFileSync(SKILL_TEMPLATE, 'utf8').replaceAll('{{VERSION}}', VERSION).replaceAll('{{LAUNCHER}}', launcher);
}

// ---------------------------------------------------------------- files

/**
 * Write atomically, keeping an existing file's mode (new files get `mode`). A symlinked config (dotfile
 * managers) is written through to its target, so the link survives.
 */
export function atomicWrite(pathIn, text, { mode = 0o600 } = {}) {
  const path = existsSync(pathIn) ? realpathSync(pathIn) : pathIn;
  mkdirSync(dirname(path), { recursive: true });
  const keep = existsSync(path) ? statSync(path).mode & 0o777 : mode;
  const tmp = join(dirname(path), `.${basename(path)}.wa-bridge-${process.pid}.tmp`);
  writeFileSync(tmp, text, { mode: keep });
  chmodSync(tmp, keep);
  renameSync(tmp, path);
}

/** Copy `path` aside before editing it (0600, newest 3 kept). Returns the backup path, or null if there was no file. */
export function backup(path, now = Date.now()) {
  if (!existsSync(path)) return null;
  const dest = `${path}.wa-bridge-bak-${now}`;
  copyFileSync(path, dest);
  chmodSync(dest, 0o600);
  const prefix = `${basename(path)}.wa-bridge-bak-`;
  const olds = readdirSync(dirname(path)).filter((f) => f.startsWith(prefix)).sort().reverse().slice(3);
  for (const f of olds) rmSync(join(dirname(path), f), { force: true });
  return dest;
}

export const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/**
 * Apply an edit to a config file safely. `edit(text|null) -> newText`; `validate(newText)` must throw on a bad
 * result. Returns { changed, record } where record goes into the manifest (null when nothing changed).
 */
export function editFile(path, edit, validate) {
  const before = readText(path);
  const after = edit(before);
  if (after === before) return { changed: false, record: null };
  validate(after);
  const bak = backup(path);
  atomicWrite(path, after);
  return { changed: true, record: { file: path, backup: bak, created: before === null, sha256: sha256(after), beforeSha256: before === null ? null : sha256(before) } };
}

/**
 * Undo an edit made by editFile. If the file is exactly what we wrote, restore the backup byte for byte (or
 * delete a file we created). Otherwise apply `structural(text) -> newText` (remove only our entry).
 * Returns 'restored' | 'deleted' | 'edited' | 'unchanged' | 'missing'.
 */
export function undoEdit(record, structural, validate) {
  const now = readText(record.file);
  if (now === null) return 'missing';
  if (sha256(now) === record.sha256) {
    if (record.created) { rmSync(record.file, { force: true }); return 'deleted'; }
    if (record.backup && existsSync(record.backup)) {
      const original = readFileSync(record.backup, 'utf8');
      validate(original);
      atomicWrite(record.file, original);
      return 'restored';
    }
  }
  const after = structural(now);
  if (after === now) return 'unchanged';
  validate(after);
  backup(record.file);
  atomicWrite(record.file, after);
  return 'edited';
}

// ---------------------------------------------------------------- skill

/** 'missing' | 'ok' | 'outdated' | 'foreign' (a wa-bridge skill dir we did not create). */
export function skillState(dir, text) {
  const file = join(dir, 'SKILL.md');
  if (!existsSync(file)) return 'missing';
  if (!existsSync(join(dir, SKILL_MARKER))) return 'foreign';
  return readFileSync(file, 'utf8') === text ? 'ok' : 'outdated';
}

/** Install or refresh the skill in `dir`. Never touches a foreign one. Returns the state before. */
export function installSkill(dir, text) {
  const state = skillState(dir, text);
  if (state === 'foreign' || state === 'ok') return state;
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, 'SKILL.md'), text, { mode: 0o644 });
  writeFileSync(join(dir, SKILL_MARKER), `managed by wa-bridge ${VERSION}; remove with: wa agents remove <agent>\n`, { mode: 0o644 });
  return state;
}

export function removeSkill(dir) {
  if (!existsSync(join(dir, SKILL_MARKER))) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------- manifest

export function manifestPath(dataDir = defaultDataDir()) {
  return join(dataDir, 'agents.json');
}

export function loadManifest(dataDir) {
  const t = readText(manifestPath(dataDir));
  if (!t) return { version: 1, agents: {}, skills: {} };
  const m = JSON.parse(t);
  return { version: 1, agents: m.agents || {}, skills: m.skills || {} };
}

export function saveManifest(dataDir, m) {
  atomicWrite(manifestPath(dataDir), JSON.stringify(m, null, 2) + '\n', { mode: 0o600 });
}

/** Reference-count a skill copy: `agent` relies on the skill in `dir`. */
export function useSkill(m, dir, agent) {
  const users = new Set(m.skills[dir]?.users || []);
  users.add(agent);
  m.skills[dir] = { users: [...users].sort() };
}

/** Drop `agent` from every skill copy; returns the dirs nobody uses any more. */
export function releaseSkills(m, agent) {
  const freed = [];
  for (const [dir, s] of Object.entries(m.skills)) {
    const users = (s.users || []).filter((u) => u !== agent);
    if (users.length) m.skills[dir] = { users };
    else { delete m.skills[dir]; freed.push(dir); }
  }
  return freed;
}
