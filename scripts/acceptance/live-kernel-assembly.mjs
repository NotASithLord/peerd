// Exact acceptance contract for the live native-kernel assembly. The report
// proves concrete listener and Port ownership; the controller build identity
// binds the compact semantic-host manifest without duplicating a route ledger
// in the service worker.

import {
  coldEventKeysFor,
  coldPortNamesFor,
  KERNEL_COLD_EVENTS,
  KERNEL_PORT_CLASSES,
} from '../../extension/background/cold-kernel-inventory.js';
import {
  SEMANTIC_HOST_ROUTE_MANIFEST,
} from '../../extension/shared/semantic-host-route-manifest.js';

export const LIVE_KERNEL_TARGETS = Object.freeze({
  'store-chrome': Object.freeze({
    firefox: false, selfHostedChrome: false, dweb: false, channel: 'store',
  }),
  'preview-chrome': Object.freeze({
    firefox: false, selfHostedChrome: true, dweb: true, channel: 'preview',
  }),
  'store-firefox': Object.freeze({
    firefox: true, selfHostedChrome: false, dweb: false, channel: 'store',
  }),
});

// Independent acceptance truth: owner labels are evidence only when the live
// artifact reports the exact reviewed owner for that browser surface.
const EVENT_OWNERS = Object.freeze({
  'runtime.onMessage': 'vault-kernel-message-router',
  'runtime.onConnect': 'kernel-port-router',
  'runtime.onStartup': 'kernel-lifecycle',
  'runtime.onInstalled': 'kernel-vault-posture-install',
  'runtime.onUpdateAvailable': 'kernel-lifecycle',
  'alarms.onAlarm': 'kernel-lifecycle',
  'storage.session.onChanged': 'kernel-firefox-actor-lifetime',
  'tabs.onCreated': 'kernel-tab-custody',
  'tabs.onUpdated': 'kernel-tab-custody',
  'tabs.onRemoved': 'kernel-tab-custody',
  'tabs.onActivated': 'kernel-tab-custody',
  'windows.onFocusChanged': 'kernel-front-door',
  'webNavigation.onCreatedNavigationTarget': 'kernel-tab-custody',
  'webRequest.onBeforeRequest': 'kernel-tab-custody',
  'action.onClicked': 'kernel-front-door',
  'commands.onCommand': 'kernel-front-door',
});
const PORT_OWNERS = Object.freeze({
  'private-transfer': 'kernel-private-transfer',
  sidepanel: 'vault-ui-ports',
  home: 'vault-ui-ports',
  eval: 'vault-ui-ports',
  'feature-lease-keepalive': 'kernel-feature-host',
  'dweb-custody': 'kernel-dweb-custody',
});
const CLOSED_PORT_REASONS = Object.freeze({
  'private-transfer': 'window-client-transfer-owned-on-chrome',
  'feature-lease-keepalive': 'firefox-background-owns-feature-lifetime',
  'dweb-custody': 'dweb-not-packaged-for-target',
});

const fail = (detail) => {
  throw new Error(`complete live kernel assembly: ${detail}`);
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const exactArray = (actual, expected) => Array.isArray(actual)
  && JSON.stringify(actual) === JSON.stringify(expected);

const semanticHostRoutesFor = (channel) => {
  const rows = SEMANTIC_HOST_ROUTE_MANIFEST.filter((row) => row.channels.includes(channel));
  const routes = rows.map((row) => row.route);
  if (routes.length === 0 || new Set(routes).size !== routes.length
      || rows.some((row) => !exactKeys(row, ['channels', 'route', 'source'])
        || typeof row.route !== 'string' || row.route.length === 0
        || typeof row.source !== 'string' || row.source.length === 0
        || !Array.isArray(row.channels) || row.channels.length === 0)) {
    fail('compact semantic host admission is invalid');
  }
  return Object.freeze(routes);
};

export const liveKernelAssemblyProfile = (targetName) => {
  const target = LIVE_KERNEL_TARGETS[targetName];
  if (!target) fail('unknown target');
  return Object.freeze({
    targetName,
    target,
    semanticHostRoutes: semanticHostRoutesFor(target.channel),
    eventKeys: Object.freeze(KERNEL_COLD_EVENTS.map((entry) => entry.key)),
    requiredEvents: Object.freeze(coldEventKeysFor(target)),
    portNames: Object.freeze(KERNEL_PORT_CLASSES.map((entry) => entry.name)),
    requiredPorts: Object.freeze(coldPortNamesFor({
      firefox: target.firefox, dweb: target.dweb,
    })),
  });
};

/**
 * @param {unknown} candidate
 * @param {'store-chrome'|'preview-chrome'|'store-firefox'} targetName
 */
export const assertLiveKernelAssembly = (candidate, targetName) => {
  const profile = liveKernelAssemblyProfile(targetName);
  if (!exactKeys(candidate, [
    'identity', 'target', 'events', 'ports',
    'missingRequiredEvents', 'incompletePorts', 'ready',
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

  if (!Array.isArray(assembly.events)
      || !exactArray(assembly.events.map((entry) => entry?.key), profile.eventKeys)) {
    fail('event inventory is incomplete, duplicated, reordered, or unknown');
  }
  const requiredEvents = new Set(profile.requiredEvents);
  for (let index = 0; index < assembly.events.length; index += 1) {
    const entry = assembly.events[index];
    const inventory = KERNEL_COLD_EVENTS[index];
    const required = requiredEvents.has(inventory.key);
    const expectedOwner = required ? EVENT_OWNERS[inventory.key] : null;
    if (!exactKeys(entry, ['key', 'placement', 'required', 'status', 'owner'])
        || entry.placement !== inventory.placement || entry.required !== required
        || entry.status !== (required ? 'owned' : 'missing')
        || entry.owner !== expectedOwner) {
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
    const inventory = KERNEL_PORT_CLASSES[index];
    const required = requiredPorts.has(inventory.name);
    const expectedOwner = required ? PORT_OWNERS[inventory.name] : null;
    const expectedReason = required
      ? Object.hasOwn(inventory, 'reason') ? inventory.reason : null
      : CLOSED_PORT_REASONS[inventory.name];
    if (!exactKeys(entry, ['name', 'cold', 'required', 'status', 'owner', 'reason'])
        || entry.cold !== inventory.cold || entry.required !== required
        || entry.status !== (required ? 'owned' : 'fail-closed')
        || entry.owner !== expectedOwner || entry.reason !== expectedReason) {
      fail(`port inventory row is invalid: ${inventory.name}`);
    }
  }

  if (assembly.ready !== true
      || !exactArray(assembly.missingRequiredEvents, [])
      || !exactArray(assembly.incompletePorts, [])) {
    fail('readiness or missing-owner projection is invalid');
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
    events: KERNEL_COLD_EVENTS.map((entry) => ({
      key: entry.key,
      placement: entry.placement,
      required: requiredEvents.has(entry.key),
      status: requiredEvents.has(entry.key) ? 'owned' : 'missing',
      owner: requiredEvents.has(entry.key) ? EVENT_OWNERS[entry.key] : null,
    })),
    ports: KERNEL_PORT_CLASSES.map((entry) => ({
      name: entry.name,
      cold: entry.cold,
      required: requiredPorts.has(entry.name),
      status: requiredPorts.has(entry.name) ? 'owned' : 'fail-closed',
      owner: requiredPorts.has(entry.name) ? PORT_OWNERS[entry.name] : null,
      reason: requiredPorts.has(entry.name)
        ? 'reason' in entry ? entry.reason : null
        : CLOSED_PORT_REASONS[entry.name],
    })),
    missingRequiredEvents: [],
    incompletePorts: [],
    ready: true,
  };
};
