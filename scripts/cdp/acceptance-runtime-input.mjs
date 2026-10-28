// why: installed-update acceptance must load the authenticated installed tree,
// not silently replace it with a freshly packaged source build. The caller
// verifies publication provenance; the harness checks version and immutability.
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const acceptanceRuntimeInput = (args, sourceVersion) => {
  if (!args.length) return null;
  if (args.length !== 1 || !args[0].startsWith('--extension=') || !args[0].slice(12)) {
    throw new Error('Expected only --extension=<authenticated runtime directory>');
  }
  const root = resolve(args[0].slice(12));
  if (!lstatSync(root).isDirectory()) throw new Error('Runtime must be a real directory');
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (manifest.version !== sourceVersion) throw new Error('Runtime and harness versions differ');
  if (manifest.manifest_version !== 3) throw new Error('Expected a packaged MV3 runtime');
  return root;
};
