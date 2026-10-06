# Peer session compatibility

Session protocol 2 is mandatory for authenticated peer admission. Both endpoints
exchange signed HELLO frames and signed HELLO_PROOF frames before handing the
channel to the mesh. A HELLO envelope ID is a fresh cryptographic challenge. Its
proof identifies both endpoints, both HELLO IDs, and the transport binding in the
sender's direction. The recipient verifies the opposite direction against its
own transport state.

WebRTC bindings contain the local and remote DTLS SHA-256 certificate fingerprints
and the negotiated data-channel stream ID. Fingerprints come from local browser
connection state, never from a peer's claimed identity or handshake payload.
Explicitly trusted local/test channel pairs use unique, endpoint-oriented local
bindings. A transport without a trustworthy binding cannot admit a peer.

The receiver strictly bounds handshake shapes, verification candidates, and early
application traffic. The exchange has a deadline, closes on failure or cancellation,
and releases its handler before handing accepted early traffic to the next owner.
The implementation in session.js owns the precise resource limits.

## Upgrade behavior

Protocol 1 peers are rejected with an upgrade-required error. There is no automatic
fallback, compatibility flag, or admission based solely on a legacy HELLO. A failed
handshake never establishes an authenticated peer for identity-based penalties.
Deploy communicating peers together or expect temporary loss of connectivity with
older installs. Existing post-admission envelope formats do not change.

The peerd-site repository vendors a transport snapshot separately. Its snapshot
must be updated before an upgraded extension can peer with that site's old demo.
Updating the extension repository alone does not complete that rollout.
