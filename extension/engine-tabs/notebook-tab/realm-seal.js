// @ts-check
// why: The seal must run before any imported user code.
// This module is the worker's first static import. Chrome evaluates it first.
// Firefox's linker keeps the same order. Keep the seal call before other code.
// The worker entry runs after its imports. It cannot seal their execution.

import { applyNotebookRealmSeal, captureWorkerConsole } from './notebook-neutralizers.js';

try {
  applyNotebookRealmSeal(globalThis);
} catch (error) {
  // why report before rethrow: Firefox strips detail from Worker error
  // events. This trusted pre-user-code message keeps a seal regression
  // actionable without letting the run continue in an unsealed realm.
  postMessage({
    type: 'seal-failed',
    error: /** @type {{ stack?: string, message?: string }} */ (error)?.stack
      || /** @type {{ message?: string }} */ (error)?.message
      || String(error),
  });
  throw error;
}

// why: Static imports run before the worker entry can capture their output.
export const consoleOutput = captureWorkerConsole();
