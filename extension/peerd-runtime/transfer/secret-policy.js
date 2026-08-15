// @ts-check
// Shared custody-secret policy for every transfer channel. Security
// boundaries classify names inside a generic secrets object; checking only
// the outer surface name lets protected material tunnel through.

export const NON_TRANSFERABLE_SECRET_PREFIXES = Object.freeze([
  'distributed/identity/',
  'distributed/device-key/',
  'distributed/self-discovery/',
  'distributed/self-records/',
]);

/** @param {string} name */
export const isCustodySecretName = (name) =>
  typeof name === 'string'
  && NON_TRANSFERABLE_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix));

/** @param {Record<string, string> | null | undefined} secrets */
export const portableSecretEntries = (secrets) => Object.fromEntries(
  Object.entries(secrets ?? {}).filter(([name]) => !isCustodySecretName(name)),
);
