import { describe, expect, test } from 'bun:test';
import {
  createKernelFirefoxLazyAddon,
} from '../../extension/background/kernel-firefox-addon.js';

describe('kernel Firefox lazy addon', () => {
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
