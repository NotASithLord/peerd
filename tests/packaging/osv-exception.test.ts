import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkExceptionScope } from '../../packaging/check-osv-exception.mjs';

const lock = readFileSync(new URL('../../bun.lock', import.meta.url), 'utf8');
const now = Date.parse('2026-10-06T00:00:00Z');
const config = '[[IgnoredVulns]]\nid = "GHSA-86w9-cpqp-85rv"\nignoreUntil = 2026-10-20T00:00:00Z\n';
let root: string;
const put = (name: string, contents: string) => writeFileSync(join(root, name), contents);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peerd-osv-scope-'));
  for (const directory of ['extension', 'packaging', 'scripts', '.github']) mkdirSync(join(root, directory));
  put('package.json', '{}');
  put('bun.lock', lock);
  put('osv-scanner.toml', config);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('temporary node-forge exception boundary', () => {
  test('accepts reviewed graph only before expiry', () => {
    expect(() => checkExceptionScope(root, now)).not.toThrow();
    expect(() => checkExceptionScope(root, Date.parse('2026-10-20T00:00:00Z'))).toThrow('expired');
  });
  test('allows removal of exception', () => {
    put('osv-scanner.toml', '');
    expect(() => checkExceptionScope(root, Date.parse('2026-11-01'))).not.toThrow();
  });
  test('rejects dependency version and integrity drift', () => {
    put('bun.lock', lock.replace('node-forge@1.4.0', 'node-forge@1.4.1'));
    expect(() => checkExceptionScope(root, now)).toThrow('changed');
    put('bun.lock', lock.replace('sha512-LarFH0+6Vfri', 'sha512-TamperedVfri'));
    expect(() => checkExceptionScope(root, now)).toThrow('changed');
  });
  test('rejects a new transitive consumer', () => {
    put('bun.lock', lock.replace('"pino": "10.3.1"', '"pino": "10.3.1", "node-forge": "^1.4.0"'));
    expect(() => checkExceptionScope(root, now)).toThrow('New node-forge consumer');
  });
  test('rejects direct dependencies and overrides', () => {
    for (const field of ['devDependencies', 'overrides']) {
      put('package.json', JSON.stringify({ [field]: { 'node-forge': '1.4.0' } }));
      expect(() => checkExceptionScope(root, now)).toThrow('Direct ADB');
    }
  });
  test('rejects newly enabled Android and bridge references', () => {
    for (const source of ['run({target:"firefox-android"})', 'client.createTcpUsbBridge()']) {
      put('scripts/new-runner.mjs', source);
      expect(() => checkExceptionScope(root, now)).toThrow('Potential ADB authentication path');
    }
  });
  test('requires review of expiry extension or changed exception formatting', () => {
    put('osv-scanner.toml', config.replace('2026-10-20', '2026-10-21'));
    expect(() => checkExceptionScope(root, now)).toThrow('scope or expiry');
    put('osv-scanner.toml', config.replace('id = "GHSA-86w9-cpqp-85rv"', "id = 'GHSA-86w9-cpqp-85rv'"));
    expect(() => checkExceptionScope(root, now)).toThrow('scope or expiry');
  });
});
