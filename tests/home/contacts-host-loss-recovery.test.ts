import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

describe('Contacts native-demand host-loss acceptance', () => {
  test('Home has a bounded nonblank read Retry and no mutation replay control', () => {
    const source = readFileSync(join(EXTENSION_DIR, 'home/contacts-section.js'), 'utf8');
    expect(source).toContain('CONTACTS_REQUEST_TIMEOUT_MS = 35_000');
    expect(source).toContain("code: 'contacts-ui-timeout'");
    expect(source).toContain("}, listPending ? 'Retrying…' : 'Retry')");
    expect(source).toContain('contacts === null && !listFailure');
    expect(source).toContain('read-only contacts refresh to reconcile.');
    expect(source).toContain('one post-operation read, never a mutation replay');
    expect(source).toContain('refresh(send, timeoutMs, true)');
    expect(source).not.toContain("'Retry update'");
    expect(source).not.toContain("'Retry forget'");
  });
});
