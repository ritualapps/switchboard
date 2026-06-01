#!/usr/bin/env node
/**
 * Switchboard bin wrapper.
 *
 * The published npm package installs this as the `switchboard` command.
 * Dynamic-imports the transpiled ESM entry at dist/cli.js (built by
 * `tsc -p tsconfig.build.json` during prepublishOnly). No runtime tsx
 * dependency.
 *
 * Dev path: `npm start` runs `tsx src/cli.ts` directly without going
 * through this bin wrapper.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const distEntry = path.resolve(__dirname, '..', 'dist', 'cli.js');
// On Windows, dynamic import() requires a file:// URL, not an absolute path.
import(pathToFileURL(distEntry).href).catch((err) => {
  process.stderr.write('SWITCHBOARD failed to start: ' + (err && err.message ? err.message : err) + '\n');
  process.exit(1);
});
