import { describe, expect, test } from 'bun:test';
import { blockedRows, blockedSet, effectOutcome, withoutBlocked } from '../../extension/home/blocked-makers.js';

const ana = 'did:key:z6MkAna00000000000000000000000000000000000000000';
const bob = 'did:key:z6MkBob00000000000000000000000000000000000000000';

describe('blocked makers', () => {
  test('the blocked list reads only a good reply, keyed by the full did', () => {
    expect([...(blockedSet({ ok: true, blocked: [ana, 7, null, bob] }) ?? [])]).toEqual([ana, bob]);
    expect(blockedSet({ ok: true, blocked: [] })?.size).toBe(0);
    for (const reply of [undefined, null, 'list', { ok: true }, { ok: false, blocked: [ana] }, { ok: 'true', blocked: [ana] }, { blocked: [ana] }]) {
      expect(blockedSet(reply)).toBe(null);
    }
  });

  test('outcomes: a stored policy is done, an unknown outcome stays unknown, any other refusal failed', () => {
    expect(effectOutcome({ ok: true, durable: true, revision: 1 })).toBe('done');
    expect(effectOutcome({ ok: true, contact: { did: ana } })).toBe('done');
    // Stored, with live enforcement not confirmed in time: the host reads the stored policy itself.
    expect(effectOutcome({ ok: false, durable: true, error: 'peer-policy-enforcement-unconfirmed', outcomeKnown: false })).toBe('done');
    for (const unknown of [{ ok: false, outcomeKnown: false }, { ok: false, code: 'contacts-ui-timeout', outcomeKnown: false }]) {
      expect(effectOutcome(unknown)).toBe('unknown');
    }
    for (const failed of [{ ok: false, error: 'vault-locked' }, { ok: false, error: 'invalid-peer-did', outcomeKnown: true },
      { ok: false, error: 'kernel-route-unauthorized', outcomeKnown: true }, {}, null, undefined]) {
      expect(effectOutcome(failed)).toBe('failed');
    }
  });

  test('a blocked maker\'s apps leave the list by the full did; a lookalike key and an app with no maker stay', () => {
    const lookalike = `did:key:z6MkEvil${ana.slice(-8)}`;
    const apps = [{ id: 'a', publisher: ana }, { id: 'b', publisher: bob }, { id: 'l', publisher: lookalike }, { id: 'n' }];
    expect(withoutBlocked(apps, new Set([ana])).map(app => app.id)).toEqual(['b', 'l', 'n']);
    expect(withoutBlocked(apps, new Set())).toBe(apps);
  });

  test('Contacts rows: the saved name and its first letter, else the short key and its first two characters', () => {
    expect(blockedRows([ana, bob], new Map([[ana, 'ana']]))).toEqual([
      { did: ana, name: 'ana', key: ana.slice(-8), letter: 'A' },
      { did: bob, name: null, key: bob.slice(-8), letter: bob.slice(-8, -6) },
    ]);
    expect(blockedRows(new Set<string>(), new Map())).toEqual([]);
  });
});
