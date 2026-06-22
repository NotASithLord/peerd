import { describe, test, expect } from 'bun:test';
import {
  canonicalGitHost, normalizeGitHost, isPlausibleGitToken,
  gitSecretName, gitHostFromSecretName, authHostForRequestUrl, gitAuthHeader,
} from '../../../extension/peerd-engine/vm-net/git-credentials.js';

describe('canonicalGitHost', () => {
  test('maps api.github.com → github.com, lowercases, strips www', () => {
    expect(canonicalGitHost('api.github.com')).toBe('github.com');
    expect(canonicalGitHost('GitHub.com')).toBe('github.com');
    expect(canonicalGitHost('www.gitlab.com')).toBe('gitlab.com');
    expect(canonicalGitHost('git.sr.ht')).toBe('git.sr.ht');
  });
});

describe('normalizeGitHost', () => {
  test('accepts a bare host, a URL, or a clone URL', () => {
    expect(normalizeGitHost('github.com')).toBe('github.com');
    expect(normalizeGitHost('https://github.com')).toBe('github.com');
    expect(normalizeGitHost('https://github.com/owner/repo')).toBe('github.com');
    expect(normalizeGitHost('  GitLab.com/ ')).toBe('gitlab.com');
  });
  test('rejects localhost, raw IPs, and junk', () => {
    expect(normalizeGitHost('localhost')).toBeNull();
    expect(normalizeGitHost('192.168.1.10')).toBeNull();
    expect(normalizeGitHost('127.0.0.1')).toBeNull();
    expect(normalizeGitHost('')).toBeNull();
    expect(normalizeGitHost('not a host')).toBeNull();
  });
});

describe('isPlausibleGitToken', () => {
  test('length + no-whitespace sanity', () => {
    expect(isPlausibleGitToken('ghp_abcdefghijklmnop')).toBe(true);
    expect(isPlausibleGitToken('short')).toBe(false);
    expect(isPlausibleGitToken('has space inside')).toBe(false);
    expect(isPlausibleGitToken('')).toBe(false);
    expect(isPlausibleGitToken(null as any)).toBe(false);
  });
});

describe('secret naming', () => {
  test('round-trips host ↔ secret name', () => {
    expect(gitSecretName('github.com')).toBe('git:github.com');
    expect(gitHostFromSecretName('git:github.com')).toBe('github.com');
    expect(gitHostFromSecretName('anthropic')).toBeNull();
  });
});

describe('authHostForRequestUrl — the host-binding gate', () => {
  test('returns canonical host for an https git URL', () => {
    expect(authHostForRequestUrl('https://github.com/a/b/archive/main.zip')).toBe('github.com');
    expect(authHostForRequestUrl('https://api.github.com/repos/a/b')).toBe('github.com'); // canonicalized
    expect(authHostForRequestUrl('https://gitlab.com/api/v4/projects/x')).toBe('gitlab.com');
  });
  test('refuses non-https (no token over cleartext)', () => {
    expect(authHostForRequestUrl('http://github.com/a/b')).toBeNull();
  });
  test('refuses private/loopback and garbage', () => {
    expect(authHostForRequestUrl('https://localhost/a/b')).toBeNull();
    expect(authHostForRequestUrl('https://127.0.0.1/a')).toBeNull();
    expect(authHostForRequestUrl('peerd://git-clone')).toBeNull();
    expect(authHostForRequestUrl('not a url')).toBeNull();
  });
});

describe('gitAuthHeader', () => {
  test('gitlab → PRIVATE-TOKEN, others → Bearer', () => {
    expect(gitAuthHeader('gitlab.com', 't')).toEqual({ 'PRIVATE-TOKEN': 't' });
    expect(gitAuthHeader('github.com', 't')).toEqual({ Authorization: 'Bearer t' });
    expect(gitAuthHeader('codeberg.org', 't')).toEqual({ Authorization: 'Bearer t' });
  });
});
