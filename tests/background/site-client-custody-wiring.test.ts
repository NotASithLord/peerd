import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The SW is a browser entry module and cannot be imported by Bun. Pin the
// imperative wiring here while origin-lock tests exercise the pure policy it
// calls. This is the same source-contract pattern as the other background
// wiring tests: it catches a future route edit that bypasses the tested core.
const source = readFileSync(
  join(import.meta.dir, '../../extension/background/service-worker.js'),
  'utf8',
);

describe('site-client custody service-worker wiring', () => {
  test('API and tab tool contexts receive their respective custody closures', () => {
    const contextStart = source.indexOf('const buildToolContext');
    const contextEnd = source.indexOf('// ── Tool dispatcher', contextStart);
    const context = source.slice(contextStart, contextEnd > contextStart ? contextEnd : undefined);
    const lockFactory = source.slice(source.indexOf('const originLockFor'), contextStart);

    expect(context).toContain('makeFixedSiteClientOriginGuard(ownedOrigin, { isKnownIdp: isKnownIdpHost })');
    expect(context).toContain('resCtx.idpTransitOnly = isKnownIdpHost(ownedOrigin)');
    expect(context.indexOf('async () => { throw new EgressDeniedError'))
      .toBeLessThan(context.indexOf('withDpopCredentials(webFetch, () => ownedOrigin'));
    expect(context).toContain('resCtx.authorizeSignInOrigin = lock?.authorizeSignInOrigin');
    expect(context).toContain('resCtx.authorizeSignInExcursion = lock?.authorizeSignInExcursion');
    expect(context).toContain('resCtx.revokeSignInExcursion = lock?.revokeSignInExcursion');
    expect(context).toContain('resCtx.authWaitingForUser = authVerdict?.action === \'wait\'');
    expect(lockFactory).toContain('authorizeSignInExcursionUnserialized = makeSignInExcursionAuthorizer({');
    expect(lockFactory).toContain('revokeSignInExcursionUnserialized = makeSignInExcursionRevoker({');
    expect(lockFactory).toMatch(/makeSignInExcursionAuthorizer\(\{[\s\S]*?saveState:[\s\S]*?isKnownIdp,/);
    expect(lockFactory).toMatch(/makeSignInExcursionRevoker\(\{[\s\S]*?saveState:[\s\S]*?isKnownIdp,/);
    expect(lockFactory).toContain('if (!isCurrentTurn())');
    expect(lockFactory).toContain('isCurrent: isCurrentTurn');
    expect(lockFactory).toContain('terminateUnreadableSignIn');
    expect(lockFactory).not.toContain('originStates.forget(actorSessionId)');
    expect(source).not.toContain("judgeLanding('chrome://unreadable-actor-tab')");
    expect(source).toContain('preflightReply = AUTH_BOUNDARY_STOPPED_MESSAGE');
    expect(source).toContain('preflightReply = AUTH_STATE_UNAVAILABLE_MESSAGE');
    expect(lockFactory.match(/originStates\.serialize\(/g)?.length).toBeGreaterThanOrEqual(4);
    expect(context).toContain('hasDurableSiteClientState(durableOriginState)');
    expect(context).toContain('lock.authorizeSiteClientOrigin(() => liveSiteClientLandingFor(sessionId))');
    expect(context.indexOf('hasDurableSiteClientState(durableOriginState)'))
      .toBeLessThan(context.indexOf('originStates.hydrate(sessionId, durableOriginState)'));
  });

  test('every worker fetch rechecks custody before confirmation and network IO', () => {
    const routeStart = source.indexOf('const siteFetchCallRoute');
    const routeEnd = source.indexOf('const siteClientRoutes', routeStart);
    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
    const route = source.slice(routeStart, routeEnd);

    const custody = route.indexOf('const reauthorizeSiteFetch = () => authorizeSiteClientRelayOrigin({');
    const confirmation = route.indexOf('needsWebWriteConfirm(httpMethod)');
    const fetch = route.indexOf('await scopedFetch(url');
    expect(custody).toBeGreaterThan(-1);
    expect(custody).toBeLessThan(confirmation);
    expect(custody).toBeLessThan(fetch);
    expect(route.match(/await reauthorizeSiteFetch\(\)/g)).toHaveLength(2);
    expect(route.lastIndexOf('await reauthorizeSiteFetch()')).toBeGreaterThan(confirmation);
    expect(route.lastIndexOf('await reauthorizeSiteFetch()')).toBeLessThan(fetch);
    expect(route).toContain('liveSiteClientLandingFor(ownerSessionId)');
    expect(route).toContain('durableState: /** @type {any} */ (owner.originState)');
    expect(route).toContain('isKnownIdp: isKnownIdpHost');
    expect(route).toContain('if (isKnownIdpHost(pin))');
    expect(route).toContain("const relayBacking = owner.backing === undefined ? 'tab' : owner.backing");
    expect(route).not.toContain("owner.backing ?? 'tab'");
  });

  test('mint-time dossier injection checks durable/live custody on both sides of IDB', () => {
    const mint = source.slice(
      source.indexOf('const siteClientMintCustodyFor'),
      source.indexOf('// DESIGN-18 tab-card anchoring'),
    );
    expect(mint).toContain('hasDurableSiteClientState(rec.originState)');
    expect(mint).toContain('lock.authorizeSiteClientOrigin(getLiveLanding)');
    expect(mint).toContain('makeFixedSiteClientOriginGuard(origin, { isKnownIdp: isKnownIdpHost })');
    expect(mint).toContain('const meta = await siteClientStore.getMeta(custody.origin)');
    expect(mint).toContain('meta && await custody.authorize() === true');
    expect(mint.indexOf('meta && await custody.authorize() === true'))
      .toBeLessThan(mint.indexOf('buildMintInjection(meta)'));
  });
});
