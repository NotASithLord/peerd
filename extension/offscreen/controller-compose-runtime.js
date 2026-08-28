// @ts-check

import {
  neutralizeFence,
  parseComposer,
  wrapUntrusted,
} from '/peerd-runtime/controller.js';
import { expandComposerCommand } from '/shared/composer-parser.js';
import { controllerPayloadBytes } from '/shared/structured-clone-size.js';
import {
  COMPOSER_COMMAND_NAME_BYTES,
  COMPOSER_OUTPUT_OUTER_BYTES,
  COMPOSER_OUTPUT_TEXT_BYTES,
  COMPOSER_REFERENCE_ERROR_BYTES,
  COMPOSER_REFERENCE_LIMIT,
  COMPOSER_REFERENCE_RAW_BYTES,
  composerUtf8Bytes,
  composerUtf8Fits,
  truncateComposerUtf8,
} from '/shared/composer-reference-policy.js';

/** @typedef {{raw:string,ok:true}|{raw:string,ok:false,error:string}} TurnComposeRefResult */
/** @typedef {{ok:false,code:string,outcomeKnown:true}|{
 * ok:true,outcomeKnown:true,value:{text:string,command:string|null,
 * commandFound:boolean,refs:TurnComposeRefResult[]}}} TurnComposeResult */

const escAttr = (/** @type {unknown} */ value) => String(value)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');
const filePayload = (/** @type {string} */ path, /** @type {string} */ content) =>
  `<peerd_file path="${escAttr(path)}">\n${neutralizeFence(content)}\n</peerd_file>`;
const tabPayload = (/** @type {any} */ value) => wrapUntrusted({
  origin: value.origin,
  tool: 'at_tab',
  body: [
    `Title: ${value.snapshot.title ?? ''}`,
    `URL: ${value.snapshot.url ?? ''}`,
    '', '[TEXT]', value.snapshot.text || '(empty)',
  ].join('\n'),
});

class TurnComposeEffectFailure extends Error {
  /** @param {any} result */
  constructor(result) {
    super(result?.error ?? result?.code ?? 'turn compose effect failed');
    this.name = 'TurnComposeEffectFailure';
    this.code = result?.code ?? 'turn-compose-effect-failed';
    this.outcomeKnown = result?.outcomeKnown === true;
    // why: only an exact host refusal is safe to turn into inline UX. A
    // thrown channel error or an unknown result must abort the outer compose
    // call so the service worker never sends partially expanded raw input.
    this.semanticRefusal = result?.ok === false && result?.outcomeKnown === true;
  }
}

class TurnComposeReferenceError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TurnComposeReferenceError';
  }
}

/** @param {unknown} cause */
const nonfatalLookupFailure = (cause) => cause instanceof TurnComposeEffectFailure
  ? cause.semanticRefusal : cause instanceof TurnComposeReferenceError;
/** @returns {{ok:false,code:string,outcomeKnown:true}} */
const quotaFailure = (/** @type {string} */ code) => Object.freeze({
  ok: false, code, outcomeKnown: true,
});
const boundedReferenceError = (/** @type {unknown} */ cause) => {
  const message = /** @type {{message?:string}} */ (cause)?.message ?? String(cause);
  return truncateComposerUtf8(message || 'composer_reference_failed',
    COMPOSER_REFERENCE_ERROR_BYTES);
};

const effectValue = async (
  /** @type {(operation:string,payload:unknown)=>Promise<any>} */ kernelCall,
  /** @type {string} */ operation,
  /** @type {unknown} */ payload,
) => {
  const result = await kernelCall(operation, payload);
  if (result?.ok === true) return result.value;
  throw new TurnComposeEffectFailure(result);
};

/** @param {unknown} payload
 * @param {{kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} options
 * @returns {Promise<TurnComposeResult>}
 */
export const composeTurn = async (payload, options) => {
  const input = /** @type {{text?:unknown}} */ (payload);
  if (typeof input?.text !== 'string' || typeof options?.kernelCall !== 'function') {
    return { ok: false, code: 'turn-compose-input-invalid', outcomeKnown: true };
  }
  const kernelCall = options.kernelCall;
  const parsed = parseComposer(input.text);
  if (parsed.command && !composerUtf8Fits(parsed.command, COMPOSER_COMMAND_NAME_BYTES)) {
    return quotaFailure('turn-compose-command-invalid');
  }
  let working = parsed.text;
  let commandFound = false;
  if (parsed.command) {
    let commands;
    try {
      commands = await effectValue(kernelCall, 'turn.compose.list-commands', {});
    } catch (cause) {
      if (!nonfatalLookupFailure(cause)) throw cause;
      commands = [];
    }
    const expanded = expandComposerCommand(
      parsed.text, Array.isArray(commands) ? commands : [],
    );
    commandFound = expanded.commandFound;
    working = expanded.text;
  }
  if (!composerUtf8Fits(working, COMPOSER_OUTPUT_TEXT_BYTES)) {
    return quotaFailure('turn-compose-output-budget-exhausted');
  }
  // why: the host and controller share one aggregate budget. Extra authored
  // references remain literal text and never trigger hidden authority calls.
  const refs = parseComposer(working).refs.slice(0, COMPOSER_REFERENCE_LIMIT);
  /** @type {TurnComposeRefResult[]} */
  const resolved = [];
  /** @type {string[]} */
  const replacements = [];
  let projectedBytes = composerUtf8Bytes(working);
  let expansionBudgetExhausted = false;
  const replacementBytes = (/** @type {any} */ ref, /** @type {string} */ replacement) =>
    projectedBytes - composerUtf8Bytes(ref.raw) + composerUtf8Bytes(replacement);
  const fitReplacement = (/** @type {any} */ ref, /** @type {string} */ replacement) => {
    const next = replacementBytes(ref, replacement);
    if (next > COMPOSER_OUTPUT_TEXT_BYTES) return false;
    projectedBytes = next;
    replacements.push(replacement);
    return true;
  };
  for (const ref of refs) {
    const resultRaw = truncateComposerUtf8(ref.raw, COMPOSER_REFERENCE_RAW_BYTES);
    const budgetError = 'composer_output_budget_exhausted';
    const minimumReplacement = ref.kind === 'tab'
      ? `\n${tabPayload({
        origin: '', snapshot: { title: '', url: '', text: '' },
      })}\n`
      : `\n${filePayload(ref.arg, '')}\n`;
    // why: after an expansion consumes the aggregate allowance, later refs
    // cannot justify more browser/storage reads merely to discover bytes the
    // successful outer result is forbidden to carry. Keep their literals and
    // report the same deterministic local budget refusal.
    if (expansionBudgetExhausted
        || replacementBytes(ref, minimumReplacement) > COMPOSER_OUTPUT_TEXT_BYTES) {
      expansionBudgetExhausted = true;
      replacements.push(ref.raw);
      resolved.push({ raw: resultRaw, ok: false, error: budgetError });
      continue;
    }
    try {
      let value;
      if (ref.kind === 'tab') {
        const explicitId = ref.arg === '' ? null
          : /^(?:[1-9]\d*)$/.test(ref.arg) && Number.isSafeInteger(Number(ref.arg))
            ? Number(ref.arg) : undefined;
        if (explicitId === undefined) throw new TurnComposeReferenceError('invalid_tab_reference');
        value = await effectValue(kernelCall, 'turn.compose.capture-tab', {
          tabId: explicitId,
        });
      } else {
        value = await effectValue(kernelCall, 'turn.compose.read-file', { path: ref.arg });
      }
      const content = ref.kind === 'tab'
        ? tabPayload(value) : filePayload(ref.arg, value.content);
      if (fitReplacement(ref, `\n${content}\n`)) {
        resolved.push({ raw: resultRaw, ok: true });
      } else {
        expansionBudgetExhausted = true;
        replacements.push(ref.raw);
        resolved.push({ raw: resultRaw, ok: false, error: budgetError });
      }
    } catch (cause) {
      if (!nonfatalLookupFailure(cause)) throw cause;
      const error = boundedReferenceError(cause);
      const annotated = `${ref.raw} (could not resolve: ${error})`;
      if (!fitReplacement(ref, annotated)) {
        expansionBudgetExhausted = true;
        replacements.push(ref.raw);
      }
      resolved.push({ raw: resultRaw, ok: false, error });
    }
  }
  for (let index = refs.length - 1; index >= 0; index -= 1) {
    const ref = refs[index];
    const replacement = replacements[index];
    working = `${working.slice(0, ref.start)}${replacement}${working.slice(ref.end)}`;
  }
  const result = /** @type {TurnComposeResult} */ ({
    ok: true, outcomeKnown: true, value: {
    text: working,
    command: parsed.command,
    commandFound,
    refs: resolved,
    },
  });
  const resultBytes = controllerPayloadBytes(result, { maxDepth: 24, maxNodes: 50_000 });
  return composerUtf8Fits(working, COMPOSER_OUTPUT_TEXT_BYTES)
      && Number.isFinite(resultBytes) && resultBytes <= COMPOSER_OUTPUT_OUTER_BYTES
    ? result : quotaFailure('turn-compose-output-budget-exhausted');
};
