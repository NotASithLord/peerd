import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkExceptionScope } from '../../packaging/check-osv-exception.mjs';

let root: string;
const put = (name: string, contents: string) => writeFileSync(join(root, name), contents);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peerd-osv-scope-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('OSV exception guard (zero active waivers)', () => {
  test('accepts a comments-only osv-scanner.toml', () => {
    put('osv-scanner.toml', '# No active exceptions\n');
    expect(() => checkExceptionScope(root)).not.toThrow();
  });

  test('accepts the repository osv-scanner.toml', () => {
    expect(() => checkExceptionScope(join(import.meta.dir, '../..'))).not.toThrow();
  });

  test('rejects any unreviewed IgnoredVulns waiver', () => {
    put('osv-scanner.toml', '[[IgnoredVulns]]\nid = "GHSA-0000-0000-0000"\n');
    expect(() => checkExceptionScope(root)).toThrow('Unreviewed OSV exception');
  });
});
