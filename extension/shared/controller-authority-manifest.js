// @ts-check

import {
  TOOL_EXECUTION_PROTOCOL,
  compileToolEffectManifest,
} from './tool-execution-protocol.js';

// why: authority budgets are keyed by stable capability class, never by the
// growing semantic tool catalog. A new controller tool composes one of these
// existing classes without changing the service-worker authority graph.
const authorityManifestSource = {
  protocol: TOOL_EXECUTION_PROTOCOL,
  digest: '5fd19cb4619a708d78e69020c499378d5445c1f5a278fe6a1a62a35a67ba9bbb',
  tools: {
    local: {
      projectionKeys: [], effects: [], argumentBytes: 256 * 1024,
      resultBytes: 2 * 1024 * 1024,
    },
    actor: {
      projectionKeys: ['sessionId', 'sessionDepth', 'sessionKind', 'inbound'],
      effects: [], argumentBytes: 1024 * 1024, resultBytes: 2 * 1024 * 1024,
    },
    pod: {
      projectionKeys: ['sessionId'], effects: [], argumentBytes: 1024 * 1024,
      resultBytes: 2 * 1024 * 1024,
    },
    repository: {
      projectionKeys: ['sessionId', 'actorType', 'actorInstanceId'], effects: [],
      argumentBytes: 1024 * 1024, resultBytes: 2 * 1024 * 1024,
    },
    vm: {
      projectionKeys: ['sessionId'], effects: [], argumentBytes: 1024 * 1024,
      resultBytes: 2 * 1024 * 1024,
    },
    notebook: {
      projectionKeys: ['sessionId'], effects: [], argumentBytes: 1024 * 1024,
      resultBytes: 2 * 1024 * 1024,
    },
    app: {
      projectionKeys: ['sessionId', 'actorInstanceId'], effects: [],
      argumentBytes: 2 * 1024 * 1024, resultBytes: 2 * 1024 * 1024,
    },
    persistence: {
      projectionKeys: ['sessionId', 'activeTabOrigin', 'goalActive'], effects: [],
      argumentBytes: 1024 * 1024, resultBytes: 2 * 1024 * 1024,
    },
    page: {
      projectionKeys: ['sessionId'], effects: [], argumentBytes: 1024 * 1024,
      resultBytes: 8 * 1024 * 1024,
    },
    introspection: {
      projectionKeys: ['sessionId', 'messageCount', 'trimCovered'], effects: [],
      argumentBytes: 256 * 1024, resultBytes: 2 * 1024 * 1024,
    },
    schedule: {
      projectionKeys: ['sessionId'], effects: [], argumentBytes: 64 * 1024,
      resultBytes: 2 * 1024 * 1024,
    },
    dweb: {
      projectionKeys: ['sessionId', 'dwebAvailable'], effects: [],
      argumentBytes: 256 * 1024, resultBytes: 2 * 1024 * 1024,
    },
  },
};

export const CONTROLLER_AUTHORITY_MANIFEST = compileToolEffectManifest(
  authorityManifestSource,
);

export const controllerAuthorityClassAllowed = (/** @type {unknown} */ value) =>
  typeof value === 'string'
  && Object.hasOwn(CONTROLLER_AUTHORITY_MANIFEST.tools, value);
