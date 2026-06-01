/**
 * Package version, read from package.json at runtime.
 *
 * Read via fs rather than a JSON import attribute (`with { type: 'json' }`)
 * so we don't require Node >=20.10 just for the syntax, and don't emit the
 * experimental-JSON-modules warning Node 20.x prints for that import form.
 * `package.json` ships in the published tarball, so the relative resolve
 * from `dist/version.js` is stable.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  version?: string;
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
) as PackageManifest;

export const VERSION = manifest.version ?? 'unknown';
