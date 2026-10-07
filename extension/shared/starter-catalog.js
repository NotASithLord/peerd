// @ts-check
// Packaged examples have local provenance, not a peer publisher or availability claim.
const STARTERS = Object.freeze({
  'csv-lab': { name: 'CSV Lab', description: 'Explore CSV tables, numeric summaries and a bar chart locally.', runtime: 'JavaScript', path: '/peerd-engine/starters/csv-lab.peerd' },
  'wasm-image': { name: 'WebAssembly Image Lab', description: 'Apply grayscale and threshold filters using a small bundled WebAssembly module.', runtime: 'JavaScript + WebAssembly', path: '/peerd-engine/starters/wasm-image.peerd' },
});
/** @param {unknown} key */
export const packagedStarter = key => typeof key === 'string' && Object.hasOwn(STARTERS, key)
  ? STARTERS[/** @type {keyof typeof STARTERS} */ (key)] : null;
export const starterKeys = Object.freeze(Object.keys(STARTERS));
/** @param {unknown} key @param {typeof fetch} [read] */
// Only literal same-extension assets from STARTERS are read, never caller URLs.
// eslint-disable-next-line no-restricted-globals
export const loadPackagedStarter = async (key, read = fetch) => {
  const starter = packagedStarter(key);
  if (!starter) throw new Error('Unknown packaged starter.');
  const response = await read(starter.path);
  if (!response.ok) throw new Error('The packaged starter could not be loaded.');
  return response.json();
};
