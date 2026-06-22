import { describe, test, expect } from 'bun:test';
import { mapError, errorSettingsTarget } from '../../extension/sidepanel/error-display.js';

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
  });

  test('raw provider throw text is matched, not dumped', () => {
    expect(mapError("Provider 'anthropic' HTTP 429: {...}")).toMatch(/Rate limited/i);
    expect(mapError('Provider HTTP 529: overloaded')).toMatch(/overloaded/i);
    expect(mapError('authentication_error: invalid x-api-key')).toMatch(/key rejected/i);
    expect(mapError('Your credit balance is too low')).toMatch(/account limit/i);
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
