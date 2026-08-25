// @ts-check

import {
  TOOL_EXECUTION_PROTOCOL,
  compileToolEffectManifest,
} from './tool-execution-protocol.js';

export const CONTROLLER_TOOL_MANIFEST = compileToolEffectManifest({
  protocol: TOOL_EXECUTION_PROTOCOL,
  digest: 'ae34d2d90539d067cb5afa4ac0ff317dcabea4a912779fef23a665c694e7c604',
  tools: {
    now: {
      projectionKeys: [],
      effects: [],
      argumentBytes: 64,
      projectionBytes: 64,
      resultBytes: 4 * 1024,
      pendingEffects: 1,
    },
  },
});

export const controllerHostsTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(CONTROLLER_TOOL_MANIFEST.tools, name);
