// @ts-check
// Compact executable admission table for the sealed semantic host. The full
// 161-route ownership ledger stays in the authority/build graph; a meta-test
// proves this projection equals exactly its migrated, non-kernel rows.

const channels = Object.freeze(['store', 'preview']);
const preview = Object.freeze(['preview']);
const row = (/** @type {string} */ route,
  /** @type {string} */ source = 'extension/background/kernel-semantic-control.js',
  /** @type {readonly string[]} */ routeChannels = channels) => Object.freeze({
  route,
  channels: routeChannels,
  source,
  placement: /** @type {const} */ ('split'),
  state: /** @type {const} */ ('migrated'),
});

export const SEMANTIC_HOST_ROUTE_CLASSIFICATIONS = Object.freeze([
  row('actors/count'),
  row('actors/overview'),
  row('app/get-meta', 'extension/background/routes/engine.js'),
  row('apps/favorite', 'extension/background/routes/engine.js'),
  row('apps/open', 'extension/background/routes/engine.js'),
  row('apps/rename', 'extension/background/routes/engine.js'),
  row('contacts/forget', 'extension/background/kernel-semantic-authority.js'),
  row('contacts/set', 'extension/background/kernel-semantic-authority.js'),
  row('contributor/disable', 'extension/background/kernel-preview-addon.js', preview),
  row('contributor/enable', 'extension/background/kernel-preview-addon.js', preview),
  row('contributor/status', 'extension/background/kernel-preview-addon.js', preview),
  row('memory/delete', 'extension/background/routes/memory.js'),
  row('memory/deleteAll', 'extension/background/routes/memory.js'),
  row('memory/suggestions', 'extension/background/routes/memory.js'),
  row('memory/suggestions/approve', 'extension/background/routes/memory.js'),
  row('memory/suggestions/dismiss', 'extension/background/routes/memory.js'),
  row('memory/write', 'extension/background/routes/memory.js'),
  row('provider/status', 'extension/background/routes/providers.js'),
]);
