// @ts-check
// Cold-safe browser API surface for the pinned modern extension runtimes.
// Chrome MV3 and Firefox WebExtensions both expose promise-returning APIs at
// the supported versions, so the 38KB compatibility shim must not join every
// service-worker wake. Keep this as an identity adapter: authority still lives
// in the owning background/document realm.

const globals = /** @type {any} */ (globalThis);
const nativeBrowser = globals.browser ?? globals.chrome;
if (!nativeBrowser?.runtime) throw new Error('WebExtension browser API is unavailable');

export default /** @type {import('webextension-polyfill')} */ (
  /** @type {unknown} */ (nativeBrowser)
);
