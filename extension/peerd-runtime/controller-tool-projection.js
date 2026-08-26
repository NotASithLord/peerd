// @ts-check

// Model-facing inventory and exposure policy are controller semantics. The
// authority host receives only the structured-clone-safe policy fields needed
// to admit a model-issued call; prose, schemas and catalog construction never
// enter its module graph.
import { listToolPolicies } from './tools/metadata/policy.js';
import { projectToolAuthority, toToolDescriptor } from './tools/metadata/descriptor.js';
import {
  actorDescriptors,
  filterActorSurface,
  filterByDwebActive,
  filterByDwebEnabled,
  filterByGoalActive,
  mainAgentDescriptors,
} from './tools/exposure.js';
import {
  filterDescriptorsByManifest,
  resolveManifestAllow,
} from './tools/manifests.js';
import { filterByActorIsolation } from './actor/isolation.js';
import { DWEB_INBOUND_TOOL_NAMES } from './actor/capability-manifest.js';
import { filterByRuntimeCapabilities } from './runtime-capabilities.js';

const descriptors = Object.freeze(listToolPolicies().map(toToolDescriptor));

/** @param {unknown} value */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string,any>} */ (value) : null;
const exactKeys = (/** @type {Record<string,any>} */ value, /** @type {string[]} */ allowed) => {
  const names = Object.keys(value);
  return names.length <= allowed.length && names.every((name) => allowed.includes(name));
};

const validInput = (/** @type {Record<string,any>} */ input) => {
  if (input.surface === 'all') return exactKeys(input, ['surface']);
  if (input.surface === 'main') {
    return exactKeys(input, [
      'surface', 'toolManifest', 'dwebEnabled', 'dwebEngaged', 'goalActive',
      'actorIsolation', 'runtimeCapabilities',
    ])
      && [input.dwebEnabled, input.dwebEngaged, input.goalActive]
        .every((value) => typeof value === 'boolean');
  }
  if (input.surface === 'actor') {
    return exactKeys(input, [
      'surface', 'actorType', 'backing', 'actorSurface', 'toolManifest',
      'runtimeCapabilities', 'inbound',
    ])
      && typeof input.actorType === 'string' && input.actorType.length <= 32
      && (input.inbound === undefined || typeof input.inbound === 'boolean');
  }
  return false;
};

/**
 * @param {unknown} value
 * @returns {{ok:true,tools:ReadonlyArray<Record<string,unknown>>}|{ok:false,code:string,outcomeKnown:true}}
 */
export const projectControllerToolSurface = (value) => {
  const input = record(value);
  if (!input || !validInput(input)) {
    return { ok: false, code: 'turn-tool-projection-invalid', outcomeKnown: true };
  }
  let projected;
  if (input.surface === 'all') {
    projected = descriptors;
  } else if (input.surface === 'actor') {
    const actorType = typeof input.actorType === 'string' ? input.actorType : '';
    const backing = input.backing === 'api' ? 'api' : input.backing === 'tab' ? 'tab' : undefined;
    const actorSurface = input.actorSurface === 'code' || input.actorSurface === 'tools'
      ? input.actorSurface : undefined;
    projected = filterByRuntimeCapabilities(filterDescriptorsByManifest(
      actorDescriptors(descriptors, actorType, backing, actorSurface),
      resolveManifestAllow(input.toolManifest),
    ), input.runtimeCapabilities);
    if (input.inbound === true && actorType === 'dweb') {
      const inbound = new Set(DWEB_INBOUND_TOOL_NAMES);
      projected = projected.filter((tool) => inbound.has(tool.name));
    }
  } else {
    projected = filterActorSurface(filterByGoalActive(filterByDwebActive(
      filterByDwebEnabled(filterDescriptorsByManifest(
        mainAgentDescriptors(descriptors), resolveManifestAllow(input.toolManifest),
      ), input.dwebEnabled === true), input.dwebEngaged === true,
    ), input.goalActive === true));
    if (record(input.actorIsolation)) {
      projected = filterByActorIsolation(projected, /** @type {any} */ (input.actorIsolation));
    }
    projected = filterByRuntimeCapabilities(projected, input.runtimeCapabilities);
  }
  return { ok: true, tools: Object.freeze(projected.map(projectToolAuthority)) };
};
