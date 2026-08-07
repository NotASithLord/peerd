// @ts-check
// actor_create — decompose a task into a focused child agent.
//
// This is the THIN tool wrapper. All the orchestration lives in
// peerd-runtime/actor/spawn.js; the SW binds it and injects the bound
// `spawnActor` into the tool context. Here we just resolve the
// caller's depth, hand off, and format the child's result for the model.
//
// The actor is the same agent loop, scoped: it runs under the
// parent's permissions through the same six gates, inherits the provider
// key, and audits every step with parentage + depth.

import { wrapUntrusted } from '../prompt-wrap.js';

// why: the model's tool_result is re-sent on every subsequent turn, so a
// runaway actor result would balloon the parent's context + rate-limit
// budget. Cap the returned text; the full transcript is always available
// in the side panel by expanding the card.
const MAX_RESULT_CHARS = 200 * 1024;

// why: the actor orchestrator slots (spawnActor/spawnActorAsync) plus
// the lineage fields (toolUseId, session.depth) are SW-injected for this tool and
// live outside the base ToolContext; narrow ctx to them at the use site. The
// result shape mirrors makeSpawnActor's documented @returns (actor/spawn.js).
/**
 * @typedef {{
 *   result: string, sessionId: string | null, toolCalls: number,
 *   durationMs: number, depth: number, exceeded?: true, refused?: true,
 *   timedOut?: true, stopped?: true, executionFailed?: true, outcomeKnown?: boolean,
 * }} SpawnActorResult
 */
/**
 * @typedef {{
 *   task: string, tools?: string[], maxSteps?: number, maxDepth?: number,
 *   allowRecursion: boolean, parentSessionId: string, parentDepth: number,
 *   parentInbound: boolean, parentToolUseId?: string,
 * }} SpawnRequest
 */
/**
 * @typedef {{
 *   spawnActor?: (req: SpawnRequest) => Promise<SpawnActorResult>,
 *   spawnActorAsync?: (req: SpawnRequest) => Promise<{ ok: true, content: string } | { ok: false, error: string }>,
 *   toolUseId?: string,
 *   session?: { sessionId?: string, depth?: number },
 *   inbound?: boolean,
 * }} ActorCtx
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const actorCreateTool = {
  name: 'actor_create',
  primitive: 'spawned',
  description: [
    'Spawn a focused actor that runs its own agent loop on ONE task.',
    'ASYNC by default (non-blocking): returns immediately, your turn ends,',
    'and the child\'s result comes back as a NEW message on a LATER turn',
    'when it finishes — you and the user keep working meanwhile. Do NOT',
    'poll or re-spawn to wait; it returns on its own. Pass sync:true ONLY',
    'when your very next step needs the result THIS turn (fan out N',
    'reasoners, then compare). Use to DECOMPOSE — ✅ "go research X and',
    'report back" (async) / "compare 3 libraries now" (sync:true). ❌ work',
    'you can do this turn. PARALLEL = emit MULTIPLE calls in ONE message.',
    'Inherits your tools minus actor_create (tools:[...] to scope, [] for',
    'pure reasoning), under your permissions. This actor is EPHEMERAL — it',
    'lives for the task and has no address. Bound actors (a sandbox\'s or',
    'the web actor\'s) are reached via message_actor instead.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The focused task for the actor. Self-contained — the actor sees only this, not your conversation.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional. Exact tool-name subset to grant. Omit to inherit your tools (minus actor_create). [] = no tools.',
      },
      maxSteps: {
        type: 'integer',
        description: 'Optional. Max model+tool rounds the actor may take (default 20).',
      },
      maxDepth: {
        type: 'integer',
        description: 'Optional. Spawn-depth ceiling (default 5). The spawn is refused past it.',
      },
      allowRecursion: {
        type: 'boolean',
        description: 'Optional. Keep actor_create in the actor\'s toolset so it can spawn its own children (default false).',
      },
      sync: {
        type: 'boolean',
        description: 'Optional. true = BLOCK and return the result in THIS turn (use when your next step needs it). Default false = async: the result arrives on a later turn; do not wait or poll.',
      },
    },
    required: ['task'],
  },
  // why: write, not mutate_external — spawning creates a child session
  // and runs the loop, but every network/DOM effect the CHILD produces
  // goes through the child's own six gates. Nothing escapes here that
  // wasn't already gated downstream.
  sideEffect: 'write',
  // The tool itself touches no origins; the actor's tools declare
  // their own and are gated individually.
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.task !== 'string' || args.task.trim().length === 0) {
      return { ok: false, error: 'task_required' };
    }
    // why: the orchestrator slots + lineage fields are SW-injected outside the
    // base ToolContext; narrow ctx to them (see ActorCtx above).
    const sctx = /** @type {ActorCtx} */ (/** @type {unknown} */ (ctx));
    const parentSessionId = sctx.session?.sessionId;
    if (!parentSessionId) {
      return { ok: false, error: 'no_parent_session' };
    }

    /** @type {SpawnRequest} */
    const req = {
      task: args.task,
      tools: Array.isArray(args.tools) ? args.tools : undefined,
      maxSteps: Number.isFinite(args.maxSteps) ? args.maxSteps : undefined,
      maxDepth: Number.isFinite(args.maxDepth) ? args.maxDepth : undefined,
      allowRecursion: args.allowRecursion === true,
      parentSessionId,
      // why: ctx.session.depth is the spawner's depth; the child is +1.
      // buildToolContext defaults it to 0 for legacy sessions.
      parentDepth: sctx.session?.depth ?? 0,
      // Trusted-lineage stamping (delegation-lineage.js): the SPAWNING turn's
      // untrusted-origin flag, folded by buildToolContext (synthetic && !trusted,
      // always set on a real ctx). FAIL-CLOSED coercion: spawn.js trusts the
      // child ONLY on an explicit `parentInbound === false`, so an ABSENT flag
      // (a ctx that never folded it) must read as inbound — taint, never pass.
      parentInbound: sctx.inbound === false ? false : true,
      // why: the dispatcher threads the tool_use_id into ctx so the live
      // event stream can be mapped to THIS card in the side panel.
      parentToolUseId: sctx.toolUseId,
    };

    // Default ASYNC (non-blocking, DESIGN-11): fire it, return a handle,
    // and the child's result re-enters this session as a later synthetic
    // turn. sync:true keeps the blocking path for "I need it THIS turn".
    if (args.sync !== true) {
      if (typeof sctx.spawnActorAsync !== 'function') {
        return { ok: false, error: 'async_actor_unavailable' };
      }
      const res = await sctx.spawnActorAsync(req);
      return res.ok ? { ok: true, content: res.content } : { ok: false, error: res.error };
    }

    if (typeof sctx.spawnActor !== 'function') {
      return { ok: false, error: 'actor_orchestrator_unavailable' };
    }
    let out;
    try {
      out = await sctx.spawnActor(req);
    } catch (error) {
      const failure = /** @type {{ message?: string, performed?: boolean, outcomeKnown?: boolean, retryable?: boolean }} */ (error);
      if (failure.outcomeKnown === false) {
        return {
          ok: false,
          error: 'Actor execution failed after work began. Its outcome is unknown. Do not retry automatically. The actor transcript could not be saved reliably.',
          performed: true,
          outcomeKnown: false,
          retryable: false,
        };
      }
      throw error;
    }
    if (out.refused) {
      // Surface a refusal as an error result so the model sees it clearly
      // and can adjust (e.g. stop trying to recurse deeper).
      return { ok: false, error: out.result };
    }
    const outcomeUnknown = out.outcomeKnown === false
      || (out.executionFailed === true && out.outcomeKnown !== true);
    if (outcomeUnknown) {
      return {
        ok: false,
        error: formatActorResult(out),
        performed: true,
        outcomeKnown: false,
        retryable: false,
      };
    }
    if (out.executionFailed === true) {
      return {
        ok: false,
        error: formatActorResult(out),
        performed: false,
        outcomeKnown: true,
        retryable: true,
      };
    }
    return { ok: true, content: formatActorResult(out) };
  },
};

/** @param {SpawnActorResult} out */
const formatActorResult = (out) => {
  let result = out.result ?? '';
  if (result.length > MAX_RESULT_CHARS) {
    const head = result.slice(0, MAX_RESULT_CHARS);
    result = `${head}\n\n…[result truncated at ${MAX_RESULT_CHARS} chars — expand the card in the side panel for the full transcript]`;
  }
  const outcomeUnknown = out.outcomeKnown === false
    || (out.executionFailed === true && out.outcomeKnown !== true);
  const flag = outcomeUnknown ? ' — EXECUTION FAILED AFTER WORK BEGAN'
    : out.executionFailed ? ' — FAILED BEFORE TARGET WORK RAN'
    : out.timedOut ? ' — HIT WALL-CLOCK TIMEOUT, result is partial'
    : out.stopped ? ' — STOPPED before finishing, result is partial'
    : out.exceeded ? ' — HIT STEP CAP, result may be incomplete' : '';
  // why UNTRUSTED (parity with the async path, async-actors.js): the child's
  // result is model-authored from a fresh context over possibly page-derived
  // bytes, so it is DATA to the parent, not instructions. Only the one-line
  // framing above is trusted; the body is fenced so a prompt injection the child
  // relayed can't steer the parent. The sync path fenced nothing before (MED-1).
  const wrapped = wrapUntrusted({ origin: 'spawned', tool: 'actor_create', body: result || '(actor returned no text)' });
  const lines = [
    ...(outcomeUnknown
      ? ['Actor execution failed after work began. Its outcome is unknown. Do not retry automatically.', '']
      : []),
    `actor (session ${out.sessionId}, depth ${out.depth}) — `
      + `${out.toolCalls} tool call${out.toolCalls === 1 ? '' : 's'}, ${out.durationMs}ms${flag}`,
    '',
    wrapped,
  ];
  return lines.join('\n');
};
