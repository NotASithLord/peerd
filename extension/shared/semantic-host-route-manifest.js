// @ts-check
// Compact executable admission table for the sealed semantic host. Kernel
// routes live with their concrete owners; only routes listed here may cross
// into the sealed host.

const channels = Object.freeze(['store', 'preview']);
const preview = Object.freeze(['preview']);
const row = (/** @type {string} */ route,
  /** @type {readonly string[]} */ routeChannels = channels) => Object.freeze({
  route,
  channels: routeChannels,
});

export const SEMANTIC_HOST_ROUTE_MANIFEST = Object.freeze([
  row('actors/count'),
  row('actors/overview'),
  row('app/get-meta'),
  row('apps/favorite'),
  row('apps/open'),
  row('apps/rename'),
  row('contacts/forget'),
  row('contacts/set'),
  row('contributor/disable', preview),
  row('contributor/enable', preview),
  row('contributor/status', preview),
  row('memory/delete'),
  row('memory/deleteAll'),
  row('memory/suggestions'),
  row('memory/suggestions/approve'),
  row('memory/suggestions/dismiss'),
  row('memory/write'),
  row('provider/status'),
]);
