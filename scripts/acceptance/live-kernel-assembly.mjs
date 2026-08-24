// Exact acceptance contract for a production native-kernel assembly report.
// This is intentionally consumed by every installed-artifact lane: a boolean
// `cutoverReady` without the complete reviewed inventories is not evidence.

import {
  coldEventKeysFor,
  coldPortNamesFor,
  LEGACY_COLD_EVENTS,
  LEGACY_PORT_CLASSES,
} from '../../extension/background/cold-kernel-inventory.js';
import {
  LEGACY_SEMANTIC_ROUTE_INVENTORY,
} from '../../extension/shared/semantic-route-inventory.generated.js';
import {
  SEMANTIC_ROUTE_CLASSIFICATIONS,
} from '../../extension/shared/semantic-route-classification.js';

export const LIVE_KERNEL_TARGETS = Object.freeze({
  'store-chrome': Object.freeze({ firefox: false, selfHostedChrome: false, dweb: false }),
  'preview-chrome': Object.freeze({ firefox: false, selfHostedChrome: true, dweb: true }),
  'store-firefox': Object.freeze({ firefox: true, selfHostedChrome: false, dweb: false }),
});

const fail = (detail) => {
  throw new Error(`complete live kernel assembly: ${detail}`);
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const exactArray = (actual, expected) => Array.isArray(actual)
  && JSON.stringify(actual) === JSON.stringify(expected);

export const liveKernelAssemblyProfile = (targetName) => {
  const target = LIVE_KERNEL_TARGETS[targetName];
  if (!target) fail('unknown target');
  const requiredEvents = coldEventKeysFor(target);
  const requiredPorts = coldPortNamesFor({ firefox: target.firefox, dweb: target.dweb });
  const semanticPlacements = Object.freeze({
    kernel: SEMANTIC_ROUTE_CLASSIFICATIONS.filter((entry) => entry.placement === 'kernel').length,
    split: SEMANTIC_ROUTE_CLASSIFICATIONS.filter((entry) => entry.placement === 'split').length,
  });
  return Object.freeze({
    targetName,
    target,
    semanticRoutes: LEGACY_SEMANTIC_ROUTE_INVENTORY.length,
    semanticPlacements,
    eventInventory: LEGACY_COLD_EVENTS.length,
    eventKeys: Object.freeze(LEGACY_COLD_EVENTS.map((entry) => entry.key)),
    requiredEvents: Object.freeze(requiredEvents),
    portInventory: LEGACY_PORT_CLASSES.length,
    portNames: Object.freeze(LEGACY_PORT_CLASSES.map((entry) => entry.name)),
    requiredPorts: Object.freeze(requiredPorts),
  });
};

/**
 * @param {unknown} candidate
 * @param {'store-chrome'|'preview-chrome'|'store-firefox'} targetName
 */
export const assertLiveKernelAssembly = (candidate, targetName) => {
  const profile = liveKernelAssemblyProfile(targetName);
  if (!exactKeys(candidate, [
    'identity', 'target', 'events', 'ports', 'counts',
    'missingRequiredEvents', 'incompletePorts', 'cutoverReady', 'semantic',
  ])) fail('top-level shape is not exact');
  const assembly = /** @type {any} */ (candidate);

  if (!exactKeys(assembly.identity, ['schema', 'buildId', 'bootId', 'kernelEpoch'])
      || assembly.identity.schema !== 1
      || typeof assembly.identity.buildId !== 'string'
      || !/^\d+\.\d+\.\d+:[a-f0-9]{64}$/.test(assembly.identity.buildId)
      || typeof assembly.identity.bootId !== 'string' || assembly.identity.bootId.length < 3
      || assembly.identity.bootId.length > 128
      || typeof assembly.identity.kernelEpoch !== 'string'
      || assembly.identity.kernelEpoch.length < 3
      || assembly.identity.kernelEpoch.length > 128
      || assembly.identity.bootId === assembly.identity.kernelEpoch) {
    fail('kernel identity is invalid');
  }
  if (!exactKeys(assembly.target, ['firefox', 'selfHostedChrome'])
      || assembly.target.firefox !== profile.target.firefox
      || assembly.target.selfHostedChrome !== profile.target.selfHostedChrome) {
    fail('target posture is invalid');
  }
  if (!exactKeys(assembly.counts, [
    'eventInventory', 'requiredEvents', 'ownedRequiredEvents',
    'portInventory', 'requiredPorts', 'ownedRequiredPorts',
  ])
      || assembly.counts.eventInventory !== profile.eventInventory
      || assembly.counts.requiredEvents !== profile.requiredEvents.length
      || assembly.counts.ownedRequiredEvents !== profile.requiredEvents.length
      || assembly.counts.portInventory !== profile.portInventory
      || assembly.counts.requiredPorts !== profile.requiredPorts.length
      || assembly.counts.ownedRequiredPorts !== profile.requiredPorts.length) {
    fail('inventory counts are invalid');
  }

  if (!Array.isArray(assembly.events)
      || !exactArray(assembly.events.map((entry) => entry?.key), profile.eventKeys)) {
    fail('event inventory is incomplete, duplicated, reordered, or unknown');
  }
  const requiredEvents = new Set(profile.requiredEvents);
  for (let index = 0; index < assembly.events.length; index += 1) {
    const entry = assembly.events[index];
    const inventory = LEGACY_COLD_EVENTS[index];
    const required = requiredEvents.has(inventory.key);
    const hasOwner = typeof entry?.owner === 'string'
      && entry.owner.length >= 3 && entry.owner.length <= 128;
    if (!exactKeys(entry, ['key', 'placement', 'required', 'status', 'owner'])
        || entry.placement !== inventory.placement || entry.required !== required
        || !['missing', 'partial', 'owned'].includes(entry.status)
        || (entry.status === 'missing' ? entry.owner !== null : !hasOwner)
        || (required && entry.status !== 'owned')) {
      fail(`event inventory row is invalid: ${inventory.key}`);
    }
  }

  if (!Array.isArray(assembly.ports)
      || !exactArray(assembly.ports.map((entry) => entry?.name), profile.portNames)) {
    fail('port inventory is incomplete, duplicated, reordered, or unknown');
  }
  const requiredPorts = new Set(profile.requiredPorts);
  for (let index = 0; index < assembly.ports.length; index += 1) {
    const entry = assembly.ports[index];
    const inventory = LEGACY_PORT_CLASSES[index];
    const required = requiredPorts.has(inventory.name);
    const hasOwner = typeof entry?.owner === 'string'
      && entry.owner.length >= 3 && entry.owner.length <= 128;
    const validReason = entry?.status === 'fail-closed'
      ? typeof entry.reason === 'string' && entry.reason.length >= 3 && entry.reason.length <= 128
      : entry?.reason === (Object.hasOwn(inventory, 'reason') ? inventory.reason : null);
    if (!exactKeys(entry, ['name', 'cold', 'required', 'status', 'owner', 'reason'])
        || entry.cold !== inventory.cold || entry.required !== required
        || !['missing', 'partial', 'owned', 'fail-closed'].includes(entry.status)
        || (entry.status === 'missing' || entry.status === 'fail-closed'
          ? entry.owner !== null : !hasOwner)
        || !validReason
        || (required && entry.status !== 'owned')) {
      fail(`port inventory row is invalid: ${inventory.name}`);
    }
  }

  if (assembly.cutoverReady !== true
      || !exactArray(assembly.missingRequiredEvents, [])
      || !exactArray(assembly.incompletePorts, [])) {
    fail('readiness or missing-owner projection is invalid');
  }
  if (!exactKeys(assembly.semantic, [
    'schema', 'total', 'kernel', 'split', 'migrated', 'unmigrated',
    'executable', 'unavailable', 'ready',
  ])
      || assembly.semantic.schema !== 2
      || assembly.semantic.total !== profile.semanticRoutes
      || assembly.semantic.kernel !== profile.semanticPlacements.kernel
      || assembly.semantic.split !== profile.semanticPlacements.split
      || assembly.semantic.migrated !== profile.semanticRoutes
      || assembly.semantic.unmigrated !== 0
      || assembly.semantic.executable !== profile.semanticRoutes
      || assembly.semantic.unavailable !== 0
      || assembly.semantic.ready !== true) {
    fail('semantic route ledger is incomplete or inconsistent');
  }
  return assembly;
};

// Deterministic fixture for contract tests. Production runners never call it.
export const completeLiveKernelAssemblyFixture = (targetName) => {
  const profile = liveKernelAssemblyProfile(targetName);
  const requiredEvents = new Set(profile.requiredEvents);
  const requiredPorts = new Set(profile.requiredPorts);
  return {
    identity: {
      schema: 1,
      buildId: `0.7.0:${'a'.repeat(64)}`,
      bootId: 'boot-acceptance-fixture',
      kernelEpoch: 'kernel-acceptance-fixture',
    },
    target: {
      firefox: profile.target.firefox,
      selfHostedChrome: profile.target.selfHostedChrome,
    },
    events: LEGACY_COLD_EVENTS.map((entry) => ({
      key: entry.key,
      placement: entry.placement,
      required: requiredEvents.has(entry.key),
      status: requiredEvents.has(entry.key) ? 'owned' : 'missing',
      owner: requiredEvents.has(entry.key) ? `owner:${entry.key}` : null,
    })),
    ports: LEGACY_PORT_CLASSES.map((entry) => ({
      name: entry.name,
      cold: entry.cold,
      required: requiredPorts.has(entry.name),
      status: requiredPorts.has(entry.name) ? 'owned' : 'missing',
      owner: requiredPorts.has(entry.name) ? `owner:${entry.name}` : null,
      reason: 'reason' in entry ? entry.reason : null,
    })),
    counts: {
      eventInventory: profile.eventInventory,
      requiredEvents: profile.requiredEvents.length,
      ownedRequiredEvents: profile.requiredEvents.length,
      portInventory: profile.portInventory,
      requiredPorts: profile.requiredPorts.length,
      ownedRequiredPorts: profile.requiredPorts.length,
    },
    missingRequiredEvents: [],
    incompletePorts: [],
    cutoverReady: true,
    semantic: {
      schema: 2,
      total: profile.semanticRoutes,
      kernel: profile.semanticPlacements.kernel,
      split: profile.semanticPlacements.split,
      migrated: profile.semanticRoutes,
      unmigrated: 0,
      executable: profile.semanticRoutes,
      unavailable: 0,
      ready: true,
    },
  };
};
