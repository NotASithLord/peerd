// @ts-check
// background/routes/system.js — cross-cutting "system" routes: the UI state
// snapshot, the human-facing audit log read, cumulative cost, side-panel
// surface control, and the settings transfer import side.
//
// transfer/export stays inline in the SW (it reads the reassigned
// storedSettings); so do the denylist/* routes (reassigned denylist state).
// Everything here closes over only stable collaborators. Bodies verbatim,
// deps injected, imports none.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => any>}
 *   why any (not Promise): most handlers are async, but sidepanel/close and
 *   surfaces/get answer synchronously; the dispatcher awaits either.
 */
export const makeSystemRoutes = (deps) => {
  const {
    vault, auditLog, sessions, pushState, kv, memory,
    buildStateSnapshot, closeSidePanel, uiPorts, loadUserEndpoints,
    inspectImport, applyImport, settingsStore, saveUserHook,
    CHANNEL, DEFAULT_SETTINGS, ExportPassphraseError,
  } = deps;

  return {
    // --- state (one-shot snapshot) ---
    // why: the options page renders from the SAME snapshot the panel gets
    // pushed over its port, but deliberately holds no port. It fetches on
    // load and refetches on focus; sendMessage also revives a dead SW.
    'state/get': async () => ({ ok: true, state: await buildStateSnapshot() }),

    // --- logs (human-facing audit log) ---
    // The agent can already introspect this (inspect_audit_log); this route
    // surfaces the same data to the USER in the Logs view. The audit log is
    // append-only and UUIDv7-keyed, so getAll() is chronological — we reverse
    // for newest-first and cap the payload so a long-lived install doesn't
    // ship megabytes to the panel.
    'audit/list': async ({ limit = 500 } = {}) => {
      try {
        const all = await auditLog.list();
        const entries = all.slice(-limit).reverse();
        return { ok: true, entries, total: all.length };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? 'audit-list-failed' };
      }
    },

    // why: the voice model store (side-panel context) routes its outbound HF
    // model fetch here so it lands in the audit log. TYPE-LOCKED: the entry type
    // is hardcoded to voice_model_fetch and only the url is taken (truncated), so
    // this route can't be used to forge arbitrary audit entries.
    'audit/voice-fetch': async (msg) => {
      auditLog.append({
        type: 'voice_model_fetch',
        details: { url: typeof msg?.url === 'string' ? msg.url.slice(0, 300) : '' },
      }).catch(() => {});
      return { ok: true };
    },

    // Cumulative BYOK spend across every chat (feature 06's global view).
    // Summed locally from each session's persisted cost tally — no network.
    'cost/total': async () => {
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      try {
        const all = await sessions.list();
        let usd = 0, tokens = 0, chats = 0;
        for (const s of all) {
          const c = s.cost;
          if (!c) continue;
          const t = (c.inputTokens || 0) + (c.outputTokens || 0)
            + (c.cacheReadTokens || 0) + (c.cacheWriteTokens || 0);
          if (t === 0 && !(Number(c.cost) > 0)) continue;
          usd += Number(c.cost) || 0;
          tokens += t;
          chats += 1;
        }
        return { ok: true, usd, tokens, chats };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? 'cost-total-failed' };
      }
    },

    // Close the side panel so the home tab re-owns the chat (single-homed,
    // DESIGN-12) — home's "bring chat home", the panel's close button, the
    // engine-tab toggle, and the Alt+Shift+P toggle all route through here. Now
    // works on Firefox too (sidebarAction.close); see closeSidePanel.
    'sidepanel/close': () => closeSidePanel(),
    // A PORTLESS engine tab (vm/notebook/app) asks whether the side panel is open
    // right now, to seed its "pull in peerd" toggle label. Read-only; the live
    // updates after this ride the surfaces/changed broadcast (broadcastSurfaces).
    'surfaces/get': () => ({ ok: true, sidePanelOpen: uiPorts.hasNamed('sidepanel') }),

    // --- transfer: explicit settings import (dual-distribution §10) ---
    //
    // The ONLY migration path between installs (store ↔ preview). transfer/export
    // stays inline in the SW (it reads the reassigned storedSettings).

    // Pre-flight: what would this import overwrite? The UI shows the
    // summary (and the dweb-dropped notice on store packages) BEFORE
    // the user confirms.
    'transfer/inspectImport': async ({ payload }) => inspectImport({
      payload, channel: CHANNEL, knownSettingKeys: Object.keys(DEFAULT_SETTINGS),
    }),

    'transfer/import': async ({ payload, passphrase }) => {
      if (payload?.secrets != null && vault.isLocked()) {
        return { ok: false, error: 'vault-locked' };
      }
      try {
        const result = await applyImport({
          payload,
          passphrase,
          channel: CHANNEL,
          knownSettingKeys: Object.keys(DEFAULT_SETTINGS),
          io: {
            applySettings: (/** @type {any} */ patch) => settingsStore.update(patch),
            setProviderEndpoints: async (/** @type {any} */ v) => {
              await kv.set('provider_endpoints.v1', v);
              await loadUserEndpoints();
            },
            setSecret: (/** @type {string} */ name, /** @type {string} */ value) => vault.setSecret(name, value),
            importMemory: (/** @type {any} */ p) => memory.importAll(p),
            saveHook: (/** @type {any} */ record) => saveUserHook({ kv }, record),
          },
        });
        if (result.ok) {
          auditLog.append({ type: 'settings_imported', counts: result.imported }).catch(() => {});
          pushState();
        }
        return result;
      } catch (e) {
        if (e instanceof ExportPassphraseError) return { ok: false, error: 'wrong-passphrase' };
        throw e;
      }
    },
  };
};
