// @ts-check

const ESM_EXPORT = 'export default m;\n';
const CLASSIC_EXPORT = 'window.m = m;\n';

/**
 * Project the hash-locked Mithril ESM source into the classic build expected
 * by sandboxed Apps.
 *
 * why: keeping one canonical vendor body removes the duplicate global file
 * without adding a second module to every extension UI page. The exact footer
 * check fails closed if a future vendor update changes the conversion shape.
 * @param {string} source
 */
export const mithrilClassicSource = (source) => {
  if (typeof source !== 'string' || !source.endsWith(ESM_EXPORT)) {
    throw new TypeError('mithril-esm-footer-mismatch');
  }
  return `${source.slice(0, -ESM_EXPORT.length)}${CLASSIC_EXPORT}`;
};
