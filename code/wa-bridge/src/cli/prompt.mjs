// Minimal interactive prompts. They read the controlling terminal (/dev/tty), not stdin, so they work even
// when stdin is a pipe (curl … | sh) and quietly report "cannot ask" when there is no terminal at all
// (an agent's shell, CI, a service).

import { closeSync, createReadStream, openSync } from 'node:fs';
import { createInterface } from 'node:readline';

export function canPrompt() {
  if (process.stdin.isTTY) return true;
  try { closeSync(openSync('/dev/tty', 'r')); return true; } catch { return false; }
}

/**
 * Ask a yes/no question. Resolves true/false, or null when there is no terminal to ask on.
 * `yes` (from --yes) answers true without asking.
 */
export async function confirm(question, { yes = false, defaultYes = true, out = process.stdout } = {}) {
  if (yes) return true;
  if (!canPrompt()) return null;
  const input = process.stdin.isTTY ? process.stdin : createReadStream('/dev/tty');
  const rl = createInterface({ input, output: out, terminal: true });
  rl.on('SIGINT', () => { out.write('\n'); process.exit(130); }); // Ctrl-C aborts, as everywhere else
  try {
    const answer = await new Promise((resolve) => {
      rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `, resolve);
      rl.once('close', () => resolve(null)); // Ctrl-D: never taken as consent
    });
    if (answer === null) return false;
    const a = String(answer).trim().toLowerCase();
    return a === '' ? defaultYes : a === 'y' || a === 'yes';
  } finally {
    rl.close();
    if (input !== process.stdin) input.destroy();
  }
}
