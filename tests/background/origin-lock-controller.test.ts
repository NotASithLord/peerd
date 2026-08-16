import { describe, expect, test } from 'bun:test';
import { makeOriginLockResolver } from '../../extension/background/origin-lock-controller.js';

const makeHarness = () => {
  const turnTokens = new Map([['actor', 1]]);
  const stopped: string[] = [];
  const released: number[] = [];
  const audits: any[] = [];
  let judgeDeps: any;
  const state = { mode: 'bound', provisional: false };
  const deps: any = {
    originStates: {
      read: () => state,
      write: async () => {},
      serialize: async (_id: string, operation: () => any) => operation(),
    },
    landingTurnTokens: turnTokens,
    landingStopReports: new Map(),
    landingStopCards: new Map(),
    makeJudgeLanding: (options: any) => {
      judgeDeps = options;
      return async (url: string) => ({ action: 'continue', url });
    },
    describeLandingStop: () => 'stopped report',
    landingStopCard: () => ({ kind: 'origin-stop' }),
    retireStoppedRoamingWebActorDurably: async () => ({
      tombstone: { status: 'fulfilled' }, routing: { status: 'fulfilled' },
    }),
    webActorRegistry: {}, retiredActorSessions: new Set(), persistWebActors: () => {},
    turnSlots: { stop: (id: string) => { stopped.push(id); } },
    webActorTabBindings: { tabFor: () => 7, drop: () => true },
    persistWebBindings: () => {},
    pageActivity: { release: async (id: number) => { released.push(id); } },
    siteActorBindings: { entries: () => [], drop: () => {} }, persistSiteActors: () => {},
    auditLog: { append: async (event: any) => { audits.push(event); } },
    originPhrase: (url: string) => new URL(url).origin,
    isKnownIdp: () => false, isKnownIdpHost: () => false,
    sensitivitySignals: () => ({}),
    makeSignInOriginAuthorizer: () => async () => true,
    makeSignInExcursionAuthorizer: () => async () => true,
    makeSignInExcursionRevoker: () => async () => true,
    makeCredentialScope: () => ({}),
    makeSiteClientOriginGuard: () => () => true,
    makeSiteClientOriginAuthorizer: () => async () => true,
    liveSiteClientLandingFor: async () => ({ status: 'none' }),
  };
  const resolve = makeOriginLockResolver(deps);
  return { resolve, turnTokens, stopped, released, audits, getJudgeDeps: () => judgeDeps };
};

describe('origin lock controller', () => {
  test('returns no lock for an unbound actor context', () => {
    expect(makeHarness().resolve(null)).toBeNull();
  });

  test('serializes judgments and refuses a context after its turn token changes', async () => {
    const harness = makeHarness();
    const lock = harness.resolve('actor')!;
    await expect(lock.judgeLanding('https://safe.example/path')).resolves.toEqual({
      action: 'continue', url: 'https://safe.example/path',
    });
    harness.turnTokens.set('actor', 2);
    await expect(lock.judgeLanding('https://later.example/')).rejects.toMatchObject({
      name: 'AbortError', message: 'stale_actor_turn',
    });
  });

  test('stops the current turn, releases its binding, and narrows audit URLs', async () => {
    const harness = makeHarness();
    harness.resolve('actor');
    await harness.getJudgeDeps().onStop({
      action: 'handoff', from: 'https://safe.example/',
      to: 'https://other.example/attacker-controlled?payload=1',
    });
    await Promise.resolve();

    expect(harness.stopped).toEqual(['actor']);
    expect(harness.released).toEqual([7]);
    expect(harness.audits[0].details.to).toBe('https://other.example');
    expect(JSON.stringify(harness.audits[0])).not.toContain('attacker-controlled');
  });
});
