// @ts-check

import {
  classifyDrivenChildRequestTarget,
  makeDrivenChildRequestGuard,
  makeFirefoxDrivenChildMarkerStore,
} from './driven-child-request-guard.js';

const root = /** @type {any} */ (globalThis);
const addonId = Symbol.for('peerd.kernel.firefox-addon.v1');
if (root[addonId]) throw new Error('kernel-firefox-addon-owner-conflict');
root[addonId] = (/** @type {any} */ {
  isDrivenSource, isSourceReady, isSensitiveHost,
}) =>
  makeDrivenChildRequestGuard({
    isDrivenSource, isSourceReady,
    classifyTarget: (url) => classifyDrivenChildRequestTarget(url, isSensitiveHost),
    markers: makeFirefoxDrivenChildMarkerStore(globalThis.localStorage),
  });
