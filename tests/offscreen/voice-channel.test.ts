import { describe, expect, test } from 'bun:test';
import { createServiceWorkerChannels } from '../../extension/offscreen/supervisor-channels.js';
import { backgroundScriptUrl } from '../../extension/offscreen/sender-checks.js';
import { parseVoiceCommand } from '../../extension/shared/voice-channel.js';

const offer = {
  type: 'peerd/voice-channel', protocol: 1, requestId: 'voice-request-0001',
  command: { type: 'voice/teardown' },
  lease: { scope: 'media-host', leaseId: 'lease-media-0001' },
};

describe('offscreen voice channel admission', () => {
  test('the shared command contract rejects extra fields and target-specific abuse', () => {
    expect(parseVoiceCommand({
      type: 'voice/init', variant: 'base', engine: 'moonshine', extra: true,
    })).toBeNull();
    expect(parseVoiceCommand({ type: 'voice/listen', targetId: 'x'.repeat(257) })).toBeNull();
    expect(parseVoiceCommand({ type: 'voice/silence', ms: 30_001 })).toBeNull();
    expect(parseVoiceCommand({ type: 'voice/stop' })).toEqual({ type: 'voice/stop' });
  });
  test('loads voice only for the exact worker source and active media lease', async () => {
    let accepted = 0;
    let closed = 0;
    const channels = createServiceWorkerChannels({
      getFeatureLeaseHost: () => ({
        isActive: () => true,
        ownsLease: (_scope: string, lease: any) => lease.leaseId === 'lease-media-0001',
      }),
      loadControllerBootstrap: async () => ({}),
      loadVoiceHost: async () => ({
        acceptVoiceChannelOffer: () => { accepted += 1; },
      }),
    });
    const message = (scriptURL: string) => ({
      data: offer,
      isTrusted: true,
      source: { scriptURL },
      ports: [{ close: () => { closed += 1; } }],
    } as unknown as MessageEvent);
    channels.onMessage(message('chrome-extension://foreign/background.js'));
    channels.onMessage(message(backgroundScriptUrl));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ accepted, closed }).toEqual({ accepted: 1, closed: 1 });
  });
});
