import { describe, expect, test } from 'bun:test';
import { makeKernelRouteProvenance } from '../../extension/background/vault-kernel-core.js';

describe('kernel voice route provenance', () => {
  test('separates human commands, offscreen events, and the mic grant page', () => {
    const table = makeKernelRouteProvenance({
      humanUi: () => false,
      homeUi: () => false,
      sidepanelUi: () => false,
      optionsUi: () => false,
      appUi: () => false,
      voiceUi: (sender: any) => sender?.surface === 'voice-ui',
      offscreenUi: (sender: any) => sender?.surface === 'offscreen',
      micUi: (sender: any) => sender?.surface === 'mic',
      vaultRoutes: [],
    });
    expect(table.get('voice/init')?.({ surface: 'voice-ui' }, {})).toBe(true);
    expect(table.get('voice/init')?.({ surface: 'offscreen' }, {})).toBe(false);
    expect(table.get('voice/chunk')?.({ surface: 'offscreen' }, {})).toBe(true);
    expect(table.get('voice/chunk')?.({ surface: 'voice-ui' }, {})).toBe(false);
    expect(table.get('voice/permission-result')?.({ surface: 'mic' }, {})).toBe(true);
    expect(table.get('dweb/base-host/generation')?.({ surface: 'offscreen' }, {})).toBe(true);
  });
});
