// @ts-check
// Hooks — the lifecycle hook system's internal barrel.
//
// This is re-exported from peerd-runtime/index.js as the module's public
// surface. Features like plan/act and others register hooks
// through registerHook(); the dispatcher runs them through
// runPreToolUse / runPostToolUse.

export {
  runPreToolUse,
  runPostToolUse,
  selectHooks,
  hookMatches,
} from './runner.js';

export {
  registerHook,
  listHooks,
  exportHooks,
  loadUserHooks,
  saveUserHook,
  removeHook,
  clearUserHooks,
  _clearAllHooks,
  HOOKS_STORAGE_KEY,
} from './registry.js';

export {
  compileUserHook,
  parseHookMarkdown,
} from './compile.js';

export { DEFAULT_HOOKS, egressAllowlistHook } from './defaults/index.js';
