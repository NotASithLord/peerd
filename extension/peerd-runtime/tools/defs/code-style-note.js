// @ts-check
// Shared JS-style reminder, disclosed in the RESULT of js_create and
// app_create — the moment the agent commits to writing Notebook or App code.
//
// why it rides the create result, not the base system prompt: progressive
// disclosure. Tasks that never spin up a Notebook or App don't pay the tokens,
// and the guidance lands exactly when the agent is about to write JS — for
// both execution kinds, from one source of truth. Kept terse on purpose
// (context budget); it mirrors the house style enforced in eslint.config.js.
export const CODE_STYLE_NOTE = [
  '<code-style>',
  'Write modern, readable JS: const/let (never var), arrow callbacks, template',
  'literals, ?. and ??. Prefer .map()/.filter()/.forEach()/for...of over C-style',
  'for(;;) loops. Name things in full so the code reads like its docs (renderRow,',
  'not r). Comment the WHY, not the what.',
  '</code-style>',
].join('\n');

// App-runtime gotcha, NOT style: the sandboxed opaque-origin iframe has no file
// server, so cross-file ES modules don't resolve and a Worker can't load by path
// (composeApp rewrites `new Worker('worker.js')` to a blob worker). The agent
// burned several turns hand-rolling workers before this was written down. Lives
// HERE (with the other create-time notes) so it has ONE source: app_create
// discloses it in its result (flag-OFF), and the App RESIDENT — the agent that
// actually writes the page files — gets it in its lore (flag-ON, system-prompt.js).
export const APP_RUNTIME_NOTE = [
  '<app-runtime>',
  'The App runs in a sandboxed, opaque-origin iframe with NO file server, so your',
  'page scripts CANNOT use cross-file ES modules: import/export BETWEEN your files',
  "won't resolve (there's no URL to fetch ./other.js from) and the app silently",
  'fails to start. Put your JS in classic <script> tags (multiple tags share ONE',
  'global scope — define in one, use in the next) OR a single self-contained',
  '<script type="module"> with no relative imports. Same for CSS: inline <style> or',
  'tag-relative <link href="./x.css"> (peerd inlines those).',
  'For heavy compute, put the work in its own file and use new Worker(\'worker.js\')',
  "— it runs automatically (wired to a blob worker). Keep the worker self-contained:",
  "a blob worker can't import other app files. Or tile work across",
  'requestAnimationFrame frames; for pure no-UI compute, js_create/js_run are simpler.',
  '</app-runtime>',
].join('\n');

// CORRECTNESS, not style: the JS footguns that yield a WRONG ANSWER (silently),
// plus the nudge to reach for the stdlib instead of hand-rolling. Disclosed
// where the agent writes compute JS — js_run (once per session) and js_create
// (Notebook). Deliberately general, not a recipe for any one problem; kept terse
// for the same context-budget reason as CODE_STYLE_NOTE.
export const JS_PITFALLS_NOTE = [
  '<js-correctness>',
  'Reach for the stdlib before hand-rolling: import { sum, mean, median, stdev,',
  'quantile, groupBy, countBy, sumBy, range, chunk, clamp, gcd, factorial, divmod,',
  'divDecimal } from \'peerd:std\', and prefer Array methods over manual index',
  'loops (fewer off-by-one bugs). Footguns that give a WRONG answer, not just',
  'ugly code:',
  '- Default to EXACT arithmetic — nothing supersedes a correct answer. Floats are',
  '  for genuinely real-valued work (stats, geometry); never reach for them for',
  '  integers, money, or ratios you want exact.',
  '- Numbers lose precision past 2**53 — use BigInt (1n, a*b, a+b) for exact',
  '  large-integer math (factorials, big sums/counters, ids). Once a value is',
  '  BigInt, STAY in BigInt: Number(big) re-rounds it back to a lossy float — the',
  '  #1 way an already-exact answer silently goes wrong. To DIVIDE, a/b floors and',
  '  DROPS the fraction — use divmod(a, b) for { quotient, remainder } or',
  '  divDecimal(a, b, places) for an exact decimal string; never Number(a)/Number(b).',
  '  JSON has no BigInt: return String(x).',
  '- Floats are inexact (0.1 + 0.2 !== 0.3) — never compare floats with ===; round',
  '  for money/display.',
  '- Default .sort() orders as STRINGS — pass a comparator for numbers,',
  '  .sort((a, b) => a - b).',
  'Then sanity-check the result against one value you already know before trusting it.',
  '</js-correctness>',
].join('\n');
