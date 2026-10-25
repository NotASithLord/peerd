// @ts-check
// What a verified App bundle asks of peerd, for Discover's "The app says it".
// why in the dweb host: it verifies the bundle, and the service worker's fixed
// cold graph has no room to grow (scripts/bench/cold-start-budgets.js).

import { buildAppManifest, parseAppManifest } from '/peerd-engine/app-manifest.js';

/**
 * Three facts from a verified bundle's own peerd.json, read by the parser an
 * install applies, never the instruction text. why the dwapp default: an
 * install writes it when the bundle has none (background/app-client.js), so
 * that is what the App gets. Null when its peerd.json is not UTF-8 or not
 * valid, which an install refuses.
 * @param {Record<string, string|Uint8Array>} files @param {string} entry
 * @returns {{dweb:boolean, instructions:boolean, observeAct:boolean}|null}
 */
export const bundleDeclaration = (files, entry) => {
  /** @type {{capabilities:readonly string[], agent:{kind:string, instructions?:string, runtime?:readonly string[]}}} */
  let contract;
  try {
    const raw = Object.hasOwn(files, 'peerd.json') ? files['peerd.json'] : null;
    contract = raw === null ? buildAppManifest({ entry, dwapp: true })
      : parseAppManifest(typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch { return null; }
  return {
    dweb: contract.capabilities.includes('dweb'),
    instructions: typeof contract.agent.instructions === 'string',
    observeAct: ['observe', 'act'].every((method) => contract.agent.runtime?.includes(method) === true),
  };
};

/** @typedef {{files:Record<string, string|Uint8Array>, entryFile:string, dweb:{hash:string}}} VerifiedApp */

/**
 * The facts bound to the hash of the version they describe, so a value kept
 * from another version never stands for this one.
 * @param {VerifiedApp} app a bundle prepareAppBundle verified
 */
export const verifiedDeclaration = (app) => {
  const declared = bundleDeclaration(app.files, app.entryFile);
  return declared && { hash: app.dweb.hash, ...declared };
};

/**
 * The bundle with its facts in the dweb slot, so the install or update that
 * hands it to storage records them with the version.
 * @template {VerifiedApp} T @param {T} app
 */
export const withDeclaration = (app) => ({ ...app, dweb: { ...app.dweb, declared: verifiedDeclaration(app) } });
