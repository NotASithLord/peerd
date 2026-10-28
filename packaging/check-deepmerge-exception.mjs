// Temporary owner-approved build-tool waiver. Do not extend to arbitrary merges.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED = {"addons-linter": ["addons-linter@10.10.0", "sha512-1n5Xvn4DyHMsulchNDl4ucWnXXQhHwLif6eK80KjieI9KIK3xD+3OYXk5ZcA6a2J8y+Nrlvq9/vq6w7KOqT2MQ=="], "deepmerge": ["deepmerge@4.3.1", "sha512-3sUqbMEc77XqpdNO7FRyRog+eW3ph+GYCbj+rK+uYyRMuwsVy0rMiVtPn+QJlKFvWP/1PYpapqYn0Me2knFn+A=="], "web-ext": ["web-ext@10.6.0", "sha512-r1MfSwVy5wRQw3UgTUCw9CDViFIoDPri1Wq8qh/mRjC8T+K0TfuxKz68bzYTEP3rbAW6Wn8y7v/jXzBYd3LLGA=="]};
export function checkDeepmergeException(root, now = Date.now()) {
  const id = 'GHSA-gcqx-w48m-w2h4';
  const expiry = '2026-11-11T00:00:00Z';
  const config = readFileSync(join(root, 'osv-scanner.toml'), 'utf8');
  const entries = config.split('[[IgnoredVulns]]').slice(1).filter(entry => entry.includes(`id = "${id}"`));
  if (!entries.length && !config.includes(id)) return;
  if (entries.length !== 1 || !entries[0].includes(`ignoreUntil = ${expiry}\n`)) {
    throw Error('deepmerge exception scope or expiry changed; re-triage required');
  }
  if (now >= Date.parse(expiry)) throw Error('deepmerge exception expired; re-triage required');
  const records = new Map();
  const lock = readFileSync(join(root, 'bun.lock'), 'utf8');
  for (const line of lock.slice(lock.indexOf('"packages": {')).split('\n')) {
    if (!line.trim() || /^\s*[{}],?\s*$/.test(line) || line.includes('"packages": {')) continue;
    const match = /^\s*"([^"]+)": (\[.*\]),?\s*$/.exec(line);
    if (!match || records.has(match[1])) throw Error('Unknown lock format; deepmerge re-triage required');
    records.set(match[1], JSON.parse(match[2]));
  }
  for (const [slot, [coordinate, integrity]] of Object.entries(EXPECTED)) {
    const entry = records.get(slot);
    if (!entry || entry[0] !== coordinate || entry.at(-1) !== integrity) {
      throw Error(`${slot} changed; deepmerge exception needs re-triage`);
    }
  }
  for (const [slot, entry] of records) {
    if (/^(deepmerge|addons-linter|web-ext)@/.test(entry[0]) && !Object.hasOwn(EXPECTED, slot)) {
      throw Error('Additional deepmerge toolchain slot; re-triage required');
    }
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = entry[2]?.[field] ?? {};
      if (Object.hasOwn(deps, 'deepmerge') && !(slot === 'addons-linter' && field === 'dependencies' && deps.deepmerge === '4.3.1')) {
        throw Error('New deepmerge consumer; re-triage required');
      }
      if (Object.hasOwn(deps, 'addons-linter') && !(slot === 'web-ext' && field === 'dependencies' && deps['addons-linter'] === '10.10.0')) {
        throw Error('New addons-linter consumer; re-triage required');
      }
    }
  }
  if (records.get('addons-linter')[2]?.dependencies?.deepmerge !== '4.3.1' ||
      records.get('web-ext')?.[2]?.dependencies?.['addons-linter'] !== '10.10.0') {
    throw Error('Reviewed deepmerge edge changed');
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions', 'patchedDependencies']) {
    if (Object.keys(manifest[field] ?? {}).some(name => /deepmerge|addons-linter/.test(name))) {
      throw Error('Direct schema-merge tool dependency or patch; re-triage required');
    }
  }
  for (const directory of ['extension', 'packaging', 'scripts', '.github']) {
    for (const relative of readdirSync(join(root, directory), { recursive: true })) {
      if (!/\.(?:js|mjs|ts|json|ya?ml)$/.test(relative) || relative.startsWith('vendor/') ||
          relative.startsWith('tests/') || /\.test\.(?:js|ts)$/.test(relative) ||
          (directory === 'packaging' && ['check-deepmerge-exception.mjs', 'check-osv-exception.mjs'].includes(relative))) continue;
      let source = readFileSync(join(root, directory, relative), 'utf8');
      // Existing explanatory comment is not an API call; all new references fail.
      if (directory === '.github' && relative === 'workflows/package-and-release.yml') {
        source = source.replace('    # addons-linter currently depends on an image parser with a known infinite', '');
      }
      if (/deepmerge|addons-linter|schemaObject|themeSchemaObject|messagesSchemaObject/.test(source)) {
        throw Error(`Potential custom schema merge in ${directory}/${relative}; re-triage required`);
      }
    }
  }
}
