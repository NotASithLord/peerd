// @ts-check
// background/ui-ports.js — the registry of live UI-surface ports.
//
// why (DESIGN-12): the side panel and the full-page home are EQUAL live views
// of the same SW session. The SW must stream session state to — and route
// confirm prompts through — EVERY open surface, not one favored singleton (the
// old `sidePanelPort`). This is the functional core of that fan-out: ports are
// opaque handles carrying `.postMessage` + `.name`; the IO is the caller's.
//
// `broadcast` is fault-isolated: a port mid-disconnect throws on postMessage,
// which must not stop delivery to the others (the onDisconnect handler removes
// the dead port shortly after). Empty registry → broadcast is a no-op, so call
// sites don't need their own "is anything connected?" guard before a push —
// they use `size` only when surrounding logic must bail (e.g. confirm
// hang-protection: no surface open → auto-deny instead of awaiting forever).

/**
 * @typedef {{ name?: string, postMessage: (msg: unknown) => void }} UiPort
 */
export const makeUiPorts = () => {
  /** @type {Set<UiPort>} */
  const ports = new Set();

  return {
    /** @param {UiPort} port */
    add: (port) => { ports.add(port); },
    /** @param {UiPort} port */
    remove: (port) => ports.delete(port),
    /** @param {UiPort} port */
    has: (port) => ports.has(port),
    /** Number of connected surfaces. */
    get size() { return ports.size; },
    /** Is at least one connected surface named `name` (e.g. 'sidepanel')? Lets
     *  the home SPA learn a side panel is open so it can hand chat off to it
     *  (DESIGN-12: chat is single-homed — the panel owns it when open). */
    /** @param {string} name */
    hasNamed: (name) => {
      for (const port of ports) if (port.name === name) return true;
      return false;
    },
    /** Fan a message out to every connected surface; dead ports are skipped.
     * @param {unknown} msg */
    broadcast: (msg) => {
      for (const port of ports) {
        try { port.postMessage(msg); }
        catch { /* port closing — its onDisconnect handler removes it */ }
      }
    },
  };
};
