// @ts-check
export { parseHookDocument as parseHookMarkdown } from '../../../shared/hook-document.js';
import { isDefaultHookId } from '../../../shared/default-hook-manifest.js';
// Compile user-authored declarative hook policy. User hooks are data, never
// executable source: arbitrary JS would violate MV3 CSP or share mutable
// intrinsics with the persistent semantic controller. Reviewed built-in code
// hooks remain static modules.

/**
 * @typedef {Object} UserHookRecord     the serializable on-"disk" form
 * @property {string} id
 * @property {'pre-tool-use' | 'post-tool-use'} event
 * @property {boolean} [enabled]
 * @property {number} [order]
 * @property {string} [match]            tool-name glob; default '*'
 * @property {'declarative'} kind
 * @property {Object} [rule]             declarative rule (kind:'declarative')
 * @property {string} [rule.matchArg]    arg name to test, e.g. 'url' or 'text'
 * @property {string} [rule.contains]    bounded literal tested against String(arg)
 * @property {'block' | 'allow'} [rule.onMatch]   default 'block'
 * @property {string} [rule.reason]
 * @property {string} [doc]              human-readable prose (the markdown body)
 */

/**
 * Build a declarative hook's run() from a {matchArg, contains, onMatch}
 * rule. Literal matching keeps invocation bounded and avoids a regex engine
 * becoming an availability boundary inside the semantic turn.
 *
 * @param {UserHookRecord} record
 * @returns {import('./runner.js').Hook['run']}
 */
const buildDeclarativeRun = (record) => {
  const { matchArg, contains, onMatch = 'block', reason } = record.rule ?? {};
  if (typeof matchArg !== 'string' || !matchArg || matchArg.length > 128
      || typeof contains !== 'string' || !contains || contains.length > 1_024) {
    throw new TypeError(`hook '${record.id}': declarative rule needs bounded matchArg + contains`);
  }
  if (onMatch !== 'block' && onMatch !== 'allow') {
    throw new TypeError(`hook '${record.id}': declarative onMatch must be block or allow`);
  }
  return (inv) => {
    const value = inv.args?.[matchArg];
    const hit = value != null && String(value).includes(contains);
    if (!hit) return { action: 'allow', reason: `${record.id}: '${matchArg}' did not contain the configured literal` };
    if (onMatch === 'allow') return { action: 'allow', reason: reason ?? `${record.id}: explicit allow` };
    return { action: 'block', reason: reason ?? `${record.id}: '${matchArg}' contained the configured literal` };
  };
};

/**
 * Compile a UserHookRecord into a live Hook. Throws on any malformed
 * record so the registry can skip it. The returned hook carries `_record`
 * so the registry can export the original serializable form back.
 *
 * @param {UserHookRecord} record
 * @returns {import('./runner.js').Hook & { _record: UserHookRecord }}
 */
export const compileUserHook = (record) => {
  if (!record || typeof record.id !== 'string' || !record.id) {
    throw new TypeError('compileUserHook: record.id is required');
  }
  if (isDefaultHookId(record.id)) {
    throw new TypeError(`hook '${record.id}': id is reserved for a built-in hook`);
  }
  if (record.event !== 'pre-tool-use' && record.event !== 'post-tool-use') {
    throw new TypeError(`hook '${record.id}': invalid event '${record.event}'`);
  }
  if (record.kind !== 'declarative') {
    throw new TypeError(`hook '${record.id}': executable JS hooks are not supported; use a declarative rule`);
  }
  const run = buildDeclarativeRun(record);

  return {
    id: record.id,
    event: record.event,
    enabled: record.enabled !== false,
    order: typeof record.order === 'number' ? record.order : 100,
    match: record.match ?? '*',
    run,
    _record: record,
  };
};
