// @ts-check

import { providerEgressPolicy } from './provider-egress-manifest.js';

/** @param {Record<string,any>} deps */
export const makeKernelProviderSetKeyRoute = ({
  vault, settingsStore, auditLog, pushState, testProvider,
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
    const settings = settingsStore.get();
    const activeName = settings.providerName;
    if (message.activate !== false && activeName !== message.provider) {
      const active = providerEgressPolicy(activeName);
      let usable = active?.credential === null;
      if (activeName === 'ollama') {
        // why: keyless does not prove a daemon has a usable inventory. Reuse
        // the sealed semantic probe; no provider catalog enters the kernel.
        try {
          const result = await testProvider?.({ provider: activeName, activate: false });
          // A lost controller lifetime is not evidence about daemon readiness.
          usable = result?.code || result?.outcomeKnown === false
            ? true : result?.ok === true && Number(result.models) > 0;
        } catch (cause) {
          usable = /** @type {{name?:string}} */ (cause)?.name === 'AbortError';
        }
      } else if (!usable && active?.credential) {
        try { usable = !!(await vault.getSecret(active.credential)); } catch { usable = false; }
      }
      // A resident WebGPU selection retains its separate composer/download
      // readiness check; never treat it as a daemon or probe it with a key.
      const current = settingsStore.get();
      const unchanged = current.providerName === activeName
        && current.providerModel === settings.providerModel
        && current.ollamaHost === settings.ollamaHost;
      if (!vault.isLocked?.() && unchanged && !usable) {
        await settingsStore.update({ providerName: message.provider, providerModel: '' });
      }
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
