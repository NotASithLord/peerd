// @ts-check

import {
  inspectTabToolCall,
  isDenylistedTab,
  originOfUrl,
  resolveTargetTab,
} from '/peerd-runtime/browser-authority.js';
import { isPrivateOrLocalHost } from '/shared/private-network.js';
import { ALLOWED_METHODS, needsWebWriteConfirm } from '/peerd-engine/authority.js';
import { finalWebRequestConfirmation } from '/shared/web-request-confirmation.js';
import { normalizeApiOrigin } from '/shared/api-origin.js';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_WEB_TEXT_CHARS = 2_000_000;
const SESSION_HEADERS = new Set([
  'cookie', 'authorization', 'proxy-authorization', 'dpop',
]);

const mismatch = () => Object.assign(new Error('resource authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

const exactKeys = (/** @type {Record<string,unknown>} */ value,
  /** @type {string[]} */ required, /** @type {string[]} */ optional = []) => {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};

const sameClone = (/** @type {unknown} */ left, /** @type {unknown} */ right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
};

/** @param {unknown} value */
const stringHeaders = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  /** @type {Record<string,string>} */
  const headers = {};
  for (const [name, item] of Object.entries(value)) {
    if (!name || typeof item !== 'string' || SESSION_HEADERS.has(name.toLowerCase())) return null;
    headers[name] = item;
  }
  return headers;
};

const expectedMethod = (/** @type {any} */ args) =>
  typeof args?.method === 'string' ? args.method.toUpperCase() : 'GET';

/** @param {any} args */
const expectedBody = (args) => {
  if (args?.body === undefined || typeof args.body === 'string') return args?.body;
  return JSON.stringify(args.body);
};

/** @param {any} args */
const expectedHeaders = (args) => {
  /** @type {Record<string,string>} */
  const headers = {};
  if (args?.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
    for (const [name, value] of Object.entries(args.headers)) {
      if (!SESSION_HEADERS.has(name.toLowerCase()) && typeof value === 'string') {
        headers[name] = value;
      }
    }
  }
  if (args?.body !== undefined && typeof args.body !== 'string'
      && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
};

/** @param {{binding:any,ctx:any,signal?:AbortSignal,shared?:any}} input */
export const createResourceToolAuthority = ({ binding, ctx, signal, shared = {} }) => {
  const args = binding.args ?? {};
  const apiIdentity = ctx?.backing === 'api' ? ctx?.actorInstanceId : null;
  const apiOwnedOrigin = typeof apiIdentity === 'string'
    && normalizeApiOrigin(apiIdentity) === apiIdentity ? apiIdentity : null;
  const requireOwnedApiOrigin = (/** @type {URL} */ parsed) => {
    if (ctx?.backing !== 'api') return;
    if (apiOwnedOrigin && parsed.origin === apiOwnedOrigin) return;
    throw Object.assign(new Error('API actor request is outside its owned origin'), {
      code: 'api_actor_origin_mismatch', outcomeKnown: true,
      outcomeKind: 'pre-effect-failure', retryable: false,
    });
  };
  const requireOperation = (/** @type {string} */ operation) => {
    if (binding.operation !== operation) throw mismatch();
  };
  const ownerSessionId = ctx?.session?.sessionId;
  return Object.freeze({
    confirmWebWrite: async (/** @type {any} */ request) => {
      requireOperation('turn.resource.confirm-web-write');
      let parsed;
      try { parsed = new URL(request?.url); } catch { throw mismatch(); }
      requireOwnedApiOrigin(parsed);
      const method = request?.method;
      const headers = stringHeaders(request?.headers);
      if (!request || !exactKeys(request, ['url', 'method', 'headers'], ['body'])
          || request.url !== args.url || method !== expectedMethod(args)
          || !ALLOWED_METHODS.includes(method) || !needsWebWriteConfirm(method)
          || request.body !== expectedBody(args)
          || !headers || !sameClone(headers, expectedHeaders(args))) throw mismatch();
      if (typeof ctx?.confirm !== 'function') return false;
      const presentation = finalWebRequestConfirmation({
        url: request.url, method, headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        source: 'web request',
      });
      const answer = await ctx.confirm({
        tool: 'web:write', kind: 'web_write', origins: [...presentation.origins],
        summary: presentation.summary,
        sessionId: ownerSessionId ?? null,
      }, signal ?? ctx?.abortSignal);
      if (answer === true || answer === 'yes_once' || answer === 'yes_session') {
        shared.webWriteApproval = Object.freeze({
          url: request.url, method, headers: Object.freeze({ ...headers }),
          ...(request.body === undefined ? {} : { body: request.body }),
        });
      }
      return answer;
    },
    requestWebText: async (/** @type {any} */ request) => {
      requireOperation('turn.resource.request-web-text');
      let parsed;
      try { parsed = new URL(request?.url); } catch { throw mismatch(); }
      requireOwnedApiOrigin(parsed);
      if (!request || typeof request !== 'object' || !exactKeys(request,
        ['url', 'method', 'headers'], ['body'])
          || request.url !== args.url || request.method !== expectedMethod(args)
          || !/^https?:$/.test(parsed.protocol)
          || !ALLOWED_METHODS.includes(request.method)
          || request.body !== expectedBody(args)
          || typeof ctx?.webFetch !== 'function') throw mismatch();
      const headers = stringHeaders(request.headers);
      if (!headers || !sameClone(headers, expectedHeaders(args))) throw mismatch();
      if (needsWebWriteConfirm(request.method)) {
        const approval = shared.webWriteApproval;
        shared.webWriteApproval = null;
        if (!approval || !sameClone(approval, {
          url: request.url, method: request.method, headers,
          ...(request.body === undefined ? {} : { body: request.body }),
        })) throw mismatch();
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, FETCH_TIMEOUT_MS);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (ctx?.actorType === 'web' && ctx?.backing === 'tab') {
          const egress = inspectTabToolCall({
            name: 'fetch_url',
            args: {
              url: request.url, method: request.method, headers,
              ...(request.body === undefined ? {} : { body: request.body }),
            },
            currentOrigin: ctx?.activeTab?.origin ?? ctx?.activeTab?.url ?? null,
          });
          if (egress.action === 'block') return {
            ok: false,
            code: 'browser_egress_tripwire_refused',
            error: 'web request refused by the host egress tripwire',
            outcomeKind: 'pre-effect-failure',
            retryable: false,
          };
        }
        let response;
        try {
          response = await ctx.webFetch(request.url, {
            method: request.method, headers, body: request.body,
            signal: controller.signal,
          });
        } catch (cause) {
          const failure = /** @type {{reason?:string,message?:string}} */ (cause);
          if (failure?.reason === 'redirect_blocked'
              || failure?.reason === 'private_network') {
            return {
              ok: false, reason: failure.reason,
              error: failure.message ?? 'web request blocked',
            };
          }
          throw cause;
        }
        if (apiOwnedOrigin) {
          let finalOrigin = null;
          try { finalOrigin = originOfUrl(response.url ?? request.url); } catch { /* refuse below */ }
          if (finalOrigin !== apiOwnedOrigin) {
            return needsWebWriteConfirm(request.method)
              ? {
                  ok: false, reason: 'api_origin_escape',
                  error: 'API actor response escaped its owned origin',
                  performed: true, outcomeKnown: false, outcomeKind: 'transport-lost',
                  retryable: false,
                }
              : {
                  ok: false, reason: 'api_origin_escape',
                  error: 'API actor response escaped its owned origin',
                  performed: true, outcomeKnown: true, outcomeKind: 'effect-completed',
                  retryable: false,
                };
          }
        }
        const body = (await response.text()).slice(0, MAX_WEB_TEXT_CHARS);
        /** @type {Record<string,string>} */
        const responseHeaders = {};
        response.headers.forEach((/** @type {string} */ value, /** @type {string} */ name) => {
          responseHeaders[name] = value;
        });
        return {
          ok: true, status: response.status, body, headers: responseHeaders,
          finalUrl: response.url ?? request.url,
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abort);
      }
    },
    extractReadableMarkdown: (/** @type {string} */ html, /** @type {string} */ url) => {
      requireOperation('turn.resource.extract-markdown');
      if (typeof html !== 'string' || html.length > 16 * 1024 * 1024
          || typeof url !== 'string') throw mismatch();
      const client = ctx?.webOffscreenClient;
      return typeof client?.extractMarkdown === 'function'
        ? client.extractMarkdown({ html, url })
        : { readerable: false };
    },
    extractDocument: async (/** @type {any} */ request) => {
      requireOperation('turn.resource.extract-document');
      if (!request || typeof request !== 'object'
          || !exactKeys(request, ['url', 'engine'], ['format'])
          || request.url !== (typeof args.url === 'string' && args.url ? args.url : null)
          || request.format !== args.format || typeof request.engine !== 'string') throw mismatch();
      const client = ctx?.docOffscreenClient;
      if (typeof client?.extract !== 'function') return {
        ok: false, error: 'doc_reader_unavailable',
        content: 'Document conversion is not available in this browser build. If the document has an HTML version, read that instead.',
      };
      let target = request.url;
      if (!target) {
        const tab = await resolveTargetTab(args, ctx);
        if (!tab?.id) return { ok: false, error: 'no_target_tab' };
        target = typeof tab.url === 'string' ? tab.url : null;
        if (!target) return { ok: false, error: 'no_document_url' };
      }
      let parsed;
      try { parsed = new URL(target); }
      catch { return { ok: false, error: `invalid_url: ${target}` }; }
      if (!/^(https?|data):$/.test(parsed.protocol)) {
        return { ok: false, error: `unsupported_scheme: ${parsed.protocol}` };
      }
      if (isDenylistedTab(target, ctx?.denylist)) {
        return { ok: false, error: 'denylisted_target' };
      }
      if (isPrivateOrLocalHost(parsed.hostname)) {
        return { ok: false, error: 'private_or_local_target_blocked' };
      }
      try {
        const result = await client.extract(
          { url: target }, { format: request.format, engine: request.engine },
        );
        return { ok: true, target, result };
      } catch (cause) {
        const error = /** @type {{code?:string,message?:string}} */ (cause);
        return {
          ok: false, error: error?.code ?? 'doc_read_failed',
          content: error?.message ?? String(cause),
        };
      }
    },
    spillResult: async (/** @type {any} */ record) => {
      requireOperation('turn.resource.spill-result');
      if (!record || typeof record !== 'object'
          || !exactKeys(record,
            ['url', 'format', 'text', 'producer', 'fenced', 'originLabel'])
          || typeof record.producer !== 'string' || record.producer.length > 128
          || record.fenced !== true
          || typeof record.url !== 'string' || typeof record.format !== 'string'
          || typeof record.text !== 'string' || typeof record.originLabel !== 'string'
          || record.originLabel !== originOfUrl(record.url)
          || typeof ownerSessionId !== 'string' || !ownerSessionId
          || typeof ctx?.resultStore?.key !== 'function'
          || typeof ctx?.resultStore?.put !== 'function') throw mismatch();
      const key = ctx.resultStore.key();
      await ctx.resultStore.put({ ...record, key, ownerSessionId });
      return key;
    },
    readResult: async (/** @type {string} */ key) => {
      requireOperation('turn.resource.read-result');
      if (key !== args.key || typeof ownerSessionId !== 'string' || !ownerSessionId
          || typeof ctx?.resultStore?.get !== 'function') throw mismatch();
      const record = await ctx.resultStore.get(key).catch(() => undefined);
      if (record && record.ownerSessionId !== ownerSessionId) {
        return { ok: false, error: `not_your_result: ${key} was spilled by another session.` };
      }
      return { ok: true, record };
    },
  });
};

export const bindResourceToolAuthority = (
  /** @type {any} */ state, /** @type {any} */ input,
) => createResourceToolAuthority({
  ...input,
  binding: Object.freeze({ operation: input.operation, args: structuredClone(input.args) }),
  shared: state,
});
