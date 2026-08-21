import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import { createKernelSemanticDemand } from '../../extension/background/kernel-semantic-demand.js';

const sender = { surface: 'home' };

describe('Contacts native-demand host-loss acceptance', () => {
  test('the live gateway retries list once and never replays set or forget', async () => {
    const calls: Array<{ route: string, replayClass: string }> = [];
    const attempts = new Map<string, number>();
    const gateway = createKernelSemanticDemand({
      routes: Object.fromEntries(['contacts/list', 'contacts/set', 'contacts/forget']
        .map((route) => [route, {
          senderClass: 'first-party',
          replayClass: route === 'contacts/list' ? 'A' : 'E',
          acceptsSender: (value: unknown) => value === sender,
        }])),
      clientOptions: {
        callDemand: async (payload: any, options: any) => {
          calls.push({ route: payload.route, replayClass: options.authority.replayClass });
          attempts.set(payload.route, (attempts.get(payload.route) ?? 0) + 1);
          if (payload.route === 'contacts/list' && attempts.get(payload.route) === 2) {
            return { ok: true, contacts: [] };
          }
          return { ok: false, code: 'semantic-demand-channel-lost', outcomeKnown: false };
        },
      },
    });
    await expect(gateway.dispatch('contacts/list', {
      type: 'contacts/list',
    }, sender)).resolves.toEqual({ ok: true, contacts: [] });
    await expect(gateway.dispatch('contacts/set', {
      type: 'contacts/set', did: 'did:key:zAlice', favorite: true,
    }, sender)).resolves.toMatchObject({ outcomeKnown: false });
    await expect(gateway.dispatch('contacts/forget', {
      type: 'contacts/forget', did: 'did:key:zAlice',
    }, sender)).resolves.toMatchObject({ outcomeKnown: false });
    expect(calls).toEqual([
      { route: 'contacts/list', replayClass: 'A' },
      { route: 'contacts/list', replayClass: 'A' },
      { route: 'contacts/set', replayClass: 'E' },
      { route: 'contacts/forget', replayClass: 'E' },
    ]);
  });

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
