// @ts-check

/**
 * `prepare` validates kernel authority before the Class-E commit. `execute`
 * crosses the existing sealed-controller private channel after acceptance.
 * @param {any} deps
 */
export const makeKernelAgentRoutes = ({
  custody, vault, sessionCache, prepare, execute, stop, auditLog,
  withLifetime = (/** @type {()=>Promise<any>} */ operation) => operation(),
  pushState = () => {},
}) => {
  /** @type {Map<string,{sessionId:string|null,controller:AbortController}>} */
  const active = new Map();
  return Object.freeze({
    'agent/send': async (/** @type {any} */ message = {}) => {
      const { text, attachments, activeTabId = null, goal = false,
        operationId = null, checkOnly = false } = message;
      const specified = Object.hasOwn(message, 'sessionId');
      const requested = specified ? message.sessionId : null;
      if (specified && !(requested === null
          || (typeof requested === 'string' && requested.length > 0))) {
        return { ok: false, error: 'agent-send-session-invalid', outcomeKnown: true };
      }
      if (checkOnly === true) return custody.validOperationId(operationId)
        ? custody.sendReceiptStatus(operationId, requested)
        : { ok: false, error: 'agent-send-operation-id-invalid', outcomeKnown: true };
      if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty-message' };
      if (operationId !== null && !custody.validOperationId(operationId)) {
        return { ok: false, error: 'agent-send-operation-id-invalid' };
      }
      if (operationId && !custody.operationWindowValid(operationId)) {
        return custody.unknownSend(operationId, 'agent-send-operation-expired');
      }
      if (vault.isLocked()) return { ok: false, error: 'locked', outcomeKnown: true };
      const current = await sessionCache.sessionGet('currentSessionId');
      if (specified && (current ?? null) !== requested) return {
        ok: false, error: 'agent-send-session-mismatch', outcomeKnown: true,
        retryable: false, ...(operationId ? { operationId } : {}),
      };
      const sessionId = specified ? requested : current ?? null;
      const input = { ...message, text: text.trim(), sessionId };
      const prepared = await prepare(input);
      if (prepared?.ok !== true) return prepared;
      const binding = operationId ? {
        fingerprint: await custody.sendFingerprint({
          text, attachments, activeTabId, goal, sessionId,
        }), sessionId,
      } : { fingerprint: '', sessionId: null };
      return custody.withSendReceipt(operationId, binding, async () => {
        const controller = new AbortController();
        const runId = operationId ?? crypto.randomUUID();
        active.set(runId, { sessionId, controller });
        const settlement = Promise.resolve(withLifetime(
          () => execute(prepared, { ...input, signal: controller.signal }),
          { outcomeKnownOnLoss: false, code: 'agent-turn-lifetime-lost' },
        )).then((result) => {
          if (result?.outcomeKnown === false) {
            const error = new Error(result.error ?? result.code ?? 'agent-turn-outcome-unknown');
            Object.assign(error, { outcomeKnown: false });
            throw error;
          }
          return result;
        }).finally(() => {
          active.delete(runId);
          void Promise.resolve(pushState()).catch(() => {});
        });
        if (operationId) {
          return { __agentSendSettlement: settlement, response: { ok: true } };
        }
        settlement.catch(() => {});
        return { ok: true };
      });
    },
    'agent/stop': async () => {
      const sessionId = await sessionCache.sessionGet('currentSessionId') ?? null;
      let stopped = false;
      for (const run of active.values()) {
        if (run.sessionId !== sessionId) continue;
        stopped = true;
        run.controller.abort();
      }
      await stop(sessionId);
      if (stopped) void auditLog.append({
        type: 'session_ended', sessionId, details: { reason: 'user_stop' },
      }).catch(() => {});
      void Promise.resolve(pushState()).catch(() => {});
      return { ok: true };
    },
    activeCount: () => active.size,
  });
};
