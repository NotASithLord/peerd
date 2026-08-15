// @ts-check

/**
 * Keep dweb boot effects behind persisted settings hydration.
 *
 * @param {{
 *   ready: Promise<unknown> | (() => Promise<unknown>),
 *   available: boolean,
 *   active: () => boolean,
 * }} deps
 */
export const createDwebSettingsGate = ({ ready, available, active }) => {
  const awaitReady = () => typeof ready === 'function' ? ready() : ready;
  /**
   * @param {() => boolean} condition
   * @param {() => unknown | Promise<unknown>} effect
   */
  const runWhen = async (condition, effect) => {
    await awaitReady();
    if (!available || !condition()) return false;
    await effect();
    return true;
  };

  return Object.freeze({
    /** @param {() => unknown | Promise<unknown>} start */
    startWhenEnabled: (start) => runWhen(active, start),
    /** @param {() => unknown | Promise<unknown>} stop */
    stopWhenDisabled: (stop) => runWhen(() => !active(), stop),
  });
};
