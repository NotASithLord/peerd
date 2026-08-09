import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The service worker cannot be imported under Bun because it needs extension
// globals. Pin the production wiring so the tested boot shell cannot be
// bypassed by a later inline check or a names-only write-guard call.
const source = readFileSync(
  join(import.meta.dir, '../../extension/background/service-worker.js'),
  'utf8',
);

describe('service worker store migration posture', () => {
  test('boot delegates checking, blocking, and stamping to one shell', () => {
    expect(source).toMatch(/const storesCheck = await applyStoreBootPosture\(\{/);
    expect(source).toMatch(/block:\s*\([^)]*blocked[^)]*\)\s*=>\s*storeWriteGuard\.block\(blocked\)/);
    expect(source).not.toMatch(/const storesCheck = await checkStores/);
  });

  test('blocked stores use one report for audit and user-facing copy', () => {
    expect(source).toContain('migrationBlockedReport({');
    expect(source).toContain("type: 'lifecycle.migration.failed'");
    expect(source).toMatch(/postChatNote\(`\$\{report\.user\}/);
  });
});
