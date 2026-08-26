// @ts-check

import {
  TOOL_EXECUTION_PROTOCOL,
  compileToolEffectManifest,
} from './tool-execution-protocol.js';

const SANDBOX_EFFECT_REQUEST_SCHEMA = {
  type: 'object',
  properties: { json: { type: 'string', maxLength: 64 * 1024 * 1024 } },
  required: ['json'],
};
const SANDBOX_EFFECT_RESULT_SCHEMA = {
  type: 'object',
  properties: { json: { type: 'string', maxLength: 4 * 1024 * 1024 } },
  required: ['json'],
};
const sandboxEffect = (/** @type {string} */ method, /** @type {string} */ operation,
  /** @type {'control'|'commit'|'resource'} */ riskClass, /** @type {number} */ maxCalls = 1) => ({
  method, operation, riskClass, maxCalls,
  requestSchema: SANDBOX_EFFECT_REQUEST_SCHEMA,
  resultSchema: SANDBOX_EFFECT_RESULT_SCHEMA,
  requestBytes: 64 * 1024 * 1024,
  resultBytes: 4 * 1024 * 1024,
});

export const CONTROLLER_TOOL_MANIFEST = compileToolEffectManifest({
  protocol: TOOL_EXECUTION_PROTOCOL,
  digest: '62b902eac7b1c6ce8f5e650552daadd0f0df4f8c4bd24dac7db68f5d9ab22f08',
  tools: {
    now: {
      projectionKeys: [],
      effects: [],
      argumentBytes: 64,
      projectionBytes: 64,
      resultBytes: 4 * 1024,
      pendingEffects: 1,
    },
    complete_goal: {
      projectionKeys: [],
      effects: [{
        method: 'endGoal', operation: 'goal.end', riskClass: 'control',
        requestSchema: {
          type: 'object', properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
        resultSchema: {
          type: 'object', properties: { ended: { type: 'boolean' } }, required: ['ended'],
        },
      }],
    },
    sandbox_create: {
      projectionKeys: ['sessionId', 'dwebEnabled'],
      argumentBytes: 64 * 1024 * 1024,
      projectionBytes: 4 * 1024,
      resultBytes: 4 * 1024 * 1024,
      pendingEffects: 1,
      effects: [
        sandboxEffect('mutateRecord', 'sandbox.record.mutate', 'resource', 2),
        sandboxEffect('ensureTab', 'sandbox.tab.ensure', 'resource'),
        sandboxEffect('mutateRepository', 'sandbox.repository.mutate', 'resource', 2),
        sandboxEffect('persistApp', 'sandbox.app.persist', 'resource'),
        sandboxEffect('openApp', 'sandbox.app.open', 'resource'),
        sandboxEffect('confirmGitClone', 'sandbox.git.confirm', 'control'),
      ],
    },
  },
});

export const controllerHostsTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(CONTROLLER_TOOL_MANIFEST.tools, name);
