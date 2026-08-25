// @ts-check

import { executeNow } from './clock/execute.js';

export const CONTROLLER_TOOL_IMPLEMENTATIONS = Object.freeze({
  now: () => executeNow(),
});
