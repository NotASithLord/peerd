// @ts-check

import { CONTROLLER_TOOL_IMPLEMENTATIONS } from '/peerd-runtime/controller-tools.js';
import { CONTROLLER_EFFECT_TOOL_MANIFEST } from '/shared/controller-tool-manifest.js';
import { createToolExecutionHost } from './tool-execution-host.js';

const host = createToolExecutionHost({
  manifest: CONTROLLER_EFFECT_TOOL_MANIFEST,
  implementations: CONTROLLER_TOOL_IMPLEMENTATIONS,
});

export const executeControllerToolCall = host.dispatch;
