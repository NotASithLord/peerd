// @ts-check
// Small browser-authority routes that must admit the exact sender before any
// storage or audit effect. Rich feature work remains outside this leaf.

export {
  createKernelAppFileReader,
  makeKernelAppEditorRoutes,
} from './kernel-app-file-reader.js';
export { createKernelSiteClientRoutes } from './kernel-site-client-routes.js';

/** @param {{ready:Promise<any>,assertWritable:()=>void,isAllowed:(sender:unknown)=>boolean}} deps */
export const makeKernelOpfsPostureRoute = ({ ready, assertWritable, isAllowed }) =>
  async (/** @type {any} */ _message = {}, /** @type {unknown} */ sender = undefined) => {
    if (!isAllowed(sender)) return { ok: false, error: 'unauthorized OPFS posture request' };
    try {
      await ready;
      assertWritable();
      return { ok: true };
    } catch (cause) {
      return { ok: false,
        error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause) };
    }
  };

/**
 * @param {Object} deps
 * @param {Promise<any>} deps.ready
 * @param {{get:(store:string,key:string)=>Promise<any>}} deps.idb
 * @param {{get:()=>Record<string,any>}} deps.settingsStore
 * @param {(sender:unknown)=>boolean} deps.isAllowed
 */
export const makeKernelVmMetaRoute = ({ ready, idb, settingsStore, isAllowed }) =>
  async (/** @type {{vmId?:unknown}} */ { vmId } = {}, /** @type {unknown} */ sender = undefined) => {
    if (!isAllowed(sender)) return { ok: false, error: 'vm-meta-unauthorized' };
    if (typeof vmId !== 'string') return { ok: false, error: 'vmId-required' };
    try {
      await ready;
      const row = await idb.get('vms', 'webvms.v1');
      const value = row?.key === 'webvms.v1' && row.value
        && typeof row.value === 'object' && !Array.isArray(row.value)
        && row.value.schemaVersion === 1 ? row.value : null;
      const vms = value?.vms && typeof value.vms === 'object' && !Array.isArray(value.vms)
        ? value.vms : null;
      const record = vms && Object.hasOwn(vms, vmId) ? vms[vmId] : null;
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return { ok: false, error: 'vm-not-found' };
      }
      return { ok: true, record, devMode: !!settingsStore.get().devMode };
    } catch (cause) {
      return { ok: false,
        error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause) };
    }
  };

/** @param {{auditLog:{append:(entry:any)=>Promise<any>},isAllowed:(sender:unknown)=>boolean}} deps */
export const makeKernelVoiceAuditRoute = ({ auditLog, isAllowed }) => async (
  /** @type {{url?:unknown}} */ message = {}, /** @type {unknown} */ sender = undefined,
) => {
  if (!isAllowed(sender)) return { ok: false, error: 'voice-audit-unauthorized' };
  auditLog.append({
    type: 'voice_model_fetch',
    details: { url: typeof message.url === 'string' ? message.url.slice(0, 300) : '' },
  }).catch(() => {});
  return { ok: true };
};
