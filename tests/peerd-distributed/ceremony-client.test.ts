// The extension side of the ceremony relay. Every negative case here is one
// of the #360 closure blockers, asserted at the acceptor: a reply from a
// lookalike origin, from a different tab at the RIGHT origin, replayed with
// a stale nonce, or reshaped to smuggle oversize/absent fields must all be
// refused before any crypto sees it.

import { describe, test, expect } from 'bun:test';
import {
  buildCeremonyRequest, acceptCeremonyReply, CEREMONY_ORIGIN, CEREMONY_URL,
} from '../../extension/peerd-distributed/self/ceremony-client.js';

const CHALLENGE = crypto.getRandomValues(new Uint8Array(32));
const ceremonyWindow = { name: 'the-tab-we-opened' };
const otherWindow = { name: 'some-other-tab' };

const assertResult = (over: Record<string, unknown> = {}) => ({
  op: 'assert',
  credentialId: 'Y3JlZA==',
  authenticatorData: 'YXV0aA==',
  clientDataJSON: 'Y2xpZW50',
  signature: 'c2ln',
  ...over,
});

const reply = (request: any, over: Record<string, unknown> = {}) => ({
  origin: CEREMONY_ORIGIN,
  source: ceremonyWindow,
  data: { peerd: 'ceremony-result', nonce: request.nonce, ok: true, result: assertResult(), ...over },
});

describe('ceremony request', () => {
  test('binds the canonical RP and a fresh nonce per request', () => {
    const a = buildCeremonyRequest({ op: 'assert', challenge: CHALLENGE });
    const b = buildCeremonyRequest({ op: 'assert', challenge: CHALLENGE });
    expect(a.rpId).toBe('id.peerd.ai');
    expect(CEREMONY_ORIGIN).toBe('https://id.peerd.ai');
    expect(CEREMONY_URL).toBe('https://id.peerd.ai/');
    expect(a.nonce).not.toBe(b.nonce); // one request, one nonce
    expect(a.challenge).not.toContain('='); // base64url, unpadded (WebAuthn wire form)
    expect(a.challenge).not.toContain('+');
  });

  test('refuses a weak challenge or unknown op', () => {
    expect(() => buildCeremonyRequest({ op: 'assert', challenge: new Uint8Array(8) })).toThrow(/16 bytes/);
    expect(() => buildCeremonyRequest({ op: 'sign' as any, challenge: CHALLENGE })).toThrow(/unsupported/);
  });
});

describe('ceremony reply acceptance', () => {
  test('accepts the genuine reply', () => {
    const request = buildCeremonyRequest({ op: 'assert', challenge: CHALLENGE });
    const verdict = acceptCeremonyReply(reply(request), { request, ceremonyWindow });
    expect(verdict.ok).toBe(true);
    expect(verdict.result.credentialId).toBe('Y3JlZA==');
  });

  test('a lookalike origin is refused', () => {
    const request = buildCeremonyRequest({ op: 'assert', challenge: CHALLENGE });
    for (const origin of ['https://id.peerd.ai.evil.example', 'https://peerd.ai', 'http://id.peerd.ai', 'https://id-peerd.ai']) {
      const verdict = acceptCeremonyReply({ ...reply(request), origin }, { request, ceremonyWindow });
      expect(verdict.defect).toBe('wrong-origin');
    }
  });

  test('a reply from a DIFFERENT tab at the right origin is refused', () => {
    const request = buildCeremonyRequest({ op: 'assert', challenge: CHALLENGE });
    const verdict = acceptCeremonyReply({ ...reply(request), source: otherWindow }, { request, ceremonyWindow });
    expect(verdict.defect).toBe('wrong-window');
  });

  test('replay: a reply carrying another request\'s nonce is refused', () => {
    const request = buildCeremonyRequest({ op: 'assert', challenge: CHALLENGE });
    const older = buildCeremonyRequest({ op: 'assert', challenge: CHALLENGE });
    const verdict = acceptCeremonyReply(reply(older), { request, ceremonyWindow });
    expect(verdict.defect).toBe('nonce-mismatch');
  });

  test('an op-swapped reply is refused (an enroll cannot answer an assert)', () => {
    const request = buildCeremonyRequest({ op: 'assert', challenge: CHALLENGE });
    const verdict = acceptCeremonyReply(
      reply(request, { result: { op: 'enroll', credentialId: 'Y3JlZA==', publicKeySpki: 'a2V5', alg: -7 } }),
      { request, ceremonyWindow },
    );
    expect(verdict.defect).toBe('op-mismatch');
  });

  test('malformed / oversize / missing fields are refused before any decode', () => {
    const request = buildCeremonyRequest({ op: 'assert', challenge: CHALLENGE });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ result: assertResult({ credentialId: '' }) }, 'bad-credentialId'],
      [{ result: assertResult({ signature: 'x'.repeat(17_000) }) }, 'bad-signature'],
      [{ result: assertResult({ authenticatorData: undefined }) }, 'bad-authenticatorData'],
      [{ result: assertResult({ prf: 42 }) }, 'bad-prf'],
      [{ result: null }, 'bad-result'],
    ];
    for (const [over, defect] of cases) {
      expect(acceptCeremonyReply(reply(request, over), { request, ceremonyWindow }).defect).toBe(defect);
    }
  });

  test('an enroll reply must carry a public key and algorithm', () => {
    const request = buildCeremonyRequest({ op: 'enroll', challenge: CHALLENGE });
    const good = acceptCeremonyReply(
      reply(request, { result: { op: 'enroll', credentialId: 'Y3JlZA==', publicKeySpki: 'a2V5', alg: -7 } }),
      { request, ceremonyWindow },
    );
    expect(good.ok).toBe(true);
    const noKey = acceptCeremonyReply(
      reply(request, { result: { op: 'enroll', credentialId: 'Y3JlZA==', alg: -7 } }),
      { request, ceremonyWindow },
    );
    expect(noKey.defect).toBe('bad-publicKeySpki');
    const noAlg = acceptCeremonyReply(
      reply(request, { result: { op: 'enroll', credentialId: 'Y3JlZA==', publicKeySpki: 'a2V5' } }),
      { request, ceremonyWindow },
    );
    expect(noAlg.defect).toBe('bad-alg');
  });

  test('a page-reported failure surfaces as a named refusal, not a result', () => {
    const request = buildCeremonyRequest({ op: 'assert', challenge: CHALLENGE });
    const verdict = acceptCeremonyReply(
      { origin: CEREMONY_ORIGIN, source: ceremonyWindow, data: { peerd: 'ceremony-result', nonce: request.nonce, ok: false, error: 'NotAllowedError' } },
      { request, ceremonyWindow },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('ceremony-NotAllowedError');
  });

  test('unrelated window chatter is ignored', () => {
    const request = buildCeremonyRequest({ op: 'assert', challenge: CHALLENGE });
    for (const data of [null, { peerd: 'ceremony-ready' }, { hello: 'world' }]) {
      const verdict = acceptCeremonyReply(
        { origin: CEREMONY_ORIGIN, source: ceremonyWindow, data }, { request, ceremonyWindow },
      );
      expect(verdict.ok).toBe(false);
    }
  });
});
