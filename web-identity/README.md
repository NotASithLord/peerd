# web-identity - the canonical relying-party ceremony page

The source for `https://id.peerd.ai`: the ONE origin where portable
peerd-identity passkeys are created and evaluated (RP ID `peerd.ai` -
decided; see `docs/design/portable-identity/04-canonical-rp.md`, which
also records what is frozen and why).

Three files, no dependencies, no build step:

- `index.html` - the consent shell (monochrome; a consent surface gets
  no accent color).
- `identity-rp.js` - the ceremony driver. A pure PRF oracle: it runs
  WebAuthn `create()`/`get()` with the frozen PRF input and returns the
  32-byte PRF output sealed to the requesting extension's ephemeral
  key. It never sees a seed, capsule, record, or capsule key, and
  stores nothing.
- `handoff.js` - a byte-identical copy of
  `extension/peerd-distributed/identity/handoff.js` (the protocol is
  single-sourced there; `tests/peerd-distributed/identity-handoff.test.ts`
  fails CI if the copies drift). To change the protocol, edit the
  extension module and re-copy.

## Deploying (site repo)

The peerd.ai site repo vendors this directory verbatim, same as the
other snapshots it carries. Requirements at the host:

- Serve at the exact origin in `IDENTITY_RP_ORIGIN` (`handoff.js`).
  Subdomain moves under `peerd.ai` are safe **until first production
  mint**; the RP ID is what credentials bind to.
- Static files only; no third-party scripts, analytics, or fonts - a
  compromise of this page at ceremony time is scoped to one PRF output
  as ciphertext, and keeping the page dependency-free keeps it that way
  (and keeps it auditable).
- Suggested headers: a CSP of `default-src 'none'; script-src 'self';
  style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
  plus `Referrer-Policy: no-referrer`.

## Local development

`localhost` is a WebAuthn-blessed dev RP: serve this directory
(`bunx serve web-identity` or any static server) and the page pins
`rpId: 'localhost'`. Dev credentials are scoped to localhost and can
never collide with production `peerd.ai` credentials.
