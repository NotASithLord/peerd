// @ts-check
import {
  coldEventKeysFor, coldPortNamesFor, KERNEL_COLD_EVENTS, KERNEL_PORT_CLASSES,
} from './cold-kernel-inventory.js';
import { parseKernelIdentity } from '../shared/kernel-identity.js';

/** @param {unknown} values @param {Set<string>} allowed @param {string} label */
const checkedOwners = (values, allowed, label) => {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new TypeError(`${label}-invalid`);
  }
  const entries = Object.entries(values);
  const invalid = entries.some(([key, value]) => !allowed.has(key)
    || typeof value !== 'string' || value.length < 3 || value.length > 128);
  if (invalid) throw new TypeError(`${label}-invalid`);
  return new Map(entries);
};

/** @param {any} deps */
export const createVaultKernelAssemblyReport = (deps) => {
  const {
    identity, firefox = false, selfHostedChrome = false,
    dweb = selfHostedChrome && !firefox,
    eventOwners = {}, portOwners = {}, failClosedPorts = {},
  } = deps;
  const canonicalIdentity = parseKernelIdentity(identity);
  if (!canonicalIdentity) throw new TypeError('vault-kernel-assembly-identity-invalid');
  const eventKeys = new Set(KERNEL_COLD_EVENTS.map(({ key }) => key));
  const portKeys = new Set(KERNEL_PORT_CLASSES.map(({ name }) => name));
  const eventOwnerMap = checkedOwners(eventOwners, eventKeys, 'vault-kernel-event-owners');
  const portOwnerMap = checkedOwners(portOwners, portKeys, 'vault-kernel-port-owners');
  const closedMap = checkedOwners(failClosedPorts, portKeys, 'vault-kernel-fail-closed-ports');
  if ([...portOwnerMap.keys()].some((key) => closedMap.has(key))) {
    throw new TypeError('vault-kernel-port-owner-overlap');
  }
  const requiredEvents = new Set(coldEventKeysFor({ firefox, selfHostedChrome }));
  const requiredPorts = new Set(coldPortNamesFor({ firefox, dweb }));
  const events = Object.freeze(KERNEL_COLD_EVENTS.map((entry) => {
    const owner = eventOwnerMap.get(entry.key) ?? null;
    return Object.freeze({
      key: entry.key, placement: entry.placement, required: requiredEvents.has(entry.key),
      status: owner ? 'owned' : 'missing', owner,
    });
  }));
  const ports = Object.freeze(KERNEL_PORT_CLASSES.map((entry) => Object.freeze({
    name: entry.name, cold: entry.cold, required: requiredPorts.has(entry.name),
    status: portOwnerMap.has(entry.name)
      ? 'owned' : closedMap.has(entry.name) ? 'fail-closed' : 'missing',
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
    missingRequiredEvents: Object.freeze(missingRequiredEvents),
    incompletePorts: Object.freeze(incompletePorts),
    ready: missingRequiredEvents.length === 0 && incompletePorts.length === 0,
  });
};
