// @ts-check
// observability/otel-export.js — debug bundle → OTLP/JSON spans.
//
// A pure mapper from the peerd debug bundle to an OpenTelemetry
// OTLP/JSON trace document (the body of an ExportTraceServiceRequest),
// so a session can be dropped into any OTel-speaking viewer the user
// already runs. Span tree: one root span per session (the chat session
// and each descendant actor/subagent session), a child span per model
// turn, and a grandchild span per tool call. Failures carry span status
// ERROR plus the classified `peerd.failure.kind` attribute.
//
// why a second FORMAT and not a second export path: the mapper is pure
// over the already-assembled bundle, so the side panel converts locally
// and saves a second file — same route, same data, no vendor, no wire.
// GenAI attributes follow the OTel gen_ai.* semconv where peerd has the
// value (system/model/token usage); everything peerd-specific is under
// the peerd.* namespace.

import { classifyFailure } from './failure-classify.js';

const SPAN_KIND_INTERNAL = 1;
const STATUS_OK = 0; // OTel STATUS_CODE_UNSET — the honest default for "it ran"
const STATUS_ERROR = 2;

/**
 * uuid → 32-char lowercase hex traceId (uuids are already 32 hex digits + dashes).
 * @param {unknown} uuid
 */
export const traceIdFromUuid = (uuid) => {
  const hex = String(uuid ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  // why pad/clamp instead of throwing: a corrupt id must not kill the export
  return (hex + '0'.repeat(32)).slice(0, 32);
};

/**
 * Deterministic 16-hex spanId from any string (FNV-1a, folded to 64 bits).
 * Tool-use ids are not hex ("toolu_…"), so they get hashed; message uuids
 * go through the same door for uniformity.
 * @param {unknown} s
 */
export const spanIdFrom = (s) => {
  let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000197) >>> 0;
  }
  const hex = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
  return hex === '0'.repeat(16) ? '1'.repeat(16) : hex; // all-zero spanId is invalid in OTel
};

/** @param {number} ms */
const ns = (ms) => String(Math.max(0, Math.round(ms)) * 1e6);

/** @param {string} key @param {unknown} value */
const attr = (key, value) => (typeof value === 'number' && Number.isFinite(value)
  ? { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } }
  : { key, value: { stringValue: String(value ?? '') } });

/**
 * Spans for ONE session record (root span + turns + tool calls).
 * @param {Record<string, any>} session
 * @param {string} traceId
 * @param {string} [parentSpanId]
 */
const sessionSpans = (session, traceId, parentSpanId) => {
  const messages = session.messages ?? [];
  const started = session.createdAt ?? messages[0]?.when ?? 0;
  const ended = messages[messages.length - 1]?.when ?? started;
  const rootId = spanIdFrom(`session:${session.sessionId}`);
  const kind = session.kind ?? 'chat';

  const root = {
    traceId, spanId: rootId, ...(parentSpanId ? { parentSpanId } : {}),
    name: `peerd.session ${kind}${session.actorType ? `:${session.actorType}` : ''}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: ns(started), endTimeUnixNano: ns(ended),
    attributes: [
      attr('peerd.session.id', session.sessionId),
      attr('peerd.session.kind', kind),
      ...(session.actorType ? [attr('peerd.actor.type', session.actorType)] : []),
      ...(session.depth != null ? [attr('peerd.session.depth', session.depth)] : []),
      attr('gen_ai.system', session.provider ?? ''),
      attr('gen_ai.request.model', session.model ?? ''),
    ],
    status: { code: STATUS_OK },
  };

  const spans = /** @type {Array<Record<string, any>>} */ ([root]);
  // why index-walk: a tool call's END is only observable as the arrival of
  // its result, which rides the NEXT (user) message — the walk needs lookahead.
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const prevWhen = messages[i - 1]?.when ?? started;
    // why the sessionId prefix: span ids must be unique across the WHOLE
    // trace, and tool_use/message ids are only unique within one session.
    const turnId = spanIdFrom(`msg:${session.sessionId}:${message.id}`);
    const failed = typeof message.error === 'string' && message.error !== '';
    spans.push({
      traceId, spanId: turnId, parentSpanId: rootId,
      name: 'peerd.model_turn',
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: ns(prevWhen), endTimeUnixNano: ns(message.when ?? prevWhen),
      attributes: [
        attr('gen_ai.request.model', message.model ?? session.model ?? ''),
        attr('gen_ai.system', message.provider ?? session.provider ?? ''),
        ...(message.stopReason ? [attr('peerd.turn.stop_reason', message.stopReason)] : []),
        attr('peerd.turn.tool_calls', message.toolUses?.length ?? 0),
      ],
      status: failed
        ? { code: STATUS_ERROR, message: String(message.error).slice(0, 500) }
        : { code: STATUS_OK },
    });
    if (failed) {
      spans[spans.length - 1].attributes.push(attr('peerd.failure.kind', classifyFailure(message.error, { stopReason: message.stopReason }).kind));
    }

    const next = messages[i + 1];
    const resultsById = new Map((next?.toolResults ?? []).map((/** @type {Record<string, any>} */ r) => [r.tool_use_id, r]));
    for (const use of message.toolUses ?? []) {
      const result = resultsById.get(use.id);
      const isError = result?.is_error === true;
      const content = typeof result?.content === 'string' ? result.content : '';
      spans.push({
        traceId, spanId: spanIdFrom(`tool:${session.sessionId}:${use.id}`), parentSpanId: turnId,
        name: `peerd.tool ${use.name}`,
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: ns(message.when ?? prevWhen),
        endTimeUnixNano: ns(next?.when ?? message.when ?? prevWhen),
        attributes: [
          attr('peerd.tool.name', use.name),
          ...(isError ? [attr('peerd.failure.kind', classifyFailure(content).kind)] : []),
        ],
        status: isError
          ? { code: STATUS_ERROR, message: content.slice(0, 500) }
          : { code: STATUS_OK },
      });
    }
  }
  return spans;
};

/**
 * The whole bundle as one OTLP/JSON trace document. One trace, rooted at
 * the chat session; each descendant session's tree hangs off the root so
 * the delegation structure is visible as span parentage.
 * @param {Record<string, any>} bundle  an assembleDebugBundle() result
 */
export const bundleToOtlp = (bundle) => {
  const session = bundle.session ?? {};
  const traceId = traceIdFromUuid(session.sessionId);
  const rootSpanId = spanIdFrom(`session:${session.sessionId}`);
  const spans = sessionSpans(session, traceId, undefined);
  for (const child of bundle.childSessions ?? []) {
    spans.push(...sessionSpans(child, traceId, rootSpanId));
  }
  const cost = bundle.summary?.cost ?? {};
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          attr('service.name', 'peerd'),
          attr('service.version', bundle.appVersion ?? 'unknown'),
          attr('peerd.channel', bundle.channel ?? 'unknown'),
          attr('gen_ai.usage.input_tokens', cost.inputTokens ?? 0),
          attr('gen_ai.usage.output_tokens', cost.outputTokens ?? 0),
          attr('peerd.cost.usd', cost.cost ?? 0),
        ],
      },
      scopeSpans: [{
        scope: { name: 'peerd.observability', version: String(bundle.version ?? 1) },
        spans,
      }],
    }],
  };
};
