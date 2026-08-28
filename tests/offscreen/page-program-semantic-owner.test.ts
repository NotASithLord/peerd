import { describe, expect, test } from 'bun:test';
import {
  navigatePageProgram,
  registerPageProgramSemanticOwner,
  releasePageProgramSemanticOwner,
  settlePageProgramSemanticResponse,
} from '../../extension/offscreen/page-program-semantic-owner.js';

describe('page-program semantic owner admission', () => {
  test('caps an unawaited in-flight burst before posting into the actor Worker', async () => {
    const posted: any[] = [];
    const worker = { postMessage: (message: any) => { posted.push(message); } } as Worker;
    const token = registerPageProgramSemanticOwner(worker, 'outer-call');
    const pending = Array.from({ length: 33 }, (_, index) =>
      navigatePageProgram(token, { url: `https://example.com/${index}` }));
    expect(posted).toHaveLength(32);
    await expect(pending[32]).resolves.toMatchObject({
      ok: false, code: 'page_program_inflight_limit', outcomeKnown: true,
    });
    releasePageProgramSemanticOwner(token);
    const retired = await Promise.all(pending.slice(0, 32));
    expect(retired.every((result: any) => result.outcomeKnown === false)).toBe(true);
  });

  test('caps total requests even when every earlier request settled', async () => {
    const posted: any[] = [];
    const worker = { postMessage: (message: any) => { posted.push(message); } } as Worker;
    const token = registerPageProgramSemanticOwner(worker, 'outer-call');
    for (let index = 0; index < 256; index += 1) {
      const pending = navigatePageProgram(token, { url: `https://example.com/${index}` });
      const message = posted.at(-1);
      expect(settlePageProgramSemanticResponse(token, {
        type: 'page-program-navigate-response', rid: message.rid,
        result: { ok: true },
      })).toBe(true);
      await expect(pending).resolves.toEqual({ ok: true });
    }
    await expect(navigatePageProgram(token, { url: 'https://example.com/excess' }))
      .resolves.toMatchObject({ ok: false, code: 'page_program_request_limit' });
    expect(posted).toHaveLength(256);
    releasePageProgramSemanticOwner(token);
  });

  test('a stale retired-owner response cannot settle a successor request', async () => {
    const posted: any[] = [];
    const worker = { postMessage: (message: any) => { posted.push(message); } } as Worker;
    const retiredToken = registerPageProgramSemanticOwner(worker, 'retired-outer');
    const retired = navigatePageProgram(retiredToken, { url: 'https://old.example/' });
    const staleMessage = posted.at(-1);
    releasePageProgramSemanticOwner(retiredToken);
    await expect(retired).resolves.toMatchObject({ outcomeKnown: false });

    const liveToken = registerPageProgramSemanticOwner(worker, 'live-outer');
    const live = navigatePageProgram(liveToken, { url: 'https://new.example/' });
    const liveMessage = posted.at(-1);
    expect(liveMessage.rid).not.toBe(staleMessage.rid);
    expect(settlePageProgramSemanticResponse(liveToken, {
      type: 'page-program-navigate-response', rid: staleMessage.rid,
      result: { ok: true, stale: true },
    })).toBe(true);
    expect(settlePageProgramSemanticResponse(liveToken, {
      type: 'page-program-navigate-response', rid: liveMessage.rid,
      result: { ok: true, live: true },
    })).toBe(true);
    await expect(live).resolves.toEqual({ ok: true, live: true });
    releasePageProgramSemanticOwner(liveToken);
  });
});
