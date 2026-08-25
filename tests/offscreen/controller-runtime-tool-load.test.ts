import { describe, expect, test } from 'bun:test';
import { loadControllerToolRuntimeForCall } from '../../extension/offscreen/controller-runtime.js';
import { makeBoundedModuleLoader } from '../../extension/shared/bounded-module-load.js';

describe('controller tool runtime loading', () => {
  test('Stop releases a call without cancelling the shared import', async () => {
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    const shared = new Promise((resolve) => { finish = resolve; });
    const running = loadControllerToolRuntimeForCall(() => shared, controller.signal);
    controller.abort();
    await expect(running).rejects.toMatchObject({
      code: 'controller-tool-runtime-load-aborted', outcomeKnown: true,
      retryable: true, phase: 'startup',
    });
    finish({ executeControllerToolCall: () => {} });
    await expect(shared).resolves.toBeTruthy();
  });

  test('an unresolved import retains a known pre-effect timeout', async () => {
    const load = makeBoundedModuleLoader(
      () => new Promise(() => {}),
      {
        timeoutMs: 5, loadCode: 'controller-tool-runtime-load-failed',
        timeoutCode: 'controller-tool-runtime-load-timeout',
      },
    );
    await expect(loadControllerToolRuntimeForCall(
      load, new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'controller-tool-runtime-load-timeout', outcomeKnown: true,
      retryable: true, phase: 'startup',
    });
  });
});
