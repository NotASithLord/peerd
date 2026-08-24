// @ts-check
// git-credential-routes — the SW message handlers for git token provisioning.
//
// Three routes back the Settings → Git credentials UI: list the HOST NAMES the
// vault holds a `git:<host>` token for, set one (validate + canonicalize host,
// sanity-check the token), and delete one. Tokens are write-only from the UI's
// point of view — `list` returns host names ONLY, never values; the token is
// decrypted just-in-time in injectGitAuth at request time (vm-http-fetch.js).
//
// Factored out of service-worker.js as an IO-injected factory so the validation
// + error mapping is bun-testable without a SW. The pure host/token policy lives
// in git-credentials.js; this composes it over an injected vault + audit. All IO
// is injected — no vault/audit import here.

import { createGitCredentialRoutes } from '../../shared/repository-channel.js';

/**
 * Build the git-credential route handlers.
 * @param {Object} deps
 * @param {{ listSecretNames: () => Promise<string[]>, getSecret?: (name:string)=>Promise<string|null>, setSecret: (name: string, value: string) => Promise<void>, deleteSecret: (name: string) => Promise<void> }} deps.vault
 * @param {(e: any) => boolean} deps.isLockedError  maps a thrown error to the 'locked' response
 * @param {(e: any) => void} [deps.audit]
 * @returns {{ 'git-cred/list': Function, 'git-cred/set': Function, 'git-cred/delete': Function }}
 */
export const makeGitCredentialRoutes = ({ vault, isLockedError, audit }) => {
  return createGitCredentialRoutes({ vault, isLockedError, audit });
};
