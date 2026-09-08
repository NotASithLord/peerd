import { describe, expect, test } from 'bun:test';
import { composerUnavailableCopy } from '../../extension/sidepanel/provider-readiness.js';

describe('composer provider readiness copy', () => {
  test('cold controller startup gives retry guidance instead of provider setup', () => {
    for (const provider of ['ollama', 'openai']) {
      const composer = { provider, reason: 'controller-not-ready' };
      expect(composerUnavailableCopy(composer, { compact: true }))
        .toBe('Starting up. Try again in a moment.');
      expect(composerUnavailableCopy(composer))
        .toBe('peerd is starting up. Try again in a moment.');
    }
  });

  test('a locked vault asks for unlock instead of an API key', () => {
    const composer = { provider: 'ollama', reason: 'vault-locked' };
    expect(composerUnavailableCopy(composer, { compact: true }))
      .toBe('Vault is locked. Unlock it to send.');
    expect(composerUnavailableCopy(composer))
      .toBe('Vault is locked. Unlock it to start chatting.');
  });

  test('a missing key keeps provider-specific setup guidance', () => {
    const composer = { provider: 'openai', reason: 'missing-key' };
    expect(composerUnavailableCopy(composer, { compact: true }))
      .toBe('Add an API key for OpenAI in Settings to send.');
    expect(composerUnavailableCopy(composer))
      .toBe('Add an API key for OpenAI in Settings to start chatting.');
  });
});
