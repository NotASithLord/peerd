// @ts-check
// /tools — the per-session tool-manifest composer command.
//
// SW-handled like /init, /loop and /system (intercepted in agent/send,
// never sent to the model — it CHANGES what the model is offered
// instead). Four forms:
//
//   /tools             show the active manifest (or "full")
//   /tools list        list the named presets
//   /tools <preset>    narrow this chat to a preset's toolset
//   /tools full        restore full exposure (clear the manifest)
//
// Functional core, imperative shell: this module owns the grammar and
// the store/audit/note choreography with every IO surface injected, so
// the whole command flow is testable (in-browser suite) without a
// service worker. The SW binds the real sessions store, session-id
// cache, chat-note poster and audit log.

import {
  TOOL_MANIFEST_PRESETS,
  resolveManifestAllow,
  manifestLabel,
} from './manifests.js';

const USAGE = '"/tools list" shows presets; "/tools <preset>" narrows this chat\'s toolset; "/tools full" restores everything.';

/**
 * One line per preset for the /tools list note. Pure.
 * @returns {string}
 */
export const describePresets = () => {
  const lines = Object.entries(TOOL_MANIFEST_PRESETS).map(([name, p]) =>
    `/tools ${name} — ${p.description} (${p.allow.length} tools)`);
  lines.push('/tools full — every registered tool (the default)');
  return lines.join('\n');
};

/**
 * Build the bound /tools handler.
 *
 * @param {Object} deps
 * @param {{ get: Function, setToolManifest: Function }} deps.sessions
 * @param {() => Promise<string | undefined>} deps.getCurrentSessionId
 * @param {() => Promise<string>} deps.ensureSession   lazily create a chat
 *   session when the user runs a SETTING form before the first message —
 *   same contract as /system's lazy-create path.
 * @param {(text: string) => void} deps.postNote       chat system-note
 * @param {(entry: object) => Promise<unknown>} deps.audit
 * @returns {(arg: string) => Promise<{ session: import('../sessions/types.js').Session | null }>}
 *   `session` is the updated record when the manifest changed (the SW
 *   refreshes its cache + pushes state), null for the read-only forms.
 */
export const makeToolsCommand = ({ sessions, getCurrentSessionId, ensureSession, postNote, audit }) =>
  async (rawArg) => {
    const arg = (rawArg ?? '').trim();

    // Show the active state.
    if (!arg) {
      const sessionId = await getCurrentSessionId();
      const s = sessionId ? await sessions.get(sessionId) : null;
      const allow = resolveManifestAllow(s?.toolManifest);
      postNote(allow
        ? `Tool manifest active for this chat: ${manifestLabel(s.toolManifest)} (${allow.size} tools exposed). ${USAGE}`
        : `No tool manifest set — every registered tool is exposed. ${USAGE}`);
      return { session: null };
    }

    if (/^list$/i.test(arg)) {
      postNote(`Tool manifest presets:\n${describePresets()}`);
      return { session: null };
    }

    // Restore full exposure. 'clear' is accepted as an alias for symmetry
    // with "/system clear" muscle memory.
    if (/^(full|clear)$/i.test(arg)) {
      const sessionId = await getCurrentSessionId();
      if (!sessionId) {
        postNote('No active chat — new chats already start with the full toolset.');
        return { session: null };
      }
      const updated = await sessions.setToolManifest(sessionId, null);
      audit({ type: 'tool_manifest_cleared', sessionId }).catch(() => {});
      postNote('Tool manifest cleared — every registered tool is exposed again.');
      return { session: updated };
    }

    // Set a preset. Strict: an unknown name is an error, never persisted —
    // the fail-closed resolver would narrow it to ZERO tools, so refusing
    // here keeps a typo from silently bricking the chat.
    const name = arg.toLowerCase();
    // why: `name` is untrusted user input; an unknown key yields undefined,
    // handled by the guard below (the documented fail-closed path).
    const preset = /** @type {Record<string, { description: string, allow: readonly string[] }>} */ (TOOL_MANIFEST_PRESETS)[name];
    if (!preset) {
      postNote(`Unknown tool preset '${arg}'.\n${describePresets()}`);
      return { session: null };
    }
    const sessionId = await ensureSession();
    const updated = await sessions.setToolManifest(sessionId, { preset: name });
    // why: audit the EVENT + preset name only — the preset's contents are
    // code, not user data, so the name is enough to reconstruct the state.
    audit({ type: 'tool_manifest_set', sessionId, details: { preset: name } }).catch(() => {});
    postNote(`Tool manifest set for this chat: ${name} — ${preset.description} (${preset.allow.length} tools). "/tools full" restores everything.`);
    return { session: updated };
  };
