// The release version, read once from package.json (a JSON import would print an experimental warning).

import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
