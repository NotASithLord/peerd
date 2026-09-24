import { describe, expect, test } from 'bun:test';
import {
  navigatePageProgram,
  readPageProgram,
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
    expect(posted).toHaveLength(1);
    await expect(pending[32]).resolves.toMatchObject({
      ok: false, code: 'page_program_inflight_limit', outcomeKnown: true,
    });
    releasePageProgramSemanticOwner(token);
    const retired = await Promise.all(pending.slice(0, 32));
    expect(retired.every((result: any) => result.outcomeKnown === false)).toBe(true);
  });

  test('keeps concurrent first navigations and a read in issuance order through settlement', async () => {
    const posted: any[] = [];
    const worker = { postMessage: (message: any) => { posted.push(message); } } as Worker;
    const token = registerPageProgramSemanticOwner(worker, 'outer-call');
    const first = navigatePageProgram(token, { url: 'https://example.com/first' });
    const second = navigatePageProgram(token, { url: 'https://example.com/second' });
    const read = readPageProgram(token, {});
    expect(posted.map((message) => message.type)).toEqual(['page-program-navigate-request']);
    settlePageProgramSemanticResponse(token, {
      type: 'page-program-navigate-response', rid: posted[0].rid,
      result: { ok: true, value: 'first' },
    });
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(posted).toHaveLength(2);
    expect(posted[1].args.url).toBe('https://example.com/second');
    settlePageProgramSemanticResponse(token, {
      type: 'page-program-navigate-response', rid: posted[1].rid,
      result: { ok: true, value: 'second' },
    });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(posted[2].type).toBe('page-program-read-request');
    settlePageProgramSemanticResponse(token, {
      type: 'page-program-read-response', rid: posted[2].rid,
      result: { ok: true, value: 'live page' },
    });
    await expect(read).resolves.toMatchObject({ value: 'live page' });
    releasePageProgramSemanticOwner(token);
  });

  test('does not dispatch queued operations after an unknown outcome', async () => {
    const posted: any[] = [];
    const worker = { postMessage: (message: any) => { posted.push(message); } } as Worker;
    const token = registerPageProgramSemanticOwner(worker, 'outer-call');
    const first = navigatePageProgram(token, { url: 'https://example.com/first' });
    const next = navigatePageProgram(token, { url: 'https://example.com/second' });
    settlePageProgramSemanticResponse(token, {
      type: 'page-program-navigate-response', rid: posted[0].rid,
      result: { ok: false, outcomeKnown: false },
    });
    await expect(first).resolves.toMatchObject({ outcomeKnown: false });
    await expect(next).resolves.toMatchObject({ outcomeKnown: false, retryable: false });
    expect(posted).toHaveLength(1);
  });

  test('ignores responses for a queued request and keeps unrelated owners independent', async () => {
    const posted: any[] = [];
    const worker = { postMessage: (message: any) => { posted.push(message); } } as Worker;
    const token = registerPageProgramSemanticOwner(worker, 'outer-call');
    const otherToken = registerPageProgramSemanticOwner(worker, 'other-call');
    const first = navigatePageProgram(token, { url: 'https://example.com/first' });
    const queued = readPageProgram(token, {});
    const other = readPageProgram(otherToken, {});
    expect(posted).toHaveLength(2);
    settlePageProgramSemanticResponse(token, {
      type: 'page-program-read-response', rid: posted[0].rid.replace(/-1$/, '-2'),
      result: { ok: true, forged: true },
    });
    settlePageProgramSemanticResponse(otherToken, {
      type: 'page-program-read-response', rid: posted[1].rid,
      result: { ok: true },
    });
    await expect(other).resolves.toMatchObject({ ok: true });
    releasePageProgramSemanticOwner(token);
    await expect(first).resolves.toMatchObject({ outcomeKnown: false });
    await expect(queued).resolves.toMatchObject({ outcomeKnown: false });
    releasePageProgramSemanticOwner(otherToken);
  });

  test('retires queued calls without dispatch when the owner closes or posting fails', async () => {
    const posted: any[] = [];
    const worker = { postMessage: (message: any) => { posted.push(message); } } as Worker;
    const token = registerPageProgramSemanticOwner(worker, 'outer-call');
    const first = navigatePageProgram(token, { url: 'https://example.com/first' });
    const next = readPageProgram(token, {});
    releasePageProgramSemanticOwner(token);
    await expect(first).resolves.toMatchObject({ outcomeKnown: false });
    await expect(next).resolves.toMatchObject({ outcomeKnown: false });
    expect(posted).toHaveLength(1);

    const failed = registerPageProgramSemanticOwner({
      postMessage: () => { throw new Error('host lost'); },
    } as unknown as Worker, 'failed-outer');
    await expect(navigatePageProgram(failed, { url: 'https://example.com/' }))
      .resolves.toMatchObject({ outcomeKnown: false, retryable: false });
    await expect(readPageProgram(failed, {})).resolves.toMatchObject({ ok: false });
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
