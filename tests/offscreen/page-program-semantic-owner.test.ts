import { describe, expect, test } from 'bun:test';
import {
  fetchPageProgramResource,
  registerPageProgramSemanticOwner,
  releasePageProgramSemanticOwner,
  settlePageProgramSemanticResponse,
} from '../../extension/offscreen/page-program-semantic-owner.js';

describe('page program semantic owner', () => {
  test('binds a fixed nested request to its live parent execution', async () => {
    const posted: any[] = [];
    const worker = { postMessage: (message: any) => posted.push(message) } as any;
    const token = registerPageProgramSemanticOwner(worker, 'outer-page-execution');
    const pending = fetchPageProgramResource(token, { url: 'https://example.com' });
    expect(posted).toEqual([{
      type: 'page-program-fetch-request', rid: 'page-semantic-1',
      args: { url: 'https://example.com' },
      parentExecutionId: 'outer-page-execution',
    }]);
    expect(settlePageProgramSemanticResponse(token, {
      type: 'page-program-fetch-response', rid: 'page-semantic-1',
      result: { ok: true, content: 'done' },
    })).toBe(true);
    expect(await pending).toEqual({ ok: true, content: 'done' });
    releasePageProgramSemanticOwner(token);
  });

  test('retirement fails an unsettled operation without claiming an outcome', async () => {
    const token = registerPageProgramSemanticOwner({ postMessage: () => {} } as any, 'outer');
    const pending = fetchPageProgramResource(token, { url: 'https://example.com' });
    releasePageProgramSemanticOwner(token);
    expect(await pending).toMatchObject({ ok: false, outcomeKnown: false, retryable: false });
  });
});
