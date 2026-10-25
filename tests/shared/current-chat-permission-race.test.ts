import { expect, test } from 'bun:test';
import { createCurrentChat } from '../../extension/shared/current-session-binding.js';
import { captureSessionAuthority } from '../../extension/shared/session-authority-epoch.js';
import { createKernelSessionAuthority } from '../../extension/background/kernel-session-authority.js';

// Exercise the production permission commit alongside lazy durable creation:
// no direct Map write stands in for the operation whose ordering matters.
test('a permission downgrade during first chat creation lands after binding', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cache = new Map<string, unknown>([
    ['currentPermissionMode', 'act'], ['currentConfirmActions', false],
  ]);
  const sessionCache = {
    sessionGet: async (key: string) => cache.get(key),
    sessionSet: async (key: string, value: unknown) => { cache.set(key, value); },
    sessionDelete: async (key: string) => { cache.delete(key); },
  };
  let record: any;
  const sessions = {
    listSummaries: async () => [],
    create: async (fields: any) => {
      entered.resolve();
      await release.promise;
      record = { ...fields, sessionId: 'new' };
      return { ...record };
    },
    updateMetadata: async (_id: string, patch: any) => { Object.assign(record, patch); return record; },
  };
  const authority = createKernelSessionAuthority({
    admitRoute: () => true, sessions, sessionCache,
    vault: { isLocked: () => false }, ready: Promise.resolve(),
    resolvePermission: (session: any, mode: unknown, confirmActions: unknown) => ({
      mode: session?.permissionMode ?? mode,
      confirmActions: session?.confirmActions ?? confirmActions,
    }),
  });
  const creating = createCurrentChat(sessions, sessionCache);
  await entered.promise;
  const changing = authority.effects['support.permission.commit']({
    patch: { permissionMode: 'plan', confirmActions: true },
  });
  expect(captureSessionAuthority(sessionCache)()).toBe(false);
  release.resolve();
  await Promise.all([creating, changing]);
  expect(record).toMatchObject({ permissionMode: 'plan', confirmActions: true });
  expect(Object.fromEntries(cache)).toEqual({
    currentSessionId: 'new', currentPermissionMode: 'plan', currentConfirmActions: true,
  });
  expect(captureSessionAuthority(sessionCache)()).toBe(true);
});
