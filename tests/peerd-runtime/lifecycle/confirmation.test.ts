// Confirmation binding (§8.3) — one approval covers one named action against
// one normalized target for one operation under one capability generation,
// once, inside a bounded window.

import { describe, test, expect } from 'bun:test';
import {
  bindConfirmation, confirmationSatisfies, consumeConfirmation,
  normalizeConfirmationTarget, CONFIRMATION_TTL_MS,
} from '../../../extension/peerd-runtime/lifecycle/confirmation.js';

const base = {
  operationId: 'op-1',
  action: 'send_message',
  target: 'https://example.com/api/send',
  generationId: 'gen-1-aaaa',
  now: 10_000,
};

describe('target normalization', () => {
  test('cosmetic URL differences collapse; the resource selection survives', () => {
    expect(normalizeConfirmationTarget('HTTPS://Example.COM:443/api/send#frag'))
      .toBe('https://example.com/api/send');
    expect(normalizeConfirmationTarget('https://example.com/api?x=1'))
      .toBe('https://example.com/api?x=1');
  });

  test('non-URL targets normalize to their trimmed selves', () => {
    expect(normalizeConfirmationTarget('  vault:openai-key ')).toBe('vault:openai-key');
    expect(normalizeConfirmationTarget(undefined)).toBe('');
  });
});

describe('binding and matching', () => {
  test('a fresh proof satisfies the exact request it was bound for', () => {
    const proof = bindConfirmation(base);
    expect(proof.expiresAt).toBe(base.now + CONFIRMATION_TTL_MS);
    const verdict = confirmationSatisfies(proof, { ...base, now: base.now + 1000 });
    expect(verdict.valid).toBe(true);
  });

  test('every changed binding refuses: operation, action, target, generation', () => {
    const proof = bindConfirmation(base);
    const later = base.now + 1000;
    const cases = [
      { ...base, now: later, operationId: 'op-2' },
      { ...base, now: later, action: 'delete_resource' },
      { ...base, now: later, target: 'https://example.com/api/delete' },
      { ...base, now: later, generationId: 'gen-2-bbbb' },
    ];
    for (const request of cases) {
      expect(confirmationSatisfies(proof, request).valid).toBe(false);
    }
  });

  test('a retry that recreated the operation cannot consume the old approval', () => {
    const proof = bindConfirmation(base);
    const verdict = confirmationSatisfies(proof,
      { ...base, operationId: 'op-1-retry', now: base.now + 1 });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain('different operation');
  });

  test('a SW restart (new generation) invalidates the approval', () => {
    const proof = bindConfirmation(base);
    const verdict = confirmationSatisfies(proof,
      { ...base, generationId: 'gen-2-cccc', now: base.now + 1 });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain('generation changed');
  });

  test('the window is bounded and judged by the injected clock', () => {
    const proof = bindConfirmation(base);
    expect(confirmationSatisfies(proof,
      { ...base, now: proof.expiresAt }).valid).toBe(false);
    expect(confirmationSatisfies(proof,
      { ...base, now: proof.expiresAt - 1 }).valid).toBe(true);
  });

  test('a cosmetically different target string still matches after normalization', () => {
    const proof = bindConfirmation(base);
    const verdict = confirmationSatisfies(proof, {
      ...base, target: 'HTTPS://EXAMPLE.com:443/api/send#x', now: base.now + 1,
    });
    expect(verdict.valid).toBe(true);
  });
});

describe('single use', () => {
  test('a consumed proof never satisfies again', () => {
    const proof = bindConfirmation(base);
    const spent = consumeConfirmation(proof);
    expect(spent.consumed).toBe(true);
    expect(proof.consumed).toBe(false); // immutably copied, not mutated
    const verdict = confirmationSatisfies(spent, { ...base, now: base.now + 1 });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain('consumed');
  });

  test('missing proof refuses', () => {
    expect(confirmationSatisfies(null, base).valid).toBe(false);
    expect(confirmationSatisfies(undefined, base).valid).toBe(false);
  });

  test('binding without the required identities throws', () => {
    expect(() => bindConfirmation({ ...base, operationId: '' })).toThrow(TypeError);
    expect(() => bindConfirmation({ ...base, generationId: '' })).toThrow(TypeError);
  });
});
