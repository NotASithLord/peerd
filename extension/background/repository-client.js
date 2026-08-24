// @ts-check
// Operation-lazy Git facade with one SW-local transaction lane per repository.

import {
  REPOSITORY_CHANNEL_CANCEL,
  REPOSITORY_CHANNEL_RESULT,
  REPOSITORY_KERNEL_FETCH,
  REPOSITORY_KERNEL_FETCH_RESULT,
  REPOSITORY_MAX_KERNEL_FETCHES,
  decodeRepositoryRpcValue,
  encodeRepositoryRpcValue,
} from '../shared/repository-channel.js';
import {
  REPOSITORY_CHANNEL_MAX_BYTES,
  REPOSITORY_CHANNEL_OFFER,
  REPOSITORY_CHANNEL_PROTOCOL,
  REPOSITORY_METHODS,
  parseRepositoryChannelOffer,
  repositoryChannelPayloadFits,
  repositoryMethodIsAppFile,
  repositoryMethodIsKnown,
  repositoryMethodIsMutating,
  repositoryMethodMayFetch,
} from '../shared/feature-lease-protocol.js';
import { base64ToBytes, bytesToBase64 } from '../shared/cold-util.js';
export { decodeRepositoryRpcValue, encodeRepositoryRpcValue };

const MAX_GIT_HTTP_BODY = 32 * 1024 * 1024;
const MAX_GIT_HTTP_HEADERS = 64;
const MAX_GIT_HTTP_HEADER_BYTES = 64 * 1024;
const PUBLIC_GIT_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
/** @typedef {Error & {code?:string,outcomeKnown?:boolean,repositoryHostDispatched?:boolean,cause?:unknown}} RepositoryError */
/** @returns {RepositoryError} */
const repositoryError = (/** @type {string} */ message, /** @type {string} */ code,
  /** @type {boolean} */ outcomeKnown, /** @type {boolean|undefined} */ dispatched,
  /** @type {unknown} */ cause = undefined) => {
  const error = /** @type {RepositoryError} */ (new Error(message));
  Object.assign(error, { code, outcomeKnown });
  if (dispatched !== undefined) error.repositoryHostDispatched = dispatched;
  if (cause !== undefined) error.cause = cause;
  return error;
};
const normalizeGitRemote = (/** @type {unknown} */ input) => {
  let url;
  try { url = new URL(String(input ?? '').trim()); }
  catch { throw new Error('invalid git remote URL'); }
  if (url.protocol !== 'https:' || url.username || url.password
      || (url.port && url.port !== '443') || url.search || url.hash
      || !PUBLIC_GIT_HOST.test(url.hostname) || /^[\d.]+$/.test(url.hostname)) {
    throw new Error('invalid public HTTPS git remote');
  }
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); }
  catch { throw new Error('git remote path is malformed'); }
  const parts = decoded.split('/').filter(Boolean);
  if (parts.length < 2 || parts.some((part) => part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error('git remote must name a repository path');
  }
  url.pathname = `/${parts.join('/')}${parts.at(-1)?.endsWith('.git') ? '' : '.git'}`;
  return { url: url.toString(), host: url.hostname.toLowerCase() };
};
const gitRemoteOwnsRequest = (/** @type {{url:string}} */ remote, /** @type {unknown} */ input) => {
  try {
    const base = new URL(remote.url);
    const request = new URL(String(input ?? ''));
    const prefix = base.pathname.replace(/\/$/, '');
    return request.protocol === 'https:' && request.origin === base.origin
      && [`${prefix}/info/refs`, `${prefix}/git-upload-pack`, `${prefix}/git-receive-pack`]
        .includes(request.pathname);
  } catch { return false; }
};
const smartHttpAuthHeader = (/** @type {string} */ host, /** @type {string} */ token) => {
  const user = host === 'github.com' ? 'x-access-token'
    : host === 'gitlab.com' || host.endsWith('.gitlab.com') ? 'oauth2' : 'git';
  let binary = '';
  for (const byte of new TextEncoder().encode(`${user}:${token}`)) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
};
const boundedResponseBody = async (/** @type {Response} */ response,
  /** @type {AbortSignal|undefined} */ signal = undefined) => {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */ const chunks = [];
  let total = 0;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('Git request cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_GIT_HTTP_BODY) {
        await reader.cancel('Git response exceeds the kernel transfer ceiling').catch(() => {});
        throw new Error('Git response exceeds the kernel transfer ceiling');
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
};

/**
 * @param {object} deps
 * @param {(url:string,init?:RequestInit)=>Promise<Response>} deps.webFetch
 * @param {(name:string)=>Promise<string|null>} deps.getSecret
 * @param {(event:any)=>void} [deps.audit]
 */
export const makeRepositoryKernelFetch = ({
  webFetch,
  getSecret,
  audit = () => {},
}) => async (/** @type {any} */ message,
  /** @type {{signal?:AbortSignal}} */ options = {}) => {
  const method = String(message?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw new Error('unsupported Git HTTP method');
  const remote = normalizeGitRemote(message?.remote);
  const url = String(message?.url ?? '');
  if (!gitRemoteOwnsRequest(remote, url)) throw new Error('Git request escaped its bound repository');
  const encodedBody = message?.bodyB64 == null ? null : String(message.bodyB64);
  if (encodedBody && encodedBody.length > Math.ceil(MAX_GIT_HTTP_BODY * 4 / 3) + 4) {
    throw new Error('Git request exceeds the kernel transfer ceiling');
  }
  const body = encodedBody == null ? undefined : base64ToBytes(encodedBody);
  if (body && body.byteLength > MAX_GIT_HTTP_BODY) throw new Error('Git request exceeds the kernel transfer ceiling');
  /** @type {Record<string,string>} */ const headers = {};
  const headerEntries = Object.entries(message?.headers ?? {});
  if (headerEntries.length > 64) throw new Error('too many Git request headers');
  let headerBytes = 0;
  for (const [name, value] of headerEntries) {
    const lower = name.toLowerCase();
    headerBytes += name.length + (typeof value === 'string' ? value.length : 0);
    if (headerBytes > 64 * 1024) throw new Error('Git request headers exceed the transfer ceiling');
    if (!['authorization', 'cookie', 'proxy-authorization'].includes(lower)
        && typeof value === 'string' && value.length <= 8_192) headers[name] = value;
  }
  let token = null;
  try { token = await getSecret(`git:${remote.host}`); } catch { /* anonymous */ }
  if (token) {
    headers.Authorization = smartHttpAuthHeader(remote.host, token);
    audit({ type: 'git_auth_attached', details: { host: remote.host, transport: 'smart-http' } });
  }
  const response = await webFetch(url, {
    method, headers,
    ...(body ? { body: /** @type {BodyInit} */ (/** @type {unknown} */ (body)) } : {}),
    credentials: 'omit', redirect: 'manual',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const responseBytes = await boundedResponseBody(response, options.signal);
  /** @type {Record<string,string>} */ const responseHeaders = {};
  let responseHeaderCount = 0;
  let responseHeaderBytes = 0;
  for (const [name, value] of response.headers.entries()) {
    responseHeaderCount += 1;
    responseHeaderBytes += name.length + value.length;
    if (responseHeaderCount > MAX_GIT_HTTP_HEADERS
        || responseHeaderBytes > MAX_GIT_HTTP_HEADER_BYTES) {
      throw new Error('Git response headers exceed the transfer ceiling');
    }
    responseHeaders[name] = value;
  }
  return {
    ok: true, url: response.url || url, status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    bodyB64: bytesToBase64(responseBytes),
  };
};

export const repositoryKey = (/** @type {{kind:string,id:string}} */ ref) => `${ref.kind}:${ref.id}`;

/** @param {Record<string,any>} service */
const makeAppFilesFacade = (service) => Object.freeze({
  inspectApp: (/** @type {string} */ appId) => service.appInspect({ kind: 'app', id: appId }),
  listApp: (/** @type {string} */ appId) => service.appList(
    { kind: 'app', id: appId }, { sizes: false },
  ),
  listAppInfo: (/** @type {string} */ appId) => service.appList(
    { kind: 'app', id: appId }, { sizes: true },
  ),
  readText: (/** @type {string} */ appId, /** @type {string} */ path) => service.appRead(
    { kind: 'app', id: appId }, { path, encoding: 'text' },
  ),
  readBytes: (/** @type {string} */ appId, /** @type {string} */ path) => service.appRead(
    { kind: 'app', id: appId }, { path, encoding: 'bytes' },
  ),
  write: (/** @type {string} */ appId, /** @type {string} */ path,
    /** @type {string|Uint8Array} */ value) => service.appWrite(
    { kind: 'app', id: appId }, { path, value },
  ),
  writeText: (/** @type {string} */ appId, /** @type {string} */ path,
    /** @type {string} */ content) => {
    if (typeof content !== 'string') throw new TypeError('App text content required');
    return service.appWrite({ kind: 'app', id: appId }, { path, value: content });
  },
  deleteFile: (/** @type {string} */ appId, /** @type {string} */ path) => service.appDelete(
    { kind: 'app', id: appId }, { path },
  ),
});

/** @param {(method:string,args:any[])=>Promise<any>} invoke
 * @param {(ref:{kind:string,id:string},operation:()=>Promise<any>)=>Promise<any>} coordinate
 */
export const makeRepositoryFacade = (invoke, coordinate) => {
  /** @type {Record<string,any>} */
  const service = Object.fromEntries(REPOSITORY_METHODS.map((method) => [
    method, (/** @type {any[]} */ ...args) => invoke(method, args),
  ]));
  service.coordinate = coordinate;
  const appRef = (/** @type {string} */ id) => ({ kind: 'app', id });
  for (const [name, method] of Object.entries({
    initApp: 'init', commitApp: 'commit', statusApp: 'status', historyApp: 'history',
    diffApp: 'diff', restoreApp: 'restore', getAppRemote: 'getRemote', destroyApp: 'destroy',
  })) {
    service[name] = (/** @type {string} */ id, /** @type {any[]} */ ...args) =>
      invoke(method, [appRef(id), ...args]);
  }
  return /** @type {ReturnType<typeof import('../peerd-engine/repository.js').createRepositoryService>} */ (
    /** @type {unknown} */ (Object.freeze({
      ...service,
      appFiles: makeAppFilesFacade(service),
    }))
  );
};

/** @param {()=>Promise<ReturnType<typeof import('../peerd-engine/repository.js').createRepositoryService>>} loader
 */
export const createDeferredRepositoryClient = (loader) => {
  /** @type {Promise<ReturnType<typeof import('../peerd-engine/repository.js').createRepositoryService>>|null} */
  let pending = null;
  const load = () => {
    if (!pending) pending = Promise.resolve().then(loader).catch((cause) => {
      pending = null;
      throw repositoryError('Firefox repository module is temporarily unavailable.',
        'repository-local-load-failed', true, undefined, cause);
    });
    return pending;
  };
  return makeRepositoryFacade(
    (method, args) => load().then((client) => /** @type {any} */ (client)[method](...args)),
    (ref, operation) => load().then((client) => client.coordinate(ref, operation)),
  );
};

/** @param {any} deps
 * @returns {ReturnType<typeof import('../peerd-engine/repository.js').createRepositoryService>} */
export const createOffscreenRepositoryClient = ({
  withHost,
  retireHost = async () => {},
  newId = () => crypto.randomUUID(),
  readTimeoutMs = 8_000,
  effectTimeoutMs = 120_000,
  appReadTimeoutMs = 4_000,
  appEffectTimeoutMs = 15_000,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  offscreenUrl = '',
  listWindowClients = async () => {
    const clientApi = /** @type {any} */ (globalThis).clients;
    return typeof clientApi?.matchAll === 'function'
      ? clientApi.matchAll({ type: 'window', includeUncontrolled: true }) : [];
  },
  kernelFetch = undefined,
  createChannel = () => new MessageChannel(),
}) => {
  if (!Number.isFinite(readTimeoutMs) || readTimeoutMs <= 0
      || !Number.isFinite(effectTimeoutMs) || effectTimeoutMs <= 0
      || !Number.isFinite(appReadTimeoutMs) || appReadTimeoutMs <= 0
      || !Number.isFinite(appEffectTimeoutMs) || appEffectTimeoutMs <= 0
      || typeof now !== 'function'
      || typeof withHost !== 'function'
      || typeof offscreenUrl !== 'string' || !offscreenUrl
      || typeof kernelFetch !== 'function'
      || typeof listWindowClients !== 'function'
      || typeof createChannel !== 'function') {
    throw new TypeError('repository-host-timeout-invalid');
  }
  /** @type {Map<string, Promise<unknown>>} */
  const transactionTails = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const operationTails = new Map();
  /** @template T @param {Map<string, Promise<unknown>>} lanes @param {string} key @param {() => Promise<T>} operation */
  const enqueue = async (lanes, key, operation) => {
    const prior = lanes.get(key) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    lanes.set(key, current);
    try { return await current; }
    finally { if (lanes.get(key) === current) lanes.delete(key); }
  };

  /** @param {string} method @param {any[]} wireArgs @param {string} callId @param {any} lease @param {AbortSignal|undefined} signal @param {(cancel:()=>void)=>void} setCancel */
  const callPrivate = async (method, wireArgs, callId, lease, signal, setCancel) => {
    const boundKernelFetch = kernelFetch;
    const matches = (await listWindowClients()).filter((/** @type {any} */ client) => client?.url === offscreenUrl);
    if (matches.length !== 1) throw new Error('repository host unavailable or ambiguous');
    const offer = {
      type: REPOSITORY_CHANNEL_OFFER,
      protocol: REPOSITORY_CHANNEL_PROTOCOL,
      channelId: callId,
      method,
      args: encodeRepositoryRpcValue(wireArgs),
      lease,
    };
    if (!parseRepositoryChannelOffer(offer)) throw new Error('repository channel offer invalid');
    const { port1, port2 } = createChannel();
    return new Promise((resolve, reject) => {
      let settled = false;
      let fetchSequence = 0;
      let boundRemote = method === 'clone'
        ? normalizeGitRemote(wireArgs?.[1]?.url).url : null;
      let reverseTransferChars = 0;
      /** @type {Set<AbortController>} */ const fetches = new Set();
      const finish = (/** @type {unknown} */ value, /** @type {boolean} */ ok) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        for (const controller of fetches) controller.abort('repository-channel-closed');
        fetches.clear();
        try { port1.close(); } catch { /* already closed */ }
        if (ok) resolve(value); else reject(value);
      };
      const cancel = () => {
        try { port1.postMessage({
          type: REPOSITORY_CHANNEL_CANCEL,
          protocol: REPOSITORY_CHANNEL_PROTOCOL,
          channelId: callId,
        }); } catch { /* already closed */ }
        finish(signal?.reason ?? new Error('repository operation cancelled'), false);
      };
      setCancel(cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      port1.onmessage = (/** @type {MessageEvent} */ event) => {
        const reply = event.data;
        if (reply?.protocol !== REPOSITORY_CHANNEL_PROTOCOL || reply?.channelId !== callId) return;
        if (reply.type === REPOSITORY_KERNEL_FETCH && typeof reply.fetchId === 'string') {
          const expectedFetchId = `${callId}:fetch:${fetchSequence + 1}`;
          let remote;
          try { remote = normalizeGitRemote(reply.request?.remote).url; }
          catch {
            finish(repositoryError('repository reverse fetch authority invalid',
              'repository-reverse-fetch-invalid', !repositoryMethodIsMutating(method), true), false);
            return;
          }
          const requestChars = typeof reply.request?.bodyB64 === 'string'
            ? reply.request.bodyB64.length : 0;
          if (!repositoryMethodMayFetch(method)
              || fetchSequence >= REPOSITORY_MAX_KERNEL_FETCHES
              || fetches.size >= 2
              || reply.fetchId !== expectedFetchId
              || (boundRemote !== null && remote !== boundRemote)
              || reverseTransferChars + requestChars > REPOSITORY_CHANNEL_MAX_BYTES) {
            finish(repositoryError('repository reverse fetch authority invalid',
              'repository-reverse-fetch-invalid', !repositoryMethodIsMutating(method), true), false);
            return;
          }
          fetchSequence += 1;
          boundRemote = remote;
          reverseTransferChars += requestChars;
          const controller = new AbortController();
          fetches.add(controller);
          Promise.resolve(boundKernelFetch(reply.request, { signal: controller.signal })).then(
            (result) => {
              const responseChars = typeof result?.bodyB64 === 'string' ? result.bodyB64.length : 0;
              if (reverseTransferChars + responseChars > REPOSITORY_CHANNEL_MAX_BYTES) {
                finish(new Error('repository reverse fetch transfer exceeded'), false);
                return;
              }
              reverseTransferChars += responseChars;
              try { port1.postMessage({
                type: REPOSITORY_KERNEL_FETCH_RESULT,
                protocol: REPOSITORY_CHANNEL_PROTOCOL,
                channelId: callId,
                fetchId: reply.fetchId,
                ok: true,
                result,
              }); } catch (cause) { finish(cause, false); }
            },
            (cause) => {
              try { port1.postMessage({
                type: REPOSITORY_KERNEL_FETCH_RESULT,
                protocol: REPOSITORY_CHANNEL_PROTOCOL,
                channelId: callId,
                fetchId: reply.fetchId,
                ok: false,
                error: cause instanceof Error ? cause.message : String(cause),
              }); } catch (postCause) { finish(postCause, false); }
            },
          ).finally(() => fetches.delete(controller));
          return;
        }
        if (reply.type !== REPOSITORY_CHANNEL_RESULT || typeof reply.ok !== 'boolean') return;
        if (!repositoryChannelPayloadFits(reply)) {
          finish(new Error('repository channel result exceeds the transfer ceiling'), false);
          return;
        }
        finish(reply, true);
      };
      port1.onmessageerror = () => finish(new Error('repository channel reply invalid'), false);
      port1.addEventListener?.('close', () => finish(
        new Error('repository channel closed'), false,
      ), { once: true });
      port1.start();
      try { matches[0].postMessage(offer, [port2]); }
      catch (cause) {
        finish(repositoryError(cause instanceof Error ? cause.message : String(cause),
          'repository-host-dispatch-failed', true, false, cause), false);
      }
    });
  };

  /** @param {boolean} [dispatched] */
  const readDeadlineError = (dispatched = false) => repositoryError(
    'Repository read expired before it could run.', 'repository-read-deadline', true, dispatched,
  );
  /** @param {string} method @param {any[]} args @param {any} lease @param {number} deadlineAt */
  const callUnhosted = async (method, args, lease = undefined, deadlineAt = Infinity) => {
    if (!repositoryMethodIsKnown(method)) throw new Error(`unsupported repository operation: ${method}`);
    const callId = newId();
    const signal = args.findLast((entry) => entry?.signal instanceof AbortSignal)?.signal;
    if (signal?.aborted) throw signal.reason ?? new Error('repository operation aborted');
    /** @type {()=>void} */ let cancelTransport = () => {};
    const onAbort = () => cancelTransport();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const wireArgs = [...args];
      while (wireArgs.length && wireArgs.at(-1) === undefined) wireArgs.pop();
      const timeoutMs = repositoryMethodIsAppFile(method)
        ? (repositoryMethodIsMutating(method) ? appEffectTimeoutMs : appReadTimeoutMs)
        : (repositoryMethodIsMutating(method) ? effectTimeoutMs : readTimeoutMs);
      const remainingMs = deadlineAt - now();
      if (!repositoryMethodIsMutating(method) && remainingMs <= 0) {
        throw readDeadlineError();
      }
      const reply = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (/** @type {unknown} */ value, /** @type {boolean} */ ok) => {
          if (settled) return;
          settled = true;
          clearTimeoutFn(timer);
          if (ok) resolve(value); else reject(value);
        };
        const timer = setTimeoutFn(() => {
          cancelTransport();
          finish(repositoryError('Repository service took too long to respond.',
            'repository-host-timeout', !repositoryMethodIsMutating(method), true), false);
        }, Math.min(timeoutMs, remainingMs));
        const transport = callPrivate(method, wireArgs, callId, lease, signal,
          (cancel) => { cancelTransport = cancel; });
        Promise.resolve(transport).then(
          (value) => finish(value, true),
          (cause) => finish(cause, false),
        );
      });
      if (!reply?.ok) {
        throw repositoryError(String(reply?.error ?? 'repository host failed'),
          String(reply?.code ?? 'repository-host-failed'), reply?.outcomeKnown === true, true);
      }
      return decodeRepositoryRpcValue(reply.result);
    } catch (cause) {
      if (cause && typeof cause === 'object' && 'outcomeKnown' in cause) throw cause;
      throw repositoryError(cause instanceof Error ? cause.message : String(cause),
        'repository-host-transport-lost', !repositoryMethodIsMutating(method), true, cause);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };
  /** @param {string} method @param {any[]} args @param {number} deadlineAt */
  const call = async (method, args, deadlineAt) => {
    const mutating = repositoryMethodIsMutating(method);
    const attempts = mutating ? 1 : 2;
    /** @type {unknown} */
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!mutating && deadlineAt <= now()) {
        throw lastError ?? readDeadlineError();
      }
      try { return await withHost((/** @type {any} */ lease) => callUnhosted(method, args, lease, deadlineAt)); }
      catch (cause) {
        lastError = cause;
        const error = /** @type {RepositoryError} */ (cause);
        if (error?.code === 'repository-host-load-failed') {
          await retireHost('repository-host-module-load-failed');
        }
        if (!mutating && error?.outcomeKnown === true
            && ['repository-host-timeout', 'repository-host-transport-lost']
              .includes(error.code ?? '')) {
          await retireHost('repository-read-host-unavailable');
        }
        if (mutating && error?.outcomeKnown !== true && error?.repositoryHostDispatched === true) {
          await retireHost('repository-mutation-outcome-unknown');
        }
        if (error?.outcomeKnown !== true) throw cause;
      }
    }
    throw lastError;
  };

  /** @template T @param {string[]} keys @param {() => Promise<T>} operation */
  const enqueueMany = async (keys, operation) => {
    const ordered = [...new Set(keys)].sort();
    const run = ordered.reduceRight(
      (next, key) => () => enqueue(operationTails, key, next),
      operation,
    );
    return run();
  };
  /** @param {string} method @param {any[]} args */
  const invoke = (method, args) => {
    const readBudget = repositoryMethodIsAppFile(method)
      ? appReadTimeoutMs * 2 : readTimeoutMs * 2;
    const deadlineAt = repositoryMethodIsMutating(method) ? Infinity : now() + readBudget;
    return method === 'fork'
      ? enqueueMany(args.slice(0, 2).map(repositoryKey), () => call(method, args, deadlineAt))
      : enqueue(operationTails, repositoryKey(args[0]), () => call(method, args, deadlineAt));
  };
  return makeRepositoryFacade(invoke, (ref, operation) =>
    enqueue(transactionTails, repositoryKey(ref), operation));
};
