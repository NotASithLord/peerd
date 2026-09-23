// @ts-check
// Drain the App editor before repository work.
// why: Taking the repository lock before flushSave would deadlock.

/** @param {{tracker:{getTabId:(id:string)=>number|null,quiesceTab?:(id:string)=>Promise<boolean>,resumeTab?:(id:string)=>Promise<boolean>,closeTab:(id:string)=>Promise<boolean>,ensureTab:(id:string,opts?:any)=>Promise<number>,reloadTab?:(id:string)=>Promise<boolean>,withDwebAuthority?:<T>(id:string,op:()=>Promise<T>,options?:{invalidate?:boolean,expectedGeneration?:number})=>Promise<T>},withLifecycle:<T>(id:string,op:()=>Promise<T>)=>Promise<T>,afterClose?:()=>Promise<void>}} deps */
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

  /** Caller owns the lifecycle lane. @template T @param {string} appId @param {()=>Promise<T>} operation
   * @param {{close?:boolean,invalidateDweb?:boolean,expectedDwebGeneration?:number}} [options] @returns {Promise<T>} */
  const runUnlocked = async (appId, operation, { close = false, invalidateDweb = false, expectedDwebGeneration } = {}) => {
    const trackedLive = tracker.getTabId(appId) != null;
    let live = trackedLive;
    if (typeof tracker.quiesceTab === 'function') {
      live = await tracker.quiesceTab(appId);
      if (trackedLive && !live) throw new Error('App editor disappeared before its pending save completed');
    }
    else if (live) throw new Error('App editor quiesce is unavailable');

    let closed = false;
    try {
      const execute = async () => {
        if (close && live) {
          closed = await tracker.closeTab(appId);
          if (!closed) throw new Error('App tab could not close after its editor was flushed');
          await afterClose();
        }
        return operation();
      };
      return await (invalidateDweb && tracker.withDwebAuthority
        ? tracker.withDwebAuthority(appId, execute, { invalidate: true, expectedGeneration: expectedDwebGeneration })
        : execute());
    } finally {
      if (closed) {
        tracker.ensureTab(appId, { active: false, groupTitle: 'peerd' }).catch(() => {});
      } else {
        await resumeOrReload(appId);
      }
    }
  };

  /** @template T @param {string} appId @param {()=>Promise<T>} operation
   * @param {{close?:boolean,invalidateDweb?:boolean,expectedDwebGeneration?:number}} [options] @returns {Promise<T>} */
  const run = (appId, operation, options) => withLifecycle(
    appId,
    () => runUnlocked(appId, operation, options),
  );

  return { run, runUnlocked };
};
