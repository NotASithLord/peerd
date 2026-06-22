// Provider failover — the pure decision layer (peerd-provider/failover.js).

import { describe, test, expect } from 'bun:test';
import { shouldFailover, planFailoverChain } from '../../extension/peerd-provider/failover.js';
import {
  ProviderHttpError,
  ProviderUsageLimitError,
  ProviderKeyMissingError,
  ProviderError,
} from '../../extension/peerd-provider/errors.js';

describe('shouldFailover', () => {
  test('a hard usage limit is failover-worthy (waiting cannot clear it)', () => {
    expect(shouldFailover(new ProviderUsageLimitError('anthropic', { status: 402 }))).toBe(true);
  });

  test('persistent overload / server faults (after adapter retries) fail over', () => {
    expect(shouldFailover(new ProviderHttpError('anthropic', 529, 'overloaded'))).toBe(true);
    expect(shouldFailover(new ProviderHttpError('anthropic', 503, 'unavailable'))).toBe(true);
    expect(shouldFailover(new ProviderHttpError('anthropic', 500, 'api_error'))).toBe(true);
  });

  test('a surviving 429 is NOT failover-worthy — it is a self-clearing throttle', () => {
    expect(shouldFailover(new ProviderHttpError('anthropic', 429, 'rate_limit'))).toBe(false);
  });

  test('a 400-class request error is NOT failover-worthy', () => {
    expect(shouldFailover(new ProviderHttpError('anthropic', 400, 'bad request'))).toBe(false);
  });

  test('a missing key on the primary is NOT failover-worthy here', () => {
    // (The shell may still advance to a configured fallback; this classifier
    // only governs whether the PRIMARY failure triggers the switch.)
    expect(shouldFailover(new ProviderKeyMissingError('anthropic'))).toBe(false);
  });

  test('generic provider errors and non-errors do not fail over', () => {
    expect(shouldFailover(new ProviderError('anthropic', 'malformed body'))).toBe(false);
    expect(shouldFailover(undefined)).toBe(false);
    expect(shouldFailover('boom')).toBe(false);
  });
});

describe('planFailoverChain', () => {
  test('primary first, then the configured fallbacks', () => {
    const chain = planFailoverChain(
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      [{ provider: 'openrouter', model: 'openai/gpt-5' }],
    );
    expect(chain).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openrouter', model: 'openai/gpt-5' },
    ]);
  });

  test('de-dupes by provider — you never fail a provider over to itself', () => {
    const chain = planFailoverChain(
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      [
        { provider: 'anthropic', model: 'claude-opus-4-8' }, // dropped (same provider)
        { provider: 'openrouter', model: 'x' },
        { provider: 'openrouter', model: 'y' }, // dropped (already present)
      ],
    );
    expect(chain.map((c) => c.provider)).toEqual(['anthropic', 'openrouter']);
  });

  test('drops malformed / model-less fallbacks', () => {
    const chain = planFailoverChain(
      { provider: 'anthropic', model: 'm' },
      [
        { provider: 'openrouter' } as any, // no model
        { provider: '', model: 'm' } as any, // no provider
        null as any,
        { provider: 'ollama', model: 'llama3' },
      ],
    );
    expect(chain).toEqual([
      { provider: 'anthropic', model: 'm' },
      { provider: 'ollama', model: 'llama3' },
    ]);
  });

  test('no fallbacks → just the primary (never empty)', () => {
    expect(planFailoverChain({ provider: 'anthropic', model: 'm' })).toEqual([
      { provider: 'anthropic', model: 'm' },
    ]);
  });
});
