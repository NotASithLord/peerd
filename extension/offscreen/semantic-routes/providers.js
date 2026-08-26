// @ts-check

import { PROVIDER_METADATA } from '/peerd-provider/controller.js';

/**
 * @param {string} route
 * @param {any} _message
 * @param {{kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} options
 */
export const dispatchProviderSemanticRoute = async (route, _message, options) => {
  if (route !== 'provider/status' || typeof options.kernelCall !== 'function') {
    return { ok: false, code: 'semantic-provider-route-refused', outcomeKnown: true };
  }
  const result = await options.kernelCall('semantic.providers.key-status', {});
  if (result?.ok !== true || !result.value || typeof result.value !== 'object') {
    return { ok: false, code: 'semantic-provider-status-unavailable', outcomeKnown: true };
  }
  const status = result.value;
  return {
    ok: true,
    providers: PROVIDER_METADATA.map((provider) => {
      const key = status[provider.name];
      return {
        name: provider.name,
        label: provider.label,
        defaultModel: provider.defaultModel,
        defaultRunnerModel: provider.defaultRunnerModel,
        hasKey: key?.hasKey === true,
        keyless: provider.keyless,
        liveModels: provider.liveModels,
        keyPreview: typeof key?.keyPreview === 'string' ? key.keyPreview : null,
      };
    }),
  };
};
