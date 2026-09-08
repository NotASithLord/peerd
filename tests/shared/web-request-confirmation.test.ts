import { describe, expect, test } from 'bun:test';
import { finalWebRequestConfirmation } from '../../extension/shared/web-request-confirmation.js';

describe('final host web-request confirmation', () => {
  test('shows the final target shape and payload metadata without secret bytes', () => {
    const prompt = finalWebRequestConfirmation({
      url: 'https://user:password@example.com:444/v2/write?token=secret&id=7',
      method: 'post', headers: { 'content-type': 'application/json', 'x-safe': 'ignored' },
      body: '{"secret":"do not display"}', source: 'site client',
    });
    expect(prompt.origins).toEqual(['https://example.com:444']);
    expect(prompt.summary).toContain('POST https://example.com:444/v2/write');
    expect(prompt.summary).toContain('Query fields: token, id');
    expect(prompt.summary).toContain('Embedded URL credentials are present but hidden');
    expect(prompt.summary).toContain('2 non-credential request headers');
    expect(prompt.summary).toContain('bytes of JSON; contents hidden');
    expect(prompt.summary).not.toContain('password');
    expect(prompt.summary).not.toContain('do not display');
    expect(prompt.summary).not.toContain('token=secret');
  });
});
