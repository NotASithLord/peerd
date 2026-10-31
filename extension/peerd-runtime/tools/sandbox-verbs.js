// @ts-check
// One verb family for the sandbox actors' model surface.
//
// Each engine actor (WebVM, Notebook, Pod, App) owns one instance and sees only
// its own kind's tools. Historically the same action had a different name per
// kind: `vm_write_file` / `js_write_file` / `pod_write` / `app_write_file`.
// A bound engine actor now sees one family instead: `sandbox_exec`,
// `sandbox_write`, `sandbox_read`. Kind-only operations (vm_import,
// pod_status, app_update, edit_file, repo_*, …) keep their names.
//
// Deliberately NOT in the family:
//   - destroying the instance (vm_delete / js_delete / pod_destroy /
//     app_delete). Next to sandbox_write and sandbox_read, a "sandbox_delete"
//     reads like deleting a file, and the call destroys the actor's own
//     instance irreversibly. An irreversible operation keeps an unambiguous name.
//   - the App's app_code. It plays the running App through observe/act, which
//     is not "run code in the sandbox" as it is for the other three kinds.
//     Giving both the same verb would teach a wrong generalization.
//
// why a PROJECTION, not a rename: the canonical per-kind names are the
// semantic catalog keys, and the catalog is what ownership families, exact
// operation grants, gates, instance pins, the operation log and the audit trail
// are keyed by. Renaming those would move every security check. Instead:
//   - outbound, the actor's descriptors (and its prompt text) are projected to
//     the verb names, keeping each kind's own description and schema, so a VM
//     actor still learns that `cmd` runs bash;
//   - inbound, a verb call is translated back to its kind's canonical name
//     before dispatch, so every gate sees exactly what it saw before;
//   - the transcript and loop events leave the worker under canonical names,
//     so persistence, audit labels, the UI and evals never see a verb; prior
//     turns are projected again on the way back in, so the history the model
//     re-reads matches the tools it is shown.
// The verbs therefore exist only inside one actor model call's view. The one
// exception is a verb the actor's kind does not have: that call is refused and
// stays recorded under the name the model used, since no canonical tool exists.
// Translation is pure naming. The service worker still enforces each actor's
// canonical allow-set and exact operation grant, so a hostile worker that sent
// a canonical name directly gains nothing it did not already have.
//
// Pure: no browser, worker or catalog imports. Bun-testable.

/** The engine actor kinds whose surface is projected. */
export const SANDBOX_ACTOR_TYPES = Object.freeze(['webvm', 'notebook', 'pod', 'app']);

/**
 * verb → (actor kind → canonical tool). A kind with no entry for a verb has no
 * such operation (a WebVM has no text read tool), and the verb is simply not
 * offered to it.
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const SANDBOX_VERBS = Object.freeze({
  sandbox_exec: Object.freeze({
    webvm: 'vm_boot', notebook: 'js_notebook', pod: 'pod_exec',
  }),
  sandbox_write: Object.freeze({
    webvm: 'vm_write_file', notebook: 'js_write_file', pod: 'pod_write', app: 'app_write_file',
  }),
  sandbox_read: Object.freeze({
    notebook: 'js_read_file', pod: 'pod_read', app: 'app_read_file',
  }),
});

/** @param {unknown} actorType */
export const isSandboxActorType = (actorType) =>
  typeof actorType === 'string' && SANDBOX_ACTOR_TYPES.includes(actorType);

/**
 * canonical → verb for one kind (empty for any other actor type).
 * @param {unknown} actorType @returns {ReadonlyMap<string, string>}
 */
export const sandboxVerbsFor = (actorType) => new Map(!isSandboxActorType(actorType) ? [] :
  Object.entries(SANDBOX_VERBS).flatMap(([verb, byKind]) => {
    const canonical = byKind[/** @type {string} */ (actorType)];
    return canonical ? [[canonical, verb]] : [];
  }));

/**
 * The canonical tool a model-facing name refers to for this actor kind.
 * A verb this kind does not have maps to null, so the caller refuses it like
 * any unknown tool. Any other name passes through unchanged.
 * @param {unknown} actorType @param {string} name @returns {string | null}
 */
export const canonicalSandboxToolName = (actorType, name) => {
  if (!isSandboxActorType(actorType) || !Object.hasOwn(SANDBOX_VERBS, name)) return name;
  return SANDBOX_VERBS[name][/** @type {string} */ (actorType)] ?? null;
};

/** @param {string} value */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rewrite this kind's canonical tool names to their verbs in model-facing text
 * (descriptions, the actor prompt). Whole identifiers only: `app_read_file` is
 * never matched inside a longer identifier.
 * @param {unknown} actorType @param {string} text @returns {string}
 */
export const projectSandboxText = (actorType, text) => {
  const verbs = sandboxVerbsFor(actorType);
  if (verbs.size === 0 || typeof text !== 'string') return text;
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_])(${[...verbs.keys()].map(escapeRegExp).join('|')})(?![A-Za-z0-9_])`, 'g',
  );
  return text.replace(pattern, (canonical) => verbs.get(canonical) ?? canonical);
};

/**
 * Project an actor's tool descriptors to the verb family: each canonical
 * engine tool takes its verb name and keeps its own description (with
 * cross-references rewritten) and schema. Other descriptors keep their name
 * but have their descriptions' cross-references rewritten too.
 * @template {{ name: string, description?: string }} T
 * @param {unknown} actorType @param {ReadonlyArray<T>} tools @returns {T[]}
 */
export const projectSandboxTools = (actorType, tools) => {
  const verbs = sandboxVerbsFor(actorType);
  if (verbs.size === 0) return [...tools];
  const projected = tools.map((tool) => ({
    ...tool,
    name: verbs.get(tool.name) ?? tool.name,
    ...(typeof tool.description === 'string'
      ? { description: projectSandboxText(actorType, tool.description) } : {}),
  }));
  // why: a provider rejects a request with two tools of one name. That can
  // only happen if a catalog tool ever takes a verb's name; fail loudly here
  // rather than in a model call.
  const names = new Set(projected.map((tool) => tool.name));
  if (names.size !== projected.length) {
    throw new TypeError(`sandbox verb projection produced a duplicate tool name for ${String(actorType)}`);
  }
  return projected;
};

/**
 * Rename assistant tool-use names through `rename` (null/undefined keeps the
 * name). Results are keyed by id, so only tool uses change. Messages that need
 * no change are returned as-is.
 * @param {ReadonlyArray<any>} messages @param {(name: string) => string | null | undefined} rename
 * @returns {any[]}
 */
const renameToolUses = (messages, rename) => messages.map((message) => {
  let next = message;
  if (Array.isArray(message?.toolUses)) {
    let changed = false;
    const toolUses = message.toolUses.map((/** @type {any} */ use) => {
      const name = typeof use?.name === 'string' ? rename(use.name) : null;
      if (!name || name === use.name) return use;
      changed = true;
      return { ...use, name };
    });
    if (changed) next = { ...next, toolUses };
  }
  // why results too: a result the loop builds itself (invalid arguments,
  // abort, timeout) stamps meta.toolName with the name the model used.
  if (Array.isArray(message?.toolResults)) {
    let changed = false;
    const toolResults = message.toolResults.map((/** @type {any} */ result) => {
      const current = result?.meta?.toolName;
      const name = typeof current === 'string' ? rename(current) : null;
      if (!name || name === current) return result;
      changed = true;
      return { ...result, meta: { ...result.meta, toolName: name } };
    });
    if (changed) next = { ...next, toolResults };
  }
  return next;
});

/**
 * Rename the keys of a rolling trim summary's tool-count map.
 * @param {any} trimSummary @param {(name: string) => string | null | undefined} rename
 */
const renameTrimSummaryTools = (trimSummary, rename) => {
  if (!trimSummary || typeof trimSummary !== 'object'
      || !trimSummary.tools || typeof trimSummary.tools !== 'object') return trimSummary;
  /** @type {Record<string, number>} */
  const tools = {};
  for (const [name, count] of Object.entries(trimSummary.tools)) {
    const key = rename(name) || name;
    tools[key] = (tools[key] ?? 0) + /** @type {number} */ (count);
  }
  return { ...trimSummary, tools };
};

/**
 * Project a stored (canonical) trim summary for the model's view.
 * @param {unknown} actorType @param {any} trimSummary
 */
export const projectSandboxTrimSummary = (actorType, trimSummary) => {
  const verbs = sandboxVerbsFor(actorType);
  return verbs.size === 0 ? trimSummary : renameTrimSummaryTools(trimSummary, (name) => verbs.get(name));
};

/**
 * Project prior transcript turns (stored under canonical names) so the tool
 * calls the model re-reads use the same names as the tools it is shown.
 * @param {unknown} actorType @param {ReadonlyArray<any>} messages @returns {any[]}
 */
export const projectSandboxHistory = (actorType, messages) => {
  const verbs = sandboxVerbsFor(actorType);
  if (verbs.size === 0) return [...messages];
  return renameToolUses(messages, (name) => verbs.get(name));
};

/**
 * The inverse, for everything that leaves the actor worker: a transcript turn
 * recorded with verbs is returned under canonical names. A verb the kind does
 * not have keeps the name the model used (that call was refused).
 * @param {unknown} actorType @param {ReadonlyArray<any>} messages @returns {any[]}
 */
export const canonicalSandboxHistory = (actorType, messages) => {
  if (!isSandboxActorType(actorType)) return [...messages];
  return renameToolUses(messages, (name) => canonicalSandboxToolName(actorType, name));
};

/**
 * A loop event leaving the actor worker, with any tool name it carries in
 * canonical form: a `tool-use` event's name, a `tool-result` event's
 * meta.toolName, and a `state` event's transcript and trim-summary tool counts.
 * Other events pass through unchanged.
 * @template {Record<string, any>} E
 * @param {unknown} actorType @param {E} event @returns {E}
 */
export const canonicalSandboxLoopEvent = (actorType, event) => {
  if (!isSandboxActorType(actorType) || !event || typeof event !== 'object') return event;
  const canonical = (/** @type {string} */ name) => canonicalSandboxToolName(actorType, name);
  if (event.type === 'tool-use' && typeof event.name === 'string') {
    const name = canonical(event.name);
    return name && name !== event.name ? { ...event, name } : event;
  }
  if (event.type === 'tool-result' && typeof event.result?.meta?.toolName === 'string') {
    const name = canonical(event.result.meta.toolName);
    return name && name !== event.result.meta.toolName
      ? { ...event, result: { ...event.result, meta: { ...event.result.meta, toolName: name } } }
      : event;
  }
  if (event.type === 'state' && event.session && typeof event.session === 'object') {
    return {
      ...event,
      session: {
        ...event.session,
        ...(Array.isArray(event.session.messages)
          ? { messages: canonicalSandboxHistory(actorType, event.session.messages) } : {}),
        ...(event.session.trimSummary
          ? { trimSummary: renameTrimSummaryTools(event.session.trimSummary, canonical) } : {}),
      },
    };
  }
  return event;
};
