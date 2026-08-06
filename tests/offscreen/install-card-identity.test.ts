import { describe, expect, test } from 'bun:test';
import {
  discoveredIdentityError,
  identityForDiscoveredUri,
} from '../../extension/offscreen/install-card-identity.js';

describe('discovery-bound install identity', () => {
  test('returns the complete identity for the exact heard URI', () => {
    expect(identityForDiscoveredUri([{
      dwapp_id: 'dwapp-1', slug: 'notes', seq: 7, publisher: 'did:key:zPeer',
      head: { content_addr: 'peerd://did:key:zPeer/hash' },
    }], 'peerd://did:key:zPeer/hash')).toEqual({
      dwappId: 'dwapp-1', slug: 'notes', seq: 7, publisher: 'did:key:zPeer',
    });
  });

  test('does not accept a copied identity for another URI', () => {
    expect(identityForDiscoveredUri([{
      dwapp_id: 'dwapp-1', slug: 'notes', seq: 7, publisher: 'did:key:zPeer',
      head: { content_addr: 'peerd://did:key:zPeer/other' },
    }], 'peerd://did:key:zPeer/hash')).toBe(null);
  });

  test('fails closed when one URI has conflicting discovery identities', () => {
    const uri = 'peerd://did:key:zPeer/hash';
    expect(identityForDiscoveredUri([
      { dwapp_id: 'one', slug: 'notes', seq: 7, publisher: 'did:key:zPeer', head: { content_addr: uri } },
      { dwapp_id: 'two', slug: 'tasks', seq: 8, publisher: 'did:key:zPeer', head: { content_addr: uri } },
    ], uri)).toBe(null);
  });

  test('rejects an update copied from another durable App stream', () => {
    const identity = {
      dwappId: 'dwapp-other', slug: 'other', seq: 9, publisher: 'did:key:zOther',
    };
    expect(discoveredIdentityError(identity, {
      expectedDwappId: 'dwapp-installed',
      expectedPublisher: 'did:key:zInstalled',
    })).toBe('discovery-stream-mismatch');
  });

  test('rejects a fetched manifest signed by another publisher', () => {
    const identity = {
      dwappId: 'dwapp-1', slug: 'notes', seq: 7, publisher: 'did:key:zPeer',
    };
    expect(discoveredIdentityError(identity, {
      expectedDwappId: 'dwapp-1',
      expectedPublisher: 'did:key:zPeer',
      manifestPublisher: 'did:key:zSubstitute',
    })).toBe('discovery-publisher-mismatch');
  });
});
