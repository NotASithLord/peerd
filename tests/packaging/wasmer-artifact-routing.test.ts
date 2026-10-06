import { expect, test } from 'bun:test';
import { WASMER_STATE } from '../../scripts/cdp/wasmer-state.mjs';

test('the Wasmer acceptance state launches the selected artifact with browser security enabled', async () => {
  const stopBeforeBrowser = new Error('captured launch');
  for (const extensionDir of ['/tmp/packaged-preview/extension', undefined]) {
    let options: unknown;
    await expect(WASMER_STATE.run(extensionDir ? { extensionDir } : null, {}, {
      launch: async (input) => { options = input; throw stopBeforeBrowser; },
    })).rejects.toBe(stopBeforeBrowser);
    expect(options).toEqual({ extensionDir, enforceWebSecurity: true, headless: true });
  }
});
