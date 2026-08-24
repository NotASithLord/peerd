// @ts-check
// Package-only same-user dweb route surface for targets without a mesh host.
//
// The two byte relays retain sender-first refusal: an ordinary extension page
// must never learn whether the disabled offscreen custody surface exists.

const disabled = () => ({ ok: false, error: 'dweb-disabled' });

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any, sender?: any) => Promise<any>>}
 */
export const makeDwebSelfRoutes = ({ dwebReady, isOffscreenSender }) => {
  const gatedDisabled = async () => {
    await dwebReady();
    return disabled();
  };
  /** @param {any} _msg @param {any} sender */
  const relayDisabled = async (_msg, sender) => {
    if (!isOffscreenSender(sender)) return { ok: false, error: 'unauthorized-relay' };
    await dwebReady();
    return disabled();
  };
  return {
    'dweb/self-status': gatedDisabled,
    'dweb/self-prepare-offer': gatedDisabled,
    'dweb/self-read-surface': relayDisabled,
    'dweb/self-apply-surface': relayDisabled,
    'dweb/self-restore': gatedDisabled,
  };
};
