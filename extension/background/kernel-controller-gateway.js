// @ts-check

const stopped = (/** @type {string} */ code, /** @type {boolean} */ known,
  /** @type {'startup'|'run'} */ phase, /** @type {unknown} */ cause = undefined) => Object.freeze({
  ok: false,
  code,
  outcomeKnown: known,
  phase,
  ...(cause === undefined ? {} : {
    error: cause instanceof Error ? cause.message : String(cause),
  }),
});

/**
 * @param {Object} deps
 * @param {(lease?:unknown)=>Promise<{call:(capability:string,payload:unknown,options?:any)=>Promise<any>,close:()=>void}>} deps.connect
 * @param {<T>(operation:(lease?:unknown)=>Promise<T>,options?:any)=>Promise<T>} [deps.withLifetime]
 * @param {boolean} [deps.retireWhenIdle]
 */
export const createKernelControllerGateway = ({
  connect,
  withLifetime = (operation) => operation(),
  retireWhenIdle = false,
}) => {
  if (typeof connect !== 'function' || typeof withLifetime !== 'function') {
    throw new TypeError('kernel-controller-gateway-config-invalid');
  }
  /** @type {any|null} */ let active = null;
  /** @type {Promise<any>|null} */ let connecting = null;
  let generation = 0;
  let users = 0;
  const retire = (/** @type {any} */ client = active) => {
    if (active !== client) return;
    try { client?.close(); } catch {}
    active = null;
  };
  const get = (/** @type {unknown} */ lease) => {
    if (active) return Promise.resolve(active);
    if (!connecting) {
      const expected = generation;
      const pending = Promise.resolve().then(() => connect(lease)).then((client) => {
        if (!client || typeof client.call !== 'function' || typeof client.close !== 'function') {
          throw new TypeError('kernel-controller-client-invalid');
        }
        if (expected !== generation) {
          try { client.close(); } catch {}
          throw new Error('kernel-controller-generation-retired');
        }
        active = client;
        return client;
      }).finally(() => { if (connecting === pending) connecting = null; });
      connecting = pending;
    }
    return connecting;
  };
  const enter = () => { users += 1; };
  const exit = () => {
    users = Math.max(0, users - 1);
    if (users === 0 && retireWhenIdle) retire();
  };
  const call = async (/** @type {string} */ capability, /** @type {unknown} */ payload,
    /** @type {{signal?:AbortSignal,timeoutMs?:number,event?:boolean,lifetime?:any}} */ options = {}) => {
    if (options.event === true && users === 0) {
      return Object.freeze({
        ok: true, outcomeKnown: true, phase: 'startup',
        value: Object.freeze({ accepted: false, inactive: true }),
      });
    }
    try {
      return await withLifetime(async (lease) => {
        enter();
        let client;
        try { client = await get(lease); }
        catch (cause) {
          exit();
          return stopped('controller-startup-failed', true, 'startup', cause);
        }
        try {
          const result = await client.call(capability, payload, options);
          if (result?.outcomeKnown === false) retire(client);
          return result;
        } catch (cause) {
          retire(client);
          return stopped('controller-transport-failed', false, 'run', cause);
        } finally { exit(); }
      }, options.lifetime);
    } catch (cause) {
      generation += 1;
      connecting = null;
      retire();
      return stopped(
        /** @type {{code?:string}} */ (cause)?.code ?? 'controller-lifetime-failed',
        /** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown !== false,
        /** @type {{phase?:'startup'|'run'}} */ (cause)?.phase ?? 'startup',
        cause,
      );
    }
  };
  const withRun = (/** @type {()=>Promise<any>} */ operation,
    /** @type {any} */ lifetime = undefined) => withLifetime(async () => {
    enter();
    try { return await operation(); }
    finally { exit(); }
  }, lifetime);
  return Object.freeze({
    call,
    withRun,
    active: () => active !== null,
    close: () => {
      generation += 1;
      connecting = null;
      retire();
    },
  });
};
