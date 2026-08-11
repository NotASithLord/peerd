'use strict';
// id.peerd.ai ceremony driver.
//
// The whole trust contract lives in the header of README.md. In short: this
// page is a WebAuthn front-end that talks ONLY to the exact Peerd extension
// origin that opened it, over one-shot origin-bound postMessage — never a
// public request/response URL. It holds no secret and derives nothing.
//
// Message protocol (extension ⇄ page):
//   page → opener   { peerd: 'ceremony-ready' }                once, on load
//   opener → page   { peerd: 'ceremony-request', nonce, op,    the request;
//                     challenge, rpId, prf?, allowCredentials?, event.origin
//                     userName?, userDisplayName? }             is recorded
//   page → opener   { peerd: 'ceremony-result', nonce, ok,     the reply, to
//                     result | error }                          that origin only

const RP_ID = location.hostname; // 'id.peerd.ai' in prod, 'localhost' in dev
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\//;

const el = (id) => document.getElementById(id);
const promptEl = el('prompt');
const runButton = el('run');
const statusEl = el('status');

/** @type {{ nonce: string, op: string, origin: string, request: any } | null} */
let pending = null;
let consumed = false;

const setStatus = (text, kind) => {
  statusEl.textContent = text || '';
  if (kind) statusEl.setAttribute('data-kind', kind); else statusEl.removeAttribute('data-kind');
};

const b64uToBytes = (s) => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64 = (bytes) => {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
};

const replyTo = (origin, message) => {
  // Reply to the EXACT extension origin that sent the request — never '*'.
  window.opener?.postMessage(message, origin);
};

const runCeremony = async () => {
  if (!pending || consumed) return;
  consumed = true; // one-shot: a page load answers exactly one request
  runButton.disabled = true;
  const { nonce, op, origin, request } = pending;
  try {
    setStatus('Waiting for your passkey…');
    const challenge = b64uToBytes(request.challenge);
    let result;
    if (op === 'enroll') {
      result = await enroll(challenge, request);
    } else if (op === 'assert') {
      result = await assert(challenge, request);
    } else {
      throw new Error('unsupported operation');
    }
    setStatus('Done. Return to Peerd.');
    replyTo(origin, { peerd: 'ceremony-result', nonce, ok: true, result });
  } catch (error) {
    const name = error && error.name ? error.name : 'Error';
    setStatus(name === 'NotAllowedError' ? 'Cancelled.' : 'Could not complete. Try again.', 'error');
    replyTo(origin, { peerd: 'ceremony-result', nonce, ok: false, error: name });
  }
};

const enroll = async (challenge, request) => {
  const publicKey = {
    rp: { id: RP_ID, name: 'Peerd' },
    user: {
      id: crypto.getRandomValues(new Uint8Array(16)),
      name: request.userName || 'peerd',
      displayName: request.userDisplayName || 'Peerd identity',
    },
    challenge,
    // Ed25519, ES256, RS256 — the same set the binding record admits.
    pubKeyCredParams: [
      { type: 'public-key', alg: -8 },
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: {
      // Platform authenticator, discoverable, synced — the "same passkey on
      // your other devices" property portable identity depends on.
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    attestation: 'none',
    timeout: 120000,
    ...(request.prf ? { extensions: { prf: { eval: { first: b64uToBytes(request.prf) } } } } : {}),
  };
  const credential = await navigator.credentials.create({ publicKey });
  if (!credential) throw new Error('no credential');
  const response = credential.response;
  const prf = credential.getClientExtensionResults?.().prf;
  return {
    op: 'enroll',
    credentialId: bytesToB64(credential.rawId),
    publicKeySpki: response.getPublicKey ? bytesToB64(response.getPublicKey()) : null,
    alg: response.getPublicKeyAlgorithm ? response.getPublicKeyAlgorithm() : null,
    transports: response.getTransports ? response.getTransports() : null,
    prf: prf && prf.results && prf.results.first ? bytesToB64(prf.results.first) : null,
  };
};

const assert = async (challenge, request) => {
  const allow = Array.isArray(request.allowCredentials)
    ? request.allowCredentials.map((id) => ({ type: 'public-key', id: b64uToBytes(id) }))
    : undefined;
  const publicKey = {
    rpId: RP_ID,
    challenge,
    userVerification: 'required',
    timeout: 120000,
    ...(allow ? { allowCredentials: allow } : {}),
    ...(request.prf ? { extensions: { prf: { eval: { first: b64uToBytes(request.prf) } } } } : {}),
  };
  const assertion = await navigator.credentials.get({ publicKey });
  if (!assertion) throw new Error('no assertion');
  const response = assertion.response;
  const prf = assertion.getClientExtensionResults?.().prf;
  return {
    op: 'assert',
    credentialId: bytesToB64(assertion.rawId),
    authenticatorData: bytesToB64(response.authenticatorData),
    clientDataJSON: bytesToB64(response.clientDataJSON),
    signature: bytesToB64(response.signature),
    userHandle: response.userHandle ? bytesToB64(response.userHandle) : null,
    prf: prf && prf.results && prf.results.first ? bytesToB64(prf.results.first) : null,
  };
};

const onMessage = (event) => {
  // Accept a request ONLY from an extension origin, and only the first one.
  if (pending) return;
  if (!EXTENSION_ORIGIN.test(event.origin)) return;
  const data = event.data;
  if (!data || data.peerd !== 'ceremony-request' || typeof data.nonce !== 'string') return;
  if (data.op !== 'enroll' && data.op !== 'assert') return;
  if (typeof data.challenge !== 'string' || data.challenge.length === 0) return;
  // The RP id the extension expects must match ours — refuse a request that
  // would mint a credential at some other relying party.
  if (data.rpId && data.rpId !== RP_ID) return;
  pending = { nonce: data.nonce, op: data.op, origin: event.origin, request: data };
  promptEl.textContent = data.op === 'enroll'
    ? 'Create your portable Peerd passkey to finish setup.'
    : 'Confirm it\'s you to set up Peerd on this device.';
  runButton.disabled = false;
  setStatus('Ready — tap Continue.');
};

const boot = () => {
  // Top-frame only: never run embedded in another site's iframe.
  if (window.top !== window.self) {
    document.body.textContent = 'This page cannot run embedded.';
    return;
  }
  if (!window.PublicKeyCredential) {
    setStatus('This browser does not support passkeys.', 'error');
    return;
  }
  runButton.addEventListener('click', runCeremony);
  window.addEventListener('message', onMessage);
  // Announce readiness to the opener so the extension knows it may send the
  // request. Bound to the opener; the opener validates the exact tab.
  window.opener?.postMessage({ peerd: 'ceremony-ready', rpId: RP_ID }, '*');
};

boot();
