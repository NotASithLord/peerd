import { describe, expect, test } from 'bun:test';
import {
  contextOwnsAppRoom,
  createAppRoomLiveness,
} from '../../extension/offscreen/app-room-liveness.js';

const APP_URL = 'chrome-extension://peerd/engine-tabs/app-tab/index.html';
const claim = {
  roomId: 'room-one',
  clientId: 'room-client-one',
  appId: 'app-one',
  documentId: 'document-one',
  tabId: 17,
};
const admissionClaim = {
  ...claim,
  admissionToken: 'room-admission-token-one',
};
const context = {
  contextType: 'TAB',
  documentId: 'document-one',
  documentUrl: `${APP_URL}#app-one?owner=session-one`,
  tabId: 17,
};

describe('offscreen App-room document liveness', () => {
  test('pins membership to the exact App document, tab, and app id', () => {
    expect(contextOwnsAppRoom(context, claim, APP_URL)).toBe(true);
    expect(contextOwnsAppRoom({ ...context, documentId: 'other' }, claim, APP_URL)).toBe(false);
    expect(contextOwnsAppRoom({ ...context, tabId: 18 }, claim, APP_URL)).toBe(false);
    expect(contextOwnsAppRoom({ ...context, documentUrl: `${APP_URL}#app-two` }, claim, APP_URL)).toBe(false);
    expect(contextOwnsAppRoom({ ...context, documentUrl: `${APP_URL}.evil#app-one` }, claim, APP_URL)).toBe(false);
  });

  test('SW loss cannot strand a host-side join after its App document closes', async () => {
    let contexts: any[] = [context];
    const expired: any[] = [];
    const liveness = createAppRoomLiveness({
      appTabUrl: APP_URL,
      getContexts: async () => contexts,
      onExpired: async (row) => { expired.push(row); },
      setIntervalFn: (() => 1) as any,
      clearIntervalFn: (() => {}) as any,
    });
    expect(liveness.track(admissionClaim)).toBe(true);
    await liveness.sweep();
    expect(expired).toEqual([]);

    // Models host commit -> SW response loss -> user closes the App. Cleanup is
    // driven by the browser context inventory, not by the missing SW reply.
    contexts = [];
    await liveness.sweep();
    expect(expired).toEqual([
      expect.objectContaining({
        roomId: claim.roomId,
        clientId: claim.clientId,
        admissionToken: admissionClaim.admissionToken,
      }),
    ]);
    expect(liveness.snapshot()).toEqual([]);
  });

  test('host commit without an App acknowledgement expires while the exact document remains open', async () => {
    let now = 1_000;
    const expired: any[] = [];
    const liveness = createAppRoomLiveness({
      appTabUrl: APP_URL,
      getContexts: async () => [context],
      onExpired: async (row) => { expired.push(row); },
      provisionalMs: 2_000,
      now: () => now,
      setIntervalFn: (() => 1) as any,
      clearIntervalFn: (() => {}) as any,
    });
    expect(liveness.track(admissionClaim)).toBe(true);
    now = 3_001;
    await liveness.sweep();
    expect(expired).toEqual([
      expect.objectContaining({
        roomId: claim.roomId,
        clientId: claim.clientId,
        admissionToken: admissionClaim.admissionToken,
      }),
    ]);
    expect(liveness.snapshot()).toEqual([]);
  });

  test('exact acknowledgement finalizes membership and stale tokens cannot remove a later admission', async () => {
    let now = 1_000;
    const expired: any[] = [];
    const liveness = createAppRoomLiveness({
      appTabUrl: APP_URL,
      getContexts: async () => [context],
      onExpired: async (row) => { expired.push(row); },
      provisionalMs: 2_000,
      now: () => now,
      setIntervalFn: (() => 1) as any,
      clearIntervalFn: (() => {}) as any,
    });
    expect(liveness.track(admissionClaim)).toBe(true);
    expect(liveness.finalize(
      claim.roomId, claim.clientId, 'room-admission-token-forged',
    )).toBe(false);
    expect(liveness.finalize(
      claim.roomId, claim.clientId, admissionClaim.admissionToken,
    )).toBe(true);
    now = 10_000;
    await liveness.sweep();
    expect(expired).toEqual([]);

    expect(liveness.untrack(
      claim.roomId, claim.clientId, admissionClaim.admissionToken,
    )).toBe(true);
    const successor = {
      ...admissionClaim,
      admissionToken: 'room-admission-token-two',
    };
    expect(liveness.track(successor)).toBe(true);
    expect(liveness.untrack(
      claim.roomId, claim.clientId, admissionClaim.admissionToken,
    )).toBe(false);
    expect(liveness.snapshot()).toEqual([
      expect.objectContaining({ admissionToken: successor.admissionToken }),
    ]);
  });

  test('a recycled SW cannot expire a same-key rejoin that changed documents mid-sweep', async () => {
    let release!: (rows: any[]) => void;
    let entered!: () => void;
    const rows = new Promise<any[]>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const expired: any[] = [];
    const liveness = createAppRoomLiveness({
      appTabUrl: APP_URL,
      getContexts: async () => { entered(); return rows; },
      onExpired: async (row) => { expired.push(row); },
      setIntervalFn: (() => 1) as any,
      clearIntervalFn: (() => {}) as any,
    });
    liveness.track(claim);
    const sweeping = liveness.sweep();
    await reading;
    const successor = { ...claim, documentId: 'document-two' };
    liveness.track(successor);
    release([]);
    await sweeping;
    expect(expired).toEqual([]);
    expect(liveness.snapshot()).toEqual([successor]);
  });

  test('enumeration failure is fail-safe and invalid claims never start a lease', async () => {
    const expired: any[] = [];
    const liveness = createAppRoomLiveness({
      appTabUrl: APP_URL,
      getContexts: async () => { throw new Error('browser unavailable'); },
      onExpired: async (row) => { expired.push(row); },
      setIntervalFn: (() => 1) as any,
      clearIntervalFn: (() => {}) as any,
    });
    expect(liveness.track({ ...claim, documentId: '' })).toBe(false);
    expect(liveness.track(claim)).toBe(true);
    await liveness.sweep();
    expect(expired).toEqual([]);
    expect(liveness.snapshot()).toEqual([claim]);
  });

  test('provisional admission still expires when browser context enumeration is unavailable', async () => {
    let now = 1_000;
    const expired: any[] = [];
    const liveness = createAppRoomLiveness({
      appTabUrl: APP_URL,
      getContexts: null,
      onExpired: async (row) => { expired.push(row); },
      provisionalMs: 2_000,
      now: () => now,
      setIntervalFn: (() => 1) as any,
      clearIntervalFn: (() => {}) as any,
    });
    expect(liveness.track(admissionClaim)).toBe(true);
    now = 3_001;
    await liveness.sweep();
    expect(expired).toEqual([
      expect.objectContaining({ admissionToken: admissionClaim.admissionToken }),
    ]);
  });
});
