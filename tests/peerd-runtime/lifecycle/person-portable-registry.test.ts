// The portable-identity arc's registry reclassification: the new
// `personPortable` / `syncSurface` axis and the exclusions that back the
// issue's §10 + §13 invariants. These lock in WHICH surfaces a verified
// self-device sync may carry, and, more importantly, which it must not.

import { describe, test, expect } from 'bun:test';
import {
  STORE_REGISTRY, storeEntry,
} from '../../../extension/peerd-runtime/lifecycle/store-registry.js';
import { SYNC_SURFACES } from '../../../extension/peerd-distributed/self/sync.js';

describe('person-portable classification', () => {
  test('the syncable surfaces are exactly the opted-in stores', () => {
    const surfaces = STORE_REGISTRY
      .filter((entry) => entry.personPortable && entry.syncSurface)
      .map((entry) => entry.syncSurface!)
      .sort();
    expect(surfaces).toEqual(['apps', 'hooks', 'memory', 'secrets', 'sessions', 'skills', 'workspaces']);
    // Every syncSurface name is a real self/sync.js surface.
    for (const surface of surfaces) expect(SYNC_SURFACES).toContain(surface);
  });

  test('sessions become person-portable but never file-portable', () => {
    const sessions = storeEntry('sessions')!;
    expect(sessions.portable).toBe(false);      // never in the hand-carried file box
    expect(sessions.personPortable).toBe(true); // but replicate to a proven self device
    expect(sessions.syncSurface).toBe('sessions');
  });

  test('workspaces sync their CONTENTS while the OPFS handles stay device-bound', () => {
    const workspaces = storeEntry('opfs-workspaces')!;
    expect(workspaces.deviceBound).toBe(true);    // the handles never travel
    expect(workspaces.personPortable).toBe(true); // the logical snapshot does
    expect(workspaces.syncSurface).toBe('workspaces');
  });

  test('§13 exclusions: permission grants, audit, and device keys are NEVER personPortable', () => {
    for (const name of ['permission-grants', 'audit', 'dpop-keys', 'device-key', 'engine-registries']) {
      const entry = storeEntry(name);
      expect(entry, `${name} should exist in the registry`).toBeDefined();
      expect(entry!.personPortable ?? false, `${name} must not be personPortable`).toBe(false);
    }
  });

  test('the device key is device-bound and never portable by any axis', () => {
    const deviceKey = storeEntry('device-key')!;
    expect(deviceKey.deviceBound).toBe(true);
    expect(deviceKey.portable).toBe(false);
    expect(deviceKey.personPortable ?? false).toBe(false);
  });

  test('the registry enumerates exactly the person-portable stores', () => {
    const names = STORE_REGISTRY.filter((entry) => entry.personPortable)
      .map((entry) => entry.store).sort();
    expect(names).toEqual(['app-manifests', 'hooks', 'memory', 'opfs-workspaces', 'sessions', 'skills', 'vault']);
  });

  test('no store is personPortable without naming a sync surface', () => {
    for (const entry of STORE_REGISTRY) {
      if (entry.personPortable) expect(typeof entry.syncSurface).toBe('string');
    }
  });
});
