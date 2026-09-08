// @ts-check
// Exact model network custody. Provider semantics construct a native request
// body in the sealed controller; this authority validates the pinned provider
// and model, redeems only approved opaque media fields, attaches credentials,
// and owns the response stream lifetime.

import {
  providerEgressHeaders,
  providerEgressPolicy,
  resolveOllamaEgressUrl,
} from './provider-egress-manifest.js';
import {
  cancelBestEffort, readBoundedResponseBytes, ResponseTooLargeError,
} from '/shared/abort.js';

const ALLOWED_RESPONSE_HEADERS = Object.freeze([
  'content-type', 'retry-after', 'anthropic-ratelimit-input-tokens-reset',
  'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens',
]);
const textEncoder = new TextEncoder();
const record = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string, any>} */ (value) : null;
const exactKeys = (/** @type {Record<string,any>|null} */ value,
  /** @type {string[]} */ keys) => !!value && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const knownFailure = (/** @type {string} */ code, /** @type {string} */ error = code) => ({
  ok: false, code, error, outcomeKnown: true,
});
const unknownFailure = (/** @type {string} */ code) => ({
  ok: false, code, error: code,
  outcomeKnown: false, retryable: false,
});
const bodyBytes = (/** @type {unknown} */ value) => {
  try { return textEncoder.encode(JSON.stringify(value)).byteLength; }
  catch { return Number.POSITIVE_INFINITY; }
};
const outputLimit = (/** @type {Record<string,any>} */ body) => {
  const value = body.max_tokens ?? body.max_completion_tokens;
  return Number.isSafeInteger(value) && value > 0 ? Number(value) : null;
};
const boundedModel = (/** @type {unknown} */ value) => typeof value === 'string'
  && value.length > 0 && value.length <= 256;

/** @param {string} providerId @param {Record<string,any>} body @param {string} modelId */
const nativeBodyAllowed = (providerId, body, modelId) => {
  if (!boundedModel(modelId) || body.model !== modelId || body.stream !== true) return false;
  if (!Array.isArray(body.messages) || body.messages.length > 20_000) return false;
  if (providerId === 'anthropic') {
    return body.system === undefined || typeof body.system === 'string' || Array.isArray(body.system);
  }
  return ['openrouter', 'openai', 'glm', 'ollama'].includes(providerId);
};

/**
 * Redeem media without exposing a general opaque-value resolver. Only the two
 * provider-native media locations emitted by Peerd's formatters are accepted.
 * @param {string} providerId
 * @param {Record<string,any>} body
 * @param {(token:string)=>string|null} redeemOpaque
 */
const redeemMedia = (providerId, body, redeemOpaque) => {
  const clone = structuredClone(body);
  if (providerId === 'anthropic') {
    for (const message of clone.messages ?? []) {
      if (!Array.isArray(message?.content)) continue;
      for (const block of message.content) {
        if (!['image', 'document'].includes(block?.type)
            || block?.source?.type !== 'base64' || typeof block.source.data !== 'string') continue;
        const redeemed = redeemOpaque(block.source.data);
        if (redeemed !== null) block.source.data = redeemed;
      }
    }
    return clone;
  }
  for (const message of clone.messages ?? []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      const value = part?.type === 'image_url' ? part.image_url?.url : null;
      if (typeof value !== 'string' || !value.startsWith('data:')) continue;
      const marker = ';base64,';
      const offset = value.indexOf(marker);
      if (offset < 5) continue;
      const token = value.slice(offset + marker.length);
      const redeemed = redeemOpaque(token);
      if (redeemed !== null) part.image_url.url = `${value.slice(0, offset + marker.length)}${redeemed}`;
    }
  }
  return clone;
};

/** @param {Response} response */
const responseProjection = (response) => ({
  status: response.status,
  statusText: String(response.statusText ?? '').slice(0, 256),
  headers: Object.fromEntries(ALLOWED_RESPONSE_HEADERS.flatMap((name) => {
    const value = response.headers.get(name);
    return value === null ? [] : [[name, value.slice(0, 2048)]];
  })),
});

/**
 * @param {Object} deps
 * @param {(resource:string|URL|Request,init?:RequestInit)=>Promise<Response>} deps.safeFetch
 * @param {{getSecret:(name:string)=>Promise<string|null>}} deps.vault
 * @param {{get:()=>Record<string,any>}} deps.settingsStore
 * @param {{open:(request:any,owner:object,signal?:AbortSignal)=>Promise<string>,
 *   read:(streamId:string,owner:object)=>Promise<any>,
 *   cancel:(streamId:string,owner:object)=>Promise<void>,
 *   closeOwner:(owner:object)=>Promise<void>,activeStreams?:()=>number}} [deps.localModelAuthority]
 * @param {()=>string} [deps.newId]
 */
export const createProviderEgressAuthority = ({
  safeFetch, vault, settingsStore, localModelAuthority,
  newId = () => crypto.randomUUID(),
}) => {
  if (typeof safeFetch !== 'function' || typeof vault?.getSecret !== 'function'
      || typeof settingsStore?.get !== 'function') {
    throw new TypeError('provider-egress-authority-config-invalid');
  }
  /** @type {Map<string,{owner:object,reader:ReadableStreamDefaultReader<Uint8Array>|null,
   * abort:AbortController,bytes:number,maxBytes:number,chunkBytes:number,
   * pending:Uint8Array|null,unlink:()=>void}>} */
  const streams = new Map();
  /** @type {Map<object, Set<{owner:object,abort:AbortController,unlink:()=>void}>>} */
  const pendingByOwner = new Map();
  /** @type {WeakSet<object>} */
  const retiredOwners = new WeakSet();
  const closeStream = (/** @type {string} */ streamId) => {
    const entry = streams.get(streamId);
    if (!entry) return;
    streams.delete(streamId);
    entry.unlink();
    entry.abort.abort();
    // why: authority retirement is the map/abort transition above. A broken
    // transport must not keep owner cleanup (and therefore turn settlement)
    // pending forever while its reader ignores cancellation.
    cancelBestEffort(entry.reader, 'model-egress-owner-retired');
  };
  const urlFor = (/** @type {any} */ policy, /** @type {'inference'|'inventory'|'context'} */ kind,
    /** @type {string} */ providerId, /** @type {string|null} */ modelId = null) => {
    if (providerId === 'ollama') {
      return resolveOllamaEgressUrl(kind, settingsStore.get().ollamaHost);
    }
    if (kind === 'inference') return policy.inferenceUrl;
    if (kind === 'inventory') return policy.inventoryUrl;
    if (kind === 'context' && providerId === 'anthropic') {
      return modelId ? `${policy.contextUrl}${encodeURIComponent(modelId)}` : null;
    }
    return kind === 'context' ? policy.contextUrl : null;
  };
  const credentialFor = async (/** @type {any} */ policy) => policy.credential
    ? vault.getSecret(policy.credential) : null;
  const linkSignal = (/** @type {AbortSignal|undefined} */ source,
    /** @type {AbortController} */ target) => {
    if (!source) return () => {};
    const abort = () => target.abort(source.reason);
    if (source.aborted) abort();
    else source.addEventListener('abort', abort, { once: true });
    return () => source.removeEventListener('abort', abort);
  };
  const beginOwnerOperation = (/** @type {object} */ owner,
    /** @type {AbortSignal|undefined} */ signal) => {
    if (retiredOwners.has(owner) || signal?.aborted) return null;
    const abort = new AbortController();
    const unlink = linkSignal(signal, abort);
    if (retiredOwners.has(owner)) {
      abort.abort('model-egress-owner-retired');
      unlink();
      return null;
    }
    const operation = { owner, abort, unlink };
    const pending = pendingByOwner.get(owner) ?? new Set();
    pending.add(operation);
    pendingByOwner.set(owner, pending);
    return operation;
  };
  const releaseOwnerOperation = (/** @type {NonNullable<ReturnType<typeof beginOwnerOperation>>} */ operation,
    /** @type {boolean} */ unlink = true) => {
    const pending = pendingByOwner.get(operation.owner);
    pending?.delete(operation);
    if (pending?.size === 0) pendingByOwner.delete(operation.owner);
    if (unlink) operation.unlink();
  };
  const ownerOperationLive = (/** @type {NonNullable<ReturnType<typeof beginOwnerOperation>>} */ operation) =>
    !operation.abort.signal.aborted && !retiredOwners.has(operation.owner);
  const ownerOperationFailure = (/** @type {NonNullable<ReturnType<typeof beginOwnerOperation>>} */ operation) =>
    knownFailure(operation.abort.signal.reason === 'model-egress-connect-timeout'
      ? 'model-egress-connect-timeout' : 'model-egress-aborted');

  /**
   * @param {unknown} input
   * @param {{owner:object,signal?:AbortSignal,maxOutputTokens:number,
   *   permits:(providerId:string,modelId:string)=>boolean,
   *   redeemOpaque?:(token:string)=>string|null}} grant
   */
  const openInference = async (input, grant) => {
    const value = record(input);
    const providerId = typeof value?.providerId === 'string' ? value.providerId : '';
    const modelId = typeof value?.modelId === 'string' ? value.modelId : '';
    const body = record(value?.nativeBody);
    const policy = providerEgressPolicy(providerId);
    if (!exactKeys(value, ['providerId', 'modelId', 'nativeBody'])
        || !policy || !body || !grant?.owner || typeof grant.permits !== 'function'
        || !grant.permits(providerId, modelId)
        || !nativeBodyAllowed(providerId, body, modelId)) {
      return knownFailure('model-egress-request-invalid');
    }
    const requestedOutput = outputLimit(body);
    if (!Number.isSafeInteger(grant.maxOutputTokens) || grant.maxOutputTokens < 1
        || requestedOutput === null || requestedOutput > grant.maxOutputTokens) {
      return knownFailure('model-egress-output-limit-denied');
    }
    const nativeBody = redeemMedia(providerId, body, grant.redeemOpaque ?? (() => null));
    if (bodyBytes(nativeBody) > policy.requestBytes) {
      return knownFailure('model-egress-request-too-large');
    }
    const url = urlFor(policy, 'inference', providerId);
    if (!url) return knownFailure('model-egress-provider-unavailable');
    const operation = beginOwnerOperation(grant.owner, grant.signal);
    if (!operation) return knownFailure('model-egress-aborted');
    let credential = null;
    try { credential = await credentialFor(policy); }
    catch {
      releaseOwnerOperation(operation);
      return knownFailure('model-egress-credential-unavailable');
    }
    if (!ownerOperationLive(operation)) {
      releaseOwnerOperation(operation);
      return knownFailure('model-egress-aborted');
    }
    const headers = providerEgressHeaders(policy, credential);
    if (!headers) {
      releaseOwnerOperation(operation);
      return knownFailure('model-egress-credential-missing');
    }
    const { abort, unlink } = operation;
    let response;
    const connectTimer = setTimeout(() => abort.abort('model-egress-connect-timeout'), policy.connectMs);
    try {
      response = await safeFetch(url, {
        method: 'POST', headers, body: JSON.stringify(nativeBody), signal: abort.signal,
      });
    } catch {
      clearTimeout(connectTimer);
      releaseOwnerOperation(operation);
      return abort.signal.aborted
        ? knownFailure(abort.signal.reason === 'model-egress-connect-timeout'
          ? 'model-egress-connect-timeout' : 'model-egress-aborted')
        : unknownFailure('model-egress-connect-failed');
    }
    clearTimeout(connectTimer);
    if (!ownerOperationLive(operation)) {
      cancelBestEffort(response.body, 'model-egress-owner-retired');
      releaseOwnerOperation(operation);
      return ownerOperationFailure(operation);
    }
    const streamId = newId();
    if (streams.has(streamId)) {
      abort.abort('model-egress-stream-collision');
      cancelBestEffort(response.body, 'model-egress-stream-collision');
      releaseOwnerOperation(operation);
      return knownFailure('model-egress-stream-collision');
    }
    streams.set(streamId, {
      owner: grant.owner, reader: response.body?.getReader() ?? null,
      abort, bytes: 0, maxBytes: policy.responseBytes, chunkBytes: policy.chunkBytes,
      pending: null, unlink,
    });
    // The stream map now owns abort/unlink; owner cleanup can see it atomically.
    releaseOwnerOperation(operation, false);
    return {
      ok: true, outcomeKnown: true,
      value: { streamId, ...responseProjection(response), hasBody: !!response.body },
    };
  };

  /** @param {unknown} input @param {{owner:object,signal?:AbortSignal}} grant */
  const readInferenceChunk = async (input, grant) => {
    const value = record(input);
    const streamId = typeof value?.streamId === 'string' ? value.streamId : '';
    const entry = streams.get(streamId);
    if (!exactKeys(value, ['streamId']) || !entry || entry.owner !== grant?.owner) {
      return knownFailure('model-egress-stream-invalid');
    }
    if (grant.signal?.aborted) {
      closeStream(streamId);
      return knownFailure('model-egress-aborted');
    }
    if (!entry.reader) {
      closeStream(streamId);
      return { ok: true, outcomeKnown: true, value: { done: true } };
    }
    try {
      if (entry.pending) {
        const chunk = entry.pending.slice(0, entry.chunkBytes);
        entry.pending = entry.pending.byteLength > entry.chunkBytes
          ? entry.pending.slice(entry.chunkBytes) : null;
        return { ok: true, outcomeKnown: true, value: { done: false, chunk } };
      }
      const next = await entry.reader.read();
      if (streams.get(streamId) !== entry || entry.abort.signal.aborted
          || grant.signal?.aborted) {
        return knownFailure('model-egress-aborted');
      }
      if (next.done) {
        closeStream(streamId);
        return { ok: true, outcomeKnown: true, value: { done: true } };
      }
      const received = next.value;
      entry.bytes += received.byteLength;
      if (entry.bytes > entry.maxBytes) {
        closeStream(streamId);
        return knownFailure('model-egress-response-limit-exceeded');
      }
      const chunk = received.slice(0, entry.chunkBytes);
      entry.pending = received.byteLength > entry.chunkBytes
        ? received.slice(entry.chunkBytes) : null;
      return { ok: true, outcomeKnown: true, value: { done: false, chunk } };
    } catch {
      const aborted = streams.get(streamId) !== entry || entry.abort.signal.aborted
        || grant.signal?.aborted;
      closeStream(streamId);
      return aborted ? knownFailure('model-egress-aborted')
        : unknownFailure('model-egress-stream-failed');
    }
  };

  /** @param {unknown} input @param {{owner:object}} grant */
  const cancelInference = async (input, grant) => {
    const value = record(input);
    const streamId = typeof value?.streamId === 'string' ? value.streamId : '';
    const entry = streams.get(streamId);
    if (!exactKeys(value, ['streamId']) || !entry || entry.owner !== grant?.owner) {
      return knownFailure('model-egress-stream-invalid');
    }
    closeStream(streamId);
    return { ok: true, outcomeKnown: true, value: null };
  };

  /** @param {unknown} input @param {{owner:object,signal?:AbortSignal,maxOutputTokens:number,
   * permits:(providerId:string,modelId:string)=>boolean}} grant */
  const openLocalGeneration = async (input, grant) => {
    const value = record(input);
    const providerId = typeof value?.providerId === 'string' ? value.providerId : '';
    const modelId = typeof value?.modelId === 'string' ? value.modelId : '';
    const requestedOutput = Number(value?.maxTokens);
    if (!value || !localModelAuthority || !exactKeys(value, [
      'providerId', 'modelId', 'messages', 'system', 'tools', 'maxTokens',
    ]) || providerId !== 'local-webgpu'
        || !grant?.owner || typeof grant.permits !== 'function'
        || !grant.permits(providerId, modelId) || !boundedModel(modelId)
        || !Array.isArray(value.messages) || value.messages.length > 256
        || typeof value.system !== 'string' || !Array.isArray(value.tools)
        || value.tools.length > 256 || !Number.isSafeInteger(requestedOutput)
        || requestedOutput < 1 || requestedOutput > grant.maxOutputTokens
        || bodyBytes(value) > providerEgressPolicy(providerId).requestBytes) {
      return knownFailure('local-model-egress-request-invalid');
    }
    if (retiredOwners.has(grant.owner) || grant.signal?.aborted) {
      return knownFailure('local-model-generation-aborted');
    }
    try {
      const streamId = await localModelAuthority.open({
        messages: value.messages,
        system: value.system,
        tools: value.tools,
        model: modelId,
        maxTokens: requestedOutput,
      }, grant.owner, grant.signal);
      if (retiredOwners.has(grant.owner) || grant.signal?.aborted) {
        void Promise.resolve(localModelAuthority.cancel(streamId, grant.owner)).catch(() => {});
        return knownFailure('local-model-generation-aborted');
      }
      return { ok: true, outcomeKnown: true, value: { streamId } };
    } catch (cause) {
      return knownFailure(
        /** @type {{code?:string}} */ (cause)?.code ?? 'local-model-generation-failed',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  };

  /** @param {unknown} input @param {{owner:object}} grant */
  const readLocalGeneration = async (input, grant) => {
    const value = record(input);
    const streamId = typeof value?.streamId === 'string' ? value.streamId : '';
    if (!localModelAuthority || !exactKeys(value, ['streamId'])
        || !streamId || !grant?.owner) {
      return knownFailure('local-model-stream-invalid');
    }
    try {
      return { ok: true, outcomeKnown: true,
        value: await localModelAuthority.read(streamId, grant.owner) };
    } catch (cause) {
      return knownFailure(
        /** @type {{code?:string}} */ (cause)?.code ?? 'local-model-generation-failed',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  };

  /** @param {unknown} input @param {{owner:object}} grant */
  const cancelLocalGeneration = async (input, grant) => {
    const value = record(input);
    const streamId = typeof value?.streamId === 'string' ? value.streamId : '';
    if (!localModelAuthority || !exactKeys(value, ['streamId'])
        || !streamId || !grant?.owner) {
      return knownFailure('local-model-stream-invalid');
    }
    try {
      await localModelAuthority.cancel(streamId, grant.owner);
      return { ok: true, outcomeKnown: true, value: null };
    } catch (cause) {
      return knownFailure(
        /** @type {{code?:string}} */ (cause)?.code ?? 'local-model-cancel-failed',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  };

  /** @param {'inventory'|'context'} kind @param {unknown} input
   * @param {{owner:object,signal?:AbortSignal,permitsProvider:(providerId:string)=>boolean}} grant */
  const readBoundedProbe = async (kind, input, grant) => {
    const value = record(input);
    const providerId = typeof value?.providerId === 'string' ? value.providerId : '';
    const modelId = typeof value?.modelId === 'string' ? value.modelId : null;
    const policy = providerEgressPolicy(providerId);
    const inputKeys = kind === 'context' ? ['providerId', 'modelId'] : ['providerId'];
    if (!exactKeys(value, inputKeys)
        || !policy || !grant?.owner || typeof grant.permitsProvider !== 'function'
        || !grant.permitsProvider(providerId)
        || (kind === 'context' && !boundedModel(modelId))) {
      return knownFailure('model-egress-probe-invalid');
    }
    const url = urlFor(policy, kind, providerId, modelId);
    if (!url) return { ok: true, outcomeKnown: true, value: null };
    const operation = beginOwnerOperation(grant.owner, grant.signal);
    if (!operation) return knownFailure('model-egress-aborted');
    let credential = null;
    try { credential = await credentialFor(policy); }
    catch {
      releaseOwnerOperation(operation);
      return knownFailure('model-egress-credential-unavailable');
    }
    if (!ownerOperationLive(operation)) {
      releaseOwnerOperation(operation);
      return knownFailure('model-egress-aborted');
    }
    const headers = providerEgressHeaders(policy, credential);
    if (!headers && policy.credential) {
      releaseOwnerOperation(operation);
      return knownFailure('model-egress-credential-missing');
    }
    const requestHeaders = headers ?? {};
    const init = kind === 'context' && providerId === 'ollama'
      ? { method: 'POST', headers: requestHeaders,
        body: JSON.stringify({ model: modelId }), signal: operation.abort.signal }
      : { method: 'GET', headers: requestHeaders, signal: operation.abort.signal };
    let response;
    try { response = await safeFetch(url, init); }
    catch {
      const aborted = !ownerOperationLive(operation);
      releaseOwnerOperation(operation);
      return aborted ? knownFailure('model-egress-aborted') : unknownFailure('model-egress-probe-failed');
    }
    if (!ownerOperationLive(operation)) {
      cancelBestEffort(response.body, 'model-egress-owner-retired');
      releaseOwnerOperation(operation);
      return knownFailure('model-egress-aborted');
    }
    const limit = Math.min(policy.responseBytes, 4 * 1024 * 1024);
    let bytes;
    try {
      bytes = await readBoundedResponseBytes(response, limit, {
        signal: operation.abort.signal,
      });
    } catch (cause) {
      const aborted = !ownerOperationLive(operation);
      releaseOwnerOperation(operation);
      return aborted ? knownFailure('model-egress-aborted')
        : cause instanceof ResponseTooLargeError
          ? knownFailure('model-egress-probe-response-too-large')
        : unknownFailure('model-egress-probe-read-failed');
    }
    releaseOwnerOperation(operation);
    return {
      ok: true, outcomeKnown: true,
      value: { ...responseProjection(response), body: bytes },
    };
  };

  return Object.freeze({
    openInference,
    readInferenceChunk,
    cancelInference,
    openLocalGeneration,
    readLocalGeneration,
    cancelLocalGeneration,
    readModelInventory: (/** @type {unknown} */ input,
      /** @type {{owner:object,signal?:AbortSignal,permitsProvider:(providerId:string)=>boolean}} */ grant) =>
      readBoundedProbe('inventory', input, grant),
    readModelContext: (/** @type {unknown} */ input,
      /** @type {{owner:object,signal?:AbortSignal,permitsProvider:(providerId:string)=>boolean}} */ grant) =>
      readBoundedProbe('context', input, grant),
    closeOwner: async (/** @type {object} */ owner) => {
      retiredOwners.add(owner);
      for (const operation of pendingByOwner.get(owner) ?? []) {
        operation.abort.abort('model-egress-owner-retired');
        operation.unlink();
      }
      pendingByOwner.delete(owner);
      for (const [streamId, entry] of streams) {
        if (entry.owner === owner) closeStream(streamId);
      }
      if (localModelAuthority) await localModelAuthority.closeOwner(owner);
    },
    activeStreams: () => streams.size + (localModelAuthority?.activeStreams?.() ?? 0),
  });
};
