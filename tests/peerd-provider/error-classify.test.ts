// error-classify — hard usage/credit limit vs transient throttle.
//
// This is the judgment the cloud adapters lean on to decide "retry" vs "fail
// fast and explicit". The risk it guards against is a per-minute 429 being
// mistaken for a hard cap (or vice versa), so the cases below pin both
// directions, including the tricky transient bodies the retry suite uses.

import { describe, test, expect } from 'bun:test';
import {
  isUsageLimitResponse,
  apiErrorMessage,
} from '../../extension/peerd-provider/error-classify.js';

describe('isUsageLimitResponse — hard limits', () => {
  test('402 is always a hard limit (OpenRouter insufficient credits)', () => {
    expect(isUsageLimitResponse(402, '')).toBe(true);
    expect(isUsageLimitResponse(402, 'anything')).toBe(true);
  });

  test.each([
    'Your credit balance is too low to access the Anthropic API.',
    '{"error":{"type":"invalid_request_error","message":"credit balance is too low"}}',
    'This request would exceed your monthly spend limit',
    '{"error":{"message":"You have exhausted your quota"}}',
    'insufficient_quota',
    'Billing hard limit has been reached',
  ])('flags a billing/credit/quota body: %s', (body) => {
    expect(isUsageLimitResponse(429, body)).toBe(true);
  });
});

describe('isUsageLimitResponse — transient (must NOT be hard)', () => {
  test.each([
    // the exact bodies the anthropic retry suite streams for retryable cases
    '{"error":{"type":"transient"}}',
    '{"error":{"type":"api_error"}}',
    // a real per-minute rate limit message — "rate limit" is deliberately
    // excluded from the hard needles so this keeps retrying
    '{"error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
    '{"error":{"type":"overloaded_error","message":"Overloaded"}}',
    '',
  ])('does NOT flag a transient body: %s', (body) => {
    expect(isUsageLimitResponse(429, body)).toBe(false);
    expect(isUsageLimitResponse(529, body)).toBe(false);
    expect(isUsageLimitResponse(500, body)).toBe(false);
  });
});

describe('apiErrorMessage', () => {
  test('extracts { error: { message } } (Anthropic/OpenAI shape)', () => {
    expect(apiErrorMessage('{"error":{"message":"credit balance is too low"}}'))
      .toBe('credit balance is too low');
  });

  test('extracts { error: "string" }', () => {
    expect(apiErrorMessage('{"error":"nope"}')).toBe('nope');
  });

  test('falls back to a trimmed raw slice for non-JSON', () => {
    expect(apiErrorMessage('  plain text error  ')).toBe('plain text error');
  });

  test('truncates very long messages with an ellipsis', () => {
    const long = 'x'.repeat(400);
    const out = apiErrorMessage(long, 50);
    expect(out!.length).toBe(50);
    expect(out!.endsWith('…')).toBe(true);
  });

  test('returns undefined for an empty body', () => {
    expect(apiErrorMessage('')).toBeUndefined();
    expect(apiErrorMessage('   ')).toBeUndefined();
  });
});
