import { describe, test, expect } from 'bun:test';
import { mapError, errorSettingsTarget } from '../../extension/sidepanel/error-display.js';
import {
  listProviderModels, listProviders, providerFailureCode, UnknownProviderError,
} from '../../extension/peerd-provider/controller.js';
import { makeModelEgress } from '../peerd-provider/model-egress-fixture';

// The error banner reads BOTH the SW's typed codes ("provider-http-429") and
// the loop's raw throw text ("Provider 'anthropic' HTTP 429: {…}"). mapError
// turns either into human copy; errorSettingsTarget decides whether the
// "Open settings" button is even useful (the bug: it used to show for every
// error, misdirecting on transient/billing faults Settings can't fix).

describe('mapError', () => {
  test('non-string / empty → generic', () => {
    expect(mapError(null)).toBe('Something went wrong.');
    expect(mapError('')).toBe('Something went wrong.');
  });

  test('typed codes', () => {
    expect(mapError('provider-key-missing')).toMatch(/add one in Settings/i);
    expect(mapError('spend-limit-reached')).toMatch(/Spend limit reached/i);
    expect(mapError('provider-usage-limit')).toMatch(/Usage\/credit limit/i);
    expect(mapError('provider-usage-limit:over cap')).toMatch(/\(over cap\)/);
    expect(mapError('actor-recovery-pending')).toMatch(/Wait a moment, then send again/i);
  });

  test('one missing provider does not mean the registry is empty', async () => {
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(0);
    const missing = await listProviderModels('not-registered', {
      modelEgress: makeModelEgress(),
    }).catch((cause) => cause);
    expect(missing).toBeInstanceOf(UnknownProviderError);
    expect(listProviders()).toEqual(providers);
    const code = providerFailureCode(missing);
    expect(code).toBe('unknown-provider');
    expect(mapError(code)).toBe('The selected provider is unavailable. Choose another provider in Settings.');
    expect(errorSettingsTarget(code)).toEqual({ section: 'providers' });
  });

  test('raw provider throw text is matched, not dumped', () => {
    expect(mapError("Provider 'anthropic' HTTP 429: {...}")).toMatch(/Rate limited/i);
    expect(mapError('Provider HTTP 529: overloaded')).toMatch(/overloaded/i);
    expect(mapError('authentication_error: invalid x-api-key')).toMatch(/key rejected/i);
    expect(mapError('Your credit balance is too low')).toMatch(/account limit/i);
    // an unmatched 4xx/5xx names the status and a next step, never the body
    const body = '{"type":"error","error":{"type":"invalid_request_error","message":"x"}}';
    expect(mapError(`Provider 'anthropic' HTTP 400: ${body}`))
      .toBe('The provider rejected the request (HTTP 400). Try again, or pick another model.');
    expect(mapError(`Provider 'anthropic' HTTP 500: ${body}`))
      .toBe('The provider had an error (HTTP 500). Try again in a moment.');
  });

  test('a throttle that mentions billing or quota reads as a rate limit, not an account limit', () => {
    expect(mapError("Provider 'openai' HTTP 429: You can increase your rate limit by adding a payment method at https://platform.openai.com/account/billing."))
      .toMatch(/Rate limited/i);
    expect(mapError("Provider 'openrouter' HTTP 429: Resource has been exhausted (e.g. check quota)."))
      .toMatch(/Rate limited/i);
    expect(mapError("Provider 'openai' HTTP 429: insufficient_quota")).toMatch(/account limit/i);
    expect(mapError("Provider 'openai' HTTP 429: billing_not_active")).toMatch(/account limit/i);
  });
});

describe('errorSettingsTarget — only when Settings can fix it', () => {
  test('key/auth/config → providers', () => {
    expect(errorSettingsTarget('provider-key-missing')).toEqual({ section: 'providers' });
    expect(errorSettingsTarget('unknown-provider')).toEqual({ section: 'providers' });
    expect(errorSettingsTarget('provider-http-401')).toEqual({ section: 'providers' });
    expect(errorSettingsTarget("Provider 'anthropic' HTTP 401: authentication_error")).toEqual({ section: 'providers' });
  });

  test('spend limit → costs (where the setting lives)', () => {
    expect(errorSettingsTarget('spend-limit-reached')).toEqual({ section: 'costs' });
  });

  test('transient / external faults → null (no in-app remedy, no misdirection)', () => {
    expect(errorSettingsTarget('provider-http-429')).toBeNull();
    expect(errorSettingsTarget('provider-http-529')).toBeNull();
    expect(errorSettingsTarget("Provider 'anthropic' HTTP 429: rate_limit")).toBeNull();
    expect(errorSettingsTarget('provider-usage-limit')).toBeNull();
    expect(errorSettingsTarget('Your credit balance is too low')).toBeNull();
    expect(errorSettingsTarget('session-not-found')).toBeNull();
    expect(errorSettingsTarget('')).toBeNull();
    expect(errorSettingsTarget(null)).toBeNull();
  });
});
