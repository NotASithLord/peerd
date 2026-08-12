// §5h - the shared paste sanity check: one rule, two surfaces (the options
// Providers card and the onboarding provider step), so it must be pure and
// identical for both.

import { describe, test, expect } from 'bun:test';
import { checkApiKeyFormat, KEY_PREFIX } from '../../extension/peerd-provider/key-format.js';

describe('checkApiKeyFormat', () => {
  test('a short paste is refused as incomplete', () => {
    const r = checkApiKeyFormat('anthropic', 'sk-ant');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('Paste a complete API key.');
  });

  test('a wrong-provider prefix is named in the refusal', () => {
    const r = checkApiKeyFormat('anthropic', 'sk-or-v1-abcdef123456');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('"sk-ant-"');
  });

  test('a matching prefix passes and returns the trimmed value', () => {
    const r = checkApiKeyFormat('anthropic', '  sk-ant-api03-abc123  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('sk-ant-api03-abc123');
  });

  test('a provider absent from KEY_PREFIX fails open (no prefix rule)', () => {
    expect(KEY_PREFIX.glm).toBeUndefined();
    const r = checkApiKeyFormat('glm', 'some-long-enough-key');
    expect(r.ok).toBe(true);
  });
});
