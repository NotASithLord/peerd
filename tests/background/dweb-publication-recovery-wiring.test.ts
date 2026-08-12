import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const serviceWorkerSource = await readFile(
  join(import.meta.dir, '../../extension/background/service-worker.js'),
  'utf8',
);

describe('dweb publication recovery wiring', () => {
  test('reconciles interrupted publications before reseeding after host start', () => {
    const onlineBranch = serviceWorkerSource.match(
      /if \(r\?\.ok && settingsStore\.get\(\)\.dwebEnabled\) \{([\s\S]*?)joinDwebAgentInbox\(\)/,
    )?.[1] ?? '';
    const reconcileAt = onlineBranch.indexOf('reconcilePendingPublications()');
    const reseedAt = onlineBranch.indexOf('.then(() => reseedSharedApps())');

    expect(reconcileAt).toBeGreaterThanOrEqual(0);
    expect(reseedAt).toBeGreaterThan(reconcileAt);
    expect(onlineBranch).not.toContain('reseedSharedApps().catch');
  });
});
