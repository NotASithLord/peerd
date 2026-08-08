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
// disarmText is PURE (not an IO surface), so importing it directly does not
// break the module's dependency-injection rule.
import { disarmText } from '../dom/cdr.js';
import { resolveTargetTab, scriptingTarget } from '../tools/defs/dom-helpers.js';
import { BrowserAutomationPolicyError } from '../tools/browser-automation-policy.js';

/**
 * Read the small page summary used by /init. This function is serialized into
 * the page, so it must be self-contained and explicitly strict.
 */
export function probeInitTabInjected() {
  'use strict';
  const headings = [...document.querySelectorAll('h1,h2,h3')]
    .map((heading) => heading.textContent?.trim() ?? '').filter(Boolean).slice(0, 12);
  const text = (document.body?.innerText || '').slice(0, 1500);
  return { headings, textSnippet: text };
}

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
 * @param {() => readonly string[]} [deps.getDenylist]
 *   Read the current denylist at scan time.
 */
export const makeInitOrchestrator = (deps) => {
  const { tabs, scripting, listApps, memory, confirm, postChatNote, getDenylist = () => [] } = deps;

  /**
   * Read the active tab's live context (title, headings, a text snippet)
   * via an injected probe. Best-effort. A refused browser target contributes
   * no tab data to durable memory and returns a scrubbed user-facing warning.
   */
  const probeActiveTab = async () => {
    try {
      const [tab] = await tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url || /^(chrome|about|devtools|edge):/.test(tab.url)) {
        return { value: tab?.url ? { url: tab.url, title: tab.title } : null };
      }
      let target;
      try {
        // why: tabs.query is a stale browser record. The shared resolver checks
        // the committed document and supplies the exact documentId used below.
        target = await resolveTargetTab({ tabId: tab.id }, {
          tabs,
          scripting,
          denylist: getDenylist(),
        });
      } catch (error) {
        if (error instanceof BrowserAutomationPolicyError) {
          return {
            value: null,
            warning: `/init skipped the browser page. ${error.code}: ${error.content}`,
          };
        }
        return { value: null, warning: '/init skipped the browser page because its current document could not be verified.' };
      }
      if (!target) {
        return { value: null, warning: '/init skipped the browser page because browser policy refused the target.' };
      }
      // why disarmText here: this page-derived probe (title, headings, body
      // snippet) is composed by draftAgentsMd into ALWAYS-LOADED project memory,
      // which re-enters the TRUSTED orchestrator system prompt every future
      // session. It is a read boundary INV-12 must cover — invisible-Unicode /
      // bidi instructions smuggled in a heading or the body would persist as a
      // durable injection, and be invisible both at the confirm gate and in the
      // Memory tab. Strip at the source, exactly as read_page / fetch_url do.
      /** @type {{ url?: string, title?: string, headings?: string[], textSnippet?: string }} */
      let probe = { url: target.url, title: disarmText(target.title) };
      try {
        const [res] = await scripting.executeScript({
          target: scriptingTarget(target),
          func: probeInitTabInjected,
        });
        if (res?.result) {
          const r = res.result;
          probe = {
            ...probe,
            headings: Array.isArray(r.headings) ? r.headings.map((/** @type {unknown} */ h) => disarmText(String(h))) : r.headings,
            textSnippet: typeof r.textSnippet === 'string' ? disarmText(r.textSnippet) : r.textSnippet,
          };
        }
      } catch { /* inject blocked — keep url/title only */ }
      return { value: probe };
    } catch {
      return { value: null, warning: '/init skipped the browser page because its current document could not be verified.' };
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
    const [tabProbe, apps] = await Promise.all([probeActiveTab(), probeApps()]);
    const probe = { tab: tabProbe.value ?? undefined, apps };
    const workspace = resolveWorkspaceKey(probe);
    const { body, sources, checklist } = draftAgentsMd(probe);

    postChatNote(`/init scanned workspace **${workspace}** (sources: ${sources.join(', ') || 'none'}). `
      + 'Review the proposed AGENTS.md and confirm to save it to project memory.');
    if (tabProbe.warning) postChatNote(tabProbe.warning);

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
