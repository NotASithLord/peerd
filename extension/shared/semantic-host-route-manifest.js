// @ts-check
// Compact executable admission table for the sealed semantic host. The full
// 161-route ownership ledger stays in the authority/build graph; a meta-test
// proves this projection equals exactly its migrated, non-kernel rows.

const channels = Object.freeze(['store', 'preview']);
const preview = Object.freeze(['preview']);
const row = (/** @type {string} */ route,
  /** @type {string} */ source = 'extension/background/semantic-route-kernel.js',
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
  row('contacts/forget'),
  row('contacts/list'),
  row('contacts/set'),
  row('contributor/disable', 'extension/background/routes/contributor-metrics.js', preview),
  row('contributor/enable', 'extension/background/routes/contributor-metrics.js', preview),
  row('contributor/status', 'extension/background/routes/contributor-metrics.js', preview),
  row('memory/delete', 'extension/background/routes/memory.js'),
  row('memory/deleteAll', 'extension/background/routes/memory.js'),
  row('memory/export', 'extension/background/routes/memory.js'),
  row('memory/suggestions', 'extension/background/routes/memory.js'),
  row('memory/suggestions/approve', 'extension/background/routes/memory.js'),
  row('memory/suggestions/dismiss', 'extension/background/routes/memory.js'),
  row('memory/write', 'extension/background/routes/memory.js'),
  row('provider/status', 'extension/background/routes/providers.js'),
  row('skills/list', 'extension/background/routes/skills.js'),
  row('skills/remove', 'extension/background/routes/skills.js'),
  row('skills/setEnabled', 'extension/background/routes/skills.js'),
  row('toolbox/read'),
  row('toolbox/record'),
]);
