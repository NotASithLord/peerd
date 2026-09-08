// @ts-check

const RECOVERY_KEYS = Object.freeze([
  'schedule.routines.v1',
  'goal.runs.v1',
]);
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

/** @param {{kv:{get:(key:string)=>Promise<unknown>},alarms:{create:(name:string,info:{when:number})=>Promise<unknown>|unknown},dwebActive:()=>boolean,load:(currentSessionId:string|null)=>Promise<unknown>,now?:()=>number}} deps */
export const createKernelRecoveryCustody = ({
  kv, alarms, dwebActive, load, now = Date.now,
}) => {
  if (typeof kv?.get !== 'function' || typeof alarms?.create !== 'function'
      || typeof dwebActive !== 'function' || typeof load !== 'function') {
    throw new TypeError('kernel-recovery-custody-config-invalid');
  }
  let failures = 0;
  /** @type {Promise<unknown>|null} */ let active = null;
  /** @type {string|null} */ let activeSessionId = null;
  const needsRecovery = (/** @type {unknown} */ value) => {
    if (value == null) return false;
    if (typeof value !== 'object' || Array.isArray(value)) return true;
    return Object.keys(value).length > 0;
  };
  const retry = async () => {
    const delay = Math.min(RETRY_MIN_MS * 2 ** Math.min(failures - 1, 4), RETRY_MAX_MS);
    try { await alarms.create('peerd-schedule', { when: now() + delay }); }
    catch {}
  };
  /** @param {string|null|undefined} currentSessionId @returns {Promise<unknown>} */
  const resume = (currentSessionId = null) => {
    const requestedSessionId = typeof currentSessionId === 'string' && currentSessionId
      ? currentSessionId : null;
    if (active) {
      if (!requestedSessionId || activeSessionId === requestedSessionId) return active;
      const prior = active;
      // An interactive unlock must not disappear behind an already-running cold
      // recovery that had no current-session continuation to restore.
      return prior.catch(() => undefined).then(() => {
        if (active === prior) {
          active = null;
          activeSessionId = null;
        }
        return resume(requestedSessionId);
      });
    }
    const attempt = (async () => {
      try {
        const stored = await Promise.all(RECOVERY_KEYS.map((key) => kv.get(key)));
        if (!stored.some(needsRecovery) && !dwebActive() && !requestedSessionId) {
          failures = 0;
          return Object.freeze({ loaded: false });
        }
      } catch {}
      try {
        const result = await load(requestedSessionId);
        failures = 0;
        return result;
      } catch (cause) {
        failures += 1;
        await retry();
        throw cause;
      }
    })();
    active = attempt;
    activeSessionId = requestedSessionId;
    void attempt.finally(() => {
      if (active === attempt) {
        active = null;
        activeSessionId = null;
      }
    }).catch(() => {});
    return attempt;
  };
  return Object.freeze({ resume });
};
