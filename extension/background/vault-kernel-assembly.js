// @ts-check
import {
  coldEventKeysFor, coldPortNamesFor, KERNEL_COLD_EVENTS, KERNEL_PORT_CLASSES,
} from './cold-kernel-inventory.js';
import { parseKernelIdentity } from '../shared/kernel-identity.js';

export const SEMANTIC_CUTOVER_SUMMARY = Object.freeze({
  schema: 2, total: 167, kernel: 149, split: 18, migrated: 167,
  unmigrated: 0, executable: 167, unavailable: 0, ready: true,
});

const EVENT_OWNERS = Object.freeze({
  'runtime.onMessage': 'vault-kernel-message-router',
  'runtime.onConnect': 'kernel-port-router',
  'runtime.onInstalled': 'kernel-vault-posture-install',
  'runtime.onUpdateAvailable': 'kernel-lifecycle',
  'storage.session.onChanged': 'kernel-firefox-actor-lifetime',
  'windows.onFocusChanged': 'kernel-front-door',
  'action.onClicked': 'kernel-front-door',
  'commands.onCommand': 'kernel-front-door',
});
// Static owner declarations are inventory, not proof that the live target
// constructed and attached the owner. Callers must provide executable
// readiness; the default report therefore fails closed for every event.
const EVENT_READY = Object.freeze({});
const PORT_OWNERS = Object.freeze({
  sidepanel: 'vault-ui-ports', home: 'vault-ui-ports', eval: 'vault-ui-ports',
  'feature-lease-keepalive': 'kernel-feature-host',
});
const PORT_READY = Object.freeze({});
const CLOSED_PORTS = Object.freeze({
  'private-transfer': 'private-transfer-owner-not-wired',
  'dweb-custody': 'dweb-custody-owner-not-wired',
});

/** @param {unknown} values @param {Set<string>} allowed @param {string} label @param {'owner'|'ready'} kind */
const checked = (values, allowed, label, kind) => {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new TypeError(`${label}-invalid`);
  }
  const entries = Object.entries(values);
  const invalid = kind === 'ready'
    ? entries.some(([key, value]) => !allowed.has(key) || typeof value !== 'boolean')
    : entries.some(([key, value]) => !allowed.has(key) || typeof value !== 'string'
      || value.length < 3 || value.length > 128);
  if (invalid) throw new TypeError(`${label}-invalid`);
  return new Map(entries);
};

/** @param {any} deps */
export const createVaultKernelAssemblyReport = (deps) => {
  const {
    identity, firefox = false, selfHostedChrome = false,
    dweb = selfHostedChrome && !firefox,
    eventOwners = EVENT_OWNERS, eventReadiness = EVENT_READY,
    portOwners = PORT_OWNERS, portReadiness = PORT_READY,
    failClosedPorts = CLOSED_PORTS,
  } = deps;
  const canonicalIdentity = parseKernelIdentity(identity);
  if (!canonicalIdentity) throw new TypeError('vault-kernel-assembly-identity-invalid');
  const eventKeys = new Set(KERNEL_COLD_EVENTS.map(({ key }) => key));
  const portKeys = new Set(KERNEL_PORT_CLASSES.map(({ name }) => name));
  const eventOwnerMap = checked(eventOwners, eventKeys, 'vault-kernel-event-owners', 'owner');
  checked(eventReadiness, eventKeys, 'vault-kernel-event-readiness', 'ready');
  const portOwnerMap = checked(portOwners, portKeys, 'vault-kernel-port-owners', 'owner');
  checked(portReadiness, portKeys, 'vault-kernel-port-readiness', 'ready');
  const closedMap = checked(failClosedPorts, portKeys, 'vault-kernel-fail-closed-ports', 'owner');
  if ([...portOwnerMap.keys()].some((key) => closedMap.has(key))) {
    throw new TypeError('vault-kernel-port-owner-overlap');
  }
  const requiredEvents = new Set(coldEventKeysFor({ firefox, selfHostedChrome }));
  const requiredPorts = new Set(coldPortNamesFor({ firefox, dweb }));
  const events = Object.freeze(KERNEL_COLD_EVENTS.map((entry) => {
    const owner = eventOwnerMap.get(entry.key) ?? null;
    return Object.freeze({
      key: entry.key, placement: entry.placement, required: requiredEvents.has(entry.key),
      status: !owner ? 'missing' : eventReadiness[entry.key] ? 'owned' : 'partial', owner,
    });
  }));
  const ports = Object.freeze(KERNEL_PORT_CLASSES.map((entry) => Object.freeze({
    name: entry.name, cold: entry.cold, required: requiredPorts.has(entry.name),
    status: portOwnerMap.has(entry.name)
      ? portReadiness[entry.name] ? 'owned' : 'partial'
      : closedMap.has(entry.name) ? 'fail-closed' : 'missing',
    owner: portOwnerMap.get(entry.name) ?? null,
    reason: closedMap.get(entry.name) ?? ('reason' in entry ? entry.reason : null),
  })));
  const missingRequiredEvents = events.filter((entry) =>
    entry.required && entry.status !== 'owned').map(({ key }) => key);
  const incompletePorts = ports.filter((entry) =>
    entry.required && entry.status !== 'owned').map(({ name }) => name);
  return Object.freeze({
    identity: canonicalIdentity, target: Object.freeze({ firefox, selfHostedChrome }),
    events, ports,
    counts: Object.freeze({
      eventInventory: events.length, requiredEvents: requiredEvents.size,
      ownedRequiredEvents: requiredEvents.size - missingRequiredEvents.length,
      portInventory: ports.length, requiredPorts: requiredPorts.size,
      ownedRequiredPorts: requiredPorts.size - incompletePorts.length,
    }),
    missingRequiredEvents: Object.freeze(missingRequiredEvents),
    incompletePorts: Object.freeze(incompletePorts),
    cutoverReady: missingRequiredEvents.length === 0 && incompletePorts.length === 0,
  });
};
