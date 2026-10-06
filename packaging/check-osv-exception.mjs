// why: an advisory-only OSV exception must not silently cover a new dependency
// graph or an enabled ADB authentication path. Remove this guard with the waiver.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkExceptionScope(root, now = Date.now()) {
  const id = 'GHSA-86w9-cpqp-85rv';
  const expiry = '2026-10-20T00:00:00Z';
  const config = readFileSync(join(root, 'osv-scanner.toml'), 'utf8');
  const entries = config.split('[[IgnoredVulns]]').slice(1)
    .filter((entry) => entry.includes(`id = "${id}"`));
  // Removing the exception is always allowed. Other OSV entries stay independent.
  if (entries.length === 0 && !config.includes(id)) return;
  if (entries.length !== 1 || !entries[0].includes(`ignoreUntil = ${expiry}\n`)) {
    throw new Error('node-forge exception scope or expiry changed; re-triage required');
  }
  if (now >= Date.parse(expiry)) throw new Error('node-forge exception expired; re-triage required');

  // why: parse only package-record lines, refusing a changed lock format rather
  // than guessing. The Bun lock metadata headers are not package records.
  const records = new Map();
  const lock = readFileSync(join(root, 'bun.lock'), 'utf8');
  for (const line of lock.slice(lock.indexOf('"packages": {')).split('\n')) {
    if (!line.trim() || /^\s*[{}],?\s*$/.test(line) || line.includes('"packages": {')) continue;
    const match = /^\s*"([^"]+)": (\[.*\]),?\s*$/.exec(line);
    if (!match) throw new Error('Unknown lock record format; node-forge scope needs re-triage');
    if (records.has(match[1])) throw new Error('Duplicate lock record');
    records.set(match[1], JSON.parse(match[2]));
  }
  const expected = new Map([
    ['web-ext', ['web-ext@10.6.0', 'sha512-r1MfSwVy5wRQw3UgTUCw9CDViFIoDPri1Wq8qh/mRjC8T+K0TfuxKz68bzYTEP3rbAW6Wn8y7v/jXzBYd3LLGA==']],
    ['@devicefarmer/adbkit', ['@devicefarmer/adbkit@3.3.9', 'sha512-AYxk5G/b2BPEfubcuxVEZEOpsLf0isqrPNJnnwAlUjZAiLdFg/uvLNRDuBhsC/Ar62X+rUhVlvlL+tKp9HCjfQ==']],
    ['node-forge', ['node-forge@1.4.0', 'sha512-LarFH0+6VfriEhqMMcLX2F7SwSXeWwnEAJEsYm5QKWchiVYVvJyV9v7UDvUv+w5HO23ZpQTXDv/GxdDdMyOuoQ==']],
  ]);
  for (const [slot, [coordinate, integrity]] of expected) {
    const entry = records.get(slot);
    if (!entry || entry[0] !== coordinate || entry.at(-1) !== integrity) {
      throw new Error(`${slot} changed; node-forge exception needs re-triage`);
    }
  }
  if (records.get('web-ext')[2]?.dependencies?.['@devicefarmer/adbkit'] !== '3.3.9' ||
      records.get('@devicefarmer/adbkit')[2]?.dependencies?.['node-forge'] !== '^1.3.1') {
    throw new Error('Reviewed dependency edge changed; re-triage required');
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions']) {
    if (Object.keys(manifest[field] ?? {}).some((name) => /node-forge|@devicefarmer\/adbkit/.test(name))) {
      throw new Error('Direct ADB dependency or override added; re-triage required');
    }
  }
  for (const [slot, entry] of records) {
    if (/^(node-forge|@devicefarmer\/adbkit|web-ext)@/.test(entry[0]) && !expected.has(slot)) {
      throw new Error('Additional node-forge toolchain slot; re-triage required');
    }
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = entry[2]?.[field] ?? {};
      if (Object.hasOwn(dependencies, 'node-forge') &&
          !(slot === '@devicefarmer/adbkit' && field === 'dependencies' && dependencies['node-forge'] === '^1.3.1')) {
        throw new Error('New node-forge consumer; re-triage required');
      }
      if (Object.hasOwn(dependencies, '@devicefarmer/adbkit') &&
          !(slot === 'web-ext' && field === 'dependencies' && dependencies['@devicefarmer/adbkit'] === '3.3.9')) {
        throw new Error('New adbkit consumer; re-triage required');
      }
    }
  }
  // This literal-source tripwire complements the reviewed graph. It deliberately
  // counts comments too, requiring review even when a new reference is ambiguous.
  for (const directory of ['extension', 'packaging', 'scripts', '.github']) {
    for (const relative of readdirSync(join(root, directory), { recursive: true })) {
      if (!/\.(?:js|mjs|ts|json|ya?ml)$/.test(relative)) continue;
      if (relative.startsWith('vendor/') || relative.startsWith('tests/') ||
          relative.endsWith('.test.js') || relative.endsWith('.test.ts') ||
          (directory === 'packaging' && relative === 'check-osv-exception.mjs')) continue;
      const source = readFileSync(join(root, directory, relative), 'utf8');
      if (/firefox-android|createTcpUsbBridge|@devicefarmer\/adbkit|node-forge/.test(source)) {
        throw new Error(`Potential ADB authentication path in ${directory}/${relative}; re-triage required`);
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkExceptionScope(fileURLToPath(new URL('../', import.meta.url)));
  console.log('OSV exception scope OK');
}
