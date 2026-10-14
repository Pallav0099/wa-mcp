// `wa` command dispatch. Product commands (connect, service, agents, update, …) live in their own modules and
// are loaded on demand; everything else is a one-call read/act command from commands.mjs.

import { renameSync, existsSync } from 'node:fs';
import { parseArgs, usage } from './args.mjs';
import { HELP, runCommand } from './commands.mjs';
import { call, clientConfig, setAutoStart } from '../client.mjs';
import { defaultDataDir } from '../config.mjs';
import { ourDaemonAnswers } from '../lifecycle.mjs';
import { nowSec } from '../util.mjs';
import { VERSION } from '../version.mjs';
import { confirm } from './prompt.mjs';

// Commands that must not start the daemon as a side effect.
const NO_AUTOSTART = new Set(['stop', 'shutdown', 'version', 'help', 'doctor', 'uninstall', 'update', 'post-install', 'logs', 'agents']);

/** Returns the process exit code. */
export async function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos.shift();
  if (!cmd || cmd === 'help' || (flags.help && !cmd)) { console.log(HELP); return 0; }
  setAutoStart(!NO_AUTOSTART.has(cmd));

  switch (cmd) {
    case 'connect':
      return (await import('./connect.mjs')).connectCommand(pos, flags);
    case 'disconnect':
      return disconnect(flags);
    case 'start': return (await import('./servicecmd.mjs')).startCommand(pos, flags);
    case 'stop': return (await import('./servicecmd.mjs')).stopCommand(pos, flags);
    case 'restart': return (await import('./servicecmd.mjs')).restartCommand(pos, flags);
    case 'logs': return (await import('./servicecmd.mjs')).logsCommand(pos, flags);
    case 'doctor': return (await import('./doctor.mjs')).doctorCommand(pos, flags);
    case 'agents': return (await import('./agents/index.mjs')).agentsCommand(pos, flags);
    case 'update': return (await import('./update.mjs')).updateCommand(pos, flags);
    case 'post-install': return (await import('./update.mjs')).postInstallCommand(pos, flags); // run by install.sh / updates
    case 'uninstall': return (await import('./uninstall.mjs')).uninstallCommand(pos, flags);
    case 'logout': // the original command name; keeps requiring --yes
      if (!flags.yes) throw usage('wa logout --yes   (this UNLINKS the bridge from the WhatsApp account)');
      return disconnect(flags);
    case 'version':
      if (flags.json) console.log(JSON.stringify({ version: VERSION, node: process.version, data: defaultDataDir() }));
      else console.log(`wa-bridge ${VERSION} · node ${process.version} · data ${defaultDataDir()}`);
      return 0;
    default:
      if (await runCommand(cmd, pos, flags)) return 0;
      throw Object.assign(new Error(`unknown command "${cmd}" — run: wa help`), { code: 'usage' });
  }
}

async function disconnect(flags) {
  if (flags.local) {
    const ok = await confirm('Forget the WhatsApp link on this machine (credentials are archived, not deleted)?', { yes: flags.yes, defaultYes: false });
    if (!ok) { console.log('Nothing changed.'); return 1; }
    try {
      const r = await call('POST', '/unlink-local', { confirm: 'UNLINK' });
      console.log('Unlinked on this machine. Link again with: wa connect');
      if (r.stillListedOnPhone) console.log('It may still be listed on the phone under Linked devices; remove it there.');
      return 0;
    } catch (e) {
      if (!['unreachable', 'start_failed', 'not_started'].includes(e.code)) throw e;
      return unlinkOffline();
    }
  }
  const ok = await confirm('Unlink wa-bridge from your WhatsApp account? The phone will stop listing this device.', { yes: flags.yes, defaultYes: false });
  if (!ok) { console.log('Nothing changed.'); return 1; }
  try {
    await call('POST', '/logout', { confirm: 'LOGOUT' });
  } catch (e) {
    if (e.code !== 'not_connected') throw e;
    console.error(`wa: ${e.message}`);
    console.error('WhatsApp can only be told while connected. To forget the link on this machine instead: wa disconnect --local');
    return 1;
  }
  console.log('Logout requested; the device will disappear from Linked devices on the phone.');
  return 0;
}

/** The daemon cannot start (e.g. broken credentials): archive them directly, since nothing else is using them. */
async function unlinkOffline() {
  const { paths, port, token } = clientConfig(undefined, { requireToken: false });
  if (token && (await ourDaemonAnswers(port, token))) throw new Error('the daemon is running; retry: wa disconnect --local');
  const auth = paths.auth;
  if (!existsSync(auth)) { console.log('Not linked on this machine.'); return 0; }
  const archived = `${auth}.revoked-${nowSec()}`;
  renameSync(auth, archived);
  console.log(`The daemon was not running; credentials archived to ${archived}. Link again with: wa connect`);
  return 0;
}
