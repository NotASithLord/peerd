// @ts-check

import { providerAuthority } from '../shared/provider-authority-policy.js';

/** @param {Record<string,any>} deps */
export const makeKernelProviderSetKeyRoute = ({
  vault, settingsStore, auditLog, pushState,
}) => async (/** @type {any} */ message = {}) => {
  const policy = providerAuthority(message.provider);
  if (!policy) return { ok: false, error: 'unknown-provider' };
  if (policy.secretName === null) return { ok: false, error: 'keyless-provider' };
  const key = typeof message.plaintext === 'string' ? message.plaintext.trim() : '';
  if (key.length < 8) return { ok: false, error: 'key-too-short' };
  try {
    const prior = await vault.getSecret(policy.secretName);
    if (prior !== key) {
      await vault.setSecret(policy.secretName, key);
      auditLog.append({ type: 'provider_added', details: { provider: policy.name } }).catch(() => {});
    }
    const active = providerAuthority(settingsStore.get().providerName);
    let usable = active?.secretName === null;
    if (!usable && active?.secretName) {
      try { usable = !!(await vault.getSecret(active.secretName)); } catch { usable = false; }
    }
    if (message.activate !== false && !usable && active?.name !== policy.name) {
      await settingsStore.update({ providerName: policy.name, providerModel: '' });
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
