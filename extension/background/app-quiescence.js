// @ts-check
// Drain a live App editor before any repository snapshot or mutation. The
// lifecycle lane is deliberately outside the editor flush: flushSave writes
// through the repository coordinator itself, so taking that lock first would
// deadlock on the pending save we are trying to preserve.

/**
 * @param {Object} deps
 * @param {{
 *   getTabId: (appId:string)=>number|null,
 *   quiesceTab?: (appId:string)=>Promise<boolean>,
 *   resumeTab?: (appId:string)=>Promise<boolean>,
 *   closeTab: (appId:string)=>Promise<boolean>,
 *   ensureTab: (appId:string, opts?:any)=>Promise<number>,
 *   reloadTab?: (appId:string)=>Promise<boolean>,
 * }} deps.tracker
 * @param {<T>(appId:string, operation:()=>Promise<T>)=>Promise<T>} deps.withLifecycle
 * @param {()=>Promise<void>} [deps.afterClose]
 */
export const createAppQuiescence = ({
  tracker,
  withLifecycle,
  afterClose = () => new Promise((resolve) => setTimeout(resolve, 100)),
}) => {
  const resumeOrReload = async (/** @type {string} */ appId) => {
    try {
      if (await tracker.resumeTab?.(appId)) return;
    } catch { /* a reload below is the recovery path */ }
    await tracker.reloadTab?.(appId).catch(() => {});
  };

  /**
   * Run while a live editor is frozen and its pending save has completed.
   * Call this form only when the caller already owns the App lifecycle lane.
   *
   * @template T
   * @param {string} appId
   * @param {()=>Promise<T>} operation
   * @param {{close?:boolean}} [options]
   * @returns {Promise<T>}
   */
  const runUnlocked = async (appId, operation, { close = false } = {}) => {
    const live = tracker.getTabId(appId) != null;
    if (!live) return operation();
    if (typeof tracker.quiesceTab !== 'function') {
      throw new Error('App editor quiesce is unavailable');
    }
    if (await tracker.quiesceTab(appId) !== true) {
      throw new Error('App editor disappeared before its pending save completed');
    }

    let closed = false;
    try {
      if (close) {
        closed = await tracker.closeTab(appId);
        if (!closed) throw new Error('App tab could not close after its editor was flushed');
        await afterClose();
      }
      return await operation();
    } finally {
      if (closed) {
        tracker.ensureTab(appId, { active: false, groupTitle: 'peerd' }).catch(() => {});
      } else {
        await resumeOrReload(appId);
      }
    }
  };

  /**
   * Serialize quiesce/freeze, the protected operation, and release/reopen as one
   * App lifecycle transaction. Repository coordination belongs inside
   * `operation`, after the editor flush.
   *
   * @template T
   * @param {string} appId
   * @param {()=>Promise<T>} operation
   * @param {{close?:boolean}} [options]
   * @returns {Promise<T>}
   */
  const run = (appId, operation, options) => withLifecycle(
    appId,
    () => runUnlocked(appId, operation, options),
  );

  return { run, runUnlocked };
};
