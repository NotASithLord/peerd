import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_PROFILE_ID, DEFAULT_PEER_NAME, PEER_NAME_MAX,
  normalizePeerName, defaultProfileRecord,
} from '../../../extension/peerd-runtime/profiles/profile.js';

describe('normalizePeerName', () => {
  test('trims and collapses internal whitespace', () => {
    expect(normalizePeerName('  my   peer  ')).toBe('my peer');
  });
  test('caps at PEER_NAME_MAX', () => {
    const long = 'x'.repeat(PEER_NAME_MAX + 20);
    expect(normalizePeerName(long).length).toBe(PEER_NAME_MAX);
  });
  test('empty / whitespace-only / non-string falls back to the default', () => {
    expect(normalizePeerName('')).toBe(DEFAULT_PEER_NAME);
    expect(normalizePeerName('   ')).toBe(DEFAULT_PEER_NAME);
    expect(normalizePeerName(undefined)).toBe(DEFAULT_PEER_NAME);
    expect(normalizePeerName(42 as any)).toBe(DEFAULT_PEER_NAME);
  });
  test('a cap that leaves trailing whitespace still trims', () => {
    const name = `${'a'.repeat(PEER_NAME_MAX - 1)} bcd`;
    expect(normalizePeerName(name)).toBe('a'.repeat(PEER_NAME_MAX - 1));
  });
});

describe('defaultProfileRecord', () => {
  test('carries the multi-profile-ready shape with the latch open', () => {
    expect(defaultProfileRecord({ now: () => 1234 })).toEqual({
      id: DEFAULT_PROFILE_ID,
      peerName: DEFAULT_PEER_NAME,
      createdAt: 1234,
      onboardingComplete: false,
    });
  });
});
