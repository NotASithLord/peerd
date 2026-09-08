// @ts-check

import { providerEgressPolicy } from './provider-egress-manifest.js';

/** @param {Record<string,any>} deps */
export const makeKernelProviderSetKeyRoute = ({
  vault, settingsStore, auditLog, pushState,
}) => async (/** @type {any} */ message = {}) => {
  const policy = providerEgressPolicy(message.provider);
  if (!policy) return { ok: false, error: 'unknown-provider' };
  if (policy.credential === null) return { ok: false, error: 'keyless-provider' };
  const key = typeof message.plaintext === 'string' ? message.plaintext.trim() : '';
  if (key.length < 8) return { ok: false, error: 'key-too-short' };
  try {
    const prior = await vault.getSecret(policy.credential);
    if (prior !== key) {
      await vault.setSecret(policy.credential, key);
      auditLog.append({ type: 'provider_added', details: { provider: message.provider } }).catch(() => {});
    }
    const activeName = settingsStore.get().providerName;
    const active = providerEgressPolicy(activeName);
    let usable = active?.credential === null;
    if (!usable && active?.credential) {
      try { usable = !!(await vault.getSecret(active.credential)); } catch { usable = false; }
    }
    if (message.activate !== false && !usable && activeName !== message.provider) {
      await settingsStore.update({ providerName: message.provider, providerModel: '' });
    }
    await Promise.resolve(pushState());
    return { ok: true };
  } catch (cause) {
    if (vault.isLocked?.()) return { ok: false, error: 'locked' };
    const unknown = cause instanceof Error ? cause : new Error(String(cause));
    Object.assign(unknown, { outcomeKnown: false });
    throw unknown;
  }
};
