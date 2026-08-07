import { describe, expect, test } from 'bun:test';
import { defaults } from '../../packaging/default-settings.mjs';
import { CHANNEL, CHANNEL_DEFAULTS } from '../../extension/shared/channel-config.js';

describe('web actor action-surface channel defaults', () => {
  test('preview is code-first while store remains on discrete tools', () => {
    expect(defaults.webActorActionSurface).toEqual({ store: 'tools', preview: 'code' });
    expect(CHANNEL).toBe('preview');
    expect(CHANNEL_DEFAULTS.webActorActionSurface).toBe('code');
  });
});
