// @ts-check
// git-credentials — the pure rules for git token storage + host-bound use.
//
// Security-critical, so it lives in ONE tested place. A git token is a bearer
// secret (same class as a model API key): it's stored in the vault, decrypted
// only in the SW at request time, and NEVER shown to the agent or the VM. This
// module owns the three pure decisions around it:
//   1. naming      — host → vault secret name (`git:<host>`), and back
//   2. validation  — is this a storable host? a plausible token?
//   3. HOST-BINDING — given an outbound request URL, which credential host (if
//      any) may authenticate it, and what header shape to use.
//
// The host-binding gate is the anti-exfil core: a token is only ever attached
// to an HTTPS request whose host canonicalizes to the token's exact host. Over
// http it is refused outright (a bearer token must never cross the wire in
// cleartext). Combined with webFetch's redirect refusal + SSRF block, a
// prompt-injected clone of an attacker URL cannot carry your token off-host.

export {
  GIT_SECRET_PREFIX,
  canonicalGitHost,
  normalizeGitHost,
  isPlausibleGitToken,
  gitSecretName,
  gitHostFromSecretName,
  authHostForRequestUrl,
  gitAuthHeader,
} from '../../shared/repository-channel.js';
