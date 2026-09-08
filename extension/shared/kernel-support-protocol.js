// @ts-check

export { KERNEL_SESSION_SUPPORT_ROUTE_NAMES } from './kernel-feature-route-inventory.js';

export const KERNEL_SUPPORT_EFFECTS_BY_ROUTE = Object.freeze({
  'session/list': Object.freeze(['support.sessions.list']),
  'session/get': Object.freeze(['support.session.read']),
  'session/contextSnapshots': Object.freeze(['support.session.context-snapshots']),
  'session/setModel': Object.freeze(['support.session.model.commit']),
  'permission/set': Object.freeze(['support.permission.commit']),
});

export const canonicalKernelSessionId = (/** @type {unknown} */ value) =>
  typeof value === 'string' && value.length > 0 ? value : null;

export const canonicalKernelSessionModel = (/** @type {unknown} */ value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().slice(0, 200);
};

export const kernelPermissionPatch = (/** @type {Record<string,any>} */ message) => {
  const patch = /** @type {Record<string,'plan'|'act'|boolean>} */ ({});
  if (message.mode !== undefined) {
    patch.permissionMode = message.mode === 'act' || message.mode === 'plan'
      ? message.mode : 'plan';
  }
  if (message.confirmActions !== undefined) patch.confirmActions = message.confirmActions !== false;
  return patch;
};
