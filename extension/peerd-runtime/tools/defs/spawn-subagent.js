// @ts-check
// spawn_subagent — decompose a task into a focused child agent.
//
// This is the THIN tool wrapper. All the orchestration lives in
// peerd-runtime/subagent/spawn.js; the SW binds it and injects the bound
// `spawnSubagent` into the tool context. Here we just resolve the
// caller's depth, hand off, and format the child's result for the model.
//
// The subagent is the same agent loop, scoped: it runs under the
// parent's permissions through the same six gates, inherits the provider
// key, and audits every step with parentage + depth. See docs/SUBAGENTS.md.

// why: the model's tool_result is re-sent on every subsequent turn, so a
// runaway subagent result would balloon the parent's context + rate-limit
// budget. Cap the returned text; the full transcript is always available
// in the side panel by expanding the card.
const MAX_RESULT_CHARS = 200 * 1024;

// why: the subagent orchestrator slots (spawnSubagent/spawnSubagentAsync) plus
// the lineage fields (toolUseId, session.depth) are SW-injected for this tool and
// live outside the base ToolContext; narrow ctx to them at the use site. The
// result shape mirrors makeSpawnSubagent's documented @returns (subagent/spawn.js).
/**
 * @typedef {{
 *   result: string, sessionId: string | null, toolCalls: number,
 *   durationMs: number, depth: number, exceeded?: true, refused?: true,
 * }} SpawnSubagentResult
 */
/**
 * @typedef {{
 *   task: string, tools?: string[], maxSteps?: number, maxDepth?: number,
 *   allowRecursion: boolean, parentSessionId: string, parentDepth: number,
 *   parentToolUseId?: string,
 * }} SpawnRequest
 */
/**
 * @typedef {{
 *   spawnSubagent?: (req: SpawnRequest) => Promise<SpawnSubagentResult>,
 *   spawnSubagentAsync?: (req: SpawnRequest) => Promise<{ ok: true, content: string } | { ok: false, error: string }>,
 *   toolUseId?: string,
 *   session?: { sessionId?: string, depth?: number },
 * }} SubagentCtx
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const spawnSubagentTool = {
  name: 'spawn_subagent',
  primitive: 'subagent',
  description: [
    'Spawn a focused subagent that runs its own agent loop on ONE task.',
    'ASYNC by default (non-blocking): returns immediately, your turn ends,',
    'and the child\'s result comes back as a NEW message on a LATER turn',
    'when it finishes — you and the user keep working meanwhile. Do NOT',
    'poll or re-spawn to wait; it returns on its own. Pass sync:true ONLY',
    'when your very next step needs the result THIS turn (fan out N',
    'reasoners, then compare). Use to DECOMPOSE — ✅ "go research X and',
    'report back" (async) / "compare 3 libraries now" (sync:true). ❌ work',
    'you can do this turn. PARALLEL = emit MULTIPLE calls in ONE message.',
    'Inherits your tools minus spawn_subagent (tools:[...] to scope, [] for',
    'pure reasoning), under your permissions.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The focused task for the subagent. Self-contained — the subagent sees only this, not your conversation.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional. Exact tool-name subset to grant. Omit to inherit your tools (minus spawn_subagent). [] = no tools.',
      },
      maxSteps: {
        type: 'integer',
        description: 'Optional. Max model+tool rounds the subagent may take (default 20).',
      },
      maxDepth: {
        type: 'integer',
        description: 'Optional. Spawn-depth ceiling (default 5). The spawn is refused past it.',
      },
      allowRecursion: {
        type: 'boolean',
        description: 'Optional. Keep spawn_subagent in the subagent\'s toolset so it can spawn its own children (default false).',
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
  // The tool itself touches no origins; the subagent's tools declare
  // their own and are gated individually.
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.task !== 'string' || args.task.trim().length === 0) {
      return { ok: false, error: 'task_required' };
    }
    // why: the orchestrator slots + lineage fields are SW-injected outside the
    // base ToolContext; narrow ctx to them (see SubagentCtx above).
    const sctx = /** @type {SubagentCtx} */ (/** @type {unknown} */ (ctx));
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
      // why: the dispatcher threads the tool_use_id into ctx so the live
      // event stream can be mapped to THIS card in the side panel.
      parentToolUseId: sctx.toolUseId,
    };

    // Default ASYNC (non-blocking, DESIGN-11): fire it, return a handle,
    // and the child's result re-enters this session as a later synthetic
    // turn. sync:true keeps the blocking path for "I need it THIS turn".
    if (args.sync !== true) {
      if (typeof sctx.spawnSubagentAsync !== 'function') {
        return { ok: false, error: 'async_subagent_unavailable' };
      }
      const res = await sctx.spawnSubagentAsync(req);
      return res.ok ? { ok: true, content: res.content } : { ok: false, error: res.error };
    }

    if (typeof sctx.spawnSubagent !== 'function') {
      return { ok: false, error: 'subagent_orchestrator_unavailable' };
    }
    const out = await sctx.spawnSubagent(req);
    if (out.refused) {
      // Surface a refusal as an error result so the model sees it clearly
      // and can adjust (e.g. stop trying to recurse deeper).
      return { ok: false, error: out.result };
    }
    return { ok: true, content: formatSubagentResult(out) };
  },
};

/** @param {SpawnSubagentResult} out */
const formatSubagentResult = (out) => {
  let result = out.result ?? '';
  if (result.length > MAX_RESULT_CHARS) {
    const head = result.slice(0, MAX_RESULT_CHARS);
    result = `${head}\n\n…[result truncated at ${MAX_RESULT_CHARS} chars — expand the card in the side panel for the full transcript]`;
  }
  const lines = [
    `subagent (session ${out.sessionId}, depth ${out.depth}) — `
      + `${out.toolCalls} tool call${out.toolCalls === 1 ? '' : 's'}, ${out.durationMs}ms${out.exceeded ? ' — HIT STEP CAP, result may be incomplete' : ''}`,
    '',
    result || '(subagent returned no text)',
  ];
  return lines.join('\n');
};
