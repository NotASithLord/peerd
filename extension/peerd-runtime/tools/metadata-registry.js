// @ts-check

// Controller-owned inert inventory. Execution registration is intentionally a
// separate module so importing the authority policy shell cannot pull this growing
// model-facing policy catalog into the service worker.
import { listToolPolicies } from './metadata/policy.js';
import {
  getToolDescriptor as getExecutionToolDescriptor,
  listToolDescriptors as listExecutionToolDescriptors,
} from './registry.js';
import {
  resolveDescriptorOrigins,
  retryClassForDescriptor,
  toToolDescriptor,
} from './metadata/descriptor.js';

/** @type {Map<string, ReturnType<typeof toToolDescriptor>>} */
const metadataDescriptors = new Map();

export const registerMetadataInventory = (inventory = listToolPolicies()) => {
  if (!Array.isArray(inventory)) throw new TypeError('metadata inventory must be an array');
  const next = new Map();
  for (const metadata of inventory) {
    const descriptor = toToolDescriptor(metadata);
    if (next.has(descriptor.name)) {
      throw new TypeError(`duplicate tool metadata: ${descriptor.name}`);
    }
    next.set(descriptor.name, descriptor);
  }
  metadataDescriptors.clear();
  for (const [name, descriptor] of next) metadataDescriptors.set(name, descriptor);
  return metadataDescriptors.size;
};

/** @param {string} name */
export const getToolDescriptor = (name) =>
  getExecutionToolDescriptor(name) ?? metadataDescriptors.get(name);

export const listToolDescriptors = () => {
  const execution = listExecutionToolDescriptors();
  const byName = new Map(execution.map((descriptor) => [descriptor.name, descriptor]));
  return [
    ...[...metadataDescriptors].map(([name, descriptor]) => byName.get(name) ?? descriptor),
    ...execution.filter((descriptor) => !metadataDescriptors.has(descriptor.name)),
  ];
};

/** @param {string} name @param {any} args @param {any} ctx */
export const resolveRegisteredToolOrigins = (name, args, ctx) => {
  const descriptor = getToolDescriptor(name);
  return descriptor ? resolveDescriptorOrigins(descriptor, args, ctx) : [];
};

/** @param {string} name */
export const retryClassForRegisteredTool = (name) =>
  retryClassForDescriptor(getToolDescriptor(name));
