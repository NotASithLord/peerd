// @ts-check

// Model-facing inventory and exposure policy are controller semantics. The
// authority host receives only the structured-clone-safe policy fields needed
// to admit a model-issued call; prose, schemas and catalog construction never
// enter its module graph.
import { listToolAuthorities } from './tools/metadata/authority.js';
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
import {
  DWEB_INBOUND_TOOL_NAMES,
  resolveWebActorSurfaceDecision,
} from './actor/capability-manifest.js';
import { filterByRuntimeCapabilities } from './runtime-capabilities.js';
import { controllerOperationsForTools } from './controller-tool-ownership.js';
import {
  APP_PROGRAM_SEMANTIC_TOOL_NAMES,
  PAGE_PROGRAM_SEMANTIC_TOOL_NAMES,
} from '../shared/page-program-authority.js';

const descriptors = Object.freeze(listToolAuthorities().map(toToolDescriptor));

/** @param {unknown} value */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string,any>} */ (value) : null;
const exactKeys = (/** @type {Record<string,any>} */ value, /** @type {string[]} */ allowed) => {
  const names = Object.keys(value);
  return names.length <= allowed.length && names.every((name) => allowed.includes(name));
};

const validInput = (/** @type {Record<string,any>} */ input) => {
  if (input.surface === 'all') return exactKeys(input, ['surface']);
  if (input.surface === 'page-program') return exactKeys(input, ['surface']);
  if (input.surface === 'app-program') return exactKeys(input, ['surface']);
  if (input.surface === 'selection') {
    return exactKeys(input, ['surface', 'toolNames'])
      && Array.isArray(input.toolNames) && input.toolNames.length <= 256
      && input.toolNames.every((name) => typeof name === 'string' && name.length <= 128);
  }
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
      'requestedActorSurface', 'headlessAvailable', 'runtimeCapabilities', 'inbound',
    ])
      && typeof input.actorType === 'string' && input.actorType.length <= 32
      && (input.requestedActorSurface === undefined
        || input.requestedActorSurface === 'tools' || input.requestedActorSurface === 'code')
      && (input.headlessAvailable === undefined || typeof input.headlessAvailable === 'boolean')
      && (input.inbound === undefined || typeof input.inbound === 'boolean');
  }
  return false;
};

/**
 * @param {unknown} value
 * @returns {{ok:true,tools:ReadonlyArray<Record<string,unknown>>,operations:ReadonlyArray<string>}|{ok:false,code:string,outcomeKnown:true}}
 */
export const projectControllerToolSurface = (value) => {
  const input = record(value);
  if (!input || !validInput(input)) {
    return { ok: false, code: 'turn-tool-projection-invalid', outcomeKnown: true };
  }
  let projected;
  /** @type {{requested:'tools'|'code',resolved:'tools'|'code',fallback:string}|null} */
  let actorSurfaceDecision = null;
  if (input.surface === 'all') {
    projected = descriptors;
  } else if (input.surface === 'page-program') {
    const names = new Set(PAGE_PROGRAM_SEMANTIC_TOOL_NAMES);
    projected = descriptors.filter((tool) => names.has(tool.name));
    if (projected.length !== names.size) {
      return { ok: false, code: 'turn-page-program-projection-incomplete', outcomeKnown: true };
    }
  } else if (input.surface === 'app-program') {
    const names = new Set(APP_PROGRAM_SEMANTIC_TOOL_NAMES);
    projected = descriptors.filter((tool) => names.has(tool.name));
    if (projected.length !== names.size) {
      return { ok: false, code: 'turn-app-program-projection-incomplete', outcomeKnown: true };
    }
  } else if (input.surface === 'selection') {
    const names = new Set(input.toolNames);
    projected = descriptors.filter((tool) => names.has(tool.name));
    if (projected.length !== names.size) {
      return { ok: false, code: 'turn-tool-selection-unknown', outcomeKnown: true };
    }
  } else if (input.surface === 'actor') {
    const actorType = typeof input.actorType === 'string' ? input.actorType : '';
    const backing = input.backing === 'api' ? 'api' : input.backing === 'tab' ? 'tab' : undefined;
    let actorSurface = input.actorSurface === 'code' || input.actorSurface === 'tools'
      ? input.actorSurface : undefined;
    const knownNonWebBacking = actorType !== 'web' && input.backing === actorType;
    const unknownBacking = Object.hasOwn(input, 'backing')
      && input.backing !== undefined && !['api', 'tab'].includes(input.backing)
      && !knownNonWebBacking;
    const unknownActorSurface = Object.hasOwn(input, 'actorSurface')
      && input.actorSurface !== undefined && !['code', 'tools'].includes(input.actorSurface);
    if (!unknownBacking && !unknownActorSurface && actorType === 'web' && backing !== 'api'
        && input.requestedActorSurface !== undefined) {
      actorSurfaceDecision = resolveWebActorSurfaceDecision({
        requested: input.requestedActorSurface,
        allowedTools: resolveManifestAllow(input.toolManifest),
        headlessAvailable: input.headlessAvailable === true,
      });
      actorSurface = actorSurfaceDecision.resolved;
    }
    projected = unknownBacking || unknownActorSurface ? []
      : filterByRuntimeCapabilities(filterDescriptorsByManifest(
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
  const tools = Object.freeze(projected.map(projectToolAuthority));
  return {
    ok: true,
    tools,
    // why: actor least authority is projected beside exposure in the sealed
    // semantic realm. The host receives only a name-free exact-operation set.
    operations: controllerOperationsForTools(tools.map((tool) => tool.name)),
    ...(actorSurfaceDecision ? {
      actorSurface: actorSurfaceDecision.resolved,
      actorSurfaceFallback: actorSurfaceDecision.fallback,
    } : {}),
  };
};
