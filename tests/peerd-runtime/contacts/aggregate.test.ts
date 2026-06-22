// Contacts — pure core (record helpers + did parsing) and the read-time
// "known peers + activity" aggregation. No IO, no network: plain values in,
// contact rows out.

import { describe, test, expect } from 'bun:test';

import {
  isPeerDid, peerDidFromUri, normalizeContactName,
  newContactRecord, applyContactPatch, MAX_CONTACT_NAME, MAX_CONTACT_TAGS,
} from '../../../extension/peerd-runtime/contacts/contact.js';
import { mergeContacts } from '../../../extension/peerd-runtime/contacts/aggregate.js';

const DID_A = 'did:key:z6MkAAAAAAAAAAAAAAAAAAAA';
const DID_B = 'did:key:z6MkBBBBBBBBBBBBBBBBBBBB';
const DID_C = 'did:key:z6MkCCCCCCCCCCCCCCCCCCCC';

describe('contact pure helpers', () => {
  test('isPeerDid accepts did:key, rejects junk', () => {
    expect(isPeerDid(DID_A)).toBe(true);
    expect(isPeerDid('did:web:example.com')).toBe(false);
    expect(isPeerDid('')).toBe(false);
    expect(isPeerDid(null as any)).toBe(false);
  });

  test('peerDidFromUri pulls the publisher out of a peerd:// uri', () => {
    expect(peerDidFromUri(`peerd://${DID_A}/abc123`)).toBe(DID_A);
    expect(peerDidFromUri(`peerd://${DID_A}`)).toBe(DID_A); // no hash segment
    expect(peerDidFromUri('https://example.com/x')).toBe(null);
    expect(peerDidFromUri('peerd://not-a-did/x')).toBe(null);
    expect(peerDidFromUri(undefined as any)).toBe(null);
  });

  test('normalizeContactName trims, collapses, caps; empty → null', () => {
    expect(normalizeContactName('  Alice   Smith ')).toBe('Alice Smith');
    expect(normalizeContactName('')).toBe(null);
    expect(normalizeContactName('   ')).toBe(null);
    expect(normalizeContactName(42 as any)).toBe(null);
    expect(normalizeContactName('x'.repeat(MAX_CONTACT_NAME + 10))!.length).toBe(MAX_CONTACT_NAME);
  });

  test('newContactRecord normalizes name + dedupes/caps tags', () => {
    const rec = newContactRecord(DID_A, { name: ' Bob ', tags: ['a', 'a', 'b', ...Array(20).fill('x')] }, 100);
    expect(rec.did).toBe(DID_A);
    expect(rec.name).toBe('Bob');
    expect(rec.tags.length).toBeLessThanOrEqual(MAX_CONTACT_TAGS);
    expect(rec.tags.filter((t: string) => t === 'a').length).toBe(1); // deduped
    expect(rec.createdAt).toBe(100);
    expect(rec.updatedAt).toBe(100);
  });

  test('applyContactPatch allowlists fields and pins identity', () => {
    const base = newContactRecord(DID_A, { name: 'Bob', notes: 'old' }, 100);
    const next = applyContactPatch(base, { name: 'Bobby', did: DID_B, createdAt: 9 } as any, 200);
    expect(next.name).toBe('Bobby');
    expect(next.notes).toBe('old');         // untouched — not in the patch
    expect(next.did).toBe(DID_A);           // identity pinned
    expect(next.createdAt).toBe(100);       // pinned
    expect(next.updatedAt).toBe(200);
  });

  test('applyContactPatch can clear a name (explicit null in patch)', () => {
    const base = newContactRecord(DID_A, { name: 'Bob' }, 100);
    const next = applyContactPatch(base, { name: null }, 200);
    expect(next.name).toBe(null);
  });
});

describe('mergeContacts', () => {
  test('unions dids across saved overlay, installed apps, and audit log', () => {
    const rows = mergeContacts({
      saved: [{ did: DID_A, name: 'Alice', notes: '', tags: [], favorite: false, createdAt: 1, updatedAt: 1 }],
      installedApps: [{ id: 'app-1', name: 'Chess', dweb: { publisher: DID_B, version_id: 'v1', slug: 'chess' } }],
      auditEntries: [{ when: 50, type: 'dweb_app_installed', details: { publisher: DID_C, uri: `peerd://${DID_C}/h` } }],
    });
    expect(rows.map((r: any) => r.did).sort()).toEqual([DID_A, DID_B, DID_C].sort());
  });

  test('folds a per-peer activity summary (apps + counts + first/last)', () => {
    const rows = mergeContacts({
      saved: [],
      installedApps: [
        { id: 'app-1', name: 'Chess', dweb: { publisher: DID_A, version_id: 'v2', slug: 'chess' } },
        { id: 'app-2', name: 'Paint', dweb: { publisher: DID_A, version_id: 'v1' } },
      ],
      auditEntries: [
        { when: 100, type: 'dweb_app_installed', details: { publisher: DID_A } },
        { when: 300, type: 'dweb_app_updated', details: { uri: `peerd://${DID_A}/newhash` } },
        { when: 200, type: 'dweb_app_installed', details: { publisher: DID_A } },
      ],
    });
    const a = rows.find((r: any) => r.did === DID_A)!;
    expect(a.activity.appCount).toBe(2);
    expect(a.activity.appsInstalled.map((x: any) => x.name).sort()).toEqual(['Chess', 'Paint']);
    expect(a.activity.installCount).toBe(2);
    expect(a.activity.updateCount).toBe(1);
    expect(a.activity.eventCount).toBe(3);
    expect(a.activity.firstEventAt).toBe(100);
    expect(a.activity.lastEventAt).toBe(300);
  });

  test('overlays the saved name + favorite onto the derived row', () => {
    const rows = mergeContacts({
      saved: [{ did: DID_A, name: 'Alice', notes: 'pal', tags: ['friend'], favorite: true, createdAt: 1, updatedAt: 9 }],
      installedApps: [{ id: 'app-1', name: 'Chess', dweb: { publisher: DID_A } }],
      auditEntries: [],
    });
    const a = rows[0];
    expect(a.did).toBe(DID_A);
    expect(a.name).toBe('Alice');
    expect(a.saved).toBe(true);
    expect(a.favorite).toBe(true);
    expect(a.tags).toEqual(['friend']);
    expect(a.activity.appCount).toBe(1); // still gets the derived activity
  });

  test('ignores events with no resolvable did (e.g. our own shares)', () => {
    const rows = mergeContacts({
      saved: [],
      installedApps: [],
      auditEntries: [
        { when: 1, type: 'dweb_app_shared', details: { appId: 'a1' } },     // outbound — no peer
        { when: 2, type: 'vault_unlocked' },                                // unrelated
        { when: 3, type: 'dweb_app_installed', details: { publisher: DID_A } },
      ],
    });
    expect(rows.map((r: any) => r.did)).toEqual([DID_A]);
  });

  test('sorts favorites first, then most-recent interaction', () => {
    const rows = mergeContacts({
      saved: [
        { did: DID_A, name: 'A', notes: '', tags: [], favorite: false, createdAt: 1, updatedAt: 10 },
        { did: DID_B, name: 'B', notes: '', tags: [], favorite: true, createdAt: 1, updatedAt: 1 },
        { did: DID_C, name: 'C', notes: '', tags: [], favorite: false, createdAt: 1, updatedAt: 1 },
      ],
      installedApps: [],
      auditEntries: [{ when: 9999, type: 'dweb_app_installed', details: { publisher: DID_C } }],
    });
    // B is favorite → first. Then C (recent install) over A (older updatedAt).
    expect(rows.map((r: any) => r.did)).toEqual([DID_B, DID_C, DID_A]);
  });
});
