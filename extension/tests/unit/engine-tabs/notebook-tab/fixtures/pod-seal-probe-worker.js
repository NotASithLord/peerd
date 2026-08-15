// @ts-check
// The production Pod seal is the FIRST dependency: this fixture proves the
// real DedicatedWorkerGlobalScope after that exact entry has run.
import { podFetch } from '../../../../../engine-tabs/pod-tab/pod-realm-seal.js';

/** @param {() => unknown} fn */
const attempt = (fn) => {
  try { fn(); return { threw: false }; }
  catch (error) {
    const caught = /** @type {{name?:string,message?:string}} */ (error);
    return { threw: true, name: caught?.name, message: caught?.message };
  }
};

postMessage({
  type: 'pod-seal-result',
  globalFetch: attempt(() => globalThis.fetch('https://example.test')),
  rawOpfs: attempt(() => navigator.storage.getDirectory()),
  chromeAbsent: /** @type {any} */ (globalThis).chrome === undefined,
  browserAbsent: /** @type {any} */ (globalThis).browser === undefined,
  namedFetch: typeof podFetch,
});
