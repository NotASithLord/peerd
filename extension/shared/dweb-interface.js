// @ts-check
// Dweb interface — the abstract surface core code programs
// against. Core NEVER imports the dweb module directly (enforced
// by ESLint + packaging/check-dweb-boundary.ts); it imports these
// types and the stub from here, and obtains the live implementation via
// loadDweb() in ./dweb-loader.js.
//
// why the split from dweb-loader.js: this file ships IDENTICALLY
// in both channels (types + stub are harmless and useful everywhere).
// The loader is the single file that names the dweb module's path,
// so the store package can swap that one file for a no-op variant and the
// post-package verifier can assert the store artifact contains zero
// references to the module — no allowlist, no exceptions. (That is also
// why these comments say "the dweb module" instead of naming its
// directory: this file ships in the store artifact, and the verifier
// greps it like everything else.)

/**
 * @typedef {Object} DwebStatus
 * @property {boolean} available  false in the store package / stub
 * @property {number | null} phase  protocol phase (research-grade; may change)
 * @property {string | null} did    this instance's identity, if created
 */

/**
 * @typedef {Object} DwebClient
 * What core is allowed to ask of the dweb. Deliberately minimal —
 * grow it only when a core surface genuinely needs a new capability.
 * The Phase 1 members are optional: absent on the stub (gate on
 * `available`, never on member presence alone).
 * @property {boolean} available
 * @property {number | null} phase
 * @property {() => Promise<DwebStatus>} getStatus
 * @property {() => Promise<{ did: string }>} ensureIdentity
 * @property {((io: { getSecret: (n: string) => Promise<string | null>, setSecret: (n: string, v: string) => Promise<void> }) => Promise<{ seed: string, pub: string, did: string }>)=} identityMaterial
 *   persistent identity material (vault IO injected — SW-side)
 * @property {((material: { seed: string, pub: string }) => Promise<any>)=} identityFromMaterial
 *   rehydrate a signing identity from material (page-side)
 * @property {((opts: any) => Promise<any>)=} installAppBundle
 *   verified bundle → engine App via an injected installer
 * @property {((io: { fetchText: (p: string) => Promise<string> }) => Promise<any>)=} loadSeedApp
 *   the built-in seed app's files (commons)
 * @property {((opts: any) => { dispose: () => void })=} createAppBridge
 *   attach the dwapp postMessage bridge to a hosted app frame (app-tab)
 * @property {string=} seedAppKey
 * @property {string[]=} defaultSignaling
 */

/** Thrown by the stub when a code path calls the dweb in a build (or
 *  configuration) where it isn't present. Core should normally never
 *  trigger this: dweb calls belong behind DWEB_ENABLED. */
export class DwebUnavailableError extends Error {
  constructor(operation = 'operation') {
    super(`dweb not available in this build (${operation})`);
    this.name = 'DwebUnavailableError';
  }
}

/**
 * The stub implementation — the only implementation that ships in the
 * store package. Status reads answer honestly; anything that would touch
 * the network or create state throws.
 * @type {DwebClient}
 */
export const dwebStub = Object.freeze({
  available: false,
  phase: null,
  getStatus: async () => ({ available: false, phase: null, did: null }),
  ensureIdentity: async () => { throw new DwebUnavailableError('ensureIdentity'); },
});
