import { describe, expect, test } from 'bun:test';
import {
  appActorSessionMatches,
  appPublisherProvenance,
  canonicalAppActorManifest,
  canonicalAppOwnerAuthority,
  manifestAppActorTools,
  resolveAppTabOwnerClaim,
  validateAppTabClaim,
} from '../../extension/background/app-actor-policy.js';

const contract = {
  schema: 1, kind: 'dwapp', entry: 'index.html', capabilities: ['dweb'],
  agent: { kind: 'bound-app', profile: 'developer', surface: 'code', runtime: ['observe'] },
};

describe('manifest-defined App actor authority identity', () => {
  test('reconnects only the same owner, App, and manifest digest', () => {
    const session = {
      kind: 'actor', actorType: 'app', parentSessionId: 'chat-a', instanceId: 'app-1',
      appManifestDigest: 'digest-a', actorSurface: 'code',
      appOwnerAuthorityDigest: 'authority-a',
      appRole: { source: 'dweb', publisher: 'did:key:publisher' },
    };
    const provenance = { publisherSource: 'dweb', publisher: 'did:key:publisher' };
    const authority = { ownerAuthorityDigest: 'authority-a' };
    expect(appActorSessionMatches(session, { ...provenance, ...authority, ownerChatId: 'chat-a', appId: 'app-1', manifestDigest: 'digest-a' })).toBe(true);
    expect(appActorSessionMatches(session, { ...provenance, ...authority, ownerChatId: 'chat-b', appId: 'app-1', manifestDigest: 'digest-a' })).toBe(false);
    expect(appActorSessionMatches(session, { ...provenance, ...authority, ownerChatId: 'chat-a', appId: 'app-1', manifestDigest: 'digest-b' })).toBe(false);
    expect(appActorSessionMatches(session, { ...provenance, ownerAuthorityDigest: 'authority-b', ownerChatId: 'chat-a', appId: 'app-1', manifestDigest: 'digest-a' })).toBe(false);
    expect(appActorSessionMatches(session, { ...provenance, ...authority, publisher: 'did:key:other', ownerChatId: 'chat-a', appId: 'app-1', manifestDigest: 'digest-a' })).toBe(false);
  });

  test('owner authority canonicalization changes with allow, permission, or confirmation posture', () => {
    const base = canonicalAppOwnerAuthority({
      allow: ['app_code', 'edit_file'], permissionMode: 'act', confirmActions: true,
    });
    expect(base).toBe(canonicalAppOwnerAuthority({
      allow: ['edit_file', 'app_code'], permissionMode: 'act', confirmActions: true,
    }));
    expect(base).not.toBe(canonicalAppOwnerAuthority({
      allow: ['app_code'], permissionMode: 'act', confirmActions: true,
    }));
    expect(base).not.toBe(canonicalAppOwnerAuthority({
      allow: ['app_code', 'edit_file'], permissionMode: 'plan', confirmActions: true,
    }));
    expect(base).not.toBe(canonicalAppOwnerAuthority({
      allow: ['app_code', 'edit_file'], permissionMode: 'act', confirmActions: false,
    }));
  });

  test('canonical digest input excludes ignored JSON fields and records verified publisher provenance', () => {
    expect(canonicalAppActorManifest({ ...contract, ignored: 'attacker-controlled' })).not.toContain('ignored');
    expect(appPublisherProvenance({ source: 'dweb', dweb: { publisher: 'did:key:z6Mk' } }))
      .toEqual({ source: 'dweb', publisher: 'did:key:z6Mk' });
    expect(appPublisherProvenance({ source: 'imported' }).source).toBe('unsigned-import');
  });

  test('runtime declarations gate direct methods and grant code only for the complete feedback loop', () => {
    const hostTools = ['app_read_file', 'app_observe', 'app_act', 'app_code'];
    expect(manifestAppActorTools({
      contract: { agent: { runtime: ['observe'] } }, hostTools, ownerAllowed: null,
    })).toEqual(['app_read_file', 'app_observe']);
    expect(manifestAppActorTools({
      contract: { agent: { runtime: ['observe', 'act'] } }, hostTools,
      ownerAllowed: new Set(['app_observe', 'app_act', 'app_code']),
    })).toEqual(['app_observe', 'app_act', 'app_code']);
  });
});

describe('App tab claim validation', () => {
  test('refuses a mismatched URL identity and a duplicate host', () => {
    expect(validateAppTabClaim({ claimedAppId: 'app-1', urlAppId: 'app-2', senderTabId: 4, liveTabId: null }))
      .toEqual({ ok: false, error: 'app-tab-url-mismatch' });
    expect(validateAppTabClaim({ claimedAppId: 'app-1', urlAppId: 'app-1', senderTabId: 4, liveTabId: 9 }))
      .toEqual({ ok: false, error: 'app-already-open' });
    expect(validateAppTabClaim({ claimedAppId: 'app-1', urlAppId: 'app-1', senderTabId: 4, liveTabId: 4 }).ok)
      .toBe(true);
  });

  test('binds the owner to the launch URL and refuses a message substitution', () => {
    expect(resolveAppTabOwnerClaim({ claimedOwner: 'chat-a', urlOwner: 'chat-a', recordOwner: 'chat-old' }))
      .toEqual({ ok: true, ownerSessionId: 'chat-a' });
    expect(resolveAppTabOwnerClaim({ claimedOwner: 'chat-b', urlOwner: 'chat-a', recordOwner: 'chat-b' }))
      .toEqual({ ok: false, error: 'app-tab-owner-mismatch' });
    expect(resolveAppTabOwnerClaim({ claimedOwner: null, urlOwner: null, recordOwner: 'chat-local' }))
      .toEqual({ ok: true, ownerSessionId: 'chat-local' });
  });
});
