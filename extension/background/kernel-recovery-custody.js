// @ts-check

const RECOVERY_KEYS = Object.freeze([
  'schedule.routines.v1',
  'goal.runs.v1',
]);
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

/** @param {{kv:{get:(key:string)=>Promise<unknown>},alarms:{create:(name:string,info:{when:number})=>Promise<unknown>|unknown},dwebActive:()=>boolean,load:()=>Promise<unknown>,now?:()=>number}} deps */
export const createKernelRecoveryCustody = ({
  kv, alarms, dwebActive, load, now = Date.now,
}) => {
  if (typeof kv?.get !== 'function' || typeof alarms?.create !== 'function'
      || typeof dwebActive !== 'function' || typeof load !== 'function') {
    throw new TypeError('kernel-recovery-custody-config-invalid');
  }
  let failures = 0;
  /** @type {Promise<unknown>|null} */ let active = null;
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
  const resume = () => {
    if (active) return active;
    const attempt = (async () => {
      try {
        const stored = await Promise.all(RECOVERY_KEYS.map((key) => kv.get(key)));
        if (!stored.some(needsRecovery) && !dwebActive()) {
          failures = 0;
          return Object.freeze({ loaded: false });
        }
      } catch {}
      try {
        const result = await load();
        failures = 0;
        return result;
      } catch (cause) {
        failures += 1;
        await retry();
        throw cause;
      }
    })();
    active = attempt;
    void attempt.finally(() => {
      if (active === attempt) active = null;
    }).catch(() => {});
    return attempt;
  };
  return Object.freeze({ resume });
};
