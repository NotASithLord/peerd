import { describe, expect, test } from 'bun:test';
import { makeOriginLockResolver } from '../../extension/background/origin-lock-controller.js';
import { makeApiActorBindings } from '../../extension/peerd-runtime/actor/web-actor.js';

const makeHarness = (over: { provisional?: boolean, siteActorBindings?: any } = {}) => {
  const turnTokens = new Map([['actor', 1]]);
  const stopped: string[] = [];
  const released: number[] = [];
  const audits: any[] = [];
  let judgeDeps: any;
  const state = { mode: 'bound', provisional: over.provisional ?? false };
  const persisted: number[] = [];
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
    siteActorBindings: over.siteActorBindings
      ?? { entries: () => [], drop: () => {}, dropBySession: () => 0 },
    persistSiteActors: () => { persisted.push(1); },
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
  return { resolve, turnTokens, stopped, released, audits, persisted, getJudgeDeps: () => judgeDeps };
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

  // issue #438. The cleanup used to split the binding key on a space while the
  // map joined it with a NUL, so it silently dropped nothing - and every test
  // here passed anyway, because none of them used a real binding map.
  test('a stopped PROVISIONAL site actor loses its binding, so a retry mints a fresh one', async () => {
    const siteActorBindings = makeApiActorBindings();
    siteActorBindings.bind('chat-1', 'https://shop.example', 'actor');
    siteActorBindings.bind('chat-1', 'https://other.example', 'someone-else');
    const harness = makeHarness({ provisional: true, siteActorBindings });
    harness.resolve('actor');
    await harness.getJudgeDeps().onStop({
      action: 'handoff', from: 'https://shop.example/', to: 'https://elsewhere.example/',
    });
    await Promise.resolve();

    expect(siteActorBindings.resolve('chat-1', 'https://shop.example')).toBe(null);
    // Another chat's actor on another origin is untouched.
    expect(siteActorBindings.resolve('chat-1', 'https://other.example')).toBe('someone-else');
    expect(harness.persisted.length).toBeGreaterThan(0);
  });

  test('a stopped NON-provisional site actor keeps its binding', async () => {
    const siteActorBindings = makeApiActorBindings();
    siteActorBindings.bind('chat-1', 'https://shop.example', 'actor');
    const harness = makeHarness({ provisional: false, siteActorBindings });
    harness.resolve('actor');
    await harness.getJudgeDeps().onStop({
      action: 'handoff', from: 'https://shop.example/', to: 'https://elsewhere.example/',
    });
    await Promise.resolve();

    expect(siteActorBindings.resolve('chat-1', 'https://shop.example')).toBe('actor');
  });
});
