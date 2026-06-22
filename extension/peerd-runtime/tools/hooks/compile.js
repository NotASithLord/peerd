// @ts-check
// Compile a user-authored hook record into a runnable Hook.
//
// SHAPE OF A USER HOOK. The user authors hooks as markdown-with-
// frontmatter + a JS body — Claude-Code-style — in the logical path
// `.peerd/hooks/<id>.md`. peerd has no real filesystem, so on disk this
// is a serializable record (see UserHookRecord) stored in
// chrome.storage.local. The markdown front-matter carries the metadata
// (event, match, order); the fenced ```js block carries the body.
//
//   ---
//   id: block-paste-secrets
//   event: pre-tool-use
//   match: type
//   order: 50
//   ---
//   Block the `type` tool from typing anything that looks like an API key.
//
//   ```js
//   // `inv` is the HookInvocation: { event, toolName, args, ctx }.
//   if (/sk-[a-zA-Z0-9]{20,}/.test(inv.args.text ?? '')) {
//     return { action: 'block', reason: 'looks like a secret' };
//   }
//   ```
//
// parseHookMarkdown() splits that into a UserHookRecord; compileUserHook()
// turns the record into a Hook the runner can run.
//
// THE TRUST BOUNDARY (why this is careful). A hook body is code the user
// asked us to run. We do NOT eval arbitrary remote strings — MV3 CSP
// forbids it and the lethal-trifecta posture forbids it harder. V1
// supports two body kinds:
//
//   - 'js'    a function body compiled via `new Function('inv', body)`.
//             This is gated: it only works when the record is marked
//             trusted AND the host environment permits Function
//             construction (it does in the SW's own world; it will be
//             refused under a strict CSP, which is the correct
//             fail-closed result — a hook that can't compile doesn't run
//             and, for a pre-hook, the dispatcher treats "no hook" as no
//             veto, while the ALWAYS-ON default egress hook is code, not
//             config, so it can never be disabled this way).
//   - 'declarative'  no code at all: a small JSON match/deny rule
//             (matchArg + pattern → block). Safe to run anywhere, no
//             Function construction. This is the recommended shape and
//             what the example browser-native hook below uses.
//
// V1.x will add a WebVM/shell body kind (run the hook as a shell script
// in the sandboxed Linux VM) — see DEV-NOTES "V1.x gaps". The compile
// seam is here so that lands without touching the runner or dispatcher.

/**
 * @typedef {Object} UserHookRecord     the serializable on-"disk" form
 * @property {string} id
 * @property {'pre-tool-use' | 'post-tool-use'} event
 * @property {boolean} [enabled]
 * @property {number} [order]
 * @property {string} [match]            tool-name glob; default '*'
 * @property {'js' | 'declarative'} kind
 * @property {boolean} [trusted]         required true for kind:'js' to compile
 * @property {string} [body]             JS function body (kind:'js')
 * @property {Object} [rule]             declarative rule (kind:'declarative')
 * @property {string} [rule.matchArg]    arg name to test, e.g. 'url' or 'text'
 * @property {string} [rule.pattern]     RegExp source tested against String(arg)
 * @property {'block' | 'allow'} [rule.onMatch]   default 'block'
 * @property {string} [rule.reason]
 * @property {string} [doc]              human-readable prose (the markdown body)
 */

/**
 * Build a declarative hook's run() from a {matchArg, pattern, onMatch}
 * rule. Pure, no Function construction — safe under any CSP. The RegExp
 * is compiled once at compile time; a bad pattern throws here (caught by
 * the registry, which skips the hook) rather than per-invocation.
 *
 * @param {UserHookRecord} record
 * @returns {import('./runner.js').Hook['run']}
 */
const buildDeclarativeRun = (record) => {
  const { matchArg, pattern, onMatch = 'block', reason } = record.rule ?? {};
  if (typeof matchArg !== 'string' || typeof pattern !== 'string') {
    throw new TypeError(`hook '${record.id}': declarative rule needs matchArg + pattern`);
  }
  const re = new RegExp(pattern); // throws on bad source → registry skips
  return (inv) => {
    const value = inv.args?.[matchArg];
    const hit = value != null && re.test(String(value));
    if (!hit) return { action: 'allow', reason: `${record.id}: '${matchArg}' did not match /${pattern}/` };
    if (onMatch === 'allow') return { action: 'allow', reason: reason ?? `${record.id}: explicit allow` };
    return { action: 'block', reason: reason ?? `${record.id}: '${matchArg}' matched /${pattern}/` };
  };
};

/**
 * Build a JS hook's run() by compiling its body. Gated behind
 * record.trusted to make the decision to run user code explicit and
 * auditable. Function construction can fail (strict CSP) — we let that
 * throw so the registry skips the hook (fail-closed: it won't run).
 *
 * @param {UserHookRecord} record
 * @returns {import('./runner.js').Hook['run']}
 */
const buildJsRun = (record) => {
  if (record.trusted !== true) {
    throw new Error(`hook '${record.id}': kind:'js' requires trusted:true (user must opt in to running hook code)`);
  }
  if (typeof record.body !== 'string' || !record.body.trim()) {
    throw new TypeError(`hook '${record.id}': kind:'js' needs a non-empty body`);
  }
  // why: async wrapper so a hook body may `await` (e.g. ctx.kv reads).
  // The body sees exactly one binding — `inv` — and returns a decision.
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  // why: intentional dynamic compilation of a trusted (trusted:true,
  // user-opted-in) hook body. Gated above. (No eslint-disable needed:
  // no-new-func only matches the `Function` global, not this indirect
  // AsyncFunction constructor.)
  const fn = new AsyncFunction('inv', record.body);
  return (inv) => fn(inv);
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
  if (record.event !== 'pre-tool-use' && record.event !== 'post-tool-use') {
    throw new TypeError(`hook '${record.id}': invalid event '${record.event}'`);
  }
  let run;
  if (record.kind === 'declarative') run = buildDeclarativeRun(record);
  else if (record.kind === 'js') run = buildJsRun(record);
  else throw new TypeError(`hook '${record.id}': unknown kind '${record.kind}'`);

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

/**
 * Tiny frontmatter splitter. NOT a full YAML parser — we deliberately
 * avoid vendoring one (security-sensitive codebase, audits every dep).
 * Supports the flat `key: value` lines our frontmatter uses, coercing
 * true/false/numbers, plus a single nested `rule:` block of indented
 * `  key: value` lines. Anything fancier is out of scope for V1
 * authoring; the runtime never depends on this — it consumes records.
 *
 * @param {string} text
 * @returns {{ meta: Record<string, any>, body: string }}
 */
const parseFrontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  /** @type {Record<string, any>} */
  const meta = {};
  /** @type {Record<string, any> | null} */
  let rule = null;
  for (const raw of m[1].split('\n')) {
    if (!raw.trim()) continue;
    const indented = /^\s+/.test(raw);
    const kv = /^\s*([\w-]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, key, valRaw] = kv;
    if (key === 'rule' && valRaw.trim() === '') { rule = {}; meta.rule = rule; continue; }
    const val = coerce(valRaw.trim());
    if (indented && rule) rule[key] = val;
    else meta[key] = val;
  }
  return { meta, body: m[2] };
};

/** @param {string} s @returns {string | number | boolean} */
const coerce = (s) => {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s !== '' && !Number.isNaN(Number(s))) return Number(s);
  return s.replace(/^["']|["']$/g, '');
};

/**
 * Parse a markdown-with-frontmatter hook file into a UserHookRecord.
 * The frontmatter supplies metadata; the prose before the code fence is
 * the `doc`; the first ```js fence is the body (kind:'js'). A YAML
 * `rule:` block in frontmatter yields kind:'declarative' instead. This
 * is the authoring ergonomics layer — the editor/importer calls it, the
 * runtime only ever sees the resulting record.
 *
 * @param {string} text
 * @returns {UserHookRecord}
 */
export const parseHookMarkdown = (text) => {
  const { meta, body: markdownBody } = parseFrontmatter(text);
  if (!meta || typeof meta.id !== 'string') {
    throw new TypeError('parseHookMarkdown: frontmatter must set at least `id` and `event`');
  }
  const codeMatch = /```(?:js|javascript)\n([\s\S]*?)```/.exec(markdownBody);
  const doc = markdownBody.replace(/```[\s\S]*?```/g, '').trim();
  /** @type {UserHookRecord} */
  const record = {
    id: meta.id,
    event: meta.event,
    enabled: meta.enabled !== false,
    order: typeof meta.order === 'number' ? meta.order : undefined,
    match: typeof meta.match === 'string' ? meta.match : undefined,
    doc,
    kind: meta.rule ? 'declarative' : 'js',
  };
  if (meta.rule) {
    record.rule = meta.rule;
  } else {
    record.trusted = meta.trusted === true;
    record.body = codeMatch ? codeMatch[1].trim() : '';
  }
  return record;
};
