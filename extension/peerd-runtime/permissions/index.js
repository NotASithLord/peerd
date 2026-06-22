// @ts-check
// peerd-runtime/permissions — public surface for the Plan/Act +
// confirm-actions permission policy (Feature 03). Re-exported through
// peerd-runtime's top-level index.js so the SW and other features import
// it as
//   import { decideAction, PERMISSION_MODES } from 'peerd-runtime';

export {
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_CONFIRM_ACTIONS,
  ACTION_CLASSES,
  classifyAction,
  decideAction,
  normalizeMode,
  normalizeConfirmActions,
  confirmActionsFromRecord,
} from './policy.js';
