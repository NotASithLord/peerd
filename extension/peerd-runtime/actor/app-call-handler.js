// @ts-check
// Imperative shell for app_code inner operations. Each call is translated to an
// existing App runtime tool and dispatched under the bound actor's ordinary
// gates, confirmations, audit trail, and exact-instance pin.

import { appCallToToolCall, shapeAppResult } from './app-api.js';

/** @param {unknown} error */
const message = (error) => error instanceof Error ? error.message : String(error);

/**
 * @param {{dispatchToolCall:(call:any,ctx:any)=>Promise<any>,buildActorContext:(binding:{sessionId:string,appId:string})=>Promise<any>|any}} deps
 */
export const makeAppCallHandler = ({ dispatchToolCall, buildActorContext }) => async (
  /** @type {{method:string,args?:object,sessionId:string,appId:string,rid?:string|number,signal?:AbortSignal}} */ req,
) => {
  if (req.signal?.aborted) return { ok: false, error: 'app_call_aborted' };
  let translated;
  try { translated = appCallToToolCall(req); }
  catch (error) { return { ok: false, error: message(error) }; }

  let ctx;
  try { ctx = await buildActorContext({ sessionId: req.sessionId, appId: req.appId }); }
  catch (error) { return { ok: false, error: `app_context_unavailable: ${message(error)}` }; }
  if (req.signal?.aborted) return { ok: false, error: 'app_call_aborted' };
  if (req.signal) ctx = { ...ctx, abortSignal: req.signal };

  const call = {
    name: translated.name,
    args: { ...translated.args },
    id: `app-${req.rid ?? ''}-${crypto.randomUUID()}`,
  };
  try {
    const result = await dispatchToolCall(call, ctx);
    const outcomeUnknown = result?.outcomeKnown === false
      || result?.outcomeKind === 'transport-lost'
      || result?.outcomeKind === 'host-lost'
      || result?.endTurnOutcomeKind === 'transport-lost'
      || result?.endTurnOutcomeKind === 'host-lost'
      || result?.structured?.recovery?.state === 'outcome_unknown';
    if (outcomeUnknown) return {
      ok: false,
      error: result?.error ?? 'app_action_outcome_unknown',
      outcomeKnown: false,
      outcomeKind: result?.outcomeKind ?? result?.endTurnOutcomeKind ?? 'transport-lost',
    };
    if (req.signal?.aborted) return {
      ok: false,
      error: 'app_call_aborted_after_dispatch',
      outcomeKnown: false,
      outcomeKind: 'transport-lost',
    };
    if (result?.ok !== true) return {
      ok: false,
      error: result?.error ?? `app.${req.method} failed`,
      outcomeKnown: true,
      outcomeKind: result?.outcomeKind ?? 'pre-effect-failure',
    };
    return { ok: true, value: shapeAppResult(req.method, result) };
  } catch (error) {
    return {
      ok: false,
      error: `app_dispatch_failed: ${message(error)}`,
      outcomeKnown: false,
      outcomeKind: 'transport-lost',
    };
  }
};
