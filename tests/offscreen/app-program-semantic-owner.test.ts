import { describe, expect, test } from 'bun:test';
import {
  actAppProgram,
  observeAppProgram,
  registerAppProgramSemanticOwner,
  releaseAppProgramSemanticOwner,
  settleAppProgramSemanticResponse,
} from '../../extension/offscreen/app-program-semantic-owner.js';

describe('app-program semantic owner admission', () => {
  test('binds observe and act to one outer exact execution', async () => {
    const posted: any[] = [];
    const worker = { postMessage: (message: any) => { posted.push(message); } } as Worker;
    const token = registerAppProgramSemanticOwner(worker, 'outer-app-effect');
    const observed = observeAppProgram(token);
    const acted = actAppProgram(token, { action: 'move', params: { x: 1 } });
    expect(posted.map(({ type, parentExecutionId }) => ({ type, parentExecutionId })))
      .toEqual([
        { type: 'app-program-observe-request', parentExecutionId: 'outer-app-effect' },
        { type: 'app-program-act-request', parentExecutionId: 'outer-app-effect' },
      ]);
    settleAppProgramSemanticResponse(token, {
      type: 'app-program-observe-response', rid: posted[0].rid,
      result: { ok: true, structured: { value: { screen: 'game' } } },
    });
    settleAppProgramSemanticResponse(token, {
      type: 'app-program-act-response', rid: posted[1].rid,
      result: { ok: true, structured: { value: { accepted: true } } },
    });
    await expect(observed).resolves.toMatchObject({ ok: true });
    await expect(acted).resolves.toMatchObject({ ok: true });
    releaseAppProgramSemanticOwner(token);
  });

  test('caps unawaited requests and refuses all pending work on release', async () => {
    const posted: any[] = [];
    const worker = { postMessage: (message: any) => { posted.push(message); } } as Worker;
    const token = registerAppProgramSemanticOwner(worker, 'outer-app-effect');
    const pending = Array.from({ length: 33 }, () => observeAppProgram(token));
    expect(posted).toHaveLength(32);
    await expect(pending[32]).resolves.toMatchObject({
      ok: false, code: 'app_program_inflight_limit', outcomeKnown: true,
    });
    releaseAppProgramSemanticOwner(token);
    const retired = await Promise.all(pending.slice(0, 32));
    expect(retired.every((result: any) => result.outcomeKnown === false)).toBe(true);
  });

  test('a stale retired-owner response cannot settle a successor request', async () => {
    const posted: any[] = [];
    const worker = { postMessage: (message: any) => { posted.push(message); } } as Worker;
    const retiredToken = registerAppProgramSemanticOwner(worker, 'retired-outer');
    const retired = observeAppProgram(retiredToken);
    const staleMessage = posted.at(-1);
    releaseAppProgramSemanticOwner(retiredToken);
    await expect(retired).resolves.toMatchObject({ outcomeKnown: false });

    const liveToken = registerAppProgramSemanticOwner(worker, 'live-outer');
    const live = observeAppProgram(liveToken);
    const liveMessage = posted.at(-1);
    expect(liveMessage.rid).not.toBe(staleMessage.rid);
    expect(settleAppProgramSemanticResponse(liveToken, {
      type: 'app-program-observe-response', rid: staleMessage.rid,
      result: { ok: true, stale: true },
    })).toBe(true);
    expect(settleAppProgramSemanticResponse(liveToken, {
      type: 'app-program-observe-response', rid: liveMessage.rid,
      result: { ok: true, live: true },
    })).toBe(true);
    await expect(live).resolves.toEqual({ ok: true, live: true });
    releaseAppProgramSemanticOwner(liveToken);
  });
});
