#!/usr/bin/env node
// `wa-bridge` (alias `wa`): the command-line interface, plus the two long-running modes
//   wa-bridge daemon   the WhatsApp daemon in the foreground (what the systemd user service runs)
//   wa-bridge mcp      the MCP server on stdio (what agents launch)
// Everything else is a CLI command; run `wa help`.

const sub = process.argv[2];
if (sub === 'daemon') {
  await import('../src/daemon.mjs');
} else if (sub === 'mcp') {
  await import('./wa-mcp.mjs');
} else {
  const { main } = await import('../src/cli/main.mjs');
  try {
    const code = await main(process.argv.slice(2));
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
  } catch (e) {
    const extra = e.detail?.candidates ? '\ncandidates:\n' + e.detail.candidates.map((c) => `  ${c.name}  ${c.jid}`).join('\n') : '';
    console.error(`wa: ${e.message}${extra}`);
    process.exitCode = e.code === 'usage' ? 2 : 1;
  }
}
