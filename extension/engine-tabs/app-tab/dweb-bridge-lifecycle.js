// @ts-check
/** @typedef {{ dispose: () => void | Promise<void>, invalidate?: () => void | Promise<void> }} DisposableBridge */
export const createDwebBridgeLifecycle = () => {
  /** @type {DisposableBridge | null} */ let active = null;
  /** @type {Record<'attach'|'dispose'|'invalidate',Promise<void>|null>} */ const pending = { attach: null, dispose: null, invalidate: null };
  let blocked = true, invalidated = false;
  const settle = async (/** @type {boolean} */ invalidate) => {
    await pending.attach; const bridge = active;
    if (invalidate && bridge?.invalidate) await bridge.invalidate(); else await bridge?.dispose();
    if (active === bridge) active = null;
  };
  const dispose = () => {
    blocked = true; if (pending.invalidate) return pending.invalidate;
    return pending.dispose ??= settle(false).finally(() => { pending.dispose = null; });
  };
  return {
    allow() { if (!invalidated) blocked = false; },
    /** @param {() => Promise<DisposableBridge | null>} create */
    attach(create) {
      if (blocked || active) return Promise.resolve();
      return pending.attach ??= (async () => { await pending.dispose;
        if (blocked || active) return;
        const candidate = await create();
        if (candidate && active) await candidate.dispose(); else if (candidate) active = candidate;
      })().finally(() => { pending.attach = null; });
    },
    dispose,
    invalidate() {
      invalidated = blocked = true; return pending.invalidate ??= settle(true).finally(() => { pending.invalidate = null; });
    },
  };
};
