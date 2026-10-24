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
    '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}',
    'insufficient_quota',
    'Billing hard limit has been reached',
    '{"error":{"message":"Your account is not active, please check your billing details on our website.","type":"billing_not_active","param":null,"code":"billing_not_active"}}',
    '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}',
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
    // throttles that mention billing or quota but clear by waiting: OpenAI's
    // free-tier per-minute limits link the billing page, and Google-routed
    // OpenRouter requests name a per-minute quota
    "{\"error\": {\"message\": \"Rate limit reached for gpt-4o-mini in organization org-abc on requests per min (RPM): Limit 3, Used 3, Requested 1. Please try again in 20s. Visit https://platform.openai.com/account/rate-limits to learn more. You can increase your rate limit by adding a payment method to your account at https://platform.openai.com/account/billing.\", \"type\": \"requests\", \"param\": null, \"code\": \"rate_limit_exceeded\"}}",
    "{\"error\": {\"message\": \"Rate limit reached for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Used 28000, Requested 4000. Please try again in 4s. Visit https://platform.openai.com/account/rate-limits to learn more. You can increase your rate limit by adding a payment method to your account at https://platform.openai.com/account/billing.\", \"type\": \"tokens\", \"param\": null, \"code\": \"rate_limit_exceeded\"}}",
    "{\"error\": {\"message\": \"Provider returned error\", \"code\": 429, \"metadata\": {\"raw\": \"{\\\"error\\\": {\\\"code\\\": 429, \\\"message\\\": \\\"Resource has been exhausted (e.g. check quota).\\\", \\\"status\\\": \\\"RESOURCE_EXHAUSTED\\\"}}\", \"provider_name\": \"Google\"}}}",
    "{\"error\": {\"message\": \"Quota exceeded for quota metric 'Generate Content API requests per minute' and limit 'GenerateContent request limit per minute for a region' of service 'generativelanguage.googleapis.com'.\", \"code\": 429, \"metadata\": {\"provider_name\": \"Google AI Studio\"}}}",
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
