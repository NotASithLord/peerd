// @ts-check
// Cross-browser policy integration for the complete relying-site sign-in path.

import { describe, it, expect } from '../../framework.js';
import {
  makeJudgeLanding,
  makeSignInOriginAuthorizer,
} from '/peerd-runtime/actor/origin-lock.js';
import { isKnownIdp, isKnownIdpHost } from '/peerd-runtime/actor/idp-registry.js';
import { loginTool } from '/peerd-runtime/tools/defs/login.js';

describe('identity-provider transit sign-in flow', () => {
  it('binds the confirmed relying site, permits one IdP excursion, and returns home', async () => {
    const state = /** @type {any} */ ({ mode: 'roaming' });
    let liveUrl = 'https://app.test/login';
    const stops = [];
    const saveState = (/** @type {any} */ patch) => Object.assign(state, patch);
    const authorizeSignInOrigin = makeSignInOriginAuthorizer({
      getState: () => state,
      getLiveLanding: async () => ({ status: 'live', url: liveUrl }),
      saveState,
      isKnownIdp: isKnownIdpHost,
    });
    const executeScript = async (/** @type {any} */ options) => {
      if (options.func?.name === 'liveDocumentLocationInjected') {
        return [{
          documentId: 'rp-document',
          result: { origin: 'https://app.test', href: liveUrl, timeOrigin: 1 },
        }];
      }
      if (options.func?.name === 'hasPasswordFieldInjected') return [{ result: { has: false } }];
      if (options.func?.name === 'loginTargetReader') {
        return [{ result: { ok: true, descriptor: { tag: 'button', name: 'Sign in with Google' } } }];
      }
      return [{ result: null }];
    };
    const loginResult = await loginTool.execute({ selector: '#sign-in' }, /** @type {any} */ ({
      session: { sessionId: 'browser-rp' },
      activeTab: { id: 7, url: liveUrl, origin: 'https://app.test' },
      tabs: { get: async () => ({ id: 7, url: liveUrl }) },
      scripting: { executeScript },
      denylist: [],
      confirm: async () => 'yes_once',
      audit: async () => {},
      authorizeSignInOrigin,
    }));
    expect(loginResult.ok).toBe(true);
    expect(state.mode).toBe('bound');
    expect(state.ownedOrigin).toBe('https://app.test');

    const judge = makeJudgeLanding({
      getState: () => state,
      saveState,
      onStop: (event) => { stops.push(event); },
      isKnownIdp: isKnownIdpHost,
      isIdp: isKnownIdp,
      now: () => 1_000,
    });
    liveUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
    expect((await judge(liveUrl))?.action).toBe('continue');
    expect(state.excursion?.returnTo).toBe('https://app.test');
    liveUrl = 'https://app.test/callback';
    expect((await judge(liveUrl))?.action).toBe('continue');
    expect(state.excursion).toBe(null);
    expect(stops.length).toBe(0);
  });

  it('never promotes the IdP itself, including cookie-equivalent spellings', async () => {
    for (const origin of [
      'https://accounts.google.com',
      'http://accounts.google.com',
      'https://accounts.google.com:8443',
      'https://accounts.google.com.',
    ]) {
      const saved = [];
      const authorize = makeSignInOriginAuthorizer({
        getState: () => ({ mode: 'roaming' }),
        getLiveLanding: async () => ({ status: 'live', url: origin }),
        saveState: (patch) => { saved.push(patch); },
        isKnownIdp: isKnownIdpHost,
      });
      expect(await authorize(origin)).toBe(false);
      expect(saved.length).toBe(0);
    }
  });
});
