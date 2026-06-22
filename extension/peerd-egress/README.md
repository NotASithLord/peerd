# peerd-egress

> The **`e`** (red) in the peerd wordmark — the security module.
> The encrypted vault, the egress chokepoint, the sensitive-site
> denylist, and the append-only audit log. Everything else depends on
> this; it is built first. Part of [peerd](../../README.md); read the
> root README first, then [`ARCHITECTURE.md`](../../ARCHITECTURE.md) and
> [`DESIGN.md`](../../DESIGN.md) (vault crypto, denylist matcher, the
> dispatcher gates).

**Status: 0.x — experimental beta.** The crypto is built on the
browser's own primitives (WebCrypto, WebAuthn, SRI) — peerd writes zero
lines of cryptographic code — but this is early software that holds your
API keys and drives your browser. Storage formats may still move; the
denylist is a floor, not a guarantee. **Use it with care.**

---

## What it does

`peerd-egress` is peerd's security foundation. It owns four things:

1. **The vault** — your API keys and other secrets, AES-GCM encrypted at
   rest, unlocked by a passkey (Touch ID / Windows Hello / a security
   key) or a recovery passphrase.
2. **The egress chokepoint** — `safeFetch` for provider traffic (a hard
   allowlist) and `webFetch` for open-web traffic (an SSRF guard + the
   denylist). Bare `fetch` is forbidden anywhere outbound; the agent and
   every sandbox it spawns reach the network only through these.
3. **The denylist** — a 164-pattern seed of banks, brokers, health
   portals, password managers, and identity providers, plus a full user
   editor.
4. **The audit log** — an append-only, capped, local-only record of
   every security-relevant event.

It also houses the storage wrappers (`chrome.storage.local`,
IndexedDB, `chrome.storage.session`) and the user-confirmation protocol,
since those are the substrate the security surfaces are built on.

## How it works today

### The vault

- **Key hierarchy.** A random 256-bit data key (DK) encrypts every
  secret with a per-secret random IV. The DK itself is stored *wrapped*
  (never plaintext on disk) under one or more key-encryption keys — a
  passphrase-derived KEK and/or a WebAuthn-PRF-derived KEK. Either
  unlock path yields the same DK.
- **Passphrase KDF: Argon2id, the only one.** The `vault.v2` format
  records the full Argon2id descriptor per wrap (default 64 MiB,
  3 iterations, 1 lane — the RFC 9106 single-lane profile, since MV3
  service workers have no `SharedArrayBuffer`). Argon2 runs via vendored,
  SHA-pinned `hash-wasm` (`vault/argon2.js` is the only importer). The
  pre-release PBKDF2 path was deleted outright (0.x, no installs, no
  compat code — `docs/DECISIONS.md` #17).
- **WebAuthn PRF unlock.** Touch ID, Windows Hello, and cross-platform
  security keys (YubiKey/FIDO2). Enrollment is **PRF-honest** — an
  authenticator that can't do PRF fails enrollment with a clear error
  rather than minting a credential that can never unlock. Transports are
  recorded so the unlock prompt routes to the right authenticator.
- **Idle auto-lock** (45 min default, user-settable, `0` = never) plus a
  manual Lock button. The unwrapped DK is mirrored to
  `chrome.storage.session` so an MV3 service-worker restart doesn't
  re-prompt; it is cleared on lock and gone when the browser closes.
- **Blob home.** The vault blob lives in IndexedDB, migrated off
  `chrome.storage.local` with a read-back-verified, loss-proof migration
  (hygiene, not a security change).

### The egress chokepoint

- **`safeFetch`** (`fetch/safe-fetch.js`) enforces a **hardcoded**
  provider allowlist (`fetch/allowlist.js`): `api.anthropic.com`,
  `api.openai.com`, `openrouter.ai`, and the Ollama loopback. Exact
  origin match (no wildcards). Redirects are forced to `manual` and fail
  closed. Even a fully prompt-injected agent trying to POST your
  conversation elsewhere is refused here.
- **`webFetch`** (`fetch/web-fetch.js`) is the open-web path for the web
  tools and the VM's `curl`/`wget`/`git`. It is allowlist-*free* but
  guarded: scheme check (http/https only), an **SSRF / private-network
  guard** (`fetch/private-network.js` — blocks loopback, LAN,
  link-local, all IPv4 notations, IPv6 including IPv4-mapped and NAT64,
  `localhost`/`*.local`), redirect fail-close, and the denylist as a
  backstop. Every call is audited.
- **Honest gap:** the guards match host strings and structural IP forms,
  not DNS resolution — a public domain that *resolves* to a private IP
  (DNS rebinding) isn't caught at this layer. The structural defense is
  that the page-reading runner has no web tools at all (see
  [`peerd-runtime`](../peerd-runtime/README.md)).

### The denylist

- A 164-pattern seed (`denylist/default.json`) across 11 categories,
  each with apex + `*.` wildcard listed separately to avoid
  substring/boundary bugs.
- The matcher (`denylist/denylist.js`) supports exact hostnames and a
  single leading `*.` wildcard only — no mid-pattern wildcards, no
  regex. `*.proton.me` matches `mail.proton.me` but not `protonmail.com`.
- A full user editor: add (validated/canonicalized by
  `normalizeDenylistPattern`), live search, and confirmed remove. User
  patterns truly delete; seed patterns disable reversibly with their
  provenance shown. Every mutation is audited.

### The audit log

- Append-only, IndexedDB-backed, UUIDv7-keyed (so insertion order *is*
  chronological order). Entry types cover `egress_denied`,
  `denylist_hit`, `tool_confirmed`, `vault_unlocked`, and more
  (`audit/types.js`).
- **Capped retention** — 20,000 entries default (channel-overridable),
  pruned oldest-first, amortized to one count per 256 appends.
- The service worker authenticates the sender on every message and port
  before routing — the audit log can't be poisoned by a spoofed sender.
- Local-only, always. The audit log never leaves the device.

## Public API (`index.js`)

- **Vault:** `createVault(deps)`, `purgeVaultBlob(...)`,
  `DEFAULT_AUTO_LOCK_MS`, `deriveArgon2id(...)`, `ARGON2_DEFAULT_PARAMS`;
  WebAuthn helpers `isWebAuthnAvailable()`,
  `probeWebAuthnCapabilities()`, `enrollWithPrf()`, `getPrfOutput()`,
  `planEnrollment()`, `platformAuthenticatorLabel()`; vault error
  subclasses (`VaultLockedError`, `WrongPassphraseError`,
  `PrfNotEnrolledError`, `KdfUnavailableError`, …).
- **Egress:** `makeSafeFetch(...)`, `HARDCODED_ALLOWLIST`, `originOf()`,
  `isAllowed()`, `makeWebFetch(...)`, `EgressDeniedError`.
- **Denylist:** `matchesDenylist()`, `findDenylistMatch()`,
  `flattenCategorisedDenylist()`, `normalizeDenylistPattern()`.
- **Confirm:** `makeConfirmCoordinator(...)`.
- **Audit:** `createAuditLog(...)`, `DEFAULT_AUDIT_MAX_ENTRIES`.
- **Storage:** `kv`, `idb.*`, `idbKV(store)`, `sessionCache.*`.

All IO is injected as dependencies into the factories — the policy logic
(KDF planning, the denylist matcher, retention arithmetic, the SSRF
guard, enrollment planning) is pure and unit-tested without a browser.

## Known limitations

- **The DK is extractable in the WebCrypto sense.** `SubtleCrypto.wrapKey`
  requires it; the key bytes are never exported to JS. A hardware-bound,
  truly non-extractable DK is future work. An attacker with code
  execution *inside the extension* already defeats this boundary —
  that's out of the threat model.
- **DNS rebinding isn't caught at the egress layer** (see above) — the
  structural defense is the no-web-tools runner.
- **Tool grants are session-scoped and origin-blind.** "Yes for this
  session" approves a tool everywhere in that chat; persistent,
  origin-scoped grants are a TODO.
- **The denylist is a floor, not a guarantee** — 164 patterns,
  user-extendable. It is matched on the host string only. Turn on
  *Confirm before actions* for per-step approval on top.
- **User-added provider endpoints aren't wired yet** — only the
  hardcoded provider allowlist is enforced today.

## TODO / backlog

In-code TODOs:

- `fetch/allowlist.js` / `fetch/safe-fetch.js` — the user-added provider
  endpoint confirmation flow.
- `confirm/protocol.js` — a persistent, origin-scoped `tool_grants`
  store (vs. today's session-only, origin-blind grants).

Backlog (tracked in GitHub Issues):

- **Multi-profile** — per-profile vault namespacing (its own KEK),
  denylist, skills, memory, and sessions, plus encrypted profile
  export/import. The default profile + onboarding already landed in the
  multi-profile shape; this is the namespacing on top.
- Hardware-bound, non-extractable DK.

## See also

- [`DESIGN.md`](../../DESIGN.md) — vault crypto, the denylist matcher,
  and the six-gate dispatcher in full.
- [`docs/DECISIONS.md`](../../docs/DECISIONS.md) — #17 (Argon2id-only),
  and the trust-mode removal.
- [`peerd-runtime`](../peerd-runtime/README.md) — the dispatcher gates
  and the no-web-tools page runner that sit on top of egress.
