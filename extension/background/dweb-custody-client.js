// @ts-check
export class DwebCustodyPortError extends Error {
  /** @param {string} message @param {string} code @param {{cause?:unknown,outcomeKnown?:boolean}} [options] */
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = 'DwebCustodyPortError';
    this.code = code;
    this.outcomeKnown = options.outcomeKnown !== false;
  }
}

/** @param {{enabled:boolean,hostAvailable:boolean,reset:()=>Promise<void>}} deps */
export const makeRetryableCustodyReset = ({ enabled, hostAvailable, reset }) => {
  let complete = false;
  /** @type {Promise<void>|null} */
  let inFlight = null;
  const ensure = async () => {
    if (!enabled || !hostAvailable || complete) return;
    if (!inFlight) {
      inFlight = Promise.resolve().then(reset)
        .then(() => { complete = true; })
        .finally(() => { inFlight = null; });
    }
    await inFlight;
  };
  return { ensure };
};

const safeId = (/** @type {unknown} */ value) => typeof value === 'string'
  && value.length >= 3 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/.test(value);
/** @param {string} code @param {boolean} [outcomeKnown] @param {unknown} [cause] */
const failure = (code, outcomeKnown = true, cause) => new DwebCustodyPortError(
  code, code, { cause, outcomeKnown },
);

/** @param {any} deps */
export const makeDwebCustodyClient = ({
  ensureOffscreen, handleSecretRequest, timeoutMs = 60_000,
  newRequestId = () => crypto.randomUUID(),
}) => {
  /** @type {any} */
  let activePort = null;
  const waiters = new Set();
  const pending = new Map();
  const unknown = new Map();

  /** @param {any} entry */
  const remember = (entry) => unknown.set(entry.operationId, {
    operationId: entry.operationId, operation: entry.operation,
    args: entry.args,
  });

  /** @param {any} port @param {string} code @param {boolean} [disconnect] */
  const lose = (port, code, disconnect = false) => {
    if (activePort === port) activePort = null;
    for (const [requestId, entry] of pending) {
      if (entry.port !== port) continue;
      pending.delete(requestId);
      clearTimeout(entry.timer);
      remember(entry);
      entry.reject(failure(code, false));
    }
    if (disconnect) { try { port.disconnect(); } catch { /* already closed */ } }
  };

  /** @param {any} next */
  const attach = (next) => {
    if (activePort && activePort !== next) {
      lose(activePort, 'port-replaced', true);
    }
    activePort = next;
    for (const resolve of waiters) resolve();
    waiters.clear();
    next.onMessage.addListener((/** @type {any} */ message) => {
      if (activePort !== next) return; // late result from a poisoned Port
      if (message?.type === 'custody/response'
          && safeId(message.requestId) && safeId(message.operationId)
          && safeId(message.authorityId)) {
        const entry = pending.get(message.requestId);
        if (!entry || entry.port !== next || entry.operationId !== message.operationId) return;
        pending.delete(message.requestId);
        clearTimeout(entry.timer);
        unknown.delete(entry.operationId);
        try { next.postMessage({ type: 'custody/ack', operationId: entry.operationId }); }
        catch { /* result is already known */ }
        if (message.ok) entry.resolve(message.result);
        else entry.reject(failure(
          typeof message.error === 'string' ? message.error : 'host-failed',
        ));
        return;
      }
      if (message?.type !== 'custody/secret-request'
          || !safeId(message.requestId)
          || !['get', 'set', 'self-get', 'self-set'].includes(message.operation)) return;
      /** @param {boolean} ok @param {any} value */
      const reply = (ok, value) => {
        if (activePort !== next) return;
        try { next.postMessage({
          type: 'custody/secret-response', requestId: message.requestId, ok,
          ...(ok ? { result: value } : { error: value }),
        }); } catch { /* disconnect owns retry */ }
      };
      Promise.resolve(handleSecretRequest(message.operation, message.args ?? {})).then(
        (result) => reply(true, result),
        (cause) => reply(false, /** @type {{code?:string,message?:string}} */ (cause)?.code
          ?? /** @type {{message?:string}} */ (cause)?.message ?? 'secret-host-failed'),
      );
    });
    next.onDisconnect.addListener(() => {
      if (activePort === next) lose(next, 'port-disconnected');
    });
  };

  const connected = async () => {
    if (activePort) return activePort;
    await ensureOffscreen();
    if (activePort) return activePort;
    await new Promise((resolve, reject) => {
      const ready = () => { clearTimeout(timer); waiters.delete(ready); resolve(undefined); };
      waiters.add(ready);
      const timer = setTimeout(() => {
        waiters.delete(ready);
        reject(failure('port-timeout'));
      }, timeoutMs);
    });
    if (!activePort) throw failure('port-disconnected');
    return activePort;
  };

  /** @param {'export'|'adopt'|'suspend'|'resume'|'reset'} operation @param {any} [args] */
  const call = async (operation, args = {}) => {
    let operationId = '';
    if (unknown.size > 0) {
      const match = [...unknown.values()].find((entry) => {
        try {
          return entry.operation === operation
            && JSON.stringify(entry.args) === JSON.stringify(args);
        } catch { return entry.operation === operation && entry.args === args; }
      });
      if (!match) throw failure('previous-outcome-unknown', false);
      operationId = match.operationId;
    }
    if (!operationId) {
      const leaseId = args?.leaseId;
      operationId = (operation === 'suspend' || operation === 'resume')
        && typeof leaseId === 'string' && leaseId.length > 0
        ? `${operation}:${leaseId}` : `operation:${crypto.randomUUID()}`;
      if (!safeId(operationId)) throw failure('protocol-invalid');
    }
    const port = await connected();
    const requestId = newRequestId();
    if (!safeId(requestId)) throw failure('protocol-invalid');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        remember(entry);
        reject(failure('operation-timeout', false));
        lose(port, 'operation-timeout', true);
      }, timeoutMs);
      pending.set(requestId, {
        operationId, operation, args, port, resolve, reject, timer,
      });
      try {
        port.postMessage({
          type: 'custody/request', requestId, operationId, operation, args,
        });
      } catch (cause) {
        const entry = pending.get(requestId);
        pending.delete(requestId);
        clearTimeout(timer);
        if (entry) remember(entry);
        lose(port, 'post-failed', true);
        reject(failure('post-failed', false, cause));
      }
    });
  };

  return Object.freeze({ attach, call });
};
