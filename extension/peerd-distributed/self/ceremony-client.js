// @ts-check
// peerd-distributed/self/ceremony-client.js — the extension side of the
// id.peerd.ai ceremony relay.
//
// The pure half of the transport contract (web-identity/README.md): build a
// request bound to a fresh nonce, and decide whether an inbound window
// message is the genuine, matching reply. Everything imperative — opening
// the tab, holding the window handle, timeouts — is the caller's (the SW /
// side panel), so this decision logic is Bun-testable and adversarial cases
// are cheap to cover.
//
// The rules the acceptor enforces, each closing one #360 blocker:
//   exact origin      the reply must come from the ceremony origin we
//                     opened — not a lookalike host, not any other tab
//   exact window      the reply's source must be the window handle we
//                     opened (a second tab at the same origin is refused)
//   nonce match       one request, one reply; a replayed or crossed reply
//                     dies here
//   shape bounds      every field bounded before any decode
//
// The page is never trusted beyond "it relayed raw authenticator output":
// the assertion is verified separately against the root-signed binding
// (webauthn-verify.js), so a hostile page cannot manufacture authority.

import { toBase64 } from '/shared/bundle/bytes.js';
import { CANONICAL_RP_ID } from '../identity/passkey-binding.js';

export const CEREMONY_ORIGIN = `https://${CANONICAL_RP_ID}`;
export const CEREMONY_URL = `${CEREMONY_ORIGIN}/`;

const MAX_FIELD_B64 = 16 * 1024;
const NONCE_BYTES = 16;

/** @param {Uint8Array} bytes  base64url, unpadded — the WebAuthn wire form */
const toBase64Url = (bytes) =>
  toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/**
 * Build a ceremony request. `challenge` is the caller's fresh challenge —
 * for enrollment-by-a-sponsor that is the CHANNEL-BOUND ceremony challenge
 * (enroll.js enrollCeremonyChallenge), never a value the page chose.
 *
 * @param {Object} args
 * @param {'enroll'|'assert'} args.op
 * @param {Uint8Array} args.challenge
 * @param {Uint8Array} [args.prfInput]        request a PRF evaluation
 * @param {string[]} [args.allowCredentials]  base64 credential ids (assert)
 * @param {string} [args.userName]
 * @param {string} [args.userDisplayName]
 */
export const buildCeremonyRequest = ({
  op, challenge, prfInput, allowCredentials, userName, userDisplayName,
}) => {
  if (op !== 'enroll' && op !== 'assert') throw new Error(`unsupported ceremony op ${op}`);
  if (!(challenge instanceof Uint8Array) || challenge.length < 16) {
    throw new Error('ceremony challenge must be at least 16 bytes');
  }
  return {
    peerd: 'ceremony-request',
    nonce: toBase64(crypto.getRandomValues(new Uint8Array(NONCE_BYTES))),
    op,
    rpId: CANONICAL_RP_ID,
    challenge: toBase64Url(challenge),
    ...(prfInput ? { prf: toBase64Url(prfInput) } : {}),
    ...(allowCredentials ? { allowCredentials: allowCredentials.map((id) => id.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')) } : {}),
    ...(userName ? { userName } : {}),
    ...(userDisplayName ? { userDisplayName } : {}),
  };
};

/**
 * Is this inbound window message the genuine reply to `request`?
 *
 * @param {{ origin?: string, data?: any, source?: unknown }} event  a MessageEvent (or a test double)
 * @param {Object} context
 * @param {any} context.request        what buildCeremonyRequest returned
 * @param {unknown} context.ceremonyWindow  the window handle we opened
 * @param {string} [context.expectedOrigin] override for localhost dev
 * @returns {{ ok: boolean, defect: string | null, result: any | null }}
 */
export const acceptCeremonyReply = (event, {
  request, ceremonyWindow, expectedOrigin = CEREMONY_ORIGIN,
}) => {
  /** @param {string} defect */
  const refuse = (defect) => ({ ok: false, defect, result: null });
  if (!event || typeof event !== 'object') return refuse('not-an-event');
  if (event.origin !== expectedOrigin) return refuse('wrong-origin');
  // The reply must come from the EXACT window we opened — a second tab at
  // the same origin (an attacker-opened one) is not our ceremony.
  if (!ceremonyWindow || event.source !== ceremonyWindow) return refuse('wrong-window');
  const data = event.data;
  if (!data || typeof data !== 'object' || data.peerd !== 'ceremony-result') return refuse('not-a-result');
  if (typeof data.nonce !== 'string' || data.nonce !== request.nonce) return refuse('nonce-mismatch');
  if (data.ok !== true) return refuse(`ceremony-${typeof data.error === 'string' ? data.error.slice(0, 32) : 'failed'}`);
  const result = data.result;
  if (!result || typeof result !== 'object') return refuse('bad-result');
  if (result.op !== request.op) return refuse('op-mismatch');

  /** @param {string} field @param {boolean} [required] */
  const bounded = (field, required = true) => {
    const value = result[field];
    if (value === null || value === undefined) return !required;
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_B64;
  };
  if (!bounded('credentialId')) return refuse('bad-credentialId');
  if (request.op === 'enroll') {
    if (!bounded('publicKeySpki')) return refuse('bad-publicKeySpki');
    if (!Number.isInteger(result.alg)) return refuse('bad-alg');
  } else {
    for (const field of ['authenticatorData', 'clientDataJSON', 'signature']) {
      if (!bounded(field)) return refuse(`bad-${field}`);
    }
  }
  if (!bounded('prf', false)) return refuse('bad-prf');
  return { ok: true, defect: null, result };
};
