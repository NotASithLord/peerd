// @ts-check
// web-identity/identity-rp.js - the canonical relying-party ceremony page.
//
// A PURE PRF ORACLE (docs/design/portable-identity/ 04): parse the
// extension's request off the fragment, take one explicit user gesture,
// run the WebAuthn ceremony for the peerd.ai credential with the frozen
// PRF input, seal the 32-byte PRF output to the request's ephemeral key,
// and navigate to the return fragment. This page never sees a seed, a
// capsule, a recovery record, or a capsule key - compromise of this page
// at ceremony time yields one credential's PRF output as ciphertext
// bound to one live request, not the identity root.
//
// Deployment (site repo vendors this directory verbatim): serve at
// IDENTITY_RP_ORIGIN, static files only, no third-party scripts. The
// origin check below fails closed anywhere else except localhost dev.

import {
  IDENTITY_RP_ID, IDENTITY_RP_ORIGIN, identityPrfInput,
  parseCeremonyRequest, sealHandoffResponse, buildReturnUrl,
  IdentityHandoffError,
} from './handoff.js';

const statusEl = /** @type {HTMLElement} */ (document.getElementById('status'));
const actionEl = /** @type {HTMLButtonElement} */ (document.getElementById('action'));
const detailEl = /** @type {HTMLElement} */ (document.getElementById('detail'));

/** @param {string} text @param {boolean} [isError] */
const show = (text, isError = false) => {
  statusEl.textContent = text;
  statusEl.classList.toggle('err', isError);
};

// why localhost is allowed: the ceremony must be testable before (and
// independently of) the production deployment; a localhost RP ID is what
// WebAuthn itself blesses for development. Credentials minted on
// localhost are dev-scoped and can never collide with peerd.ai ones.
const devHost = ['localhost', '127.0.0.1'].includes(location.hostname);
const rpId = devHost ? 'localhost' : IDENTITY_RP_ID;

/** @param {ArrayBuffer | Uint8Array} bytes */
const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
/** @param {string} b64 */
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** @param {PublicKeyCredential} credential */
const readTransports = (credential) => {
  try {
    const response = /** @type {AuthenticatorAttestationResponse} */ (credential.response);
    const transports = response?.getTransports?.();
    return Array.isArray(transports) ? transports.slice(0, 8) : null;
  } catch { return null; }
};

/** @param {any} extensionResults  getClientExtensionResults() */
const prfFrom = (extensionResults) => {
  const first = extensionResults?.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
};

/** @param {any} request */
const runRegister = async (request) => {
  const prfInput = await identityPrfInput();
  const credential = /** @type {PublicKeyCredential | null} */ (await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: 'peerd' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'peerd identity',
        displayName: 'peerd identity',
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: 'public-key', alg: -8 },   // Ed25519
        { type: 'public-key', alg: -7 },   // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      // why discoverable-preferred: a portable identity credential must be
      // findable on a fresh machine with zero local state - that is the
      // whole point of minting it here rather than in the extension.
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      timeout: 120_000,
      attestation: 'none',
      extensions: { prf: { eval: { first: prfInput } } },
    },
  }));
  if (!credential) throw new IdentityHandoffError('ceremony was cancelled', 'cancelled');
  const credentialId = toB64(credential.rawId);
  const transports = readTransports(credential);
  const direct = prfFrom(credential.getClientExtensionResults?.());
  // Same honesty as the vault's enrollment path: some authenticators only
  // materialise PRF on a follow-up get(); a still-missing PRF means THIS
  // authenticator cannot protect the identity, and enrollment must fail
  // rather than hand back a credential that can never unlock anything.
  const prfOutput = direct ?? await runGet({ credentialId }, prfInput);
  return { prfOutput, credentialId, transports };
};

/** @param {{ credentialId?: string | null }} request @param {Uint8Array} [prfInputBytes] */
const runGet = async (request, prfInputBytes) => {
  const prfInput = prfInputBytes ?? await identityPrfInput();
  const assertion = /** @type {PublicKeyCredential | null} */ (await navigator.credentials.get({
    publicKey: {
      rpId,
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      // With a known credential, route straight to it; without one, the
      // discoverable-credential picker is exactly the recovery UX.
      allowCredentials: request.credentialId
        ? [{ type: 'public-key', id: fromB64(request.credentialId) }]
        : [],
      userVerification: 'required',
      timeout: 120_000,
      extensions: { prf: { eval: { first: /** @type {BufferSource} */ (prfInput) } } },
    },
  }));
  if (!assertion) throw new IdentityHandoffError('ceremony was cancelled', 'cancelled');
  const prfOutput = prfFrom(assertion.getClientExtensionResults?.());
  if (!prfOutput) {
    throw new IdentityHandoffError(
      'This authenticator does not support the PRF extension and cannot protect a peerd identity.',
      'prf-unsupported',
    );
  }
  return prfOutput;
};

const main = () => {
  if (!devHost && location.origin !== IDENTITY_RP_ORIGIN) {
    show(`This page only operates at ${IDENTITY_RP_ORIGIN}.`, true);
    return;
  }
  let request;
  try {
    request = parseCeremonyRequest(location.hash);
  } catch (e) {
    show(`Invalid ceremony request: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`, true);
    return;
  }
  if (!request) {
    show('This is the peerd identity ceremony page. Open it from peerd (Settings → Backup) - it does nothing on its own, stores nothing, and never sees your identity key.');
    return;
  }

  const verb = request.flow === 'register' ? 'Create a peerd identity passkey' : 'Unlock with your peerd passkey';
  show(`peerd is asking to ${request.flow === 'register'
    ? 'protect your identity backup with a new passkey.'
    : 'unlock your identity backup with your passkey.'}`);
  detailEl.textContent = 'Your identity key never touches this page; the passkey result returns encrypted to the peerd extension that opened it.';
  actionEl.textContent = verb;
  actionEl.hidden = false;

  actionEl.addEventListener('click', async () => {
    actionEl.disabled = true;
    show('Waiting for your authenticator…');
    try {
      const result = request.flow === 'register'
        ? await runRegister(request)
        : {
            prfOutput: await runGet(request),
            credentialId: request.credentialId ?? null,
            transports: request.transports ?? null,
          };
      const sealed = await sealHandoffResponse({ request, ...result });
      result.prfOutput.fill(0);
      show('Done - returning to peerd. You can close this tab.');
      // why replace (not assign): the request fragment never enters
      // history; only the sealed, single-request ciphertext does.
      location.replace(buildReturnUrl(location.origin, sealed));
    } catch (e) {
      actionEl.disabled = false;
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      show(err?.name === 'NotAllowedError'
        ? 'The ceremony was cancelled or timed out. You can try again.'
        : `Ceremony failed: ${err?.message ?? e}`, true);
    }
  });
};

main();
