// Argument parsing shared by every `wa` command: positionals plus --flag value / --flag=value / boolean flags.

export const BOOLEAN_FLAGS = new Set([
  'json', 'unread', 'new', 'follow', 'yes', 'groups', 'dms', 'refresh', 'all', 'help',
  'local', 'no-agents', 'force', 'purge', 'rollback', 'quick', 'no-service', 'wait',
]);
const SHORT = { y: 'yes', f: 'follow', h: 'help' };

export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else flags[name] = argv[++i];
    } else if (/^-[a-z]$/.test(a) && SHORT[a[1]]) {
      flags[SHORT[a[1]]] = true;
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

export function usage(text) {
  return Object.assign(new Error(`usage: ${text}`), { code: 'usage' });
}
