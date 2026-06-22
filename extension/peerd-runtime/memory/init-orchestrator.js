// @ts-check
// /init orchestration — workspace scan → draft AGENTS.md → confirm →
// persist (V1.5). Pushed down from the SW so the service worker keeps
// only wiring; every IO surface (tabs, scripting, the App registry, the
// memory store, the confirm round-trip, the chat note channel) is
// injected.
//
// peerd's workspace is a browsing context, not just a file tree, so the
// probe composes @tab (live page via the user's session) + peerd Apps +
// (best-effort) a WebVM listing. The draft is PURE (draftAgentsMd); the
// confirm round-trip is the same SW ↔ side panel channel memory writes
// use — /init never silently persists.
//
// The vault-locked gate stays in the SW glue: VaultLockedError is an
// egress type, and the runtime never imports concrete egress adapters
// (the DI rule).

import { draftAgentsMd, deriveChecklist, resolveWorkspaceKey } from './initializer.js';

/**
 * @param {Object} deps
 * @param {{ query(q:object): Promise<any[]> }} deps.tabs            browser.tabs
 * @param {{ executeScript(opts:object): Promise<any[]> }} deps.scripting  browser.scripting
 * @param {() => Promise<Array<{ id:string, name?:string, description?:string }>>} deps.listApps
 *   List peerd Apps (appRegistry.list bound by the SW).
 * @param {{ writeWithConfirm(req:object): Promise<any>, ensureInitializer(req:object): Promise<any> }} deps.memory
 *   The memory store (createMemoryStore instance).
 * @param {(prompt: object) => Promise<'yes_once'|'yes_session'|'no'>} deps.confirm
 *   The SW ↔ side panel confirmation round-trip (confirmAction).
 * @param {(text: string) => void} deps.postChatNote
 *   Post a system note into the chat transcript.
 */
export const makeInitOrchestrator = (deps) => {
  const { tabs, scripting, listApps, memory, confirm, postChatNote } = deps;

  /**
   * Read the active tab's live context (title, headings, a text snippet)
   * via an injected probe. Best-effort — restricted pages (chrome://,
   * the web store) throw on inject; we return what we have.
   */
  const probeActiveTab = async () => {
    try {
      const [tab] = await tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url || /^(chrome|about|devtools|edge):/.test(tab.url)) {
        return tab?.url ? { url: tab.url, title: tab.title } : null;
      }
      let probe = { url: tab.url, title: tab.title };
      try {
        const [res] = await scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const headings = [...document.querySelectorAll('h1,h2,h3')]
              .map((h) => h.textContent.trim()).filter(Boolean).slice(0, 12);
            const text = (document.body?.innerText || '').slice(0, 1500);
            return { headings, textSnippet: text };
          },
        });
        if (res?.result) probe = { ...probe, ...res.result };
      } catch { /* inject blocked — keep url/title only */ }
      return probe;
    } catch {
      return null;
    }
  };

  /** List peerd Apps for the /init probe (best-effort). */
  const probeApps = async () => {
    try {
      const apps = await listApps();
      return (apps || []).map((a) => ({ id: a.id, name: a.name, description: a.description }));
    } catch { return []; }
  };

  /**
   * Run /init for the current workspace. Scans, drafts an AGENTS.md, asks
   * the user to confirm the write (memory.writeWithConfirm, origin agent),
   * persists on yes, and seeds the initializer journal with a derived
   * feature checklist.
   */
  const runInit = async () => {
    const [tab, apps] = await Promise.all([probeActiveTab(), probeApps()]);
    const probe = { tab: tab ?? undefined, apps };
    const workspace = resolveWorkspaceKey(probe);
    const { body, sources, checklist } = draftAgentsMd(probe);

    postChatNote(`/init scanned workspace **${workspace}** (sources: ${sources.join(', ') || 'none'}). `
      + 'Review the proposed AGENTS.md and confirm to save it to project memory.');

    const res = await memory.writeWithConfirm({
      scope: { kind: 'project', workspace },
      body,
      origin: 'agent',
      confirm: (/** @type {import('./memory.js').WriteProposal} */ proposal) => confirm({
        tool: 'init',
        sideEffect: 'write',
        kind: 'memory_write',
        proposal,
        summary: `Create AGENTS.md for ${workspace} (+${proposal.addedLines} lines)`,
        origins: [],
        sessionId: null,
      }),
    });

    if (res.rejected) {
      postChatNote('/init cancelled — nothing was saved.');
      return { ok: false, rejected: true };
    }
    // Seed the initializer journal (first-run build log + checklist). This
    // is internal bookkeeping (origin:user), so it does not re-prompt.
    await memory.ensureInitializer({ workspace, checklist: checklist.length ? checklist : deriveChecklist(probe) });
    postChatNote(`/init saved AGENTS.md for **${workspace}** and started an initializer journal. `
      + 'It now loads into context at the start of every session here.');
    return { ok: true, workspace };
  };

  return Object.freeze({ runInit });
};
