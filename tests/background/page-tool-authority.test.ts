import { describe, expect, test } from 'bun:test';
import { createPageToolAuthority } from '../../extension/background/page-tool-authority.js';

describe('exact page authority', () => {
  test('runs page code with authority-owned capability limits and run identity', async () => {
    const observed: any[] = [];
    const authority = createPageToolAuthority({
      call: { name: 'page_code', args: { code: 'return 42', timeoutMs: 999_999 } },
      ctx: {
        session: { sessionId: 'actor-web-1' },
        jsOffscreenClient: {
          execHeadless: async (code: string, options: any) => {
            observed.push({ code, options });
            return { value: 42, error: null };
          },
        },
        scriptRuns: {
          mintRunId: () => 'page-run-1',
          register: (...args: any[]) => observed.push({ register: args }),
          release: (...args: any[]) => observed.push({ release: args }),
        },
      },
    });
    await expect(authority.runOwnedPageProgram()).resolves
      .toEqual({ value: 42, error: null });
    expect(observed[0].register).toEqual([
      'page-run-1', undefined, 'actor-web-1', { page: true },
    ]);
    expect(observed[1]).toMatchObject({
      code: 'return 42',
      options: {
        timeoutMs: 180_000,
        caps: { page: true, egress: false, subagent: false, opfs: false },
        ownerSessionId: 'actor-web-1', runId: 'page-run-1',
      },
    });
    expect(observed[2].release).toEqual(['page-run-1']);
  });

  test('refuses a handler that does not match the admitted tool', () => {
    const authority = createPageToolAuthority({
      call: { name: 'snapshot', args: {} }, ctx: {},
    });
    expect(() => authority.clickOwnedTarget()).toThrow('page authority mismatch');
  });
});
