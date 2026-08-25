// @ts-check

import { executeNow } from '/peerd-runtime/controller-tools.js';
import { CONTROLLER_TOOL_MANIFEST } from '/shared/controller-tool-manifest.js';
import { createToolExecutionHost } from './tool-execution-host.js';

const host = createToolExecutionHost({
  manifest: CONTROLLER_TOOL_MANIFEST,
  implementations: Object.freeze({ now: () => executeNow() }),
});

export const executeControllerToolCall = host.dispatch;
