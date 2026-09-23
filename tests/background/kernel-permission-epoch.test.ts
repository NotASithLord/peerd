import { describe, expect, test } from 'bun:test';
import { createKernelSessionAuthority } from '../../extension/background/kernel-session-authority.js';
import {
  beginSessionAuthorityChange, captureSessionAuthority,
} from '../../extension/shared/session-authority-epoch.js';

describe('kernel permission commit authority fence', () => {
  test.each(['success', 'failure'])('revokes both stores before readiness and through cache %s', async (outcome) => {
    const ready = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const write = Promise.withResolvers<void>();
    const idb = {};
    const cacheValues = new Map<string, unknown>([['currentSessionId', 'chat']]);
    const updates: unknown[] = [];
    const sessionCache = {
      sessionGet: async (key: string) => cacheValues.get(key),
      sessionSet: async (key: string, value: unknown) => {
        entered.resolve();
        await write.promise;
        cacheValues.set(key, value);
      },
    };
    const authority = createKernelSessionAuthority({
      admitRoute: () => false,
      ready: ready.promise,
      vault: { isLocked: () => false },
      sessionCache,
      sessions: {
        listSummaries: async () => [],
        beginAuthorityChange: () => beginSessionAuthorityChange(idb),
        updateMetadata: async (id: string, patch: unknown) => {
          updates.push({ id, patch });
          return { sessionId: id, permissionMode: 'plan' };
        },
      },
      resolvePermission: () => ({ mode: 'plan', confirmActions: true }),
    });
    const prior = [captureSessionAuthority(idb), captureSessionAuthority(sessionCache)];
    expect(prior.map((current) => current())).toEqual([true, true]);
    const commit = authority.effects['support.permission.commit']({ patch: { permissionMode: 'plan' } });
    // why: a request already waiting at final-send must lose authority before
    // either readiness or either store can yield to an unrelated request.
    expect(prior.map((current) => current())).toEqual([false, false]);
    expect(captureSessionAuthority(idb)()).toBe(false);
    expect(captureSessionAuthority(sessionCache)()).toBe(false);
    ready.resolve();
    await entered.promise;
    expect(captureSessionAuthority(idb)()).toBe(false);
    expect(captureSessionAuthority(sessionCache)()).toBe(false);
    if (outcome === 'failure') {
      const rejected = commit.catch((error: unknown) => error);
      write.reject(new Error('cache unavailable'));
      expect(await rejected).toMatchObject({ outcomeKnown: false, retryable: false });
      expect(updates).toEqual([]);
    } else {
      write.resolve();
      await expect(commit).resolves.toEqual({ mode: 'plan', confirmActions: true });
      expect(updates).toEqual([{ id: 'chat', patch: { permissionMode: 'plan' } }]);
    }
    expect(prior.map((current) => current())).toEqual([false, false]);
    expect(captureSessionAuthority(idb)()).toBe(true);
    expect(captureSessionAuthority(sessionCache)()).toBe(true);
  });
});
