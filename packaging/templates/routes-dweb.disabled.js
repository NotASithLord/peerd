// @ts-check
// Package-only dweb route surface for targets without a mesh host.
//
// why retain every route: stale extension pages and internal callers must get
// the same typed, provenance-ordered refusal as the full factory, rather than
// falling through to an unknown message. The package swaps this whole reviewed
// module; Preview Chrome continues to run the authored implementation.

const disabled = async () => ({ ok: false, error: 'dweb-disabled' });

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any, sender?: any) => Promise<any>>}
 */
export const makeDwebRoutes = (deps) => {
  const {
    kv, isOffscreenSender, createDwebRollbackGuard, dwebPublicationGeneration,
  } = deps;
  // Preserve the full factory's pure construction boundary. No admit call can
  // occur in a disabled package, but dependency/setup drift must remain visible.
  createDwebRollbackGuard({ kv });

  /** @param {any} _msg @param {any} sender */
  const offscreenDisabled = async (_msg, sender) => isOffscreenSender?.(sender) === true
    ? { ok: false, error: 'dweb-disabled' }
    : { ok: false, error: 'offscreen-sender-required' };
  /** @param {any} msg @param {any} sender */
  const offscreenCustodyChanged = async (msg, sender) => {
    if (isOffscreenSender?.(sender) !== true) {
      return { ok: false, error: 'offscreen-sender-required' };
    }
    // The full storage callbacks check their exact publication generation
    // before observing the disabled gate. Preserve that collaborator boundary
    // and its thrown-error behavior, even though the result remains fail-closed.
    if (typeof dwebPublicationGeneration === 'function') dwebPublicationGeneration();
    return { ok: false, error: 'dweb-custody-changed' };
  };
  /** @param {any} _msg @param {any} sender */
  const metaDisabled = async (_msg, sender) => isOffscreenSender?.(sender) === true
    ? { ok: false, accepted: false, error: 'dweb-disabled' }
    : { ok: false, accepted: false, error: 'offscreen-sender-required' };

  return {
    'dweb/meta-admit': metaDisabled,
    'dweb/app-snapshot': offscreenDisabled,
    'dweb/audit': disabled,
    'dweb/app-install': offscreenCustodyChanged,
    'dweb/app-update': offscreenCustodyChanged,
    'dweb/app-record-served': offscreenDisabled,
    'dweb/open-commons': disabled,
    'dweb/ensure-seed-app': disabled,
    'dweb/base/start': disabled,
    'dweb/base/stop': disabled,
    'dweb/base/status': disabled,
    'dweb/base/announce': disabled,
    'dweb/base/find': disabled,
    'dweb/base/share-app': disabled,
    'dweb/base/heard': disabled,
    'dweb/base/install': disabled,
    'dweb/base/updates': disabled,
    'dweb/base/update-app': disabled,
    'dweb/base/room': disabled,
    'dweb/distributed/info': disabled,
  };
};
