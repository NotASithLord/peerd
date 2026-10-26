// Pure policy for the experimental API lane. The host remains responsible for
// tool grants, confirmation, revision pinning, GET/HEAD enforcement and execution.
import {
  canonicalSiteClientJson, normalizeSiteClientContracts, normalizeSiteOrigin,
  validateSiteClientValue,
} from '../../extension/peerd-runtime/site-clients/core.js';

// A bounded 32k JSON value can occupy 192k after lossless ASCII escaping.
export const MAX_API_RECEIPT_CHARS = 256_000;
export const MAX_HELPER_INPUT_CHARS = 24_000;
export const MAX_AUTHORED_BODY_CHARS = 12_000;
export const RECOVERY_TOOL_NAMES = Object.freeze([
  'snapshot', 'read_page', 'query_dom', 'read_state', 'click', 'type',
  'site_capture', 'site_client_read', 'site_client_write', 'site_client_run',
]);

export class ApiPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApiPolicyError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new ApiPolicyError(code, message); };
const record = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value, required, optional = []) => record(value)
  && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const boundedText = (value, limit, empty = false) => typeof value === 'string'
  && (empty || value.trim().length > 0) && value.length <= limit && !value.includes('\0');

export const canonicalOrigin = value => {
  if (typeof value !== 'string') return null;
  const normalized = normalizeSiteOrigin(value);
  // The production normalizer intentionally accepts convenience inputs. This
  // protocol expects an exact origin, never a credential, path or sibling host.
  return normalized === value ? normalized : null;
};

/** Read host metadata only at the outer receipt, never from website result data. */
export const inspectToolReceipt = raw => {
  if (typeof raw !== 'string' || raw.length > MAX_API_RECEIPT_CHARS) {
    fail('receipt_budget', 'Tool receipt is missing or exceeds the local protocol budget.');
  }
  let value = null;
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (record(parsed) && (typeof parsed.ok === 'boolean'
          || Object.hasOwn(parsed, 'outcomeKnown') || Object.hasOwn(parsed, 'outcomeKind'))) value = parsed;
    } catch { /* A plain tool string can happen to begin with a brace. */ }
  }
  // Peerd's OpenAI formatter forwards content only. The production agent loop
  // stops before another call on unknown outcomes, and persists this exact
  // host-authored sentinel for any later resumed transcript.
  const wireUnknown = raw === 'outcome_unknown: Verify the target before retrying.'
    || raw.startsWith('outcome_unknown: Verify the target before retrying.: ')
    || raw === 'not_run: Prior tool outcome unknown.';
  const uncertain = wireUnknown || value?.outcomeKnown === false || value?.possibleCommit === true
    || value?.writeStatus === 'may_have_applied'
    || ['unknown', 'transport-lost', 'host-lost'].includes(value?.outcomeKind);
  const failed = value?.ok === false || value?.executionFailed === true;
  return {
    value, content: typeof value?.content === 'string' ? value.content : raw,
    failed, uncertain, performed: value?.performed, retryable: value?.retryable,
  };
};

/**
 * The real OpenAI wire omits is_error. Accept the current host success shapes
 * for tools whose failure must not be replayed, instead of guessing that any
 * prose receipt denotes success. This is receipt-format checking, not a claim
 * that website data inside the fence is true.
 */
export const hasSuccessfulToolReceipt = (raw, toolName) => {
  const receipt = inspectToolReceipt(raw);
  if (receipt.failed || receipt.uncertain) return false;
  if (receipt.value?.ok === true) return true;
  const content = receipt.content;
  const fence = /^<untrusted_web_content origin="[^"\n<>]+" tool="([a-z_]+)" retrieved_at="([^"\n<>]+)">\n[\s\S]*\n<\/untrusted_web_content>$/.exec(content);
  if (fence?.[1] === toolName && Number.isFinite(Date.parse(fence[2]))) return true;
  if (toolName === 'snapshot') return /^(?:a11y snapshot|pseudo-a11y snapshot \()/.test(content);
  if (toolName === 'site_capture') return content.startsWith('capture started on ')
    || content.startsWith('capture stopped: no in-scope API traffic observed ');
  if (toolName === 'site_client_read' || toolName === 'site_client_run') {
    try {
      hostEnvelope(raw, toolName === 'site_client_read' ? 'site_client_contract'
        : content.includes('<site_client_validation>') ? 'site_client_validation' : 'site_client_result');
      return true;
    } catch { return false; }
  }
  if (toolName === 'site_client_write') {
    if (content === 'no change (identical to the stored client).') return true;
    try {
      const value = JSON.parse(content);
      return record(value) && ['create', 'update'].includes(value.op)
        && canonicalOrigin(value.origin) !== null && boundedText(value.revision, 160);
    } catch { return false; }
  }
  return false;
};

const hostEnvelope = (raw, tag) => {
  const receipt = inspectToolReceipt(raw);
  if (receipt.uncertain) fail('uncertain_outcome', 'The host could not establish the previous tool outcome.');
  if (receipt.failed) fail('tool_failed', 'The host refused or failed the site-client request.');
  // The canonical outer provenance fence is mandatory. Only its first body
  // may hold the host envelope; never search arbitrary source or nested data.
  const tool = tag === 'site_client_contract' ? 'site_client_read' : 'site_client_run';
  const fence = /^<untrusted_web_content origin="([^"\n<>]+)" tool="([a-z_]+)" retrieved_at="([^"\n<>]+)">\n([\s\S]*?)\n<\/untrusted_web_content>(?:\n|$)/.exec(receipt.content);
  if (!fence || fence[2] !== tool || !Number.isFinite(Date.parse(fence[3]))) {
    fail('missing_envelope', `Expected the anchored ${tag} host envelope in its provenance fence.`);
  }
  // JSON occupies one physical line and the host escapes every literal '<'.
  const match = new RegExp(`^<${tag}>\\n([^\\r\\n<]+)\\n</${tag}>(?:\\n|$)`).exec(fence[4]);
  if (!match) fail('missing_envelope', `Expected the anchored ${tag} host envelope.`);
  let value;
  try { value = JSON.parse(match[1]); }
  catch { fail('invalid_envelope', 'The site-client host envelope is not valid JSON.'); }
  // Public canonical origins are ASCII host names plus an optional port; the
  // production wrapper does not need attribute escaping for this identity.
  if (!canonicalOrigin(value?.origin) || fence[1] !== `site-client(${value.origin})`) {
    fail('invalid_envelope', 'The site-client provenance origin does not match its envelope.');
  }
  return value;
};

export const parseSiteClientContract = (raw, expectedOrigin) => {
  const value = hostEnvelope(raw, 'site_client_contract');
  if (!exactKeys(value, ['schema', 'origin', 'revision', 'status', 'operations', 'validatedOperations'])
      || value.schema !== 1 || !canonicalOrigin(expectedOrigin) || value.origin !== expectedOrigin
      || value.revision !== null && (!boundedText(value.revision, 160) || !/^[A-Za-z0-9_.:-]+$/.test(value.revision))
      || !['draft', 'validated', 'stale'].includes(value.status)
      || !Array.isArray(value.validatedOperations)
      || value.validatedOperations.some(name => typeof name !== 'string')
      || new Set(value.validatedOperations).size !== value.validatedOperations.length) {
    fail('invalid_contract', 'Invalid site-client identity, revision or validation metadata.');
  }
  const { operations } = normalizeSiteClientContracts(value.operations, []);
  const validated = new Set(value.validatedOperations);
  if ([...validated].some(name => !operations.some(op => op.name === name && op.readOnly === true))
      || value.status !== 'validated' && validated.size > 0
      || value.revision === null && (value.status === 'validated' || validated.size > 0)) {
    fail('invalid_contract', 'Validation names must identify declared READ operations.');
  }
  return Object.freeze({ ...value, operations,
    eligibleOperations: value.status === 'validated'
      ? operations.filter(op => op.readOnly === true && validated.has(op.name)) : [],
  });
};

export const selectApiInvocation = (selection, contract) => {
  if (!exactKeys(selection, ['operation', 'input'])) {
    fail('invalid_selection', 'API selection must contain only operation and input.');
  }
  if (selection.operation === null && selection.input === null) return null;
  const operation = contract.eligibleOperations.find(op => op.name === selection.operation);
  if (!operation) fail('ineligible_operation', 'The helper selected an unverified or non-READ operation.');
  const input = validateSiteClientValue(selection.input, operation.inputSchema);
  return Object.freeze({
    origin: contract.origin, revision: contract.revision, operation: operation.name, input,
    outputSchema: operation.outputSchema,
  });
};

export const apiInvocationArgs = invocation => ({
  origin: invocation.origin, revision: invocation.revision,
  operation: invocation.operation, input: invocation.input,
});

export const verifySiteClientResult = (raw, invocation) => {
  const value = hostEnvelope(raw, 'site_client_result');
  if (!exactKeys(value, ['schema', 'origin', 'revision', 'operation', 'inputValidated', 'outputValidated', 'readOnly', 'result'])
      || value.schema !== 1 || value.origin !== invocation.origin
      || value.revision !== invocation.revision || value.operation !== invocation.operation
      || value.inputValidated !== true || value.outputValidated !== true || value.readOnly !== true) {
    fail('invalid_result', 'The typed result does not match the selected, host-validated READ operation.');
  }
  // This verifies the output contract. It cannot establish task truth, freshness
  // of the remote site, or semantic correctness of the stored implementation.
  return validateSiteClientValue(value.result, invocation.outputSchema);
};

/** Check the entire helper request rather than silently dropping evidence. */
export const boundedHelperInput = value => {
  const text = canonicalSiteClientJson(value, MAX_HELPER_INPUT_CHARS);
  if (text.length > MAX_HELPER_INPUT_CHARS) fail('helper_budget', 'Helper input exceeds the local prototype budget.');
  return text;
};

const assertOrigin = (args, origin) => {
  if (!canonicalOrigin(origin) || args.origin !== origin) {
    fail('wrong_origin', 'Recovery is limited to the currently observed exact origin.');
  }
};
const assertFieldText = text => {
  if (!boundedText(text, 2_000, true) || /[\r\n\0]/.test(text)) {
    fail('invalid_field', 'Recovery text must be one bounded field value.');
  }
};

/**
 * The helper proposes one normal Peerd tool. It receives no execution channel.
 * Generated modules may only be proposed through the existing confirmed-write
 * tool; arbitrary generated site_client_run code is never accepted here.
 */
export const validateRecoveryPlan = (plan, {
  origin, observation, tools, choices, contract, captureActive = false,
  hasDiscoveryEvidence = false,
}) => {
  if (!record(plan) || !['tool', 'decision', 'answer', 'blocked'].includes(plan.kind)) {
    fail('invalid_recovery', 'Recovery must return one explicit plan kind.');
  }
  if (plan.kind === 'decision') {
    if (!exactKeys(plan, ['kind'])) fail('invalid_recovery', 'Resume decision accepts no other fields.');
    return { kind: 'decision' };
  }
  if (plan.kind === 'answer' || plan.kind === 'blocked') {
    if (!exactKeys(plan, ['kind', 'text']) || !boundedText(plan.text, 4_000)) {
      fail('invalid_recovery', 'Recovery answer must be bounded text.');
    }
    return { kind: plan.kind, text: plan.text };
  }
  if (!exactKeys(plan, ['kind', 'name', 'args']) || !record(plan.args)
      || !RECOVERY_TOOL_NAMES.includes(plan.name) || !tools.has(plan.name)) {
    fail('ungranted_recovery_tool', 'Recovery selected an unavailable tool or malformed arguments.');
  }
  // The wire already carries JSON; canonicalization bounds the complete value
  // and rejects class instances, cycles and oversized payloads.
  const args = JSON.parse(canonicalSiteClientJson(plan.args, MAX_HELPER_INPUT_CHARS));
  const requireKeys = (required, optional = []) => {
    if (!exactKeys(args, required, optional)) fail('invalid_recovery_args', 'Unexpected recovery tool arguments.');
  };
  switch (plan.name) {
    case 'snapshot':
    case 'read_page':
      requireKeys([]);
      break;
    case 'query_dom':
      requireKeys(['selector'], ['limit', 'includeHidden']);
      if (!boundedText(args.selector, 500) || args.limit !== undefined
          && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20)
          || args.includeHidden !== undefined && typeof args.includeHidden !== 'boolean') {
        fail('invalid_recovery_args', 'DOM query exceeds the local read budget.');
      }
      break;
    case 'read_state':
      if (Object.hasOwn(args, 'ref')) {
        requireKeys(['ref']);
        if (!observation?.elements.some(element => element.ref === args.ref)) {
          fail('invalid_recovery_args', 'State read requires an observed ref.');
        }
      } else {
        requireKeys(['selector']);
        if (!boundedText(args.selector, 500)) fail('invalid_recovery_args', 'State selector is invalid.');
      }
      break;
    case 'click':
    case 'type': {
      requireKeys(plan.name === 'click' ? ['ref'] : ['ref', 'text']);
      const operation = plan.name === 'click' ? 'CLICK' : 'TYPE_TEXT';
      if (!choices || ![...choices.values()].some(action => action.operation === operation && action.ref === args.ref)) {
        fail('invalid_recovery_args', 'Recovery mutations require an enabled, observed, allowlisted ref.');
      }
      if (plan.name === 'type') assertFieldText(args.text);
      break;
    }
    case 'site_capture':
      requireKeys(['action']);
      if (!canonicalOrigin(origin) || !['start', 'stop'].includes(args.action)
          || (args.action === 'start') === captureActive) {
        fail('invalid_capture', 'Capture must change state on the currently observed origin.');
      }
      break;
    case 'site_client_read':
      requireKeys(['origin']);
      assertOrigin(args, origin);
      break;
    case 'site_client_run':
      requireKeys(['origin', 'mode', 'revision']);
      assertOrigin(args, origin);
      if (args.mode !== 'validate' || !contract || typeof contract.revision !== 'string'
          || contract.origin !== origin || args.revision !== contract.revision) {
        fail('invalid_recovery_args', 'Recovery can only validate the currently read revision; generated run code is refused.');
      }
      break;
    case 'site_client_write': {
      requireKeys(['origin', 'summary', 'body', 'operations', 'validationCases'], ['endpoints', 'auth', 'deriver']);
      assertOrigin(args, origin);
      if (!hasDiscoveryEvidence || !boundedText(args.summary, 2_000)
          || !boundedText(args.body, MAX_AUTHORED_BODY_CHARS)) {
        fail('invalid_authorship', 'Authoring needs observed discovery evidence and a nonempty bounded module; deletion is refused.');
      }
      const normalized = normalizeSiteClientContracts(args.operations, args.validationCases);
      if (!normalized.operations.length || normalized.operations.some(op => op.readOnly !== true)
          || normalized.operations.some(op => new Set(normalized.validationCases
            .filter(item => item.operation === op.name).map(item => canonicalSiteClientJson(item.input))).size < 2)) {
        fail('invalid_authorship', 'Authoring is limited to READ contracts with at least two distinct declared inputs each.');
      }
      if (args.auth !== undefined && !['session', 'bearer', 'none', 'unknown'].includes(args.auth)
          || args.deriver !== undefined && !['probe', 'capture-cdp', 'capture-tap'].includes(args.deriver)) {
        fail('invalid_authorship', 'Unknown client provenance metadata.');
      }
      if (args.endpoints !== undefined && (!Array.isArray(args.endpoints) || args.endpoints.length > 12
          || args.endpoints.some(endpoint => !exactKeys(endpoint, ['method', 'path'], ['note'])
            || !['GET', 'HEAD'].includes(endpoint.method) || !boundedText(endpoint.path, 500)
            || !endpoint.path.startsWith('/') || endpoint.path.startsWith('//')
            || endpoint.note !== undefined && !boundedText(endpoint.note, 400, true)))) {
        fail('invalid_authorship', 'Authoring endpoint inventory must be bounded same-origin READ paths.');
      }
      Object.assign(args, normalized);
      break;
    }
    default: fail('ungranted_recovery_tool', 'Unsupported recovery tool.');
  }
  return { kind: 'tool', name: plan.name, args };
};
