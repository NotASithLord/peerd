// @ts-check
// eval/om2w-actions — pure mapping from peerd tool calls to Online-Mind2Web
// "Grammar A" action strings (schema online-mind2web-v2).
//
// The OM2W judge consumes an action_history of factual page actions. peerd's
// turn/tool-use events carry { name, input }; this module decides (a) whether a
// tool call IS a page action (reads/orchestration are not — the README:
// "The action history should contain only the factual actions taken by the
// agent"), and (b) how to phrase it. Reference format (data/example/example_v2):
//   page -> NAVIGATE -> <description>
//   CLICK <target> -> <description> | SUCCESS
//   TYPE [css] -> <description> | FAILED
//   TASK_COMPLETE -> ANSWER: <final answer>
// Pure — no IO; bun-tested. The eval runner supplies the tool result's ok flag
// for the status suffix; the exporter appends the TASK_COMPLETE step.

/** Truncate free text for an action description (keeps result.json readable). */
/** @param {string} s @param {number} [max] */
const clip = (s, max = 80) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The page-action mapping for one peerd tool call, or null when the call is
 * not a page action (reads, delegation, compute — excluded from action_history).
 * @param {string} name  tool name from turn/tool-use
 * @param {Record<string, any>} [input]  tool args from turn/tool-use
 * @returns {{ verb: string, target: string, description: string } | null}
 */
export const pageActionFor = (name, input = {}) => {
  const selTarget = () => {
    if (typeof input.selector === 'string' && input.selector) return `[${input.selector}]`;
    if (typeof input.ref === 'string' && input.ref) return `ref=${input.ref}`;
    return 'page';
  };
  switch (name) {
    case 'navigate':
      return { verb: 'NAVIGATE', target: 'page', description: `navigate to ${String(input.url ?? '')}` };
    case 'open_tab':
      return { verb: 'NAVIGATE', target: 'page', description: `open a tab at ${String(input.url ?? '')}` };
    case 'click': {
      const nth = typeof input.nth === 'number' ? ` (nth=${input.nth})` : '';
      return { verb: 'CLICK', target: selTarget(), description: `click ${selTarget()}${nth}` };
    }
    case 'type':
      return { verb: 'TYPE', target: selTarget(), description: `type "${clip(String(input.text ?? ''))}"` };
    case 'page_keys':
      return { verb: 'PRESS_KEY', target: 'page', description: `press ${clip(String(input.keys ?? ''))}` };
    default:
      // Everything else — snapshot/read_page/read_state/query_dom/watch_changes
      // (perception), message_actor/actor_list (orchestration), fetch_url (HTTP,
      // not a page action), js_*/vm_*/app_* (compute), page_code (coarse script;
      // OM2W runs use the tool-call surface) — is NOT a page action.
      return null;
  }
};

/**
 * The page-action mapping for one page.* op (the CODE surface's real actions,
 * announced by the SW page-program routes as 'page/op' events). A page_code tool
 * call is ONE opaque tool_use; its factual page actions are these inner ops —
 * without them a code-arm trajectory records as [navigate, answer] and the
 * judge can't see the work. goto/click/fill act; snapshot/content perceive
 * (excluded, same rule as the tool mapping above).
 * @param {string} method  page.* method from the page/op event
 * @param {Record<string, any>} [args]
 * @returns {{ verb: string, target: string, description: string } | null}
 */
export const pageActionForOp = (method, args = {}) => {
  switch (method) {
    case 'goto': return pageActionFor('navigate', { url: args.url });
    case 'click': return pageActionFor('click', args);
    case 'fill': return pageActionFor('type', { selector: args.selector, text: args.text });
    default:
      // snapshot / content — perception, not page actions.
      return null;
  }
};

/**
 * Format one action as a Grammar A string, reference style: navigations read
 * `page -> NAVIGATE -> <desc>`; targeted verbs read `<VERB> <target> -> <desc>`.
 * A known outcome appends ` | SUCCESS` / ` | FAILED` (must agree with the
 * step's action_status field, per the schema).
 * @param {{ verb: string, target: string, description: string }} a
 * @param {'SUCCESS' | 'FAILED' | null} [status]
 * @returns {string}
 */
export const formatAction = (a, status = null) => {
  const base = a.verb === 'NAVIGATE'
    ? `page -> NAVIGATE -> ${a.description}`
    : `${a.verb} ${a.target} -> ${a.description}`;
  return status ? `${base} | ${status}` : base;
};

/** The synthesized step-0 action (the harness's initial navigation to the task's website). @param {string} url */
export const initialNavigation = (url) => formatAction({ verb: 'NAVIGATE', target: 'page', description: `Initial navigation to ${url}` });

/** The final TASK_COMPLETE action; its text must match agent_final_answer (modulo whitespace). @param {string} answer */
export const taskComplete = (answer) => `TASK_COMPLETE -> ANSWER: ${answer}`;
