// @ts-check

import {
  isDenylistedTab,
  originOfUrl,
  resolveTargetTab,
} from '/peerd-runtime/browser-authority.js';
import { isPrivateOrLocalHost } from '/shared/private-network.js';

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

/** @param {{call:any,ctx:any,signal?:AbortSignal}} input */
export const createResourceToolAuthority = ({ call, ctx, signal }) => {
  const args = call?.args ?? {};
  const requireTool = (/** @type {string[]} */ names) => {
    if (!names.includes(call?.name)) throw mismatch();
  };
  const ownerSessionId = ctx?.session?.sessionId;
  return Object.freeze({
    confirmWebWrite: async (/** @type {string} */ url, /** @type {string} */ method) => {
      requireTool(['fetch_url']);
      let parsed;
      try { parsed = new URL(url); } catch { throw mismatch(); }
      if (url !== args.url || method !== expectedMethod(args)
          || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
          || typeof ctx?.confirm !== 'function') throw mismatch();
      return ctx.confirm({
        tool: 'web:write', kind: 'web_write', origins: [parsed.origin],
        summary: `Allow a ${method} request to ${parsed.host}? This can send data out of the browser.`,
        sessionId: ownerSessionId ?? null,
      }, signal ?? ctx?.abortSignal);
    },
    requestWebText: async (/** @type {any} */ request) => {
      requireTool(['fetch_url']);
      let parsed;
      try { parsed = new URL(request?.url); } catch { throw mismatch(); }
      if (!request || typeof request !== 'object' || !exactKeys(request,
        ['url', 'method', 'headers'], ['body'])
          || request.url !== args.url || request.method !== expectedMethod(args)
          || !/^https?:$/.test(parsed.protocol)
          || request.body !== expectedBody(args)
          || typeof ctx?.webFetch !== 'function') throw mismatch();
      const headers = stringHeaders(request.headers);
      if (!headers || !sameClone(headers, expectedHeaders(args))) throw mismatch();
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, FETCH_TIMEOUT_MS);
      signal?.addEventListener('abort', abort, { once: true });
      try {
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
      requireTool(['fetch_url']);
      if (typeof html !== 'string' || html.length > 16 * 1024 * 1024
          || typeof url !== 'string') throw mismatch();
      const client = ctx?.webOffscreenClient;
      return typeof client?.extractMarkdown === 'function'
        ? client.extractMarkdown({ html, url })
        : { readerable: false };
    },
    extractDocument: async (/** @type {any} */ request) => {
      requireTool(['read_doc']);
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
      requireTool(['fetch_url', 'read_doc']);
      if (!record || typeof record !== 'object'
          || !exactKeys(record,
            ['url', 'format', 'text', 'producer', 'fenced', 'originLabel'])
          || record.producer !== call.name || record.fenced !== true
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
      requireTool(['read_result']);
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
) => state.authority ??= createResourceToolAuthority(input);
