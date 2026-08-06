import { describe, expect, test } from 'bun:test';
import { makeOffscreenJsClient } from '../../extension/background/offscreen-js-client.js';

describe('offscreen JS client', () => {
  test('Stop during offscreen startup prevents the job from being dispatched', async () => {
    let finishStartup = () => {};
    const startup = new Promise<void>((resolve) => { finishStartup = resolve; });
    const sent: object[] = [];
    const controller = new AbortController();
    const client = makeOffscreenJsClient({
      ensureOffscreen: () => startup,
      sendMessage: async (message: object) => {
        sent.push(message);
        return { ok: true, result: {} };
      },
    });

    const pending = client.execHeadless('return 1', {
      runId: 'run-1',
      signal: controller.signal,
    });
    controller.abort();
    finishStartup();

    await expect(pending).rejects.toThrow('headless job aborted before dispatch');
    expect(sent).toEqual([]);
  });
});
