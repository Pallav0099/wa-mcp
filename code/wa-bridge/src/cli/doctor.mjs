// `wa doctor`: check every moving part and say what to do about each problem. Never starts or changes anything.

import { existsSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { which } from './agents/common.mjs';
import { clientConfig, stoppedFlag } from '../client.mjs';
import { ourDaemonAnswers } from '../lifecycle.mjs';
import { launcherPath } from '../self.mjs';
import { lingerEnabled, systemdAvailable, unitInstalled, unitPath, unitStatus, UNIT_NAME } from '../service.mjs';
import { formatTs, jidUser } from '../util.mjs';
import { VERSION } from '../version.mjs';

const MARK = { ok: '✓', warn: '!', fail: '✗', info: '·' };

function portInUse(port) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(800, () => done(false));
  });
}

export async function collectChecks({ agentChecks = defaultAgentChecks } = {}) {
  const checks = [];
  const add = (level, text, fix) => checks.push({ level, text, fix });

  const [maj, min] = process.versions.node.split('.').map(Number);
  add(maj > 22 || (maj === 22 && min >= 16) ? 'ok' : 'fail', `wa-bridge ${VERSION} on node ${process.version}`, 'needs node >= 22.16; reinstall with the install script');

  const launcher = launcherPath();
  if (launcher) add('ok', `installed launcher ${launcher}`);
  else add('info', 'running from a source checkout (no installed launcher)');
  const wa = which('wa');
  if (wa && launcher) {
    let same = false;
    try { same = realpathSync(wa) === realpathSync(launcher); } catch { /* broken link */ }
    add(same ? 'ok' : 'warn', same ? '`wa` on PATH is this wa-bridge' : `\`wa\` on PATH is another program (${wa})`, 'use `wa-bridge` instead of `wa`');
  } else if (launcher && !which('wa-bridge')) {
    add('warn', 'neither `wa` nor `wa-bridge` is on PATH', 'add ~/.local/bin to PATH (open a new terminal after installing)');
  }

  let cfg;
  try {
    cfg = clientConfig(undefined, { requireToken: false });
    add('ok', `config ${join(cfg.paths.root, 'config.json')} is valid`);
  } catch (e) {
    add('fail', e.message);
    return checks;
  }
  if (!existsSync(cfg.paths.root)) {
    add('warn', `no data directory yet (${cfg.paths.root})`, 'run: wa connect');
  } else if (process.platform !== 'win32') {
    const mode = statSync(cfg.paths.root).mode & 0o777;
    add(mode === 0o700 ? 'ok' : 'fail', `data dir ${cfg.paths.root} is ${mode === 0o700 ? 'private (0700)' : `mode ${mode.toString(8)}: other users may read your messages`}`, `chmod 700 ${cfg.paths.root}`);
    if (existsSync(cfg.paths.token)) {
      const tm = statSync(cfg.paths.token).mode & 0o777;
      add(tm === 0o600 ? 'ok' : 'fail', `API token ${tm === 0o600 ? 'is 0600' : `is mode ${tm.toString(8)}`}`, `chmod 600 ${cfg.paths.token}`);
    }
  }

  // service
  if (systemdAvailable()) {
    if (unitInstalled()) {
      const st = unitStatus();
      const fine = st?.active === 'active' && st.enabled === 'enabled';
      add(fine ? 'ok' : 'warn', `service ${UNIT_NAME}: ${st ? `${st.enabled}, ${st.active} (${st.sub})${st.restarts ? `, ${st.restarts} restart(s)` : ''}` : 'unknown'}`, st?.active !== 'active' ? 'run: wa start   (details: wa logs)' : 'run: wa start');
      const linger = lingerEnabled();
      if (linger === false) add('warn', 'lingering is off: the service stops when you log out and does not start at boot until you log in', `to keep it always on: loginctl enable-linger ${process.env.USER || '$USER'}`);
    } else {
      add('warn', `no background service yet (${unitPath()})`, 'run: wa start   (or wa connect)');
    }
  } else {
    add('info', 'no systemd user session: the daemon runs detached and does not survive a reboot', 'after a reboot run: wa start');
  }
  if (existsSync(stoppedFlag(cfg.paths))) add('warn', 'stopped with `wa stop`; agents will not restart it', 'run: wa start');

  // daemon + link
  const up = cfg.token && (await ourDaemonAnswers(cfg.port, cfg.token));
  if (!up) {
    const busy = await portInUse(cfg.port);
    add('fail', busy ? `port ${cfg.port} is used by another program, not wa-bridge` : `daemon is not answering on 127.0.0.1:${cfg.port}`, busy ? `set "port" in ${cfg.paths.config}, then: wa restart` : 'run: wa start   (details: wa logs)');
  } else {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/health`, { headers: { authorization: `Bearer ${cfg.token}` } });
    const h = await res.json();
    add('ok', `daemon answers on 127.0.0.1:${cfg.port}`);
    if (!h.linked) add('warn', 'not linked to WhatsApp', 'run in a terminal: wa connect');
    else if (h.state === 'open') add('ok', `linked as +${jidUser(h.me?.pn) || '?'} · ${h.stats.messages} messages stored${h.sync?.chunks ? ` · history sync ${h.sync.isLatest ? 'caught up' : 'in progress'}` : ''}`);
    else {
      const fix = h.state === 'replaced' || h.state === 'forbidden' ? 'wa disconnect --local, then wa connect' : 'it retries by itself; if it persists: wa restart';
      add('fail', `linked but ${h.state}${h.lastDisconnect ? ` (last close code ${h.lastDisconnect.code} at ${formatTs(h.lastDisconnect.at)})` : ''}`, fix);
    }
    if (!h.sending?.enabled) add('info', 'sending is switched off (config.json: sending.enabled)');
  }

  add(which('ffmpeg') ? 'ok' : 'warn', which('ffmpeg') ? 'ffmpeg found (voice notes)' : 'ffmpeg not found: sending voice notes from non-Ogg audio will fail', 'install ffmpeg with your package manager');

  for (const c of await agentChecks()) checks.push(c);
  return checks;
}

async function defaultAgentChecks() {
  try {
    const m = await import('./agents/index.mjs');
    return m.doctorChecks ? m.doctorChecks() : [];
  } catch (e) {
    return [{ level: 'warn', text: `agent integrations could not be checked: ${e.message}` }];
  }
}

export async function doctorCommand(pos, flags) {
  const checks = await collectChecks();
  if (flags.json) { console.log(JSON.stringify(checks, null, 2)); }
  else {
    console.log('wa-bridge doctor');
    for (const c of checks) {
      console.log(`  ${MARK[c.level]} ${c.text}`);
      if (c.fix && c.level !== 'ok') console.log(`      → ${c.fix}`);
    }
  }
  const failures = checks.filter((c) => c.level === 'fail').length;
  const warnings = checks.filter((c) => c.level === 'warn').length;
  if (!flags.json) console.log(failures ? `\n${failures} problem(s), ${warnings} warning(s)` : `\nall good${warnings ? ` (${warnings} warning(s))` : ''}`);
  return failures ? 1 : 0;
}
