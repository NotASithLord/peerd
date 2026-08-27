import { describe, expect, test } from 'bun:test';
import {
  createKernelFirefoxLazyAddon,
} from '../../extension/background/kernel-firefox-addon.js';
import {
  makeKernelFirefoxContributor,
} from '../../extension/background/kernel-firefox-contributor-addon.js';

describe('kernel Firefox lazy addon', () => {
  test('disabled contributor arm performs one local read without loading semantics', async () => {
    const loads: string[] = [];
    const contributorFactory = makeKernelFirefoxContributor({
      contributorOwner: async () => { loads.push('owner'); return {}; },
      contributorSemantic: async () => { loads.push('semantic'); return {}; },
    });
    let reads = 0;
    const contributor = contributorFactory({
      kv: {
        get: async () => { reads += 1; return null; },
        set: async () => {}, delete: async () => {},
      },
    });
    expect(await contributor.arm()).toEqual({ enabled: false, generation: null });
    expect({ reads, loads }).toEqual({ reads: 1, loads: [] });
  });

  test('refuses an untrusted contributor sender before storage or semantic demand', async () => {
    const loads: string[] = [];
    const contributorFactory = makeKernelFirefoxContributor({
      contributorOwner: async () => { loads.push('owner'); return {}; },
      contributorSemantic: async () => { loads.push('semantic'); return {}; },
    });
    const optionsSender = {};
    const sidepanelSender = {};
    let reads = 0;
    const contributor = contributorFactory({
      kv: {
        get: async () => { reads += 1; return null; },
        set: async () => {}, delete: async () => {},
      },
      optionsUi: (candidate: any) => candidate === optionsSender,
      sidepanelUi: (candidate: any) => candidate === sidepanelSender,
      homeUi: () => false,
    });
    expect(await contributor.routes['contributor/status']({
      type: 'contributor/status',
    }, {})).toEqual({
      ok: false, code: 'contributor-channel-admission-denied', outcomeKnown: true,
    });
    expect(await contributor.routes['contributor/feedback']({
      type: 'contributor/feedback',
    }, {})).toEqual({
      ok: false, error: 'trusted-chat-sender-required', outcomeKnown: true,
    });
    expect({ reads, loads }).toEqual({ reads: 0, loads: [] });
  });

  test('loads each implementation only on its exact first demand', async () => {
    const loads: string[] = [];
    const addon = createKernelFirefoxLazyAddon({
      controller: async () => {
        loads.push('controller');
        return { connectDirectController: async (value: any) => ({ controller: value }) };
      },
      lifetime: async () => {
        loads.push('lifetime');
        return { lifetime: true };
      },
      repository: async () => {
        loads.push('repository');
        return { createFirefoxRepositoryClient: async (value: any) => ({ repository: value }) };
      },
    });

    expect(loads).toEqual([]);
    const connect = addon.connectDirectController;
    const createRepository = addon.createFirefoxRepositoryClient;
    expect(loads).toEqual([]);

    await expect(connect('controller-deps')).resolves.toEqual({
      controller: 'controller-deps',
    });
    expect(loads).toEqual(['controller']);
    await connect('again');
    expect(loads).toEqual(['controller']);

    await expect(createRepository('repository-deps')).resolves.toEqual({
      repository: 'repository-deps',
    });
    expect(loads).toEqual(['controller', 'repository']);

    await expect(addon.firefoxLifetime).resolves.toEqual({ lifetime: true });
    await expect(addon.firefoxLifetime).resolves.toEqual({ lifetime: true });
    expect(loads).toEqual(['controller', 'repository', 'lifetime']);
  });
});
