// @ts-check
// Untrusted-content wrap — re-export of the canonical implementation.
//
// why: the @-tab resolver is a lethal-trifecta surface and must emit the
// SAME <untrusted_web_content> wrap read_page does, so there is exactly
// one wrapUntrusted and the composer can't drift from it.
export { wrapUntrusted } from '../tools/prompt-wrap.js';
