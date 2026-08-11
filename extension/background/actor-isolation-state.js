// @ts-check
// Durable fail-closed state for the actor Worker host. The key includes both
// host and protocol, so a browser-host change or protocol bump gets a fresh
// health record instead of inheriting an incompatible failure.

const KEY_PREFIX = 'actorIsolationFailure';

/**
 * @param {{ host?: string|null }} capability
 * @param {number} protocol
 */
export const actorIsolationFailureKey = (capability, protocol) =>
  `${KEY_PREFIX}:${String(capability?.host ?? 'none')}:v${protocol}`;

/**
 * @param {Object} deps
 * @param {{ get: (key: string) => Promise<Record<string, any>>, set: (items: Record<string, any>) => Promise<void>, remove: (key: string) => Promise<void> }} deps.storage
 * @param {number} deps.protocol
 * @param {() => number} [deps.now]
 */
export const makeActorIsolationStateStore = ({ storage, protocol, now = Date.now }) => ({
  /** @param {{ host?: string|null }} capability */
  load: async (capability) => {
    const key = actorIsolationFailureKey(capability, protocol);
    const record = (await storage.get(key))?.[key];
    if (record?.status !== 'temporarily_unavailable'
        || record?.host !== capability?.host
        || record?.protocol !== protocol) return null;
    return {
      status: /** @type {const} */ ('temporarily_unavailable'),
      host: capability?.host ?? null,
      reason: typeof record.reason === 'string' ? record.reason : 'The actor worker host did not start.',
      retryable: true,
    };
  },

  /** @param {{ host?: string|null }} capability @param {unknown} reason @param {string} code */
  markUnavailable: async (capability, reason, code) => {
    const key = actorIsolationFailureKey(capability, protocol);
    await storage.set({
      [key]: {
        status: 'temporarily_unavailable',
        host: capability?.host ?? null,
        protocol,
        reason: /** @type {{ message?: string }} */ (reason)?.message ?? String(reason || 'The actor worker host did not start.'),
        code,
        recordedAt: now(),
      },
    });
  },

  /** @param {{ host?: string|null }} capability */
  clear: async (capability) => storage.remove(actorIsolationFailureKey(capability, protocol)),
});
