// @ts-check

/**
 * Pure URL-origin normalization shared by sealed semantics and egress. Keeping
 * this leaf outside the privileged egress barrel prevents a policy hook from
 * importing vault/storage/browser authority into a semantic Worker graph.
 * @param {string | URL | Request} resource
 */
export const originOf = (resource) => {
  const urlString = typeof Request !== 'undefined' && resource instanceof Request
    ? resource.url : resource instanceof URL ? resource.toString() : resource;
  const url = new URL(/** @type {string | URL} */ (urlString));
  return `${url.protocol}//${url.host}`;
};
