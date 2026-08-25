// @ts-check

import {
  TOOL_EXECUTION_PROTOCOL,
  compileToolEffectManifest,
} from './tool-execution-protocol.js';

export const CONTROLLER_TOOL_MANIFEST = compileToolEffectManifest({
  protocol: TOOL_EXECUTION_PROTOCOL,
  digest: 'bb92c44598ca5357ee17b747bc9d63c4b5668df43d89dea1de1d622bab7d47e4',
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
