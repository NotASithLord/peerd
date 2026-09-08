// @ts-check

// why: semantic heaps may shape model-visible results, but they never author
// durable audit records. The host derives one bounded verdict from a
// controller-reported call identity plus the final host-stamped result block;
// the exact-operation receipt, not the semantic label, is authority evidence.

const bounded = (/** @type {unknown} */ value, /** @type {number} */ max) =>
  typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
    : '';

/**
 * @param {{sessionId:string,callId:string,label:unknown,result:unknown}} input
 * @returns {{type:'semantic_report'|'tool_executed'|'tool_failed'|'tool_blocked',sessionId:string,details:Record<string,unknown>}}
 */
export const semanticCallAuditEntry = ({ sessionId, callId, label, result }) => {
  const block = result && typeof result === 'object' && !Array.isArray(result)
    ? /** @type {Record<string,any>} */ (result) : {};
  const receipts = Array.isArray(block.authorityReceipts)
    ? block.authorityReceipts.filter((receipt) => receipt && typeof receipt === 'object') : [];
  const semanticFailed = block.is_error === true || block.ok === false;
  // why: worker-authored authorityPerformed/outcomeKnown fields are never
  // evidence. Only the host receipt ledger may make an authority claim.
  const performed = receipts.some((receipt) => receipt.performed === true);
  const outcomeKnown = !receipts.some((receipt) => receipt.outcomeKnown === false);
  const refused = receipts.some((receipt) => receipt.refused === true);
  const noEffect = receipts.length > 0 && !performed && !refused && outcomeKnown;
  const outcome = !outcomeKnown ? 'unknown'
    : performed && refused ? 'performed-refused'
      : performed ? 'performed'
        : refused ? 'refused'
          : semanticFailed ? 'semantic-failure'
            : noEffect ? 'no-op' : 'semantic-success';
  const gate = Array.isArray(block.meta?.gates)
    ? block.meta.gates.find((/** @type {any} */ entry) => entry && typeof entry === 'object'
      && entry.allowed === false) : null;
  const hook = Array.isArray(block.meta?.hooks)
    ? block.meta.hooks.find((/** @type {any} */ entry) => entry && typeof entry === 'object'
      && entry.action === 'block') : null;
  const hostFailed = !outcomeKnown || refused || semanticFailed;
  const semanticBlocked = receipts.length === 0 && semanticFailed && (gate || hook);
  const type = semanticBlocked ? 'tool_blocked'
    : receipts.length === 0 && !semanticFailed
      ? 'semantic_report' : hostFailed ? 'tool_failed' : 'tool_executed';
  const receipt = receipts.find((entry) => entry.outcomeKnown === false
    || entry.refused === true) ?? receipts[0];
  return {
    type,
    sessionId,
    details: {
      tool: bounded(label, 128) || 'unknown semantic call',
      callId: bounded(callId, 160),
      semantic: true,
      outcome,
      performed,
      outcomeKnown,
      refused,
      ...(typeof receipt?.operation === 'string'
        ? { operation: bounded(receipt.operation, 160) } : {}),
      ...(typeof receipt?.code === 'string' ? { code: bounded(receipt.code, 96) } : {}),
      ...(gate?.name ? { gate: bounded(gate.name, 96) } : hook?.id
        ? { gate: `hook:${bounded(hook.id, 80)}` } : {}),
      ...(gate?.reason ? { reason: bounded(gate.reason, 240) } : hook?.reason
        ? { reason: bounded(hook.reason, 240) } : {}),
    },
  };
};
