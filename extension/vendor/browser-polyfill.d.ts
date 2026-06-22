// Type sidecar for the vendored webextension-polyfill (runtime is
// browser-polyfill.js). why: feature code imports `browser` as the
// default export and drives chrome.* APIs through it; without this the
// import resolves to `any` and every browser.* call goes unchecked.
// @types/webextension-polyfill (dev-only, type-only) supplies the real
// WebExtension surface. No runtime cost — TS prefers this .d.ts for
// types while the browser loads the .js. Keep the version in
// package.json aligned with the vendored polyfill (SOURCE.txt).
import type { Browser } from 'webextension-polyfill';

declare const browser: Browser;
export default browser;
