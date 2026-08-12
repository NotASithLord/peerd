# Same-user device enrollment and P2P state sync

Status: implemented (protocol + custody + transfer + flow); the rendered
front-door fork and the live two-browser ceremony remain (see Limitations).

This document is the architecture summary for the portable-identity arc.
The code is the specification; this names the shape and points at it.

## 1. Architecture

```
                    Person DID  (did:key, random Ed25519 seed)
              permanent root, retained only by a root-authority install
                                  |
              +-------------------+-------------------+
              |                   |                   |
        certifies            authorizes           issues
              |                   |                   |
       Device key           Passkey credential   Discovery secret
    (per install,          (enrollment/recovery   (random 32 bytes,
     never exported)        authority at          shared by devices)
              |             id.peerd.ai)               |
              |                                        |
              +--------- mutual auth over -------------+
                     private rotating rendezvous
                                  |
                          self-device link
                                  |
                        versioned state surfaces
```

Four records, all Ed25519-signed by the person root, all offline-verifiable:

| Record | File | Statement |
|---|---|---|
| Device certificate | `identity/device-certificate.js` | this device key belongs to this person |
| Device roster | same | the person's current device set; revocation by superseding snapshot |
| Passkey binding | `identity/passkey-binding.js` | this credential may enroll/recover devices for this person |
| Recovery record | `identity/recovery-record.js` (existing) | the sealed identity capsule |

Rosters and bindings are **snapshots**, not diffs, with a monotonically
increasing `seq`. Add, remove, rotate, and revoke are all "sign the next
snapshot": the person DID never changes. Anti-rollback matches the DHT's
mutable-item rule: strictly higher `seq`, same person; equal `seq` is a fork,
not an upgrade.

why a roster instead of certificate expiry: a browser extension has no clock
a verifier can trust against a peer's forged timestamp, and short-lived
certificates would need the person root online at renewal: exactly the
always-on infrastructure peerd does not have.

## 2. Trust model

Three tiers, where there were two:

| Tier | Meaning | Grants |
|---|---|---|
| unknown peer | any DID on the mesh | nothing beyond rate-capped inbound |
| known/contact | user-saved overlay, a2a-approved | existing per-DID consent |
| **self device** | mutually proven same-person device | state transfer only |

A peer reaches `self device` only by satisfying **both**, in **both**
directions:

1. a device certificate that verifies under *my* person root, naming exactly
   the device key the mesh link already authenticated, and not revoked in the
   newest roster I hold; and
2. a fresh signature over a challenge bound to protocol version, room, both
   device DIDs by role, and both nonces.

Neither half alone suffices. A stolen certificate has no key; a key without a
certificate is anonymous; a same-DID claim is not authentication; a recorded
proof dies with its nonces; a proof reflected at its author names the wrong
prover. Each of those is a test in `self-handshake.test.ts` and an invariant
in `portable-identity-invariants.test.ts`.

The person DID remains the stable identity peers reason about. Device keys
sign; the certificate says whose device is signing.

## 3. Enrollment sequence

```
 Device B (new)              id.peerd.ai              Device A (sponsor)
     |                            |                          |
     |-- open tab, postMessage -->|                          |
     |   {op, challenge, nonce}   |                          |
     |                            |-- WebAuthn get() -->     |
     |                            |   (Touch ID / platform UV)|
     |<-- raw assertion + PRF ----|                          |
     |    (origin- and nonce-bound, one-shot)                |
     |                                                       |
     |  derive (topicSecret, macKey) from PRF                |
     |  join enroll rendezvous topic                         |
     |                                                       |
     |  mint this install's device key (never exported)       |
     |------------------ ENROLL_REQ ------------------------>|
     |   credentialId, ECDH key, device DID + id, MAC         |
     |                            verify MAC vs binding      |
     |<----------------- ENROLL_CHALLENGE -------------------|
     |   fresh, single-use                                   |
     |                                                       |
     |  ceremony #2: assert over                             |
     |  H(challenge || ECDH key || device DID)               |
     |------------------ ENROLL_PROOF ---------------------->|
     |                            verify assertion against   |
     |                            the ROOT-SIGNED binding    |
     |<----------------- ENROLL_GRANT -----------------------|
     |   AES-GCM sealed to the exchange transcript:          |
     |   device certificate, discovery secret, binding, roster|
     |                                                       |
     |  verify binding under person DID; certificate names   |
     |  MY pre-minted device key; roster lists it active      |
     |  persist device custody; never receive the root seed   |
```

Three proofs, three jobs. The **possession MAC** gates challenge minting so a
stranger on the topic cannot even make the sponsor allocate state. The
**assertion** is the load-bearing "the person is present and approved, now"
a bearer MAC must never be grant-sufficient. The **channel binding** welds the
assertion to the key the grant will be sealed to, so a relay that substitutes
its own key invalidates the assertion it is relaying.

The grant's AES-GCM key is HKDF-salted with the whole transcript (challenge,
credential, both ephemeral keys), so a recorded grant is undecryptable in any
other exchange. The certificate and roster must also name the exact device
key and installation id committed by the request and second assertion.

A hostile sponsor cannot substitute a different identity: it would need a
passkey binding that verifies under *its* root and lists the enrollee's
credential as active, which requires enrolling the user's own passkey against
its identity.

## 4. Private discovery sequence

```
  topic = HMAC-SHA256(discovery_secret, domain || 0x00 || epoch_index)

  Device A                                        Device B
     | derive window {epoch-1, epoch, epoch+1}        |
     |----- join peerd-self/<topic> -------------     |
     |                                    -----  join peerd-self/<topic>
     |<========== both present on the same room =====>|
     |                                                |
     |          every peer here is a CANDIDATE        |
     |          -> mutual authentication (§5)         |
```

- Only devices holding the secret can compute the topic.
- The topic is HMAC output: observers derive no DID from it, and knowing a DID
  derives no topic (the secret is random, never identity material).
- Topics rotate per 6-hour epoch, bounding passive linkability.
- A ±1-epoch window absorbs clock skew.
- Rotating the secret moves every topic without touching the DID.
- A revocation rotation is root-signed, commits the prior and next roster
  sequence, and is accepted only by devices still active in the next roster.
- Self and enrollment spaces are domain-separated.

Discovery yields **candidates only**. Joining or guessing a topic establishes
nothing, proven in `self-coordinator.test.ts`, where an intruder who shares
the room is refused for lacking a same-person certificate.

## 5. Same-device authentication sequence

```
  Laptop                                          Desktop
    |------ AUTH_HELLO {cert, nonce_L} ------------->|
    |                     verify cert under my root, |
    |                     bound to the link's key,   |
    |                     not revoked in my roster   |
    |<----- AUTH_HELLO {cert, nonce_D} --------------|
    |  verify likewise                               |
    |------ AUTH_PROOF sig_L(domain, room,           |
    |          prover=L, verifier=D, n_L, n_D) ----->|
    |<----- AUTH_PROOF sig_D(domain, room,           |
    |          prover=D, verifier=L, n_D, n_L) ------|
    |                                                |
    |  both verified in BOTH directions -> self-device
```

Proof bytes carry the domain tag `peerd/self-device-auth/v1`, so they can
never verify as an envelope, DHT item, certificate, or manifest, and those
can never verify as a proof (asserted in `self-handshake.test.ts`).

## 6. State-transfer sequence

```
  Receiver (B)                                    Source (A)
     |<---------------- SYNC_OFFER -------------------|
     |   manifest: per-surface {version, bytes, hash} |
     |   (secrets present only if consent given)      |
     |                                                |
     |  user approves; secrets held back for its own  |
     |  decision                                      |
     |------------------ SYNC_PULL ------------------>|  per surface
     |                          isSelfDevice(from)?   |  <- endpoint gate
     |<----------------- SYNC_CHUNK ------------------|  bounded chunks
     |<----------------- SYNC_CHUNK ------------------|
     |  reassemble -> verify SHA-256 against manifest |
     |  -> apply that surface                         |
     |                                                |
     |  on failure: fresh collector, re-PULL the same |
     |  surface (same snapshot, same bytes, same hash)|
     |                                                |
     |------------------ SYNC_PULL (secrets) -------->|  only after the
     |                                                |  explicit consent
```

Surfaces apply independently, so an interrupted transfer leaves whole
surfaces present or absent: never half-written. Pulls are idempotent, so
retry is the whole recovery story. The surface vocabulary is **closed**: a
name outside `SYNC_SURFACES` is refused, never "applied generically".

No Peerd-hosted server is in the data path. TURN, if WebRTC needs it, relays
opaque DTLS.

## 7. Durable-surface portability, before and after

`portable` gates the hand-carried file export. `personPortable` (new) gates
replication to a cryptographically proven self device. They differ because
"unsafe in a JSON file a stranger might read" and "unsafe to send to your own
proven device" are different questions.

| Surface | portable (before) | portable (after) | personPortable (new) | Notes |
|---|---|---|---|---|
| memory | yes | yes | **yes** | existing export payload |
| skills | yes | yes | **yes** | metadata; bodies reinstall from origin |
| hooks | yes | yes | **yes** | arrive disabled + untrusted |
| settings | yes | yes | **yes** | explicit values only |
| vault (secrets) | yes | yes | **yes, consent-gated** | re-encrypted under the receiver's vault |
| sessions (chats) | no | no | **yes** | durable conversation only; actor/runtime bookkeeping stripped |
| app-manifests | no | no | **yes** | logical artifacts + content hash, never the IDB handle |
| opfs-workspaces | no (device-bound) | no (device-bound) | **yes, contents only** | logical snapshot materializes into a fresh root; no handle travels |
| permission-grants | no | no | **no** | consent here is not consent there |
| audit | no | no | **no** | provenance is never rewritten |
| dpop-keys | no (device-bound) | no | **no** | non-extractable by platform |
| device-key | *(new entry)* | no (device-bound) | **no** | never leaves the installation |
| engine-registries | no (device-bound) | no | **no** | tab/VM/worker handles are runtime state |
| dweb-identity | no | no | **no** | moves only via the verified recovery/grant path |

## 8. Files changed

New, `extension/peerd-distributed/identity/`: `device-key.js`,
`device-certificate.js`, `passkey-binding.js`, `webauthn-verify.js`.

New, `extension/peerd-distributed/self/`: `rendezvous.js`, `handshake.js`,
`enroll.js`, `sync.js`, `host.js`, `coordinator.js`, `custody.js`,
`ceremony-client.js`.

New, `extension/peerd-runtime/`: `transfer/self-sync-surfaces.js`,
`transfer/enrollment-flow.js`.

New, `web-identity/`: `index.html`, `ceremony.js`, `ceremony.css`, `README.md`.

Modified: `extension/peerd-distributed/index.js` (module surface),
`extension/peerd-runtime/lifecycle/store-registry.js` (the `personPortable`
axis + the `device-key` entry), `packaging/check-tscheck.ts` (coverage floor).

Tests: eleven new files under `tests/peerd-distributed/`,
`tests/peerd-runtime/`, and `tests/web/`, plus `tests/helpers/webauthn-fixtures.ts`.

## 9. The hosted component, and exactly what it can observe

One static page at `https://id.peerd.ai/`. It has no server, no storage, no
database, and a CSP with `connect-src 'none'`, it cannot make a network
request at all.

Per ceremony it observes: the challenge and nonce the extension chose, the
credential id, the credential public key (on create), the signature, and the
PRF output when requested. That is the entire list.

It never receives: the identity seed, the capsule or capsule key, the vault
key, any chat, memory, App, workspace, setting, or credential. Peer sync does
not traverse it: the sync protocol contains no URL or origin.

If the page were compromised, the worst it can do is refuse to run or hand
back an authenticator result. It cannot forge an assertion (no credential
private key; the authenticator holds it behind platform user verification),
and a PRF output alone is not enrollment authority: the grant additionally
requires a fresh assertion the sponsor verifies against the root-signed
binding.

## 10. Cross-browser status

Person identity, certificates, the discovery derivation, the handshake, and
the sync wire format are **browser-neutral** by construction: WebCrypto
Ed25519/HMAC/AES-GCM and JSON. Only custody hosting differs.

Live interoperability is bounded by an existing platform gap, not by this
design: `peerd-distributed/` ships **only in preview-Chrome** (the packaging
predicate is `channel === 'preview' && browser !== 'firefox'`), and Firefox
has no mesh host at all (issue #376: no offscreen API, and the mesh needs a
keyless document). So today:

| Direction | Status |
|---|---|
| Chrome preview → Chrome preview | the supported path |
| Firefox → anything | blocked on #376 (no mesh host) |
| Store builds | dweb pruned entirely; manual file backup remains the path |

Closing the Firefox and store directions is a packaging/hosting decision that
belongs with #376 and the store-permissions decision, not with this protocol.

## 11. Red-team results

`tests/peerd-distributed/portable-identity-invariants.test.ts` asserts all
eighteen issue invariants against shipped code; every one passes and each
failure message names its invariant. Attacks specifically exercised and
refused:

- a certificate from a different root, and a genuine certificate replayed for
  a different device key;
- a roster with its revocation stripped, and a rolled-back (lower/equal `seq`)
  roster;
- a binding relabelled to a victim DID, a credential key swapped inside one,
  and an appended attacker credential;
- an assertion replayed over a stale challenge, minted at a sibling RP
  (`peerd.ai` vs `id.peerd.ai`), produced by `create()` instead of `get()`,
  from a phishing origin, inside a cross-origin frame, or without user
  verification;
- a ceremony reply from a lookalike origin, from a different tab at the right
  origin, or carrying another request's nonce;
- an enrollment request without the possession MAC, with a revoked credential,
  or with the ephemeral key spliced;
- a recorded enrollment grant replayed into a new exchange;
- a hostile sponsor substituting its own identity (both variants);
- an auth proof replayed, reflected, or carried from another room, and an
  ordinary mesh envelope signature replanted as a proof;
- a sync manifest naming an unknown surface, a duplicated surface, an oversize
  claim, or a malformed hash; a chunk with a changed total, bad sequence, junk
  base64, or tampered bytes;
- a non-self peer pulling state (silent drop, not even a refusal frame).

## 12. Demo instructions

The protocol end to end, without a browser:

```
bun test ./tests/peerd-distributed/self-transfer.e2e.test.ts
```

That rehearses the finished-marker scenario: two devices bootstrap custody
under one person, discover each other on a derived rendezvous room, mutually
authenticate to `self-device`, and transfer chats, memory, settings, an App,
and a workspace, with real certificates, real challenge-response, real
chunking and hashing. Only WebRTC is substituted (an in-memory mesh).

The full suite for this arc:

```
bun test ./tests/peerd-distributed/ ./tests/peerd-runtime/enrollment-flow.test.ts \
         ./tests/peerd-runtime/self-sync-surfaces.test.ts ./tests/web/
```

The live two-device scenario additionally needs the gate wiring below and a
deployed ceremony page.

## 13. Known limitations

1. **The rendered front door is not wired.** The flow state machine, copy, and
   every branch are implemented and tested; the vault gate's
   "Create new / Use my existing Peerd" fork is not yet rendered. Peerd
   requires UI changes to pass the visual verify loop, and the pinned Chrome
   for Testing binary was unreachable from the authoring environment.
2. **No live WebAuthn ceremony has run.** The verifier is exercised against
   fabricated-but-real signatures (WebCrypto keys, genuine DER encoding). A
   real Touch ID ceremony against a deployed `id.peerd.ai` remains release
   validation, as does the in-browser tier for the enrollment double-ceremony.
3. **`id.peerd.ai` is not deployed.** The page is written and its posture is
   gated by tests, but hosting, TLS, and related-origin metadata belong to the
   site repository.
4. **Preview-Chrome only** (§10).
5. **Snapshot transfer, not ongoing sync.** Deliberate, see §14.
6. **Conflict behavior is keep-destination.** A session id already present on
   the receiver is skipped, not merged.
7. **Public transport device-certificate switchover remains a release gate.** Mesh envelopes, Agent
   Cards, manifests, DHT items, and A2A still sign with the person root. The
   enrolled-device grant therefore does not install a public-network root at
   all; such a device may use the private self-device mesh, but must not start
   the public base network until those surfaces accept certificate-backed
   device signatures. This avoids solving revocation by copying the permanent
   root to every device.

## 14. Deliberately deferred to ongoing multi-device sync

- Continuous background replication; this arc is initial migration.
- Multi-master convergence: no CRDTs, vector clocks, or tombstones. The wire
  format carries per-surface versions and hashes so incremental reconciliation
  can be added, but nothing here claims general multi-master sync.
- Delta transfer. Content hashes are carried per App and per surface; chunk-
  level HAVE/WANT is the natural next layer.
- Roster/binding propagation over gossip and the DHT (issue #362), including
  delivery of the signed discovery rotation to active devices that were
  offline when revocation happened.
- Cross-device activity aggregation with retained per-device provenance.
- Hosted encrypted backup for the "no device online" case.
- Per-dwapp subidentities (issue #320).
