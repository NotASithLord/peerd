# `id.peerd.ai`: the canonical Peerd identity ceremony

This directory is the entire hosted footprint of Peerd's portable identity.
It is deployed at **`https://id.peerd.ai/`** and does exactly one thing:
run a WebAuthn ceremony (create a passkey, or produce an assertion) at a
stable relying party, and hand the raw result back to the exact Peerd
extension instance that opened it.

It is **not** an account system, a profile host, or a general-purpose API.
It holds no state, runs no model, and never sees your Peerd data.

## Why a hosted RP at all

A passkey is bound to its relying-party ID. The vault's existing passkey is
created from the extension origin (`chrome-extension://<id>` /
`moz-extension://<id>`), which differs per browser, per channel, and per
install, so it can never be the *portable* credential that lets a second
device recognize you. Portable identity needs a single, permanent RP ID.
That RP is `id.peerd.ai`, and it is effectively permanent: changing it would
orphan every credential ever created here.

## The transport (and why it is not the closed PR's URL oracle)

The previous attempt (PR #360) passed a request public key in the URL
fragment and returned the authenticator output encrypted to it. That is a
public request/response oracle: anyone holding a stolen recovery record could
craft the request and decrypt the result. It was closed for exactly that.

This page uses **no request/response URL**. Instead:

1. The extension opens `https://id.peerd.ai/` in a tab it
   controls (never an iframe).
2. The page refuses to run if it is framed (`window.top !== window.self`),
   and shows only a consent button, nothing runs without a user gesture.
3. The extension `postMessage`s a **ceremony request** to the tab, carrying a
   fresh per-ceremony `challenge`, `purpose`, and `nonce`. The production page
   accepts only the pinned Peerd preview extension origin, records that exact
   `event.origin`, and replies to **that origin only**. An arbitrary installed
   extension cannot drive Peerd's trusted RP page.
4. The page runs `navigator.credentials.create()` / `.get()` with the
   supplied challenge and explicit user verification, then `postMessage`s the
   **raw** WebAuthn result back to the recorded origin, echoing the `nonce`.
5. The result is raw authenticator output only, `credentialId`,
   `authenticatorData`, `clientDataJSON`, `signature`, the credential
   `publicKey` (SPKI, on create), and the PRF output when requested. The
   page derives nothing, stores nothing, and encrypts nothing to a
   caller-chosen key.

The extension binds the reply to its purpose and request by the `nonce` and
the exact tab id, and verifies the assertion itself against the person-root-signed
passkey binding (`peerd-distributed/identity/webauthn-verify.js`). The page
is a dumb authenticator front-end; trust lives in the extension.

### What a hostile page could do, and why it doesn't matter

If `id.peerd.ai` were compromised and served malicious JS, the worst it can
do is refuse to run a ceremony, or run one and hand the extension a result.
It cannot forge a valid assertion (it has no credential private key, the
authenticator holds that, gated by platform user verification), and the PRF
output it can obtain is **not sufficient** to enroll a device: enrollment
additionally requires a fresh assertion the *sponsor device* verifies against
the root-signed binding, plus the sponsor's own challenge. The page never
receives the identity seed, capsule, capsule key, vault key, or any Peerd
profile data, those never leave the extension.

## Files

- `index.html`: the ceremony page. Strict CSP, no external resources, no
  inline event handlers. All logic in `ceremony.js`.
- `ceremony.js`: the ceremony driver (framed-check, consent gate,
  origin-bound postMessage relay, WebAuthn create/get with PRF).
- `.well-known/`, reserved for the deploy's WebAuthn related-origin and
  security metadata (populated by the site repo at deploy).

## Local development

`localhost` credentials use RP ID `localhost` and can never collide with the
`id.peerd.ai` production credentials: a different RP ID is a different
credential space. Serve this directory over `http://localhost:<port>/` for
development only.

## What this component can observe

Nothing about your Peerd state. Per ceremony it sees: the challenge and nonce
the extension chose, the credential id / public key / signature the
authenticator produced, and (when requested) a PRF output. It has no
network egress (strict CSP `connect-src 'none'`), no storage, and no server
it is a static page.
