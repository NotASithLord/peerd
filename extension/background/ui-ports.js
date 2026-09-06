// @ts-check
/** @typedef {{ name?: string, postMessage: (msg: unknown) => void }} UiPort */
export const makeUiPorts = () => {
  /** @type {Set<UiPort>} */
  const ports = new Set();

  return {
    /** @param {UiPort} port */
    add: (port) => { ports.add(port); },
    /** @param {UiPort} port */
    remove: (port) => ports.delete(port),
    get size() { return ports.size; },
    /** @param {string} name */
    hasNamed: (name) => {
      for (const port of ports) if (port.name === name) return true;
      return false;
    },
    /** @param {unknown} msg */
    broadcast: (msg) => {
      for (const port of ports) {
        try { port.postMessage(msg); }
        catch { /* port closing — its onDisconnect handler removes it */ }
      }
    },
  };
};
